import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  dashboardCommand,
  detailLines,
  exactTime,
  relativeStartTime,
} from "../src/dashboard.js";
import { readConfig, readSessions } from "../src/runtime.js";
import type { Session } from "../src/types.js";

vi.mock("../src/runtime.js", () => ({
  readConfig: vi.fn(),
  readSessions: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each([
  [0, "just now"],
  [59_999, "just now"],
  [60_000, "1m ago"],
  [3_600_000, "1h ago"],
  [86_400_000, "1d ago"],
  [-1, "in future"],
])("formats elapsed time %i without rounding up", (elapsed, expected) => {
  const start = "2026-09-12T10:00:00.000Z";
  expect(relativeStartTime(start, Date.parse(start) + elapsed)).toBe(expected);
});
it("shows an explicit UTC timestamp and handles missing/bad dates", () => {
  expect(exactTime("2026-09-12T12:00:00+02:00")).toBe(
    "2026-09-12 10:00:00 UTC",
  );
  expect(relativeStartTime("bad date")).toBe("unknown");
  expect(exactTime("bad date")).toBe("unknown");
});

it("redraws age without loading data, updates freshness only on refresh, and clears its timer on exit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:01:00Z"));
  vi.stubEnv("TERM", "xterm");
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 80,
    rows: 24,
  });
  let screen = "";
  output.on("data", (chunk) => {
    screen += chunk.toString();
  });
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    input as unknown as NodeJS.ReadStream,
  );
  vi.spyOn(process, "stdout", "get").mockReturnValue(
    output as unknown as NodeJS.WriteStream,
  );
  const session: Session = {
    id: "clock-session",
    repositoryId: "repo",
    repositoryPath: "/repo",
    worktreePath: "/source",
    branch: "task",
    status: "active",
    startCommit: "base",
    integrationCommitAtStart: null,
    startedAt: "2026-09-12T10:00:00Z",
    taskSummary: "Clock",
    dependsOn: [],
  };
  vi.mocked(readConfig).mockResolvedValue({
    repositories: [],
    lockWaitSeconds: 1,
    codexCommand: "codex",
  });
  vi.mocked(readSessions).mockResolvedValue([session]);
  expect(detailLines({ repository: undefined, session })).toContain(
    "Started: 2026-09-12 10:00:00 UTC",
  );
  const running = dashboardCommand();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(screen).toContain("1m ago");
    expect(screen).toContain("Status refreshed at 2026-09-12 10:01:00 UTC");
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("2m ago");
    expect(screen).toContain("Status refreshed at 2026-09-12 10:01:00 UTC");
    expect(readSessions).toHaveBeenCalledTimes(1);
    expect(readConfig).toHaveBeenCalledTimes(1);
    screen = "";
    input.emit("keypress", "r", { name: "r" });
    await vi.advanceTimersByTimeAsync(0);
    expect(readSessions).toHaveBeenCalledTimes(2);
    expect(screen).toContain("Status refreshed at 2026-09-12 10:02:00 UTC");
    // Simulate returning after several hours, rather than incrementing a counter.
    vi.setSystemTime(new Date("2026-09-12T14:00:00Z"));
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("4h ago");
    expect(readSessions).toHaveBeenCalledTimes(2);
    expect(screen).toContain("Status refreshed at 2026-09-12 10:02:00 UTC");
    input.emit("keypress", "\r", { name: "return" });
    await vi.advanceTimersByTimeAsync(0);
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("Started: 2026-09-12 10:00:00 UTC");
    expect(screen).toContain("Esc back");
    expect(readSessions).toHaveBeenCalledTimes(2);
  } finally {
    input.emit("keypress", "q", { name: "q" });
    await vi.advanceTimersByTimeAsync(0);
    await running;
  }
  expect(vi.getTimerCount()).toBe(0);
  expect(input.setRawMode).toHaveBeenLastCalledWith(false);
});
