import { execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordValidationCache } from "../src/cache.js";
import { commandFingerprint } from "../src/process.js";
import {
  planSourceReuse,
  queueBypassWithReuse,
  treeDifference,
} from "../src/target-move-reuse.js";
import type { Command, RepositoryConfig, Session } from "../src/types.js";

interface Fixture {
  root: string;
  repo: string;
  runtime: string;
  home: string;
  log: string;
  validator: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ValidationRun {
  label: string;
  tree: string;
}

const cli =
  process.env.PARALLEL_INTEGRATOR_TEST_CLI ??
  join(process.cwd(), "dist", "cli.js");
// Optionally check that a real older coordinator (for example an installed
// release's dist/cli.js) accepts a configuration that sets the opt-in.
const legacyCli = process.env.SESH_INTEGRATOR_TEST_LEGACY_CLI;
const temporaryRoots: string[] = [];
const TIMEOUT = 120_000;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential("source validation reuse across target movement", () => {
  it(
    "reuses source results when the target moved only by TASKS.json changes",
    async () => {
      const fixture = await createFixture(true);
      const task = await validatedCodeSession(fixture);

      // Another session moves the target by a task-register change only.
      const mover = await addWorktree(fixture, "register-update");
      await runCliOk(fixture, mover, ["begin", "--summary", "register"]);
      commitFile(mover, "TASKS.json", '{ "tasks": ["moved"] }\n', "register");
      await runCliOk(fixture, mover, ["validate"]);
      await runCliOk(fixture, mover, ["integrate", "--summary", "register"]);
      const movedTarget = git(fixture.repo, "rev-parse", "main");

      const before = (await validationRuns(fixture)).length;
      const integration = await runCliOk(fixture, task.worktree, [
        "integrate",
        "--summary",
        "code done",
      ]);
      const merged = git(fixture.repo, "rev-parse", "main^{tree}");
      expect(merged).not.toBe(task.sourceTree);
      expect(ancestor(fixture, movedTarget, "main")).toBe(true);
      expect(ancestor(fixture, task.readyCommit, "main")).toBe(true);

      // The tier's commands and the integration-only build ran on the merged
      // tree; the session's other source results were reused.
      const runs = (await validationRuns(fixture)).slice(before);
      expect(runs).toEqual([
        { label: "tasks", tree: merged },
        { label: "build", tree: merged },
      ]);
      expect(integration.stdout).toContain(
        "Source validation reuse: the merged tree differs from the validated source tree only in task-register paths (1 path(s): TASKS.json)",
      );
      for (const label of ["lint", "unit"])
        expect(integration.stdout).toMatch(
          new RegExp(
            `Reusing source validation: \\S+ \\S+ \\S+ ${label} \\(target moved only by task-register paths\\)`,
          ),
        );
      expect(integration.stdout).toContain("Running validation:");
      const metrics = await integrateMetrics(fixture, task.worktree);
      expect(metrics).toMatchObject({
        integrationSourceReuse: "applied",
        integrationSourceReuseTier: "task-register",
        integrationSourceReuseDifferingPaths: 1,
        integrationSourceReusedCommands: 2,
        integrationValidationCommandsRun: 2,
      });
      expect(metrics.integrationSourceReusedCommandList).toMatch(
        /lint; .*unit$/,
      );
      // Reused results are never recorded as verified for the merged tree.
      const session = await sessionFor(fixture, task.worktree);
      expect(session.status).toBe("succeeded");
      const mergedEntries = session.validationCacheEntries
        .filter((entry: any) => entry.tree === merged)
        .map((entry: any) => entry.command.at(-1));
      expect(mergedEntries.sort()).toEqual(["build", "tasks"]);
    },
    TIMEOUT,
  );

  it(
    "reruns every command when the target moved by a code change",
    async () => {
      const fixture = await createFixture(true);
      const task = await validatedCodeSession(fixture);
      commitFile(fixture.repo, "other.txt", "other code\n", "move target");

      const before = (await validationRuns(fixture)).length;
      const integration = await runCliOk(fixture, task.worktree, [
        "integrate",
        "--summary",
        "code done",
      ]);
      const merged = git(fixture.repo, "rev-parse", "main^{tree}");
      expect(await runLabels(fixture, before, merged)).toEqual([
        "build",
        "lint",
        "unit",
      ]);
      expect(integration.stdout).toContain(
        "Source validation reuse skipped: the merged tree differs from the validated source tree outside any single validation tier (1 path(s): other.txt)",
      );
      expect(integration.stdout).not.toContain("Reusing source validation:");
      expect(await integrateMetrics(fixture, task.worktree)).toMatchObject({
        integrationSourceReuse: "skipped",
        integrationSourceReuseDifferingPaths: 1,
        integrationValidationCommandsRun: 3,
      });
    },
    TIMEOUT,
  );

  it(
    "reruns every command when the target moved by TASKS.json and code together",
    async () => {
      const fixture = await createFixture(true);
      const task = await validatedCodeSession(fixture);
      await writeFile(join(fixture.repo, "TASKS.json"), '{ "tasks": [1] }\n');
      await writeFile(join(fixture.repo, "other.txt"), "other code\n");
      git(fixture.repo, "add", "TASKS.json", "other.txt");
      git(fixture.repo, "commit", "-m", "mixed target movement");

      const before = (await validationRuns(fixture)).length;
      const integration = await runCliOk(fixture, task.worktree, [
        "integrate",
        "--summary",
        "code done",
      ]);
      const merged = git(fixture.repo, "rev-parse", "main^{tree}");
      expect(await runLabels(fixture, before, merged)).toEqual([
        "build",
        "lint",
        "unit",
      ]);
      expect(integration.stdout).toContain(
        "outside any single validation tier (2 path(s): TASKS.json, other.txt)",
      );
      expect(integration.stdout).not.toContain("Reusing source validation:");
      expect(await integrateMetrics(fixture, task.worktree)).toMatchObject({
        integrationSourceReuse: "skipped",
        integrationSourceReuseDifferingPaths: 2,
      });
    },
    TIMEOUT,
  );

  it(
    "reruns every command for a matching tier without the opt-in",
    async () => {
      const fixture = await createFixture(false);
      const task = await validatedCodeSession(fixture);
      commitFile(fixture.repo, "TASKS.json", '{ "tasks": [2] }\n', "register");

      const before = (await validationRuns(fixture)).length;
      const integration = await runCliOk(fixture, task.worktree, [
        "integrate",
        "--summary",
        "code done",
      ]);
      const merged = git(fixture.repo, "rev-parse", "main^{tree}");
      expect(await runLabels(fixture, before, merged)).toEqual([
        "build",
        "lint",
        "unit",
      ]);
      expect(integration.stdout).toContain(
        "but tier task-register does not set reuseSourceValidationOnTargetMove",
      );
      expect(integration.stdout).not.toContain("Reusing source validation:");
      expect(await integrateMetrics(fixture, task.worktree)).toMatchObject({
        integrationSourceReuse: "skipped",
        integrationSourceReuseTier: "task-register",
      });
    },
    TIMEOUT,
  );

  it(
    "reruns every command when validationCache is off",
    async () => {
      const fixture = await createFixture(true);
      await updateConfig(fixture, (config) => {
        config.repositories[0].validationCache = "off";
      });
      const task = await validatedCodeSession(fixture);
      commitFile(fixture.repo, "TASKS.json", '{ "tasks": [3] }\n', "register");

      const before = (await validationRuns(fixture)).length;
      const integration = await runCliOk(fixture, task.worktree, [
        "integrate",
        "--summary",
        "code done",
      ]);
      const merged = git(fixture.repo, "rev-parse", "main^{tree}");
      expect(await runLabels(fixture, before, merged)).toEqual([
        "build",
        "lint",
        "unit",
      ]);
      expect(integration.stdout).toContain(
        "Source validation reuse skipped: validationCache is off",
      );
    },
    TIMEOUT,
  );

  it(
    "rejects invalid opt-in values and older coordinators accept the key",
    async () => {
      const fixture = await createFixture(true);
      for (const value of ["yes", 1, null]) {
        await updateConfig(fixture, (config) => {
          config.repositories[0].validationTiers[0].reuseSourceValidationOnTargetMove =
            value;
        });
        const result = await runCli(fixture, fixture.repo, ["status"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          "Invalid reuseSourceValidationOnTargetMove for validation tier task-register",
        );
      }
      for (const value of [true, false]) {
        await updateConfig(fixture, (config) => {
          config.repositories[0].validationTiers[0].reuseSourceValidationOnTargetMove =
            value;
        });
        await runCliOk(fixture, fixture.repo, ["status"]);
        if (legacyCli) {
          const legacy = await runCli(
            fixture,
            fixture.repo,
            ["status"],
            legacyCli,
          );
          expect(legacy.code, legacy.stdout + legacy.stderr).toBe(0);
        }
      }
    },
    TIMEOUT,
  );

  it("lists both sides of renames and exact path names between trees", async () => {
    const fixture = await createFixture(true);
    await writeFile(join(fixture.repo, "code.txt"), "code\n");
    git(fixture.repo, "add", "code.txt");
    git(fixture.repo, "commit", "-m", "code");
    const before = git(fixture.repo, "rev-parse", "HEAD^{tree}");
    git(fixture.repo, "rm", "-q", "TASKS.json");
    git(fixture.repo, "mv", "code.txt", "TASKS.json");
    await writeFile(join(fixture.repo, " TASKS.json"), "spaced\n");
    git(fixture.repo, "add", " TASKS.json");
    git(fixture.repo, "commit", "-m", "rename code into the register");
    const after = git(fixture.repo, "rev-parse", "HEAD^{tree}");
    expect(await treeDifference(fixture.repo, before, after)).toEqual([
      " TASKS.json",
      "TASKS.json",
      "code.txt",
    ]);
  });
});

describe("source reuse planning", () => {
  const lint: Command = ["check", "lint"];
  const unit: Command = ["check", "unit"];
  const build: Command = ["check", "build"];
  const tasks: Command = ["check", "tasks"];

  async function planFor(
    tiers: RepositoryConfig["validationTiers"],
    moved: string,
    sessionPatch: Partial<Session> = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "sesh-reuse-plan-"));
    temporaryRoots.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "commit.gpgSign", "false");
    await writeFile(join(root, "code.txt"), "code\n");
    git(root, "add", "code.txt");
    git(root, "commit", "-q", "-m", "source");
    const readyCommit = git(root, "rev-parse", "HEAD");
    const sourceTree = git(root, "rev-parse", "HEAD^{tree}");
    await writeFile(join(root, moved), "moved\n");
    git(root, "add", moved);
    git(root, "commit", "-q", "-m", "target movement");
    const mergedTree = git(root, "rev-parse", "HEAD^{tree}");
    const repository = {
      path: root,
      gitCommonDir: join(root, ".git"),
      validationCache: "session",
      validationTiers: tiers,
    } as RepositoryConfig;
    const session = {
      id: "session_plan",
      readyCommit,
      sourceValidatedCommit: readyCommit,
      sourceValidatedTree: sourceTree,
      ...sessionPatch,
    } as Session;
    for (const command of [lint, unit])
      await recordValidationCache(repository, session, sourceTree, command);
    return await planSourceReuse({
      repository,
      session,
      worktree: root,
      mergedTree,
      steps: [{ parallel: [lint, unit, tasks] }, build],
    });
  }

