import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  findLatestSessionForWorktree,
  readSession,
  recordSessionActivity,
  updateSessionTasks,
  writeSession,
} from "../src/runtime.js";
import type { SessionAudit } from "../src/session-audit.js";
import { editTasks } from "../src/tasks.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const currentCli = join(process.cwd(), "dist", "cli.js");
/**
 * Optional previously installed coordinator, for example
 * `~/.local/share/sesh-integrator/releases/<release>/dist/cli.js`, used to
 * check that older lifecycle code reads, preserves and resumes records that
 * carry the heartbeat. Unset in normal runs because releases are host-local.
 */
const olderCli = process.env.SESH_COMPAT_CLI;

const sample = (id: string, worktreePath = `/source/${id}`): Session => ({
  id,
  repositoryPath: "/repo",
  repositoryId: "repo",
  worktreePath,
  branch: "task",
  status: "active",
  startCommit: "base",
  integrationCommitAtStart: null,
  startedAt: "2026-10-01T00:00:00.000Z",
  taskSummary: "Heartbeat",
  dependsOn: [],
});

const withoutHeartbeat = ({ lastActivityAt: _, ...session }: Session) =>
  session;

async function storage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sesh-activity-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", root);
  return root;
}

const recordLocks = async (root: string) =>
  (await readdir(join(root, "locks"))).filter((name) =>
    name.startsWith("session-record"),
  );

it("records the heartbeat for lifecycle and checklist saves but not lookups", async () => {
  const root = await storage();
  const started = Date.now();
  const fresh = sample("session_fresh");
  await writeSession(fresh);
  const begun = (await readSession(fresh.id))!;
  expect(Date.parse(begun.lastActivityAt!)).toBeGreaterThanOrEqual(started);
  expect(fresh.lastActivityAt).toBe(begun.lastActivityAt);

  // A record written by an older coordinator has no heartbeat.
  const legacy = sample("session_legacy");
  await writeFile(
    join(root, "sessions", `${legacy.id}.json`),
    `${JSON.stringify(legacy, null, 2)}\n`,
  );
  // Locating it lazily indexes the record without inventing activity.
  expect(
    (await findLatestSessionForWorktree(legacy.worktreePath, ["active"]))?.id,
  ).toBe(legacy.id);
  expect(await readdir(join(root, "indexes", "worktrees"))).toHaveLength(2);
  expect((await readSession(legacy.id))!.lastActivityAt).toBeUndefined();

  const planned = await updateSessionTasks(legacy.id, (tasks) =>
    editTasks(tasks, { action: "add", titles: ["Plan"] }),
  );
  expect(planned.lastActivityAt).toBe(planned.tasksUpdatedAt);
  expect((await readSession(legacy.id))!.lastActivityAt).toBe(
    planned.lastActivityAt,
  );

  // A non-activity save follows the stored heartbeat, never the snapshot's.
  await writeSession({ ...legacy }, { activity: false });
  await writeSession(
    { ...legacy, lastActivityAt: "2000-01-01T00:00:00.000Z" },
    { activity: false },
  );
  let saved = (await readSession(legacy.id))!;
  expect(saved.lastActivityAt).toBe(planned.lastActivityAt);
  expect(saved.tasks).toHaveLength(1);

  // A lifecycle save from a stale snapshot keeps the checklist and records work.
  legacy.status = "ready";
  legacy.readyCommit = "exact-source";
  await writeSession(legacy);
  saved = (await readSession(legacy.id))!;
  expect(saved.status).toBe("ready");
  expect(saved.tasks).toHaveLength(1);
  expect(saved.tasksUpdatedAt).toBe(planned.tasksUpdatedAt);
  expect(Date.parse(saved.lastActivityAt!)).toBeGreaterThanOrEqual(
    Date.parse(planned.lastActivityAt!),
  );
  expect(legacy.lastActivityAt).toBe(saved.lastActivityAt);

  // Work that does not otherwise save the session, such as a source commit.
  const touched = await recordSessionActivity(fresh.id);
  expect(Date.parse(touched!.lastActivityAt!)).toBeGreaterThanOrEqual(
    Date.parse(begun.lastActivityAt!),
  );
  expect((await readSession(fresh.id))!.lastActivityAt).toBe(
    touched!.lastActivityAt,
  );
  expect(await recordSessionActivity("session_unknown")).toBeUndefined();

  // Sessions finished without changes are left untouched.
  const closed = { ...sample("session_closed"), status: "no_changes" as const };
  const closedPath = join(root, "sessions", `${closed.id}.json`);
  await writeFile(closedPath, `${JSON.stringify(closed, null, 2)}\n`);
  const closedBytes = await readFile(closedPath, "utf8");
  expect((await recordSessionActivity(closed.id))?.lastActivityAt).toBe(
    undefined,
  );
  expect(await readFile(closedPath, "utf8")).toBe(closedBytes);
  expect(await recordLocks(root)).toEqual([]);
});

