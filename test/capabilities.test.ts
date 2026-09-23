import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as processTools from "../src/process.js";
import {
  capabilitiesCommand,
  executionContext,
  probeCapabilities,
  requireCapabilities,
  reportExecutionFailure,
} from "../src/capabilities.js";
import { ensureRuntime, readConfig, writeConfig } from "../src/runtime.js";
import { retainCoordinator } from "../src/coordinator.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("../src/process.js", async (original) => ({
  ...(await original<typeof import("../src/process.js")>()),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "sesh-capabilities-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", join(root, "runtime"));
  await ensureRuntime();
  const repo = join(root, "repo");
  await fs.mkdir(repo);
  const result = await processTools.run("git", ["init", "--quiet", repo]);
  expect(result.code).toBe(0);
  await fs.writeFile(join(repo, "user-work.txt"), "preserve me");
  return { root, repo };
}
function denied(code = "EPERM", syscall = "rename") {
  return Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
}

it("probes files, directories and Git/worktrees without changing user state or requiring signing", async () => {
  const { root, repo } = await fixture();
  const gitConfig = join(root, "gitconfig");
  await fs.writeFile(
    gitConfig,
    "[commit]\n gpgSign = true\n[gpg]\n program = nonexistent-signing-program\n",
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
  const before = await fs.readdir(join(repo, ".git"));
  const report = await probeCapabilities(repo);
  expect(report.failures).toEqual([]);
  expect(report.artifacts).toEqual([]);
  expect(await fs.readdir(join(repo, ".git"))).toEqual(before);
  expect(await fs.readFile(join(repo, "user-work.txt"), "utf8")).toBe(
    "preserve me",
  );
  expect(await fs.readdir(join(root, "runtime", "worktrees"))).toEqual([]);
  expect(await fs.readFile(gitConfig, "utf8")).toContain("gpgSign = true");
});

it("keeps directory-rename evidence alongside failed cleanup and lists owned artifacts", async () => {
  const { repo } = await fixture();
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith("-renamed")) throw denied();
    return rename(from, to);
  });
  vi.spyOn(fs, "rm").mockRejectedValue(denied("EACCES", "rmdir"));
  const report = await probeCapabilities(repo);
  expect(
    report.failures.some(
      (f) => f.operation === "rename directory" && f.evidence.includes("EPERM"),
    ),
  ).toBe(true);
  expect(
    report.failures.some(
      (f) =>
        f.operation === "cleanup disposable directory" &&
        f.evidence.includes("EACCES"),
    ),
  ).toBe(true);
  expect(report.artifacts.length).toBeGreaterThan(0);
  expect(
    report.failures.every((f) =>
      f.evidence.includes("not established diagnoses"),
    ),
  ).toBe(true);
  for (const path of report.artifacts)
    expect((await fs.stat(path)).isDirectory()).toBe(true);
});

it("retains failed readiness without repeating probes, then rechecks explicitly", async () => {
  const { repo } = await fixture();
  const rename = fs.rename;
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith("-renamed")) throw denied("EROFS");
    return rename(from, to);
  });
  await expect(requireCapabilities(repo)).rejects.toThrow(
    "EROFS: filesystem reported a read-only location",
  );
  spy.mockRestore();
  const mkdir = vi.spyOn(fs, "mkdtemp");
  await expect(requireCapabilities(repo)).rejects.toThrow("no probe repeated");
  expect(mkdir).not.toHaveBeenCalled();
  expect((await capabilitiesCommand(["--recheck"], repo))?.failures).toEqual(
    [],
  );
  await expect(requireCapabilities(repo)).resolves.toBeUndefined();
});

it("persists manual choice and keeps it on recheck; changed contexts are independent", async () => {
  const { repo } = await fixture();
  await capabilitiesCommand(["--mode", "manual"], repo);
  const mkdir = vi.spyOn(fs, "mkdtemp");
  await expect(requireCapabilities(repo)).rejects.toThrow(
    "Manual handoff mode",
  );
  expect(mkdir).not.toHaveBeenCalled();
  await capabilitiesCommand(["--recheck"], repo);
  await expect(requireCapabilities(repo)).rejects.toThrow(
    "Manual handoff mode",
  );
  const old = executionContext();
  vi.stubEnv("SESH_EXECUTION_CONTEXT", "authorized-terminal");
  expect(executionContext()).not.toBe(old);
  await expect(requireCapabilities(repo)).resolves.toBeUndefined();
  vi.unstubAllEnvs(); // Restore the first context but keep the fixture runtime.
  vi.stubEnv("SESH_INTEGRATOR_HOME", join(roots[0]!, "runtime"));
  await expect(requireCapabilities(repo)).rejects.toThrow(
    "Manual handoff mode",
  );
  await capabilitiesCommand(["--mode", "automatic"], repo);
  await expect(requireCapabilities(repo)).resolves.toBeUndefined();
});

