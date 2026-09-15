import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  dashboardCommand,
  detailLines,
  exactTime,
  renderDashboard,
} from "../src/dashboard.js";
import { readConfig, readSessions } from "../src/runtime.js";
import { editTasks } from "../src/tasks.js";
import type { Session } from "../src/types.js";

vi.mock("../src/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime.js")>()),
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

it("refreshes automatically, defers updates during input, and clears timers on exit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:01:00Z"));
  vi.stubEnv("SESH_INTEGRATOR_HOME", "/nonexistent-dashboard-test-runtime");
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
    expect(screen).toContain("Clock");
    expect(screen).toContain("Last refresh 2026-09-12 10:01:00 UTC");
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("Clock");
    expect(screen).toContain("Last refresh 2026-09-12 10:02:00 UTC");
    expect(readSessions).toHaveBeenCalledTimes(4);
    expect(readConfig).toHaveBeenCalledTimes(4);
    screen = "";
    input.emit("keypress", "r", { name: "r" });
    await vi.advanceTimersByTimeAsync(0);
    expect(readSessions).toHaveBeenCalledTimes(5);
    expect(screen).toContain("Last refresh 2026-09-12 10:02:00 UTC");
    const press = async (name: string) => {
      screen = "";
      input.emit("keypress", "", { name });
      await vi.advanceTimersByTimeAsync(0);
    };
    await press("left");
    expect(screen).toContain("[needs attention]");
    await press("left");
    expect(screen).toContain("[all]");
    await press("right");
    expect(screen).toContain("[needs attention]");
    await press("right");
    expect(screen).toContain("[active]");
    await press("p");
    expect(screen).toContain("> All repositories");
    await press("down");
    expect(screen).toContain("> repo");
    expect(screen).toContain("repo: all repos");
    await press("left");
    expect(screen).toContain("[active]");
    await press("escape");
    expect(screen).toContain("repo: all repos");
    expect(screen).not.toContain("Esc cancel");
    await press("p");
    await press("down");
    await press("return");
    expect(screen).toContain("repo: repo");
    expect(screen).not.toContain("Esc cancel");
    await press("p");
    expect(screen).toContain("> repo");
    await press("up");
    await press("return");
    expect(screen).toContain("repo: all repos");
    await press("s");
    expect(screen).toContain("> updated");
    await press("up");
    expect(screen).toContain("> priority");
    expect(screen).toContain("sort: updated");
    await press("escape");
    expect(screen).toContain("sort: updated");
    await press("s");
    await press("down");
    await press("return");
    expect(screen).toContain("sort: repository");
    // Dropdown colors must be independent of the selected session underneath.
    vi.stubEnv("NO_COLOR", undefined);
    for (const columns of [80, 160]) {
      output.columns = columns;
      for (const color of ["", "truecolor"]) {
        vi.stubEnv("COLORTERM", color);
        for (const name of ["p", "s"]) {
          await press(name);
          const overlayRows = screen.split(/\x1b\[\d+;\d+H/).slice(1);
          expect(overlayRows.length).toBeGreaterThan(0);
          const highlighted = overlayRows.filter((line) =>
            /\x1b\[(?:44;97|38;2;240;248;252;48;2;48;86;109)m/.test(line),
          );
          expect(highlighted).toHaveLength(1);
          expect(highlighted[0]).toContain(
            name === "p" ? "> All repositories" : "> repository",
          );
          expect(highlighted[0]).not.toContain("Up/Down");
          await press("escape");
          expect(screen).not.toContain("Esc cancel");
        }
      }
    }
    output.columns = 160;
    vi.stubEnv("NO_COLOR", "1");
    // Simulate returning after several hours, rather than incrementing a counter.
    vi.setSystemTime(new Date("2026-09-12T14:00:00Z"));
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("Clock");
    expect(readSessions).toHaveBeenCalledTimes(7);
    expect(screen).toContain("Last refresh 2026-09-12 14:01:00 UTC");
    input.emit("keypress", "/", { name: "/" });
    input.emit("keypress", "C", { name: "c" });
    await vi.advanceTimersByTimeAsync(0);
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    // Deferred refresh leaves the active search untouched.
    expect(screen).toBe("");
    expect(readSessions).toHaveBeenCalledTimes(7);
    input.emit("keypress", "", { name: "escape" });
    await vi.advanceTimersByTimeAsync(0);
    input.emit("keypress", "\r", { name: "return" });
    await vi.advanceTimersByTimeAsync(0);
    screen = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toContain("Started: 2026-09-12 09:00:00 UTC");
    expect(screen).toContain("Esc back");
    expect(readSessions).toHaveBeenCalledTimes(10);
    // A newer session must not steal selection or reset detail scrolling.
    output.rows = 10;
    input.emit("keypress", "", { name: "down" });
    await vi.advanceTimersByTimeAsync(0);
    screen = "";
    vi.mocked(readSessions).mockResolvedValue([
      session,
      { ...session, id: "new-session", taskSummary: "New arrival" },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(screen).toContain("Clock\r\n");
    expect(screen).not.toContain("New arrival");
    expect(screen).toMatch(/2-\d+\/\d+ \^ above v below/);
    vi.mocked(readSessions).mockRejectedValueOnce(
      new Error("temporary read failure"),
    );
    screen = "";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(screen).toContain("Refresh failed: temporary read failure");
    screen = "";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(screen).toContain("Clock\r\n");
    expect(screen).not.toContain("Refresh failed:");
    // Tab focuses the split pane; scrolling does not move the session list.
    output.rows = 30;
    const checklistSession = {
      ...session,
      tasks: editTasks([], {
        action: "add",
        titles: Array.from({ length: 20 }, (_, i) => `Checklist item ${i + 1}`),
      }),
    };
    vi.mocked(readSessions).mockResolvedValue([checklistSession]);
    await press("r");
    await press("escape");
    await press("tab");
    expect(screen).toContain("Selected item [focused]");
    await press("pagedown");
    expect(screen).toContain("^ above");
    expect(screen).toContain("1/1");
    const position = screen.match(/(\d+-\d+\/\d+) \^ above/)?.[1];
    expect(position).toBeTruthy();
    screen = "";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(screen).toContain(position!);
    expect(screen).toContain("Selected item [focused]");
    await press("end");
    expect(screen).not.toContain("v below");
    await press("home");
    expect(screen).not.toContain("^ above");
    await press("tab");
    expect(screen).toContain("Sessions  1/1 [focused]");
    // Compact terminals use the full detail screen with the same controls.
    output.columns = 80;
    await press("tab");
    expect(screen).toContain("Tab/Esc back");
    await press("pagedown");
    expect(screen).toContain("^ above");
    await press("tab");
    expect(screen).toContain("Enter for details");
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
