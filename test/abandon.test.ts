import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AbandonRefusal,
  abandonSession,
  validateAbandonReason,
} from "../src/abandon.js";
import {
  preflightRuntimeCompatibility,
  unfinished,
} from "../src/coordinator.js";
import {
  actionReason,
  defaultDashboardView,
  detailLines,
  filterDashboard,
  loadDashboard,
  needsAttention,
  type DashboardRow,
} from "../src/dashboard.js";
import { webRow } from "../src/dashboard-web.js";
import { webScript } from "../src/dashboard-web-assets.js";
import {
  readSession,
  recordSessionActivity,
  updateSessionTasks,
  writeSession,
} from "../src/runtime.js";
import { classifySession, type SessionAudit } from "../src/session-audit.js";
import { currentTask, editTasks } from "../src/tasks.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const currentCli = join(process.cwd(), "dist", "cli.js");
/**
 * Optional previously installed coordinator (see docs/development.md). When
 * set, an extra test checks that it neither crashes on nor reopens an
 * abandoned record and can continue a restored one.
 */
const olderCli = process.env.SESH_COMPAT_CLI;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sesh-abandon-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const repo = join(root, "repo");
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
  const exec = (args: string[], cwd = repo, cli = currentCli) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    return {
      code: result.status,
      stdout: result.stdout,
      output: result.stdout + result.stderr,
    };
  };
  const run = (args: string[], cwd = repo, code = 0, cli = currentCli) => {
    const result = exec(args, cwd, cli);
    expect(result.code, `${args.join(" ")}\n${result.output}`).toBe(code);
    return result.output;
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  await writeFile(join(repo, "base.txt"), "base\n");
  git(["add", "base.txt"]);
  git(["commit", "-m", "base"]);
  run(["register"]);
  const recordPath = (id: string) => join(runtime, "sessions", `${id}.json`);
  const raw = (id: string) => readFile(recordPath(id), "utf8");
  const record = async (id: string) => JSON.parse(await raw(id)) as Session;
  const save = (session: Session) =>
    writeFile(recordPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
  const begin = async (summary: string, cli = currentCli) => {
    const output = run(
      ["begin", "--create-worktree", "--summary", summary],
      repo,
      0,
      cli,
    );
    const id = /Started (session_\S+)/.exec(output)?.[1];
    expect(id, output).toBeTruthy();
    return record(id!);
  };
  const clone = async (
    session: Session,
    suffix: string,
    changes: Partial<Session>,
  ) => {
    const copy = { ...session, ...changes, id: `${session.id}_${suffix}` };
    await save(copy);
    return copy;
  };
  const abandon = (id: string, extra: string[] = [], code = 0) =>
    run(
      ["abandon", "--session", id, "--reason", "Stale test", ...extra],
      repo,
      code,
    );
  /** Git refs and worktrees, which abandon and restore must never change. */
  const gitState = () => [
    git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    git(["worktree", "list", "--porcelain"]),
  ];
  return {
    root,
    runtime,
    repo,
    env,
    git,
    exec,
    run,
    raw,
    record,
    save,
    begin,
    clone,
    abandon,
    gitState,
  };
}

/** Every path, type, size, mtime and content hash under the given roots. */
async function snapshot(paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      result[path] = `link ${await readlink(path)}`;
    } else if (entry.isDirectory()) {
      result[path] = `dir ${entry.mtimeMs}`;
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name));
    } else {
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      result[path] = `file ${entry.size} ${entry.mtimeMs} ${hash}`;
    }
  };
  for (const path of paths) await walk(path);
  return result;
}

