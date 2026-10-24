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

interface Fixture {
  root: string;
  repo: string;
  runtime: string;
  home: string;
  log: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A session whose local target recovery waits for its staged conflict fix. */
interface WaitingRecovery {
  worktree: string;
  recoveryWorktree: string;
  /** The validated staging result the recovery started from. */
  result: string;
  /** The committed target the recovery merges. */
  target: string;
}

const cli =
  process.env.PARALLEL_INTEGRATOR_TEST_CLI ??
  join(process.cwd(), "dist", "cli.js");
const staging = "sesh-integrator/integration";
const temporaryRoots: string[] = [];
const TIMEOUT = 120_000;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential("local target recovery after staging moved", () => {
  it.each(["staged resolution", "committed result"])(
    "records the session as integrated when another session promoted its result (%s)",
    async (state) => {
      const fixture = await createFixture();
      const waiting = await waitOnLocalTargetConflict(fixture);
      const other = await integrateOnStaging(fixture, "other", false);
      expect(other.status).toBe("succeeded");
      const promoted = git(fixture.repo, "rev-parse", "main");
      expect(ancestor(fixture, waiting.result, promoted)).toBe(true);
      expect(git(fixture.repo, "rev-parse", staging)).toBe(promoted);
      let committed: string | undefined;
      if (state === "committed result") {
        // An older coordinator committed the result, then failed to advance
        // staging from its stale baseline (incident CH-20261024-B42D42).
        const recovery = waiting.recoveryWorktree;
        const resolved = git(
          recovery,
          "commit-tree",
          git(recovery, "write-tree"),
          "-p",
          waiting.result,
          "-p",
          waiting.target,
          "-m",
          "Local reconciliation snapshot",
        );
        git(recovery, "commit", "-m", "Integrate recovering");
        committed = git(recovery, "rev-parse", "HEAD");
        await updateSession(fixture, waiting.worktree, (session) => {
          session.localTargetRecovery.resolvedCommit = resolved;
          session.localTargetRecovery.resultCommit = committed;
          session.integratedCommit = committed;
          session.awaitingConflictResolution = false;
        });
      }
      const validations = (await validationTrees(fixture)).length;

      const resumed = await runCliOk(fixture, waiting.worktree, ["resume"]);

      expect(resumed.stdout).toContain(
        `main at ${promoted} already contains its validated result ${waiting.result}. Recording the session as integrated through that promotion without a new commit`,
      );
      const session = await sessionFor(fixture, waiting.worktree);
      expect(session.status).toBe("succeeded");
      expect(session.recoveryPhase).toBeUndefined();
      expect(session.integratedCommit).toBe(waiting.result);
      expect(session.promotedCommit).toBe(waiting.result);
      expect(session.localTargetRecovery).toBeUndefined();
      expect(session.localTargetRecoveryHistory.at(-1)).toEqual({
        baseCommit: waiting.result,
        targetCommit: waiting.target,
        stagingBefore: waiting.result,
        worktree: waiting.recoveryWorktree,
        ...(committed
          ? {
              resolvedCommit: expect.any(String),
              resultCommit: committed,
            }
          : {}),
      });
      expect(session.recoveryBundle.state).toBe("archived");
      // No new commit, validation or ref movement; the stale attempt stays put.
      expect(git(fixture.repo, "rev-parse", "main")).toBe(promoted);
      expect(git(fixture.repo, "rev-parse", staging)).toBe(promoted);
      expect(await validationTrees(fixture)).toHaveLength(validations);
      if (committed) expect(ancestor(fixture, committed, "main")).toBe(false);
      expect(
        await readFile(join(waiting.recoveryWorktree, "shared.txt"), "utf8"),
      ).toBe("target\ntask\n");
      const audit = await runCliOk(fixture, fixture.repo, ["reconcile"]);
      expect(audit.stdout).toContain(
        "all recorded validated integrations are present on target main",
      );
    },
    TIMEOUT,
  );

  it(
    "restarts reconciliation from staging that moved forward without reaching the target",
    async () => {
      const fixture = await createFixture();
      const waiting = await waitOnLocalTargetConflict(fixture);
      const other = await integrateOnStaging(fixture, "other", true);
      expect(other.status).toBe("promotion_pending");
      const moved = other.integratedCommit;
      expect(git(fixture.repo, "rev-parse", staging)).toBe(moved);
      expect(git(fixture.repo, "rev-parse", "main")).toBe(waiting.target);
      // Committing the note that blocked that promotion moves the target too.
      git(fixture.repo, "add", "notes.txt");
      git(fixture.repo, "commit", "-m", "notes");
      const target = git(fixture.repo, "rev-parse", "main");
      const validations = (await validationTrees(fixture)).length;

      const resumed = await runCliOk(fixture, waiting.worktree, ["resume"]);

      expect(resumed.stdout).toContain(
        `moved from ${waiting.result} to ${moved} while`,
      );
      expect(resumed.stdout).toContain(
        `restarting local target reconciliation from ${moved} with full validation`,
      );
      const session = await sessionFor(fixture, waiting.worktree);
      expect(session.status).toBe("succeeded");
      expect(session.localTargetRecoveryHistory.at(-1)).toMatchObject({
        baseCommit: waiting.result,
        stagingBefore: waiting.result,
        targetCommit: waiting.target,
        worktree: waiting.recoveryWorktree,
      });
      expect(session.localTargetRecovery).toMatchObject({
        baseCommit: moved,
        stagingBefore: moved,
        targetCommit: target,
      });
      for (const commit of [waiting.result, moved, target])
        expect(ancestor(fixture, commit, session.promotedCommit)).toBe(true);
      expect(git(fixture.repo, "rev-parse", "main")).toBe(
        session.promotedCommit,
      );
      expect(git(fixture.repo, "rev-parse", staging)).toBe(
        session.promotedCommit,
      );
      // The restarted merge is validated in full before promotion.
      expect((await validationTrees(fixture)).slice(validations)).toEqual([
        git(fixture.repo, "rev-parse", `${session.promotedCommit}^{tree}`),
      ]);
      expect(
        await readFile(join(waiting.recoveryWorktree, "shared.txt"), "utf8"),
      ).toBe("target\ntask\n");
    },
    TIMEOUT,
  );

  it(
    "stops for review when staging no longer contains the recovery baseline",
    async () => {
      const fixture = await createFixture();
      const waiting = await waitOnLocalTargetConflict(fixture);
      const other = await integrateOnStaging(fixture, "other", true);
      expect(other.status).toBe("promotion_pending");
      // Staging history is then replaced without the waiting session's result.
      const replacement = git(
        fixture.repo,
        "commit-tree",
        `${waiting.target}^{tree}`,
        "-p",
        waiting.target,
        "-m",
        "replacement staging",
      );
      git(fixture.repo, "update-ref", `refs/heads/${staging}`, replacement);
      const validations = (await validationTrees(fixture)).length;

      const refused = await runCli(fixture, waiting.worktree, ["resume"]);

      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        `Staging ${staging} moved to ${replacement}, which no longer contains local target recovery baseline ${waiting.result}, and target main at ${waiting.target} does not contain validated result ${waiting.result}`,
      );
      const session = await sessionFor(fixture, waiting.worktree);
      expect(session.status).toBe("needs_review");
      expect(session.recoveryPhase).toBe("local_target");
      expect(session.localTargetRecovery.stagingBefore).toBe(waiting.result);
      expect(git(fixture.repo, "rev-parse", staging)).toBe(replacement);
      expect(git(fixture.repo, "rev-parse", "main")).toBe(waiting.target);
      expect(await validationTrees(fixture)).toHaveLength(validations);
    },
    TIMEOUT,
  );
});