it("preserves opt-outs and never probes a disabled repository", async () => {
  const { repo } = await fixture();
  const config = await readConfig();
  config.disabledRepositories = [join(repo, ".git")];
  await writeConfig(config);
  const mkdir = vi.spyOn(fs, "mkdtemp");
  await expect(requireCapabilities(repo)).rejects.toThrow("disabled");
  expect((await probeCapabilities(repo)).skipped).toContain("disabled");
  expect(mkdir).not.toHaveBeenCalled();
});

it("reports Git protection and missing dependency evidence without diagnosing a sandbox", async () => {
  const { repo } = await fixture();
  const spy = vi.spyOn(processTools, "run").mockResolvedValue({
    code: 128,
    stdout: "",
    stderr: "fatal: detected dubious ownership in repository",
  });
  expect((await probeCapabilities(repo)).failures[0]?.evidence).toContain(
    "dubious ownership",
  );
  spy.mockRejectedValue(
    Object.assign(denied("ENOENT", "spawn git"), { path: "git" }),
  );
  expect((await probeCapabilities(repo)).failures[0]?.evidence).toContain(
    "executable was not found",
  );
});

it("identifies a Git metadata write failure in the disposable fixture", async () => {
  const { repo } = await fixture();
  const run = processTools.run;
  vi.spyOn(processTools, "run").mockImplementation(
    async (command, args, options) =>
      args.includes("read-tree")
        ? {
            code: 128,
            stdout: "",
            stderr: "fatal: Unable to create index.lock: Permission denied",
          }
        : run(command, args, options),
  );
  const report = await probeCapabilities(repo);
  expect(report.failures).toHaveLength(1);
  expect(report.failures[0]?.operation).toBe("git index write");
  expect(report.artifacts).toEqual([]);
});

it("preserves original coordinator copy failure and failed snapshot cleanup", async () => {
  await fixture();
  const original = denied("EACCES", "copyfile");
  vi.spyOn(fs, "cp").mockRejectedValue(original);
  vi.spyOn(fs, "rm").mockRejectedValue(denied("EPERM", "rmdir"));
  const error = await retainCoordinator().catch((e) => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.cause).toBe(original);
  expect(error.message).toContain("EACCES: copyfile");
  expect(error.message).toContain("Coordinator snapshot cleanup");
  expect(error.message).toContain(".install-");
  expect(error.errors[1].cause.code).toBe("EPERM");
});

it("preserves original coordinator rename failure even when recursive cleanup fails", async () => {
  await fixture();
  const original = denied("EPERM", "rename");
  vi.spyOn(fs, "rename").mockRejectedValue(original);
  vi.spyOn(fs, "rm").mockRejectedValue(denied("EACCES", "rmdir"));
  const error = await retainCoordinator().catch((e) => e);
  expect(error.cause).toBe(original);
  expect(error.message).toContain("EPERM: rename");
  expect(error.message).toContain("EACCES: rmdir");
});

it("retains cleanup artifacts across later successful rechecks", async () => {
  const { repo } = await fixture();
  const remove = vi.spyOn(fs, "rm").mockRejectedValue(denied("EPERM", "rmdir"));
  const failed = await capabilitiesCommand(["--recheck"], repo);
  expect(failed?.artifacts.length).toBeGreaterThan(0);
  remove.mockRestore();
  const passed = await capabilitiesCommand(["--recheck"], repo);
  expect(passed?.failures).toEqual([]);
  expect(passed?.artifacts).toEqual(failed?.artifacts);
});

