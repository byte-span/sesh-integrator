import { execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface Fixture {
  root: string;
  repo: string;
  runtime: string;
  home: string;
  log: string;
  gate: string;
  release: string;
  allowBad: string;
  dirtyTarget: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ValidationRun {
  tree: string;
  files: string[];
  passed: boolean;
}

const cli =
  process.env.PARALLEL_INTEGRATOR_TEST_CLI ??
  join(process.cwd(), "dist", "cli.js");
// Optionally run the legacy waiter with a real pre-batching coordinator build
// (for example an installed release's dist/cli.js) instead of the test switch.
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

describe.sequential("integration batches", () => {
  it(
    "merges three waiting sessions into one validated, promoted candidate",
    async () => {
      const fixture = await createFixture();
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["batch-a", "a.txt"],
        ["batch-b", "b.txt"],
        ["batch-c", "c.txt"],
      ]);
      await writeFile(fixture.release, "go\n");
      const results = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      for (const result of results)
        expect(result.code, result.stdout + result.stderr).toBe(0);

      const members = await sessionsFor(fixture, tasks);
      const batchId = members[0]!.integrationBatch?.id;
      expect(batchId).toMatch(/^batch_/);
      const commit = members[0]!.integratedCommit;
      for (const member of members) {
        expect(member.status).toBe("succeeded");
        expect(member.integrationBatch).toMatchObject({
          id: batchId,
          outcome: "batched",
          stagingCommit: commit,
          validationTier: "full",
          members: members.map((item) => item.id),
        });
        expect(member.integratedCommit).toBe(commit);
        expect(member.promotedCommit).toBe(commit);
        expect(member.waitingForLock).toBe(false);
        expect(member.integrationWait).toBeUndefined();
        expect(member.recoveryBundle?.state).toBe("archived");
        expect(ancestor(fixture, member.readyCommit, "main")).toBe(true);
      }
      expect(git(fixture.repo, "rev-parse", "main")).toBe(commit);
      expect(
        git(fixture.repo, "rev-parse", "sesh-integrator/integration"),
      ).toBe(commit);
      // Each member keeps its own completion summary and rollout record.
      expect(members.map((member) => member.completionSummary)).toEqual([
        "batch-a done",
        "batch-b done",
        "batch-c done",
      ]);

      // One run for the blocker, one for the whole batch.
      const runs = await validationRuns(fixture);
      expect(runs).toHaveLength(2);
      expect(runs[1]!.tree).toBe(git(fixture.repo, "rev-parse", "main^{tree}"));
      expect(runs[1]!.files).toEqual([
        "a.txt",
        "b.txt",
        "blocker.txt",
        "c.txt",
        "shared.txt",
      ]);

      const leader = members.find(
        (member) => member.integrationBatch.role === "leader",
      )!;
      const outputs = tasks.map((task, index) => ({
        session: members[index]!,
        result: results[index + 1]!,
      }));
      for (const { session, result } of outputs) {
        expect(result.stdout).toContain(`Session: ${session.id}`);
        expect(result.stdout).toContain(
          `Promoted ${session.id} to main at ${commit}`,
        );
        if (session.id === leader.id)
          expect(result.stdout).toContain(
            `Integration batch ${batchId}: ${leader.id} claimed 2 waiting session(s)`,
          );
        else {
          // The wait or the final report names the batch the session joined.
          expect(result.stdout).toContain(`batch ${batchId}`);
          expect(result.stdout).toContain(`led by ${leader.id}`);
        }
      }
    },
    TIMEOUT,
  );

  it(
    "leaves a conflicting member out and integrates it alone through conflict resume",
    async () => {
      const fixture = await createFixture();
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["conflict-a", "shared.txt", "A\n"],
        ["conflict-b", "shared.txt", "B\n"],
        ["conflict-c", "c.txt"],
      ]);
      await writeFile(fixture.release, "go\n");
      const [blocked, a, b, c] = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      expect(blocked!.code, blocked!.stderr).toBe(0);
      expect(a!.code, a!.stdout + a!.stderr).toBe(0);
      expect(c!.code, c!.stdout + c!.stderr).toBe(0);
      expect(b!.code).toBe(1);
      expect(b!.stderr).toContain("Merge conflict requires resolution");

      const [first, conflicting, third] = await sessionsFor(fixture, tasks);
      expect(first!.status).toBe("succeeded");
      expect(third!.status).toBe("succeeded");
      expect(first!.integrationBatch.id).toBe(third!.integrationBatch.id);
      expect(first!.integrationBatch.members).toEqual([first!.id, third!.id]);
      expect(first!.promotedCommit).toBe(third!.promotedCommit);
      expect(conflicting!.status).toBe("needs_review");
      expect(conflicting!.awaitingConflictResolution).toBe(true);
      expect(conflicting!.integrationBatch).toMatchObject({
        id: first!.integrationBatch.id,
        outcome: "excluded",
      });
      expect(conflicting!.integrationBatch.reason).toContain("shared.txt");

      // The existing conflict-resume flow completes the excluded member.
      const worktree = conflicting!.integrationWorktreePath;
      await writeFile(join(worktree, "shared.txt"), "A\nB\n");
      git(worktree, "add", "shared.txt");
      const resumed = await runCli(fixture, tasks[1]!.worktree, ["resume"]);
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      const [, resolved] = await sessionsFor(fixture, tasks);
      expect(resolved!.status).toBe("succeeded");
      expect(git(fixture.repo, "show", "main:shared.txt")).toBe("A\nB");
      expect(ancestor(fixture, first!.readyCommit, "main")).toBe(true);
      expect(ancestor(fixture, third!.readyCommit, "main")).toBe(true);
      // Blocker, the two-session batch, and the resolved conflict.
      expect(await validationRuns(fixture)).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    "isolates a failing member so passing members still promote",
    async () => {
      const fixture = await createFixture();
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["isolate-a", "a.txt"],
        ["isolate-bad", "bad.txt"],
        ["isolate-c", "c.txt"],
      ]);
      await writeFile(fixture.release, "go\n");
      const [blocked, a, bad, c] = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      expect(blocked!.code, blocked!.stderr).toBe(0);
      expect(a!.code, a!.stdout + a!.stderr).toBe(0);
      expect(c!.code, c!.stdout + c!.stderr).toBe(0);
      expect(bad!.code).toBe(1);
      expect(bad!.stdout).toContain("Completion summary:");
      expect(bad!.stdout).toContain("Source integration: validation_pending");

      const [first, failing, third] = await sessionsFor(fixture, tasks);
      expect(first!.status).toBe("succeeded");
      expect(third!.status).toBe("succeeded");
      expect(failing!.status).toBe("validation_pending");
      for (const session of [first!, failing!, third!])
        expect(session.integrationBatch.outcome).toBe("isolated");
      expect(ancestor(fixture, first!.readyCommit, "main")).toBe(true);
      expect(ancestor(fixture, third!.readyCommit, "main")).toBe(true);
      expect(ancestor(fixture, failing!.readyCommit, "main")).toBe(false);

      // Every promoted tree passed validation; the failing tree never landed.
      const runs = await validationRuns(fixture);
      const passed = new Set(
        runs.filter((run) => run.passed).map((run) => run.tree),
      );
      for (const session of [first!, third!])
        expect(
          passed.has(
            git(fixture.repo, "rev-parse", `${session.promotedCommit}^{tree}`),
          ),
        ).toBe(true);
      expect(passed.has(git(fixture.repo, "rev-parse", "main^{tree}"))).toBe(
        true,
      );
      // Blocker, combined, first alone, failing alone, third alone. The
      // remaining pair reproduced the failed combined tree and was split
      // without rerunning it.
      expect(runs).toHaveLength(5);
      expect(runs.filter((run) => !run.passed)).toHaveLength(2);

      // The failing member stays resumable through the normal flow.
      await writeFile(fixture.allowBad, "yes\n");
      const resumed = await runCli(fixture, tasks[1]!.worktree, ["resume"]);
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      const [, recovered] = await sessionsFor(fixture, tasks);
      expect(recovered!.status).toBe("succeeded");
      expect(ancestor(fixture, failing!.readyCommit, "main")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "caps batch size at the configured maximum",
    async () => {
      const fixture = await createFixture();
      await updateConfig(fixture, (config) => {
        config.repositories[0].integrationBatching = { maxSessions: 2 };
      });
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["cap-a", "a.txt"],
        ["cap-b", "b.txt"],
        ["cap-c", "c.txt"],
      ]);
      await writeFile(fixture.release, "go\n");
      const results = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      for (const result of results)
        expect(result.code, result.stdout + result.stderr).toBe(0);
      const members = await sessionsFor(fixture, tasks);
      for (const member of members) expect(member.status).toBe("succeeded");
      const batched = members.filter(
        (member) => member.integrationBatch?.outcome === "batched",
      );
      expect(batched).toHaveLength(2);
      expect(batched[0]!.integrationBatch.id).toBe(
        batched[1]!.integrationBatch.id,
      );
      expect(batched[0]!.integrationBatch.members).toHaveLength(2);
      expect(members.filter((member) => !member.integrationBatch)).toHaveLength(
        1,
      );
      expect(await validationRuns(fixture)).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    "integrates one session at a time when batching is disabled",
    async () => {
      const fixture = await createFixture();
      await updateConfig(fixture, (config) => {
        config.integrationBatching = { maxSessions: 4 };
        config.repositories[0].integrationBatching = { enabled: false };
      });
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["serial-a", "a.txt"],
        ["serial-b", "b.txt"],
        ["serial-c", "c.txt"],
      ]);
      await writeFile(fixture.release, "go\n");
      const results = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      for (const result of results)
        expect(result.code, result.stdout + result.stderr).toBe(0);
      const members = await sessionsFor(fixture, tasks);
      for (const member of members) {
        expect(member.status).toBe("succeeded");
        expect(member.integrationBatch).toBeUndefined();
      }
      expect(new Set(members.map((member) => member.promotedCommit)).size).toBe(
        3,
      );
      expect(await validationRuns(fixture)).toHaveLength(4);
    },
    TIMEOUT,
  );

  it(
    "never claims a waiting session from a coordinator that predates batching",
    async () => {
      const fixture = await createFixture();
      // Older coordinators read the same configuration and ignore these keys.
      await updateConfig(fixture, (config) => {
        config.integrationBatching = { enabled: true, maxSessions: 8 };
        config.repositories[0].integrationBatching = { maxSessions: 4 };
      });
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["modern-a", "a.txt"],
        ["legacy", "legacy.txt", "legacy\n", true],
        ["modern-b", "b.txt"],
      ]);
      await writeFile(fixture.release, "go\n");
      const results = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      for (const result of results)
        expect(result.code, result.stdout + result.stderr).toBe(0);
      const [modernA, legacy, modernB] = await sessionsFor(fixture, tasks);
      expect(legacy!.status).toBe("succeeded");
      expect(legacy!.integrationBatch).toBeUndefined();
      expect(legacy!.integrationWait).toBeUndefined();
      expect(modernA!.integrationBatch.id).toBe(modernB!.integrationBatch.id);
      expect(modernA!.integrationBatch.outcome).toBe("batched");
      expect(await validationRuns(fixture)).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    "preserves a validated batch as promotion_pending for each member's resume",
    async () => {
      const fixture = await createFixture();
      const blocker = await startBlocker(fixture);
      const tasks = await startWaiting(fixture, [
        ["pending-a", "a.txt"],
        ["pending-b", "b.txt"],
      ]);
      await writeFile(fixture.dirtyTarget, "yes\n");
      await writeFile(fixture.release, "go\n");
      const [blocked, ...results] = await Promise.all([
        blocker.result,
        ...tasks.map((task) => task.result),
      ]);
      expect(blocked!.code, blocked!.stderr).toBe(0);
      for (const result of results) expect(result.code).toBe(1);
      const before = git(fixture.repo, "rev-parse", "main");
      const members = await sessionsFor(fixture, tasks);
      const staged = members[0]!.integratedCommit;
      for (const member of members) {
        expect(member.status).toBe("promotion_pending");
        expect(member.recoveryPhase).toBe("promotion");
        expect(member.integratedCommit).toBe(staged);
        expect(member.promotedCommit).toBeUndefined();
        expect(member.integrationBatch.outcome).toBe("batched");
      }
      // The validated batch stays staged; the dirty target never moved.
      expect(
        git(fixture.repo, "rev-parse", "sesh-integrator/integration"),
      ).toBe(staged);
      expect(git(fixture.repo, "rev-parse", "main")).toBe(before);
      expect(git(fixture.repo, "status", "--porcelain")).toBe("M shared.txt");

      // After the user's edit is set aside, each member resumes on its own.
      await rm(fixture.dirtyTarget);
      git(fixture.repo, "checkout", "--", "shared.txt");
      for (const task of tasks) {
        const resumed = await runCli(fixture, task.worktree, ["resume"]);
        expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      }
      for (const member of await sessionsFor(fixture, tasks)) {
        expect(member.status).toBe("succeeded");
        expect(member.promotedCommit).toBe(staged);
      }
      expect(git(fixture.repo, "rev-parse", "main")).toBe(staged);
      const status = await runCli(fixture, tasks[0]!.worktree, [
        "status",
        "--session",
        members[0]!.id,
        "--json",
      ]);
      expect(JSON.parse(status.stdout).session.integrationBatch).toMatchObject({
        id: members[0]!.integrationBatch.id,
        outcome: "batched",
        stagingCommit: staged,
        members: members.map((member) => member.id),
      });
    },
    TIMEOUT,
  );

  it("rejects invalid batching configuration", async () => {
    const fixture = await createFixture();
    for (const value of [
      { maxSessions: 0 },
      { maxSessions: 2.5 },
      { enabled: "yes" },
      { maxSize: 4 },
    ]) {
      await updateConfig(fixture, (config) => {
        config.repositories[0].integrationBatching = value;
      });
      const result = await runCli(fixture, fixture.repo, ["status"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Invalid integrationBatching");
    }
    await updateConfig(fixture, (config) => {
      delete config.repositories[0].integrationBatching;
      config.integrationBatching = { maxSessions: 65 };
    });
    const global = await runCli(fixture, fixture.repo, ["status"]);
    expect(global.code).toBe(1);
    expect(global.stderr).toContain("Invalid integrationBatching");
  });
});