async function waitOnLocalTargetConflict(
  fixture: Fixture,
): Promise<WaitingRecovery> {
  // A preserved conflict holds the shared integration worktree, so the
  // sessions below integrate in isolated worktrees from the staging tip.
  const first = await addWorktree(fixture, "holder-first");
  const holder = await addWorktree(fixture, "holder");
  await runCliOk(fixture, first, ["begin", "--summary", "holder first"]);
  await runCliOk(fixture, holder, ["begin", "--summary", "holder"]);
  commitFile(first, "holder.txt", "first\n", "holder first");
  commitFile(holder, "holder.txt", "holder\n", "holder");
  await runCliOk(fixture, first, ["integrate", "--summary", "holder first"]);
  expect(
    (await runCli(fixture, holder, ["integrate", "--summary", "holder"])).code,
  ).toBe(1);

  // An uncommitted target file blocks promotion; committing it moves the target.
  const worktree = await addWorktree(fixture, "recovering");
  await runCliOk(fixture, worktree, ["begin", "--summary", "recovering"]);
  commitFile(worktree, "shared.txt", "task\n", "task");
  await writeFile(join(fixture.repo, "shared.txt"), "target\n");
  expect(
    (await runCli(fixture, worktree, ["integrate", "--summary", "recovering"]))
      .code,
  ).toBe(1);
  let session = await sessionFor(fixture, worktree);
  expect(session.status).toBe("promotion_pending");
  const result = session.integratedCommit;
  git(fixture.repo, "add", "shared.txt");
  git(fixture.repo, "commit", "-m", "target work");
  const target = git(fixture.repo, "rev-parse", "main");

  const conflicted = await runCli(fixture, worktree, ["resume"]);
  expect(conflicted.code).toBe(1);
  expect(conflicted.stderr).toContain(
    "Resolve and stage local target conflicts",
  );
  session = await sessionFor(fixture, worktree);
  expect(session.recoveryPhase).toBe("local_target");
  expect(session.localTargetRecovery).toMatchObject({
    baseCommit: result,
    stagingBefore: result,
    targetCommit: target,
  });
  const recoveryWorktree = session.integrationWorktreePath;
  await writeFile(join(recoveryWorktree, "shared.txt"), "target\ntask\n");
  git(recoveryWorktree, "add", "shared.txt");
  return { worktree, recoveryWorktree, result, target };
}

