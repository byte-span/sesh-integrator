import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { watchDashboard } from "../src/dashboard-watch.js";

vi.mock("node:fs", () => ({ watch: vi.fn() }));
vi.mock("../src/runtime.js", () => ({
  runtimePaths: () => ({
    root: "/runtime",
    config: "/runtime/config.json",
    sessions: "/runtime/sessions",
  }),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("batches atomic replacements, filters unrelated files, recovers watchers, and closes everything", async () => {
  vi.useFakeTimers();
  const handles: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = [];
  vi.mocked(watch).mockImplementation((() => {
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
    handles.push(handle);
    return handle;
  }) as unknown as typeof watch);
  const changed = vi.fn();
  const stop = watchDashboard(changed);
  try {
    const rootEvent = vi.mocked(watch).mock.calls[0]![2] as unknown as (
      event: string,
      name: string,
    ) => void;
    const sessionEvent = vi.mocked(watch).mock
      .calls[1]![2] as unknown as typeof rootEvent;
    rootEvent("rename", "logs");
    await vi.advanceTimersByTimeAsync(150);
    expect(changed).not.toHaveBeenCalled();
    sessionEvent("rename", "session.json");
    sessionEvent("change", "session.json");
    rootEvent("rename", "config.json");
    await vi.advanceTimersByTimeAsync(150);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(handles[0]!.close).toHaveBeenCalled();
    handles.at(-1)!.emit("error", new Error("watch unavailable"));
    await vi.advanceTimersByTimeAsync(150);
    expect(changed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changed).toHaveBeenCalledTimes(3);
    sessionEvent("rename", "session.json");
  } finally {
    stop();
  }
  expect(handles.every((handle) => handle.close.mock.calls.length > 0)).toBe(
    true,
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the fallback when directories are missing and retries attaching", async () => {
  vi.useFakeTimers();
  vi.mocked(watch).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  const changed = vi.fn();
  const stop = watchDashboard(changed);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(4);
  } finally {
    stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});