interface Running {
  worktree: string;
  result: Promise<CliResult>;
}

/** A session whose validation holds the repository lock until released. */
async function startBlocker(fixture: Fixture): Promise<Running> {
  const worktree = await addWorktree(fixture, "blocker");
  await runCliOk(fixture, worktree, ["begin", "--summary", "blocker"]);
  commitFile(worktree, "blocker.txt", "blocker\n", "blocker");
  const result = runCli(fixture, worktree, [
    "integrate",
    "--summary",
    "blocker done",
  ]);
  await waitFor(() => exists(fixture.gate), "blocker validation to start");
  return { worktree, result };
}

/** Start integrations one by one so each is waiting before the next. */
async function startWaiting(
  fixture: Fixture,
  specs: [string, string, string?, boolean?][],
): Promise<Running[]> {
  const started: Running[] = [];
  for (const [name, file, contents, legacy] of specs) {
    const worktree = await addWorktree(fixture, name);
    const executable = (legacy && legacyCli) || cli;
    const begun = await runCli(
      fixture,
      worktree,
      ["begin", "--summary", name],
      {},
      executable,
    );
    expect(begun.code, begun.stdout + begun.stderr).toBe(0);
    commitFile(worktree, file, contents ?? `${name}\n`, name);
    const result = runCli(
      fixture,
      worktree,
      ["integrate", "--summary", `${name} done`],
      legacy ? { PARALLEL_INTEGRATOR_TEST_LEGACY_INTEGRATE: "1" } : {},
      executable,
    );
    await waitFor(async () => {
      const session = (await sessions(fixture)).find(
        (item) => item.worktreePath === worktree,
      );
      return (
        session?.waitingForLock === true &&
        (legacy ? session.status === "ready" : !!session.integrationWait)
      );
    }, `${name} to wait for the repository lock`);
    started.push({ worktree, result });
  }
  return started;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sesh-batch-test-"));
  temporaryRoots.push(root);
  const fixture: Fixture = {
    root,
    repo: join(root, "repo"),
    runtime: join(root, "runtime"),
    home: join(root, "home"),
    log: join(root, "validation.log"),
    gate: join(root, "blocker-started"),
    release: join(root, "release-blocker"),
    allowBad: join(root, "allow-bad"),
    dirtyTarget: join(root, "dirty-target"),
  };
  await mkdir(fixture.repo, { recursive: true });
  await mkdir(fixture.home, { recursive: true });
  git(fixture.repo, "init", "-b", "main");
  git(fixture.repo, "config", "user.name", "Test User");
  git(fixture.repo, "config", "user.email", "test@example.com");
  git(fixture.repo, "config", "commit.gpgSign", "false");
  await writeFile(join(fixture.repo, "shared.txt"), "base\n");
  git(fixture.repo, "add", "shared.txt");
  git(fixture.repo, "commit", "-m", "base");
  await runCliOk(fixture, fixture.repo, ["init"]);
  await runCliOk(fixture, fixture.repo, ["register"]);
  const validator = join(root, "validate.cjs");
  await writeFile(
    validator,
    `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [log, gate, release, allowBad, dirtyTarget, target] = process.argv.slice(2);
const tree = execFileSync("git", ["write-tree"], { encoding: "utf8" }).trim();
const files = fs.readdirSync(".").filter((name) => name.endsWith(".txt")).sort();
const passed = !files.includes("bad.txt") || fs.existsSync(allowBad);
if (files.includes("blocker.txt") && !fs.existsSync(release)) {
  fs.writeFileSync(gate, "started\\n");
  const started = Date.now();
  while (!fs.existsSync(release) && Date.now() - started < 60000)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
fs.appendFileSync(log, JSON.stringify({ tree, files, passed }) + "\\n");
// Simulates a user editing the checked-out target while a batch validates.
if (fs.existsSync(dirtyTarget) && files.includes("a.txt") && files.includes("b.txt"))
  fs.appendFileSync(target + "/shared.txt", "uncommitted user edit\\n");
process.exit(passed ? 0 : 3);
`,
  );
  await updateConfig(fixture, (config) => {
    config.lockWaitSeconds = 90;
    config.repositories[0].integrationValidationCommands = [
      [
        process.execPath,
        validator,
        fixture.log,
        fixture.gate,
        fixture.release,
        fixture.allowBad,
        fixture.dirtyTarget,
        fixture.repo,
      ],
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
  extraEnv: NodeJS.ProcessEnv = {},
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
        ...extraEnv,
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

async function sessions(fixture: Fixture): Promise<any[]> {
  const directory = join(fixture.runtime, "sessions");
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  const values = await Promise.all(
    names.map(async (name) => {
      try {
        return JSON.parse(await readFile(join(directory, name), "utf8"));
      } catch {
        return undefined; // Mid-write; the next poll reads it.
      }
    }),
  );
  return values
    .filter(Boolean)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function sessionsFor(fixture: Fixture, tasks: Running[]): Promise<any[]> {
  const all = await sessions(fixture);
  return tasks.map((task) =>
    all.find((session) => session.worktreePath === task.worktree)!,
  );
}

async function validationRuns(fixture: Fixture): Promise<ValidationRun[]> {
  return (await readFile(fixture.log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ValidationRun);
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Bounded wait for a disposable-fixture condition. */
async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
