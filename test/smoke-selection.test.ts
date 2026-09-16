import { expect, it, vi } from "vitest";
// The launcher runs directly in Node before the TypeScript build.
// @ts-expect-error JavaScript launcher has no declaration file.
import { main as launch, selection } from "../smoke/run.mjs";

const report = vi.fn(async () => {});
const prepare = vi.fn(async () => ({
  env: { SESH_SMOKE_USAGE_DIR: "/usage", SESH_SMOKE_USAGE_RUN_ID: "run" },
  report,
}));
const main = (args: string[], env: NodeJS.ProcessEnv, execute: unknown) =>
  launch(args, env, execute, prepare);

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
])(
  "rejects invalid selection %j before launching any process",
  async (...args) => {
    const execute = vi.fn();
    await expect(await main(args, {}, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  },
);

it("routes only selected harnesses to Vitest and preserves safety settings", async () => {
  const execute = vi
    .fn()
    .mockReturnValueOnce({ status: 0 })
    .mockReturnValueOnce({ status: 7 });
  const env = {
    SESH_SMOKE_HOME: "/sandbox",
    SESH_SMOKE_BUDGET_CONFIRMED: "1",
    SESH_SMOKE_HARNESSES: "claude",
  };
  expect(await main(["--harness", "codex"], env, execute)).toBe(7);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalled();
  const [command, args, options] = execute.mock.calls[1]!;
  expect(command).toBe(process.execPath);
  expect(args.slice(1)).toEqual(["run", "--config", "smoke/vitest.config.ts"]);
  expect(options.env).toEqual({
    ...env,
    SESH_SMOKE_USAGE_DIR: "/usage",
    SESH_SMOKE_USAGE_RUN_ID: "run",
    SESH_SMOKE_HARNESSES: "codex",
    SESH_SMOKE_LIVE_CONFIRMED: "1",
  });
  expect(env.SESH_SMOKE_HARNESSES).toBe("claude");
});

it("opts Codex into live calls without requiring a separate home or budget flag", async () => {
  const execute = vi.fn().mockReturnValue({ status: 0 });
  expect(await main(["--harness", "codex"], {}, execute)).toBe(0);
  const env = execute.mock.calls[1]![2].env;
  expect(env.SESH_SMOKE_LIVE_CONFIRMED).toBe("1");
  expect(env.SESH_SMOKE_HOME).toBeUndefined();
  expect(env.SESH_SMOKE_BUDGET_CONFIRMED).toBeUndefined();
});

it("does not launch live tests after a failed build or add budget approval", async () => {
  const execute = vi.fn().mockReturnValue({ status: 2 });
  expect(await main(["--all"], {}, execute)).toBe(2);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    execute.mock.calls[0]![2].env.SESH_SMOKE_BUDGET_CONFIRMED,
  ).toBeUndefined();
});

it("shows help without building or calling providers", async () => {
  const execute = vi.fn();
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await main(["--help"], {}, execute)).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("--harness"));
  } finally {
    output.mockRestore();
  }
});

it("reports after a launcher error and preserves the failure", async () => {
  const report = vi.fn(async () => {});
  const execute = vi
    .fn()
    .mockReturnValueOnce({ status: 0 })
    .mockReturnValueOnce({ error: new Error("launch failed") });
  await expect(
    launch(["--harness", "codex"], {}, execute, async () => ({
      env: {},
      report,
    })),
  ).rejects.toThrow("Could not start the live smoke tests");
  expect(report).toHaveBeenCalledTimes(1);
});

it("does not let a reporting failure hide the test exit status", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const execute = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 7 });
    expect(
      await launch(["--harness", "codex"], {}, execute, async () => ({
        env: {},
        report: async () => {
          throw new Error("unreadable");
        },
      })),
    ).toBe(7);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("usage is unknown"),
    );
  } finally {
    output.mockRestore();
  }
});