  const optIn = {
    name: "task-register",
    paths: ["TASKS.json"],
    sourceValidationCommands: [tasks],
    integrationValidationCommands: [tasks],
    reuseSourceValidationOnTargetMove: true,
  };

  it("runs the tier's commands and reuses only commands with source results", async () => {
    const plan = await planFor([optIn], "TASKS.json");
    expect(plan.outcome).toBe("applied");
    expect(plan.tier).toBe("task-register");
    expect(plan.differingPaths).toEqual(["TASKS.json"]);
    // The tier's command runs once on the merged tree, ahead of the plan.
    expect(plan.steps).toEqual([tasks, { parallel: [lint, unit] }, build]);
    expect([...plan.reused].sort()).toEqual(
      [lint, unit].map(commandFingerprint).sort(),
    );
  });

  it("keeps a lightweight plan's queue bypass only for lightweight added commands", async () => {
    const bypass = "lightweight validation tier tests";
    const heavy = await planFor([optIn], "TASKS.json");
    expect(heavy.outcome).toBe("applied");
    expect(queueBypassWithReuse(heavy, bypass)).toBeUndefined();
    const light = await planFor(
      [{ ...optIn, bypassBuildQueue: true }],
      "TASKS.json",
    );
    expect(queueBypassWithReuse(light, bypass)).toBe(bypass);
    const empty = await planFor(
      [{ ...optIn, integrationValidationCommands: [] }],
      "TASKS.json",
    );
    expect(queueBypassWithReuse(empty, bypass)).toBe(bypass);
    const skipped = await planFor([], "TASKS.json");
    expect(skipped.outcome).toBe("skipped");
    expect(queueBypassWithReuse(skipped, bypass)).toBe(bypass);
    expect(queueBypassWithReuse(heavy, undefined)).toBeUndefined();
  });