it("blocks an existing session before mutation and recovers the same session after an explicit choice", async () => {
  const { root, repo } = await fixture();
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "empty-gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  async function git(args: string[]) {
    const result = await processTools.run("git", args, { cwd: repo });
    expect(result.code, result.stderr).toBe(0);
  }
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["add", "user-work.txt"]);
  await git(["-c", "commit.gpgSign=false", "commit", "-m", "base"]);
  const cli = join(process.cwd(), "dist", "cli.js");
  async function command(args: string[], cwd = repo, expected = 0) {
    const result = await processTools.run(process.execPath, [cli, ...args], {
      cwd,
    });
    expect(result.code, result.stdout + result.stderr).toBe(expected);
    return result.stdout + result.stderr;
  }
  await command(["worktree-location", "--repo-local"]);
  await command(["register"]);
  await command([
    "begin",
    "--create-worktree",
    "--summary",
    "existing session",
  ]);
  const sessionPath = join(
    root,
    "runtime",
    "sessions",
    (await fs.readdir(join(root, "runtime", "sessions"))).find((n) =>
      n.endsWith(".json"),
    )!,
  );
  const before = await fs.readFile(sessionPath, "utf8");
  const session = JSON.parse(before);
  expect(session.worktreePath).toContain(
    join(repo, ".worktrees", "source-worktrees"),
  );
  expect(
    await command(
      ["worktree-location", "--directory", join(root, "other")],
      repo,
      1,
    ),
  ).toContain("finish it before changing");
  expect(
    await command(
      ["worktree-location", "--repo-local"],
      session.worktreePath,
      1,
    ),
  ).toContain("main checkout");
  await command(["capabilities", "--mode", "manual"]);
  expect(await command(["validate"], session.worktreePath, 1)).toContain(
    "Manual handoff mode",
  );
  expect(await command(["resume", "--session", session.id], repo, 1)).toContain(
    "Manual handoff mode",
  );
  expect(await fs.readFile(sessionPath, "utf8")).toBe(before);
  expect(await command(["status", "--session", session.id])).toContain(
    session.id,
  );
  await command(["capabilities", "--mode", "automatic"], session.worktreePath);
  await command(["capabilities", "--recheck"], session.worktreePath);
  vi.stubEnv("PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK", "1");
  const config = await readConfig();
  const allow = join(root, "allow-validation");
  config.repositories[0]!.integrationValidationCommands = [
    [
      process.execPath,
      "-e",
      `process.exit(require('fs').existsSync(${JSON.stringify(allow)}) ? 0 : 1)`,
    ],
  ];
  await writeConfig(config);
  await fs.writeFile(join(session.worktreePath, "task.txt"), "task\n");
  await git(["-C", session.worktreePath, "add", "task.txt"]);
  await command(["commit", "--message", "task"], session.worktreePath);
  await command(
    ["integrate", "--summary", "task", "--rollout", "none"],
    session.worktreePath,
    1,
  );
  const pending = await fs.readFile(sessionPath, "utf8");
  expect(JSON.parse(pending).status).toBe("validation_pending");
  await command(["capabilities", "--mode", "manual"], session.worktreePath);
  expect(await command(["resume"], session.worktreePath, 1)).toContain(
    "Manual handoff mode",
  );
  expect(await fs.readFile(sessionPath, "utf8")).toBe(pending);
  await fs.writeFile(allow, "allow\n");
  await command(["capabilities", "--mode", "automatic"], session.worktreePath);
  await command(["capabilities", "--recheck"], session.worktreePath);
  await command(["resume"], session.worktreePath);
  const finished = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  expect(finished.id).toBe(session.id);
  expect(finished.status).toBe("succeeded");
  expect(finished.integrationWorktreePath).toContain(
    join(repo, ".worktrees", "recovery-worktrees"),
  );
  expect(finished.coordinator).toEqual(session.coordinator);
  expect(finished.readyCommit).toBe(JSON.parse(pending).readyCommit);
  expect(await fs.readFile(join(repo, "task.txt"), "utf8")).toBe("task\n");
});

it("persists late denial evidence without changing the original error or session state", async () => {
  const { repo } = await fixture();
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  const primary = Object.assign(denied("EPERM", "rename"), {
    path: join(repo, ".git", "metadata"),
  });
  const cleanup = Object.assign(denied("EACCES", "rmdir"), {
    path: join(repo, "owned-temp"),
  });
  const combined = new AggregateError(
    [primary, cleanup],
    "primary plus cleanup",
    { cause: primary },
  );
  await reportExecutionFailure(combined, "begin");
  await expect(requireCapabilities(repo)).rejects.toThrow(primary.path);
  await expect(requireCapabilities(repo)).rejects.toThrow(cleanup.path);
  expect(combined.cause).toBe(primary);
  expect(await fs.readdir(join(roots[0]!, "runtime", "sessions"))).toEqual([]);
});

it("checks planned installation locations before writing guidance", async () => {
  const { root, repo } = await fixture();
  const guidance = join(root, "harness-guidance");
  await fs.mkdir(guidance);
  const make = fs.mkdtemp;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    if (String(prefix).startsWith(guidance)) throw denied("EACCES", "mkdir");
    return make(prefix, options as never);
  });
  const report = await probeCapabilities(repo, [guidance]);
  expect(report.failures).toEqual([
    expect.objectContaining({
      operation: "create disposable directory",
      location: guidance,
    }),
  ]);
  expect(await fs.readdir(guidance)).toEqual([]);
});