it("shows the audit, abandons only the record and lists the session separately", async () => {
  const f = await fixture();
  const stale = await f.begin("Stale task");
  const other = await f.begin("Other task");
  const gitBefore = f.gitState();
  const filesBefore = await snapshot([stale.worktreePath, f.repo]);
  const before = await f.record(stale.id);

  const output = f.run([
    "abandon",
    "--session",
    stale.id,
    "--reason",
    "Superseded by the other task",
  ]);
  expect(output).toContain("Session audit before abandoning");
  expect(output).toMatch(new RegExp(`${stale.id}  \\[empty\\]`));
  expect(output).toContain("    - worktree clean");
  expect(output).toContain(`Abandoned ${stale.id} at `);
  expect(output).toContain("(was active, bucket empty)");
  expect(output).toContain(`restore: seshx restore --session ${stale.id}`);
  expect(output.indexOf("[empty]")).toBeLessThan(output.indexOf("Abandoned "));

  const saved = await f.record(stale.id);
  expect(saved.status).toBe("abandoned");
  expect(saved.abandonment).toMatchObject({
    reason: "Superseded by the other task",
    previousStatus: "active",
    bucket: "empty",
  });
  expect(saved.abandonment!.evidence).toContain("worktree clean");
  expect(saved.abandonment!.includedUnsaved).toBeUndefined();
  expect(Date.parse(saved.abandonment!.abandonedAt)).toBeGreaterThanOrEqual(
    Date.parse(before.lastActivityAt!),
  );
  // The heartbeat keeps the pre-abandon idle evidence.
  expect(saved.lastActivityAt).toBe(before.lastActivityAt);
  expect(unfinished(saved)).toBe(false);
  // Branch, worktree, commits and files are untouched.
  expect(f.gitState()).toEqual(gitBefore);
  expect(await snapshot([stale.worktreePath, f.repo])).toEqual(filesBefore);

  const status = f.run(["status"]);
  const [open, closed] = status.split("\nAbandoned sessions: ");
  expect(open).toContain("Sessions: 1\n");
  expect(open).toContain(other.id);
  expect(open).not.toContain(stale.id);
  expect(closed).toMatch(/^1 \(terminal;/);
  expect(closed).toContain(`${stale.id}  abandoned`);
  expect(closed).toContain("abandon reason: Superseded by the other task");
  expect(closed).toContain(`restore: seshx restore --session ${stale.id}`);
  const detail = f.run(["status", "--session", stale.id]);
  expect(detail).toContain("abandoned: ");
  expect(detail).toContain("abandon evidence: worktree clean");
  expect(detail).not.toContain("Abandoned sessions:");

  const audit = JSON.parse(f.run(["sessions", "audit", "--json"]));
  expect(audit.sessions.map((row: SessionAudit) => row.sessionId)).toEqual([
    other.id,
  ]);

  // Lifecycle and checklist commands refuse it and never reopen it.
  const recorded = await f.raw(stale.id);
  await writeFile(join(stale.worktreePath, "late.txt"), "late\n");
  f.git(["add", "late.txt"], stale.worktreePath);
  for (const args of [
    ["commit", "--message", "late"],
    ["validate"],
    ["integrate", "--summary", "late", "--rollout", "none"],
    ["finish", "--no-changes", "--summary", "late"],
    ["tasks", "add", "--title", "late"],
    ["resume", "--session", stale.id],
    ["validate", "--session", stale.id],
  ]) {
    const output = f.run(args, stale.worktreePath, 1);
    expect(output, args.join(" ")).toMatch(
      /abandoned|not resumable \(abandoned\)/,
    );
  }
  expect(f.run(["tasks", "list"], stale.worktreePath)).toContain(
    "Current: Abandoned",
  );
  expect(await f.raw(stale.id)).toBe(recorded);
  expect(f.git(["rev-parse", stale.branch])).toBe(stale.startCommit);
  // Repeating is refused.
  expect(f.abandon(stale.id, [], 1)).toContain("already abandoned");
  expect(await f.raw(stale.id)).toBe(recorded);
});

it("refuses sessions in lifecycle or recovery state, holding a lock, or finished", async () => {
  const f = await fixture();
  const base = await f.begin("Base");
  const locks = join(f.runtime, "locks");
  const lockOwner = (sessionId: string) => ({
    pid: process.pid,
    hostname: hostname(),
    sessionId,
    acquiredAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  });
  // A readable manifest lets the compatibility preflight pass, so the
  // archived bundle itself is what abandon refuses.
  const bundle = join(f.runtime, "recovery-bundles", "attempt");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "manifest.json"), '{"version":1}\n');
  const cases: [Session, RegExp][] = [
    [
      await f.clone(base, "ready", {
        status: "ready",
        readyCommit: base.startCommit,
      }),
      /status is ready/,
    ],
    [await f.clone(base, "review", { status: "needs_review" }), /needs_review/],
    [
      await f.clone(base, "validation", { status: "validation_pending" }),
      /validation_pending/,
    ],
    [
      await f.clone(base, "promotion", { status: "promotion_pending" }),
      /promotion_pending/,
    ],
    [
      await f.clone(base, "waiting", { waitingForLock: true }),
      /waiting for the repository lock/,
    ],
    [
      await f.clone(base, "merge", { recoveryPhase: "merge" }),
      /recovery phase merge/,
    ],
    [
      await f.clone(base, "bundle", {
        recoveryBundle: {
          version: 1,
          attemptId: "attempt",
          path: bundle,
          manifestHash: "hash",
          state: "archived",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      }),
      /archived recovery bundle/,
    ],
    [
      await f.clone(base, "succeeded", { status: "succeeded" }),
      /already finished \(succeeded\)/,
    ],
    [
      await f.clone(base, "nochange", { status: "no_changes" }),
      /already finished \(no_changes\)/,
    ],
  ];
  // A session holding the repository lock, and one whose record is locked.
  const repoLocked = await f.clone(base, "repolock", {});
  const repoLock = join(locks, `${base.repositoryId}.lock`);
  await writeFile(repoLock, JSON.stringify(lockOwner(repoLocked.id)));
  cases.push([repoLocked, /holds repository lock/]);
  const recordLocked = await f.clone(base, "recordlock", {});
  const recordLock = join(locks, `session-record-${recordLocked.id}`);
  await writeFile(recordLock, JSON.stringify(lockOwner(recordLocked.id)));
  cases.push([recordLocked, /session record lock present/]);

  const gitBefore = f.gitState();
  for (const [session, reason] of cases) {
    const before = await f.raw(session.id);
    const output = f.abandon(session.id, ["--include-unsaved"], 1);
    expect(output, session.id).toMatch(reason);
    expect(output, session.id).toMatch(/Refusing to abandon|already finished/);
    expect(await f.raw(session.id), session.id).toBe(before);
  }
  // Locks are left exactly as found.
  expect(JSON.parse(await readFile(repoLock, "utf8")).sessionId).toBe(
    repoLocked.id,
  );
  expect(JSON.parse(await readFile(recordLock, "utf8")).sessionId).toBe(
    recordLocked.id,
  );
  expect(f.gitState()).toEqual(gitBefore);

  // Argument and reason validation never touch the record.
  const before = await f.raw(base.id);
  for (const args of [
    ["abandon", "--session", base.id],
    ["abandon", "--reason", "x"],
    ["abandon", "--session", base.id, "--reason", "   "],
    ["abandon", "--session", base.id, "--reason", "two\nlines"],
    ["abandon", "--session", base.id, "--reason", "x".repeat(501)],
    ["abandon", "--session", base.id, "--reason", "x", "--force"],
    ["abandon", "--session", "session_unknown", "--reason", "x"],
    ["abandon", "--session", "../escape", "--reason", "x"],
    ["restore"],
    ["restore", "--session", base.id],
  ])
    expect(f.exec(args).code, args.join(" ")).toBe(1);
  expect(await f.raw(base.id)).toBe(before);
  expect(() => validateAbandonReason(" ok ")).not.toThrow();
});