  it("uses the first matching tier even when a later tier opts in", async () => {
    const plan = await planFor(
      [
        {
          name: "guidance",
          paths: ["GUIDE.md"],
          sourceValidationCommands: [],
          integrationValidationCommands: [],
        },
        { ...optIn, name: "docs", paths: ["**/*.md"] },
      ],
      "GUIDE.md",
    );
    expect(plan.outcome).toBe("skipped");
    expect(plan.tier).toBe("guidance");
    expect(plan.reused.size).toBe(0);
  });

  it("keeps the full plan for local target recovery and unvalidated commits", async () => {
    for (const patch of [
      { recoveryPhase: "local_target" as const },
      { sourceValidatedCommit: "0".repeat(40) },
    ]) {
      const plan = await planFor([optIn], "TASKS.json", patch);
      expect(plan.outcome).toBe("skipped");
      expect(plan.steps).toEqual([{ parallel: [lint, unit, tasks] }, build]);
      expect(plan.reused.size).toBe(0);
    }
  });
});

interface ValidatedSession {
  worktree: string;
  readyCommit: string;
  sourceTree: string;
}

/** A code-changing session whose exact ready commit passed seshx validate. */
async function validatedCodeSession(
  fixture: Fixture,
): Promise<ValidatedSession> {
  const worktree = await addWorktree(fixture, "code-change");
  await runCliOk(fixture, worktree, ["begin", "--summary", "code change"]);
  const readyCommit = commitFile(worktree, "code.txt", "code\n", "code");
  const sourceTree = git(worktree, "rev-parse", "HEAD^{tree}");
  const before = (await validationRuns(fixture)).length;
  await runCliOk(fixture, worktree, ["validate"]);
  expect(await runLabels(fixture, before, sourceTree)).toEqual([
    "lint",
    "unit",
  ]);
  return { worktree, readyCommit, sourceTree };
}