/**
 * Integrates a session started from the current target while the waiting
 * recovery holds its result on staging; the merge repeats that conflict.
 */
async function integrateOnStaging(
  fixture: Fixture,
  name: string,
  blockPromotion: boolean,
): Promise<any> {
  const worktree = await addWorktree(fixture, name);
  await runCliOk(fixture, worktree, ["begin", "--summary", name]);
  commitFile(worktree, `${name}.txt`, `${name}\n`, name);
  const conflicted = await runCli(fixture, worktree, [
    "integrate",
    "--summary",
    name,
  ]);
  expect(conflicted.code).toBe(1);
  expect(conflicted.stdout).toContain("using isolated worktree");
  const pending = await sessionFor(fixture, worktree);
  await writeFile(
    join(pending.integrationWorktreePath, "shared.txt"),
    "target\ntask\n",
  );
  git(pending.integrationWorktreePath, "add", "shared.txt");
  if (blockPromotion)
    await writeFile(join(fixture.repo, "notes.txt"), "uncommitted\n");
  const resumed = await runCli(fixture, worktree, ["resume"]);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(
    blockPromotion ? 1 : 0,
  );
  return await sessionFor(fixture, worktree);
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sesh-local-target-test-"));
  temporaryRoots.push(root);
  const fixture: Fixture = {
    root,
    repo: join(root, "repo"),
    runtime: join(root, "runtime"),
    home: join(root, "home"),
    log: join(root, "validation.log"),
  };
  await mkdir(fixture.repo, { recursive: true });
  await mkdir(fixture.home, { recursive: true });
  git(fixture.repo, "init", "-b", "main");
  git(fixture.repo, "config", "user.name", "Test User");
  git(fixture.repo, "config", "user.email", "test@example.com");
  git(fixture.repo, "config", "commit.gpgSign", "false");
  await writeFile(join(fixture.repo, "base.txt"), "base\n");
  git(fixture.repo, "add", "base.txt");
  git(fixture.repo, "commit", "-m", "base");
  await runCliOk(fixture, fixture.repo, ["init"]);
  await runCliOk(fixture, fixture.repo, ["register"]);
  await updateConfig(fixture, (config) => {
    config.repositories[0].integrationValidationCommands = [
      [
        process.execPath,
        "-e",
        `const tree=require('child_process').execFileSync('git',['write-tree'],{encoding:'utf8'});require('fs').appendFileSync(${JSON.stringify(fixture.log)},tree)`,
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

/** Trees that integration validation ran on, oldest first. */
async function validationTrees(fixture: Fixture): Promise<string[]> {
  try {
    return (await readFile(fixture.log, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function runCli(
  fixture: Fixture,
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const effective =
    args[0] === "integrate" ? [...args, "--rollout", "none"] : args;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...effective], {
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

async function sessionPath(
  fixture: Fixture,
  worktree: string,
): Promise<string> {
  const directory = join(fixture.runtime, "sessions");
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const session = JSON.parse(await readFile(path, "utf8"));
    if (session.worktreePath === worktree) return path;
  }
  throw new Error(`No session for ${worktree}`);
}

async function sessionFor(fixture: Fixture, worktree: string): Promise<any> {
  return JSON.parse(
    await readFile(await sessionPath(fixture, worktree), "utf8"),
  );
}

async function updateSession(
  fixture: Fixture,
  worktree: string,
  mutate: (session: any) => void,
): Promise<void> {
  const path = await sessionPath(fixture, worktree);
  const session = JSON.parse(await readFile(path, "utf8"));
  mutate(session);
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`);
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
