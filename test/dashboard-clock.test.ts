import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  dashboardCommand,
  detailLines,
  exactTime,
  renderDashboard,
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

it("shows an explicit UTC timestamp and handles missing/bad dates", () => {
  expect(exactTime("2026-09-12T12:00:00+02:00")).toBe(
    "2026-09-12 10:00:00 UTC",
  );
  expect(exactTime("bad date")).toBe("unknown");
});

it("redraws age without loading data, updates freshness only on refresh, and clears its timer on exit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:01:00Z"));
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", "1");
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 160,
    rows: 40,
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
    startedAt: "2026-09-12T09:00:00Z",
    readyAt: "2026-09-12T10:00:00Z",
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
    "Started: 2026-09-12 09:00:00 UTC",
  );
  const running = dashboardCommand();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(screen).toContain("1m");
    expect(screen).toContain("Last refresh 2026-09-12 10:01:00 UTC");
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("2m");
    expect(screen).toContain("Last refresh 2026-09-12 10:01:00 UTC");
    expect(readSessions).toHaveBeenCalledTimes(1);
    expect(readConfig).toHaveBeenCalledTimes(1);
    screen = "";
    input.emit("keypress", "r", { name: "r" });
    await vi.advanceTimersByTimeAsync(0);
    expect(readSessions).toHaveBeenCalledTimes(2);
    expect(screen).toContain("Last refresh 2026-09-12 10:02:00 UTC");
    // Simulate returning after several hours, rather than incrementing a counter.
    vi.setSystemTime(new Date("2026-09-12T14:00:00Z"));
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("4h");
    expect(readSessions).toHaveBeenCalledTimes(2);
    expect(screen).toContain("Last refresh 2026-09-12 10:02:00 UTC");
    input.emit("keypress", "/", { name: "/" });
    input.emit("keypress", "C", { name: "c" });
    await vi.advanceTimersByTimeAsync(0);
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("Search: C_");
    expect(readSessions).toHaveBeenCalledTimes(2);
    input.emit("keypress", "", { name: "escape" });
    await vi.advanceTimersByTimeAsync(0);
    input.emit("keypress", "\r", { name: "return" });
    await vi.advanceTimersByTimeAsync(0);
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("Started: 2026-09-12 09:00:00 UTC");
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

it("keeps the full refresh date visible in compact layouts", () => {
  const lines = renderDashboard(
    [],
    0,
    79,
    24,
    new Date("2026-09-12T10:00:00Z"),
  );
  expect(lines.join("\n")).toContain("Last refresh 2026-09-12 10:00:00 UTC");
  expect(lines.every((line) => line.length <= 79)).toBe(true);
});