async function createFixture(optIn: boolean): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sesh-target-move-test-"));
  temporaryRoots.push(root);
  const fixture: Fixture = {
    root,
    repo: join(root, "repo"),
    runtime: join(root, "runtime"),
    home: join(root, "home"),
    log: join(root, "validation.log"),
    validator: join(root, "validate.cjs"),
  };
  await mkdir(fixture.repo, { recursive: true });
  await mkdir(fixture.home, { recursive: true });
  git(fixture.repo, "init", "-b", "main");
  git(fixture.repo, "config", "user.name", "Test User");
  git(fixture.repo, "config", "user.email", "test@example.com");
  git(fixture.repo, "config", "commit.gpgSign", "false");
  await writeFile(join(fixture.repo, "base.txt"), "base\n");
  await writeFile(join(fixture.repo, "TASKS.json"), '{ "tasks": [] }\n');
  git(fixture.repo, "add", "base.txt", "TASKS.json");
  git(fixture.repo, "commit", "-m", "base");
  await runCliOk(fixture, fixture.repo, ["init"]);
  await runCliOk(fixture, fixture.repo, ["register"]);
  await writeFile(
    fixture.validator,
    `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [log, label] = process.argv.slice(2);
const tree = execFileSync("git", ["write-tree"], { encoding: "utf8" }).trim();
fs.appendFileSync(log, JSON.stringify({ label, tree }) + "\\n");
`,
  );
  const check = (label: string) => [
    process.execPath,
    fixture.validator,
    fixture.log,
    label,
  ];
  await updateConfig(fixture, (config) => {
    config.repositories[0].sourceValidationCommands = [
      { parallel: [check("lint"), check("unit")] },
    ];
    config.repositories[0].integrationValidationCommands = [
      { parallel: [check("lint"), check("unit")] },
      check("build"),
    ];
    config.repositories[0].validationTiers = [
      {
        name: "task-register",
        paths: ["TASKS.json"],
        sourceValidationCommands: [check("tasks")],
        integrationValidationCommands: [check("tasks")],
        ...(optIn ? { reuseSourceValidationOnTargetMove: true } : {}),
      },
    ];
  });
  return fixture;
}