it("requires --include-unsaved for uncommitted or unintegrated work", async () => {
  const f = await fixture();
  const dirty = await f.begin("Dirty");
  await writeFile(join(dirty.worktreePath, "draft.txt"), "draft\n");
  const committed = await f.begin("Committed");
  await writeFile(join(committed.worktreePath, "feature.txt"), "feature\n");
  f.git(["add", "feature.txt"], committed.worktreePath);
  f.git(["commit", "-m", "feature"], committed.worktreePath);
  const head = f.git(["rev-parse", committed.branch]);

  for (const [session, evidence] of [
    [dirty, "uncommitted path(s) in worktree: draft.txt"],
    [committed, "commit(s) at"],
  ] as const) {
    const before = await f.raw(session.id);
    const refused = f.abandon(session.id, [], 1);
    expect(refused).toContain("[unsaved work]");
    expect(refused).toContain(evidence);
    expect(refused).toContain("rerun with --include-unsaved");
    expect(await f.raw(session.id)).toBe(before);

    const output = f.abandon(session.id, ["--include-unsaved"]);
    expect(output).toContain("(was active, bucket unsaved)");
    const saved = await f.record(session.id);
    expect(saved.status).toBe("abandoned");
    expect(saved.abandonment).toMatchObject({
      bucket: "unsaved",
      includedUnsaved: true,
    });
    expect(saved.abandonment!.evidence.join("\n")).toContain(evidence);
  }
  // The unsaved work itself stays exactly where it was.
  expect(await readFile(join(dirty.worktreePath, "draft.txt"), "utf8")).toBe(
    "draft\n",
  );
  expect(f.git(["status", "--porcelain"], dirty.worktreePath)).toBe(
    "?? draft.txt",
  );
  expect(f.git(["rev-parse", committed.branch])).toBe(head);
});