it("waits for the session record lock and serializes competing heartbeat writes", async () => {
  const root = await storage();
  const session = sample("session_locked");
  await writeSession(session);
  const before = (await readSession(session.id))!;

  // A held record lock blocks the heartbeat until its owner releases it.
  const lock = join(root, "locks", `session-record-${session.id}`);
  await writeFile(lock, "{}\n", { flag: "wx" });
  let settled = false;
  const pending = recordSessionActivity(session.id).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(settled).toBe(false);
  expect(await readSession(session.id)).toEqual(before);
  await rm(lock);
  const touched = (await pending)!;
  expect(Date.parse(touched.lastActivityAt!)).toBeGreaterThan(
    Date.parse(before.lastActivityAt!),
  );

  // Checklist edits, heartbeats and a stale lifecycle save interleave safely.
  const stale = { ...before, status: "ready" as const, readyCommit: "exact" };
  await Promise.all([
    ...Array.from({ length: 4 }, (_, index) =>
      updateSessionTasks(session.id, (tasks) =>
        editTasks(tasks, { action: "add", titles: [`Task ${index}`] }),
      ),
    ),
    ...Array.from({ length: 4 }, () => recordSessionActivity(session.id)),
    writeSession(stale),
  ]);
  const saved = (await readSession(session.id))!;
  expect(saved.tasks).toHaveLength(4);
  expect(saved.status).toBe("ready");
  expect(Date.parse(saved.lastActivityAt!)).toBeGreaterThanOrEqual(
    Date.parse(saved.tasksUpdatedAt!),
  );
  expect(await recordLocks(root)).toEqual([]);
});

type Variant = "new" | "legacy" | "older-coordinator";