async function addWorktree(fixture: Fixture, branch: string): Promise<string> {
  const path = join(fixture.root, branch);
  git(fixture.repo, "worktree", "add", "-b", branch, path, "main");
  return await realpath(path);
}

function commitFile(
  worktree: string,
  name: string,
  contents: string,
  message: string,
): string {
  execFileSync(process.execPath, [
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(join(worktree, name))},${JSON.stringify(contents)})`,
  ]);
  git(worktree, "add", name);
  git(worktree, "commit", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ancestor(fixture: Fixture, commit: string, ref: string): boolean {
  try {
    git(fixture.repo, "merge-base", "--is-ancestor", commit, ref);
    return true;
  } catch {
    return false;
  }
}

async function runCli(
  fixture: Fixture,
  cwd: string,
  args: string[],
  executable = cli,
): Promise<CliResult> {
  const effective =
    args[0] === "integrate" ? [...args, "--rollout", "none"] : args;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...effective], {
      cwd,
      env: {
        ...process.env,
        PARALLEL_INTEGRATOR_HOME: fixture.runtime,
        PARALLEL_INTEGRATOR_AUDIT_HOME: fixture.home,
        PARALLEL_INTEGRATOR_DOCTOR_HOME: fixture.home,
        PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCliOk(
  fixture: Fixture,
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const result = await runCli(fixture, cwd, args);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result;
}

async function sessionFor(fixture: Fixture, worktree: string): Promise<any> {
  const directory = join(fixture.runtime, "sessions");
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const session = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (session.worktreePath === worktree) return session;
  }
  throw new Error(`No session for ${worktree}`);
}

async function integrateMetrics(
  fixture: Fixture,
  worktree: string,
): Promise<Record<string, unknown>> {
  const session = await sessionFor(fixture, worktree);
  const performance = JSON.parse(
    await readFile(
      join(fixture.runtime, "performance", `${session.id}.json`),
      "utf8",
    ),
  );
  return performance.runs.findLast((run: any) => run.command === "integrate")
    .metrics;
}

async function validationRuns(fixture: Fixture): Promise<ValidationRun[]> {
  try {
    return (await readFile(fixture.log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ValidationRun);
  } catch {
    return [];
  }
}

/** Labels of the commands run on one tree since a log position, sorted. */
async function runLabels(
  fixture: Fixture,
  since: number,
  tree: string,
): Promise<string[]> {
  const runs = (await validationRuns(fixture)).slice(since);
  expect(runs.every((run) => run.tree === tree)).toBe(true);
  return runs.map((run) => run.label).sort();
}

async function updateConfig(
  fixture: Fixture,
  mutate: (config: any) => void,
): Promise<void> {
  const path = join(fixture.runtime, "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  mutate(config);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}