it("rechecks under the record lock and rejects stale saves of an abandoned session", async () => {
  const f = await fixture();
  vi.stubEnv("SESH_INTEGRATOR_HOME", f.runtime);
  const session = await f.begin("Recheck");
  const preview = {
    session,
    audit: await classifySession(session),
  };
  // Activity after the preview, here a checklist edit, makes it stale.
  f.run(["tasks", "add", "--title", "Plan", "--session", session.id]);
  const edited = await f.raw(session.id);
  const refusal = await abandonSession(session.id, {
    reason: "Stale",
    preview,
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(AbandonRefusal);
  expect((refusal as Error).message).toContain(
    "changed after it was inspected",
  );
  expect(await f.raw(session.id)).toBe(edited);

  // Without a supplied preview the current state is inspected and used.
  const snapshot = (await readSession(session.id))!;
  const { session: abandoned, audit } = await abandonSession(session.id, {
    reason: "Stale",
  });
  expect(abandoned.status).toBe("abandoned");
  expect(audit.bucket).toBe("other");
  expect(abandoned.abandonment!.bucket).toBe("other");
  const recorded = await f.raw(session.id);

  // A lifecycle save from a stale snapshot cannot reopen it, a heartbeat is
  // skipped, checklist edits are refused, and nothing else can abandon it.
  await expect(writeSession({ ...snapshot })).rejects.toThrow(
    `seshx restore --session ${session.id}`,
  );
  expect((await recordSessionActivity(session.id))?.status).toBe("abandoned");
  await expect(
    updateSessionTasks(session.id, (tasks) =>
      editTasks(tasks, { action: "add", titles: ["Late"] }),
    ),
  ).rejects.toThrow("was abandoned");
  expect(await f.raw(session.id)).toBe(recorded);
  const other = await f.begin("Other");
  await expect(writeSession({ ...other, status: "abandoned" })).rejects.toThrow(
    "only with seshx abandon",
  );
  expect((await f.record(other.id)).status).toBe("active");

  // Abandoned sessions no longer count for coordinator compatibility checks.
  const incompatible = {
    ...abandoned,
    coordinator: { ...abandoned.coordinator!, stateContract: 99 },
  };
  await f.save(incompatible);
  await expect(preflightRuntimeCompatibility()).resolves.toBeUndefined();
  await f.save({ ...incompatible, status: "active" });
  await expect(preflightRuntimeCompatibility()).rejects.toThrow(
    "Incompatible session",
  );
  await f.save(abandoned);
});

it("restores an abandoned session to active and continues its lifecycle", async () => {
  const f = await fixture();
  const session = await f.begin("Restorable");
  f.run(["tasks", "add", "--title", "Implement", "--session", session.id]);
  f.abandon(session.id);
  const abandoned = await f.record(session.id);
  const gitBefore = f.gitState();

  const output = f.run(["restore", "--session", session.id], f.root);
  expect(output).toContain(`Restored ${session.id} to active.`);
  expect(output).toContain("reason: Stale test");
  expect(output).toContain(`Continue task in: ${session.worktreePath}`);
  const restored = await f.record(session.id);
  expect(restored.status).toBe("active");
  expect(restored.abandonment).toBeUndefined();
  expect(restored.abandonmentHistory).toEqual([
    { ...abandoned.abandonment, restoredAt: restored.lastActivityAt },
  ]);
  expect(Date.parse(restored.lastActivityAt!)).toBeGreaterThan(
    Date.parse(abandoned.lastActivityAt!),
  );
  expect(restored.tasks).toEqual(abandoned.tasks);
  expect(f.gitState()).toEqual(gitBefore);
  expect(f.run(["status", "--session", session.id])).toContain("restored: ");
  // Restoring again is refused.
  expect(f.run(["restore", "--session", session.id], f.repo, 1)).toContain(
    "Only an abandoned session can be restored",
  );

  // A restore never takes over a worktree another unfinished session uses.
  const claimed = await f.clone(abandoned, "claimed", {});
  const claimedBefore = await f.raw(claimed.id);
  expect(f.run(["restore", "--session", claimed.id], f.repo, 1)).toContain(
    `now belongs to unfinished session ${session.id}`,
  );
  expect(await f.raw(claimed.id)).toBe(claimedBefore);

  // The restored session finishes its normal lifecycle.
  await writeFile(join(session.worktreePath, "feature.txt"), "feature\n");
  f.git(["add", "feature.txt"], session.worktreePath);
  f.run(
    ["tasks", "update", "1", "--status", "completed"],
    session.worktreePath,
  );
  f.run(["commit", "--message", "Feature"], session.worktreePath);
  f.run(["validate"], session.worktreePath);
  f.run(
    ["integrate", "--summary", "Feature done", "--rollout", "none"],
    session.worktreePath,
  );
  expect((await f.record(session.id)).status).toBe("succeeded");
  expect(f.git(["show", "main:feature.txt"])).toBe("feature");
}, 60000);

it("shows abandoned sessions separately in the dashboards", async () => {
  const f = await fixture();
  vi.stubEnv("SESH_INTEGRATOR_HOME", f.runtime);
  const open = await f.begin("Open");
  const stale = await f.begin("Stale");
  f.abandon(stale.id);
  let rows = await loadDashboard();
  const find = (id: string) => rows.find((row) => row.session?.id === id)!;
  const abandonedRow: DashboardRow = find(stale.id);
  const ids = (filter: (typeof defaultDashboardView)["filter"]) =>
    filterDashboard(rows, { ...defaultDashboardView, filter }).map(
      (row) => row.session?.id,
    );
  expect(ids("abandoned")).toEqual([stale.id]);
  for (const filter of [
    "all",
    "active",
    "completed",
    "review",
    "needs attention",
  ] as const)
    expect(ids(filter), filter).not.toContain(stale.id);
  expect(ids("active")).toEqual([open.id]);
  expect(needsAttention(abandonedRow)).toBe(false);
  expect(currentTask(abandonedRow.session)).toBe("Abandoned");
  for (const action of ["validate", "integrate", "resume"] as const)
    expect(actionReason(abandonedRow, action)).toContain(
      `seshx restore --session ${stale.id}`,
    );
  const details = detailLines(abandonedRow);
  expect(details).toContain("Abandon reason: Stale test");
  expect(details).toContain(`Restore: seshx restore --session ${stale.id}`);
  const web = webRow(abandonedRow);
  expect(web.status).toBe("abandoned");
  expect(web.attention).toBe(false);
  expect(web.next).toContain(`seshx restore --session ${stale.id}`);
  expect(Object.values(web.actions).every((reason) => reason)).toBe(true);
  expect(webScript).toContain('abandoned: "Abandoned"');

  // A repository whose only session is abandoned keeps its empty row.
  f.run(["finish", "--no-changes", "--summary", "Done"], open.worktreePath);
  f.abandon(open.id, [], 1);
  rows = await loadDashboard();
  expect(rows.filter((row) => !row.session)).toHaveLength(0);
  const lonely = await f.clone(await f.record(stale.id), "only", {});
  await rm(join(f.runtime, "sessions", `${open.id}.json`));
  await rm(join(f.runtime, "sessions", `${stale.id}.json`));
  rows = await loadDashboard();
  expect(rows.map((row) => row.session?.id)).toEqual([lonely.id, undefined]);
  expect(ids("all")).toEqual([undefined]);
  expect(ids("abandoned")).toEqual([lonely.id]);
});

it.skipIf(!olderCli)(
  "lets an older coordinator read an abandoned record without reopening it, then continue after restore",
  async () => {
    const f = await fixture();
    const session = await f.begin("Older coordinator task", olderCli!);
    expect(session.coordinator?.cliPath).not.toBe(currentCli);
    f.abandon(session.id);
    const recorded = await f.raw(session.id);
    const older = (args: string[], cwd = session.worktreePath) =>
      f.exec(args, cwd, olderCli!);

    const crashed = /TypeError|ReferenceError|at .*\.js:\d+/;
    // Explicit observation works.
    for (const args of [
      ["status"],
      ["status", "--session", session.id],
      ["tasks", "list", "--session", session.id],
    ]) {
      const result = older(args);
      expect(result.code, `${args.join(" ")}\n${result.output}`).toBe(0);
    }
    expect(older(["status"]).stdout).toContain(`${session.id}  abandoned`);
    // Inferred lookups and the audit may not know the status, but never crash.
    for (const args of [
      ["tasks", "list"],
      ["sessions", "audit"],
    ]) {
      const result = older(args);
      expect(
        result.code === 0 ||
          /Unknown command|session exists/.test(result.output),
        `${args.join(" ")}\n${result.output}`,
      ).toBe(true);
      expect(result.output).not.toMatch(crashed);
    }
    // Mutations are refused without crashing or reopening the session.
    await writeFile(join(session.worktreePath, "late.txt"), "late\n");
    f.git(["add", "late.txt"], session.worktreePath);
    for (const args of [
      ["tasks", "add", "--title", "Late"],
      ["tasks", "add", "--title", "Late", "--session", session.id],
      ["commit", "--message", "Late"],
      ["validate"],
      ["validate", "--session", session.id],
      ["integrate", "--summary", "Late", "--rollout", "none"],
      ["finish", "--no-changes", "--summary", "Late"],
      ["resume"],
      ["resume", "--session", session.id],
    ]) {
      const result = older(args);
      expect(result.code, `${args.join(" ")}\n${result.output}`).toBe(1);
      expect(result.output, args.join(" ")).not.toMatch(crashed);
    }
    // Beginning another task from the launch checkout leaves it alone.
    const next = f.exec(
      ["begin", "--create-worktree", "--summary", "Next"],
      f.repo,
      olderCli!,
    );
    expect(next.code, next.output).toBe(0);
    expect(await f.raw(session.id)).toBe(recorded);
    expect(f.git(["rev-parse", session.branch])).toBe(session.startCommit);

    // After a restore by the current CLI the older coordinator continues it.
    f.run(["restore", "--session", session.id]);
    const commit = older(["commit", "--message", "Late"]);
    expect(commit.code, commit.output).toBe(0);
    const validate = older(["validate"]);
    expect(validate.code, validate.output).toBe(0);
    const integrate = older([
      "integrate",
      "--summary",
      "Late done",
      "--rollout",
      "none",
    ]);
    expect(integrate.code, integrate.output).toBe(0);
    const finished = await f.record(session.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.abandonmentHistory).toHaveLength(1);
    expect(f.git(["show", "main:late.txt"])).toBe("late");
  },
  90000,
);