async function lifecycleFixture() {
  const root = await mkdtemp(join(tmpdir(), "sesh-activity-cli-"));
  roots.push(root);
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  await mkdir(repo);
  const env = {
    ...process.env,
    SESH_INTEGRATOR_HOME: runtime,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
  };
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const run = (cli: string, args: string[], cwd = repo, code = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(
      result.status,
      `${args.join(" ")}\n${result.stdout}${result.stderr}`,
    ).toBe(code);
    return result.stdout;
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  await writeFile(join(repo, "shared.txt"), "base\n");
  git(["add", "shared.txt"]);
  git(["commit", "-m", "base"]);
  run(currentCli, ["register"]);
  const recordPath = (id: string) => join(runtime, "sessions", `${id}.json`);
  const record = async (id: string) =>
    JSON.parse(await readFile(recordPath(id), "utf8")) as Session;
  const begin = async (cli: string, summary: string) => {
    const output = run(cli, [
      "begin",
      "--create-worktree",
      "--summary",
      summary,
    ]);
    const id = /Started (session_\S+)/.exec(output)?.[1];
    expect(id, output).toBeTruthy();
    return record(id!);
  };
  return { repo, runtime, git, run, record, recordPath, begin };
}

/**
 * Drives one session through commit, validate, a conflicting integrate and
 * resume. `legacy` strips the heartbeat before every command; the older
 * coordinator variant uses `SESH_COMPAT_CLI` for every lifecycle command.
 */
async function lifecycleFlow(variant: Variant) {
  const f = await lifecycleFixture();
  const lifecycle = variant === "older-coordinator" ? olderCli! : currentCli;
  const blocker = await f.begin(currentCli, "Blocker");
  let subject = await f.begin(lifecycle, "Subject");
  const id = subject.id;
  if (variant === "older-coordinator") {
    // The current `seshx tasks` adds the field to an older session's record.
    f.run(currentCli, ["tasks", "add", "--title", "Plan", "--session", id]);
    subject = await f.record(id);
    expect(subject.lastActivityAt).toBe(subject.tasksUpdatedAt);
  } else expect(subject.lastActivityAt).toBeTruthy();
  const strip = async () => {
    if (variant !== "legacy") return;
    await writeFile(
      f.recordPath(id),
      `${JSON.stringify(withoutHeartbeat(await f.record(id)), null, 2)}\n`,
    );
  };
  await strip();

  // Observing a session never records activity.
  const observed = await readFile(f.recordPath(id), "utf8");
  f.run(lifecycle, ["status"], subject.worktreePath);
  f.run(lifecycle, ["status", "--session", id]);
  f.run(lifecycle, ["tasks", "list"], subject.worktreePath);
  f.run(lifecycle, ["tasks", "list", "--session", id]);
  const audit = JSON.parse(f.run(currentCli, ["sessions", "audit", "--json"]))
    .sessions as SessionAudit[];
  expect(await readFile(f.recordPath(id), "utf8")).toBe(observed);
  expect(audit.find((row) => row.sessionId === id)?.lastActivity?.source).toBe(
    variant === "legacy" ? "startedAt" : "lastActivityAt",
  );

  const step = async (args: string[], code = 0) => {
    await strip();
    const prior = (await f.record(id)).lastActivityAt;
    const output = f.run(lifecycle, args, subject.worktreePath, code);
    const after = (await f.record(id)).lastActivityAt;
    if (variant === "older-coordinator") {
      // Older lifecycle code preserves the field without refreshing it.
      expect(after, args[0]).toBe(prior);
    } else {
      expect(after, args[0]).toBeTruthy();
      if (prior)
        expect(Date.parse(after!), args[0]).toBeGreaterThan(Date.parse(prior));
    }
    return output;
  };

  // The blocker lands first so the subject's integration conflicts.
  await writeFile(join(blocker.worktreePath, "shared.txt"), "blocker\n");
  f.git(["add", "shared.txt"], blocker.worktreePath);
  f.git(["commit", "-m", "blocker"], blocker.worktreePath);
  f.run(
    currentCli,
    ["integrate", "--summary", "Blocker done", "--rollout", "none"],
    blocker.worktreePath,
  );

  await writeFile(join(subject.worktreePath, "shared.txt"), "subject\n");
  f.git(["add", "shared.txt"], subject.worktreePath);
  await step(["commit", "--message", "Subject change"]);
  await step(["validate"]);
  await step(
    ["integrate", "--summary", "Subject done", "--rollout", "none"],
    1,
  );
  const pending = await f.record(id);
  expect(pending.status).toBe("needs_review");
  expect(pending.awaitingConflictResolution).toBe(true);

  const integration =
    pending.integrationWorktreePath ??
    join(f.runtime, "worktrees", pending.repositoryId);
  await writeFile(join(integration, "shared.txt"), "blocker\nsubject\n");
  f.git(["add", "shared.txt"], integration);
  await step(["resume"]);
  const finished = await f.record(id);
  expect(finished.status).toBe("succeeded");
  expect(f.git(["show", "main:shared.txt"])).toBe("blocker\nsubject");
  return finished;
}

it.each(["new", "legacy"] as const)(
  "loads, integrates and resumes a %s record through the current lifecycle",
  async (variant) => {
    const finished = await lifecycleFlow(variant);
    expect(finished.lastActivityAt).toBeTruthy();
  },
  60000,
);

it.skipIf(!olderCli)(
  "lets an older coordinator read, preserve and resume a record carrying the heartbeat",
  async () => {
    const finished = await lifecycleFlow("older-coordinator");
    expect(finished.lastActivityAt).toBe(finished.tasksUpdatedAt);
  },
  60000,
);
