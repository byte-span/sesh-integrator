import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { run } from "../src/process.js";
import {
  spawnFailure,
  ExecutionOperationError,
  MissingWorkingDirectoryError,
} from "../src/execution-error.js";
import {
  reportExecutionFailure,
  requireCapabilities,
} from "../src/capabilities.js";
import { ensureRuntime, readConfig, writeConfig } from "../src/runtime.js";
import * as locations from "../src/worktree-location.js";

vi.mock("../src/worktree-location.js", async (original) => ({
  ...(await original<typeof import("../src/worktree-location.js")>()),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "sesh-status-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  vi.stubEnv("SESH_INTEGRATOR_HOME", runtime);
  await ensureRuntime();
  const caller = join(root, "caller");
  const historical = join(root, "historical");
  for (const repo of [caller, historical])
    expect((await run("git", ["init", "--quiet", repo])).code).toBe(0);
  const config = await readConfig();
  config.repositories = [caller, historical].map((path) => ({
    path,
    gitCommonDir: join(path, ".git"),
    defaultBranch: "main",
    integrationBranch: "staging",
    setupCommands: [],
    sourceValidationCommands: [],
    integrationValidationCommands: [],
    postIntegrationCommands: [],
    conflictInstructions: "",
  }));
  await writeConfig(config);
  const records = [historical, caller].map((repositoryPath, index) => ({
    id: `session_${index}`,
    repositoryId: `repo_${index}`,
    repositoryPath,
    worktreePath: repositoryPath,
    branch: "task",
    status: "active",
    startCommit: "base",
    integrationCommitAtStart: null,
    startedAt: `2026-09-0${index + 1}`,
    taskSummary: "retained task",
    dependsOn: [],
  }));
  for (const record of records)
    await fs.writeFile(
      join(runtime, "sessions", `${record.id}.json`),
      JSON.stringify(record),
    );
  vi.spyOn(process, "cwd").mockReturnValue(caller);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  return { root, runtime, caller, historical, records, stdout, stderr };
}
async function reports(runtime: string) {
  const directory = join(runtime, "capabilities");
  const names = await fs.readdir(directory).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  return Promise.all(
    names
      .filter((n) => n.endsWith(".report.json"))
      .map(async (n) =>
        JSON.parse(await fs.readFile(join(directory, n), "utf8")),
      ),
  );
}
it("continues broad and selected status after a missing historical checkout, retaining records and existing stops", async () => {
  const f = await fixture();
  await fs.rm(f.historical, { recursive: true });
  await reportExecutionFailure(
    Object.assign(new Error("denied"), { code: "EPERM", syscall: "rename" }),
    "begin",
  );
  const before = await reports(f.runtime);
  await main(["status"]);
  expect(f.stdout.mock.calls.flat().join("")).toContain("session_1  active");
  expect(f.stdout.mock.calls.flat().join("")).toContain("Locks:");
  expect(f.stderr.mock.calls.flat().join("")).toContain(
    "working directory is missing",
  );
  expect(f.stdout.mock.calls.flat().join("")).toContain(
    "unavailable (historical checkout missing)",
  );
  await main(["status", "--session", "session_0"]);
  expect(await reports(f.runtime)).toEqual(before);
  for (const record of f.records)
    expect(
      await fs.readFile(
        join(f.runtime, "sessions", `${record.id}.json`),
        "utf8",
      ),
    ).toBe(JSON.stringify(record));
});
it("does not probe a historical checkout when the session already records its integration path", async () => {
  const f = await fixture();
  await fs.rm(f.historical, { recursive: true });
  await fs.writeFile(
    join(f.runtime, "sessions", "session_0.json"),
    JSON.stringify({
      ...f.records[0],
      integrationWorktreePath: "/retained/integration",
    }),
  );
  await main(["status"]);
  expect(f.stderr).not.toHaveBeenCalled();
  expect(f.stdout.mock.calls.flat().join("")).toContain(
    "/retained/integration",
  );
  expect(await reports(f.runtime)).toEqual([]);
});
it.each(["EACCES", "EPERM", "EROFS"])(
  "fails closed and attributes historical %s to the inspected repository",
  async (code) => {
    const f = await fixture();
    const original = locations.worktreePaths;
    vi.spyOn(locations, "worktreePaths").mockImplementation(async (cwd) => {
      if (cwd === f.historical)
        throw spawnFailure(
          "git",
          cwd,
          Object.assign(new Error("execution denied"), {
            code,
            syscall: "spawn git",
            path: "git",
          }),
        );
      return original(cwd);
    });
    await expect(main(["status"])).rejects.toThrow("execution denied");
    const saved = await reports(f.runtime);
    expect(saved).toHaveLength(1);
    expect(saved[0].scope).toBe(join(f.historical, ".git"));
    expect(saved[0].failures[0]).toMatchObject({
      operation: "inspect session worktree location",
      location: f.historical,
    });
    await expect(requireCapabilities(f.historical)).rejects.toThrow(
      "Previous capability failure retained",
    );
    await expect(requireCapabilities(f.caller)).resolves.toBeUndefined();
  },
);
it("keeps Git permission exit errors scoped to historical inspection", async () => {
  const f = await fixture();
  vi.spyOn(locations, "worktreePaths").mockRejectedValue(
    new Error("fatal: detected dubious ownership in repository"),
  );
  await expect(main(["status"])).rejects.toThrow("dubious ownership");
  expect((await reports(f.runtime))[0].scope).toBe(join(f.historical, ".git"));
});
it("distinguishes a missing cwd, a non-directory cwd, and an unavailable executable", async () => {
  const f = await fixture();
  const missing = await run("git", ["status"], {
    cwd: join(f.root, "absent"),
  }).catch((e) => e);
  expect(missing).toBeInstanceOf(MissingWorkingDirectoryError);
  await reportExecutionFailure(missing, "status");
  const file = join(f.root, "file");
  await fs.writeFile(file, "file");
  expect(await run("git", [], { cwd: file }).catch((e) => e)).toBeInstanceOf(
    MissingWorkingDirectoryError,
  );
  expect(await reports(f.runtime)).toEqual([]);
  const executable = await run(join(f.root, "missing-git"), [], {
    cwd: f.historical,
  }).catch((e) => e);
  expect(executable).toBeInstanceOf(ExecutionOperationError);
  expect(executable).not.toBeInstanceOf(MissingWorkingDirectoryError);
  expect(executable.message).toContain("executable or interpreter unavailable");
  await reportExecutionFailure(executable, "status");
  expect((await reports(f.runtime))[0].scope).toBe(join(f.historical, ".git"));
  await expect(requireCapabilities(f.historical)).rejects.toThrow(
    "Previous capability failure retained",
  );
});
it("does not swallow a missing Git executable during current repository discovery", async () => {
  const f = await fixture();
  vi.stubEnv("PATH", join(f.root, "empty-path"));
  await expect(main(["status"])).rejects.toThrow(
    "executable or interpreter unavailable",
  );
  expect((await reports(f.runtime))[0].scope).toBe(join(f.caller, ".git"));
});
it("groups aggregate failures by their inspected repositories", async () => {
  const f = await fixture();
  const errors = [f.caller, f.historical].map((cwd) =>
    spawnFailure(
      "git",
      cwd,
      Object.assign(new Error("denied"), {
        code: "EACCES",
        syscall: "spawn git",
      }),
    ),
  );
  await reportExecutionFailure(new AggregateError(errors), "status");
  expect((await reports(f.runtime)).map((r) => r.scope).sort()).toEqual(
    [join(f.caller, ".git"), join(f.historical, ".git")].sort(),
  );
});

it("does not classify a denied cwd inspection as a missing historical checkout", async () => {
  const f = await fixture();
  vi.spyOn(syncFs, "statSync").mockImplementation(() => {
    throw Object.assign(new Error("denied inspection"), {
      code: "EACCES",
      syscall: "stat",
    });
  });
  const error = spawnFailure(
    "git",
    f.historical,
    Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      syscall: "spawn git",
    }),
  );
  expect(error).not.toBeInstanceOf(MissingWorkingDirectoryError);
  await reportExecutionFailure(error, "status");
  const saved = await reports(f.runtime);
  expect(saved[0].scope).toBe(join(f.historical, ".git"));
  expect(
    saved[0].failures.some((f: { evidence: string }) =>
      f.evidence.includes("EACCES"),
    ),
  ).toBe(true);
});