it("uses an explicitly selected repository-local root and preserves exclusions and manual mode", async () => {
  const { root, repo } = await fixture();
  const { worktreeLocationCommand, worktreePaths } =
    await import("../src/worktree-location.js");
  const exclude = join(repo, ".git", "info", "exclude");
  await fs.writeFile(exclude, "# user rule\nprivate.txt\n");
  await capabilitiesCommand(["--mode", "manual"], repo);
  await worktreeLocationCommand(["--repo-local"], repo);
  await worktreeLocationCommand(["--repo-local"], repo);
  expect(await fs.readFile(exclude, "utf8")).toBe(
    "# user rule\nprivate.txt\n/.worktrees/\n",
  );
  const paths = await worktreePaths(repo);
  expect(paths.sourceWorktrees).toBe(
    join(repo, ".worktrees", "source-worktrees"),
  );
  const make = fs.mkdtemp;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    if (String(prefix).startsWith(join(root, "runtime", "worktrees")))
      throw denied();
    return make(prefix, options as never);
  });
  expect((await probeCapabilities(repo)).failures).toEqual([]);
  await expect(requireCapabilities(repo)).rejects.toThrow(
    "Manual handoff mode",
  );
  for (const directory of [
    paths.sourceWorktrees,
    paths.worktrees,
    paths.recoveryWorktrees,
  ])
    expect(await fs.readdir(directory)).toEqual([]);
});

it("does not mistake a writable alternative for writable shared Git metadata", async () => {
  const { repo } = await fixture();
  const { worktreeLocationCommand } =
    await import("../src/worktree-location.js");
  await worktreeLocationCommand(["--repo-local"], repo);
  const make = fs.mkdtemp;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    if (String(prefix).startsWith(join(repo, ".git"))) throw denied("EACCES");
    return make(prefix, options as never);
  });
  const report = await probeCapabilities(repo);
  expect(report.failures).toContainEqual(
    expect.objectContaining({ location: join(repo, ".git") }),
  );
});

it("installer readiness respects saved stops without repeating probes", async () => {
  const { repo } = await fixture();
  const { installationReadiness } = await import("../src/capabilities.js");
  await capabilitiesCommand(["--mode", "manual"], repo);
  const make = vi.spyOn(fs, "mkdtemp");
  await installationReadiness(repo);
  expect(make).not.toHaveBeenCalled();
});

it("reports a denied selected destination without silently choosing another", async () => {
  const { repo } = await fixture();
  const { worktreeLocationCommand } =
    await import("../src/worktree-location.js");
  await worktreeLocationCommand(["--repo-local"], repo);
  const destination = join(repo, ".worktrees", "source-worktrees");
  const mkdir = fs.mkdir;
  vi.spyOn(fs, "mkdir").mockImplementation(async (path, options) => {
    if (String(path) === destination) throw denied("EACCES");
    return mkdir(path, options as never);
  });
  const report = await probeCapabilities(repo);
  expect(report.failures).toContainEqual(
    expect.objectContaining({
      operation: "prepare worktree directory",
      location: destination,
    }),
  );
  const selected = await processTools.run(
    "git",
    ["config", "--local", "--get", "sesh.worktreeRoot"],
    { cwd: repo },
  );
  expect(selected.stdout.trim()).toBe(join(repo, ".worktrees"));
});

it("rejects metadata, parent, tracked, and symlinked unsafe locations", async () => {
  const { root, repo } = await fixture();
  const { worktreeLocationCommand } =
    await import("../src/worktree-location.js");
  for (const path of [
    root,
    repo,
    join(repo, ".git", "nested"),
    join(repo, "..", "repo", ".git", "nested"),
  ])
    await expect(
      worktreeLocationCommand(["--directory", path], repo),
    ).rejects.toThrow("dedicated worktree directory");
  await fs.symlink(join(repo, ".git"), join(repo, "metadata-link"), "dir");
  await expect(
    worktreeLocationCommand(
      ["--directory", join(repo, "metadata-link", "nested")],
      repo,
    ),
  ).rejects.toThrow("outside Git metadata");
  await processTools.run("git", ["add", "user-work.txt"], { cwd: repo });
  await expect(
    worktreeLocationCommand(["--directory", join(repo, "user-work.txt")], repo),
  ).rejects.toThrow("tracked files");
});
