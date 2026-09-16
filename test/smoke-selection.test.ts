import { expect, it, vi } from "vitest";
// The launcher runs directly in Node before the TypeScript build.
// @ts-expect-error JavaScript launcher has no declaration file.
import { main, selection } from "../smoke/run.mjs";

it("selects one or several harnesses and lets explicit flags override the environment", () => {
  expect(
    selection(["--harness", "codex"], { SESH_SMOKE_HARNESSES: "claude" }),
  ).toEqual({ harnesses: ["codex"] });
  expect(selection(["--harness=codex,claude"])).toEqual({
    harnesses: ["codex", "claude"],
  });
  expect(selection(["--harness", "gemini", "--harness", "grok"])).toEqual({
    harnesses: ["gemini", "grok"],
  });
  expect(selection(["--all"], { SESH_SMOKE_HARNESSES: "codex" })).toEqual({
    harnesses: ["codex", "claude", "gemini", "grok"],
  });
  expect(selection([], { SESH_SMOKE_HARNESSES: "codex,gemini" })).toEqual({
    harnesses: ["codex", "gemini"],
  });
});

it.each([
  [],
  ["--harness"],
  ["--harness", "unknown"],
  ["--harness", "codex,"],
  ["--harness", "codex,codex"],
  ["--all", "--harness", "codex"],
  ["--unknown"],
  ["codex"],
])("rejects invalid selection %j before launching any process", (...args) => {
  const execute = vi.fn();
  expect(() => main(args, {}, execute)).toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("routes only selected harnesses to Vitest and preserves safety settings", () => {
  const execute = vi
    .fn()
    .mockReturnValueOnce({ status: 0 })
    .mockReturnValueOnce({ status: 7 });
  const env = {
    SESH_SMOKE_HOME: "/sandbox",
    SESH_SMOKE_BUDGET_CONFIRMED: "1",
    SESH_SMOKE_HARNESSES: "claude",
  };
  expect(main(["--harness", "codex"], env, execute)).toBe(7);
  expect(execute).toHaveBeenCalledTimes(2);
  const [command, args, options] = execute.mock.calls[1]!;
  expect(command).toBe(process.execPath);
  expect(args.slice(1)).toEqual(["run", "--config", "smoke/vitest.config.ts"]);
  expect(options.env).toEqual({ ...env, SESH_SMOKE_HARNESSES: "codex" });
  expect(env.SESH_SMOKE_HARNESSES).toBe("claude");
});

it("does not launch live tests after a failed build or add budget approval", () => {
  const execute = vi.fn().mockReturnValue({ status: 2 });
  expect(main(["--all"], {}, execute)).toBe(2);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    execute.mock.calls[0]![2].env.SESH_SMOKE_BUDGET_CONFIRMED,
  ).toBeUndefined();
});

it("shows help without building or calling providers", () => {
  const execute = vi.fn();
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(main(["--help"], {}, execute)).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("--harness"));
  } finally {
    output.mockRestore();
  }
});
