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
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  idleDays,
  lastActivity,
  type SessionAudit,
} from "../src/session-audit.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface AuditReport {
  readOnly: boolean;
  liveness: string;
  counts: Record<string, number>;
  sessions: SessionAudit[];
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sesh-session-audit-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const env = {
    ...process.env,
    SESH_INTEGRATOR_HOME: runtime,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const run = (args: string[], cwd: string, code = 0) => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "dist/cli.js"), ...args],
      { cwd, env, encoding: "utf8", timeout: 20000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(code);
    return result.stdout;
  };
  const createRepo = async (name: string) => {
    const repo = join(root, name);
    await mkdir(repo);
    git(["init", "-b", "main"], repo);
    git(["config", "user.name", "Test"], repo);
    git(["config", "user.email", "test@example.test"], repo);
    await writeFile(join(repo, "README.txt"), "base\n");
    git(["add", "README.txt"], repo);
    git(["commit", "-m", "base"], repo);
    run(["register"], repo);
    return repo;
  };
  const recordPath = (id: string) => join(runtime, "sessions", `${id}.json`);
  const record = async (id: string): Promise<Session> =>
    JSON.parse(await readFile(recordPath(id), "utf8")) as Session;
  const save = async (session: Session) =>
    writeFile(recordPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
  const begin = async (repo: string, summary: string): Promise<Session> => {
    const output = run(
      ["begin", "--create-worktree", "--summary", summary],
      repo,
    );
    const id = /Started (session_\S+)/.exec(output)?.[1];
    expect(id, output).toBeTruthy();
    return record(id!);
  };
  /** Copies a record under a new ID, modelling states without full lifecycles. */
  const clone = async (
    session: Session,
    suffix: string,
    changes: Partial<Session>,
  ): Promise<Session> => {
    const copy = { ...session, ...changes, id: `${session.id}_${suffix}` };
    await save(copy);
    return copy;
  };
  const audit = (cwd: string, args: string[] = []): AuditReport =>
    JSON.parse(run(["sessions", "audit", "--json", ...args], cwd));
  return {
    root,
    runtime,
    git,
    run,
    createRepo,
    record,
    save,
    begin,
    clone,
    audit,
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

const byId = (report: AuditReport, id: string): SessionAudit => {
  const found = report.sessions.filter((audit) => audit.sessionId === id);
  expect(found, `exactly one audit row for ${id}`).toHaveLength(1);
  return found[0]!;
};

it("classifies empty, delivered, unsaved and other sessions without changing any state", async () => {
  const f = await fixture();
  const repo = await f.createRepo("repo");

  const empty = await f.begin(repo, "Empty session");
  // Stale index stat data: a plain `git status` would rewrite the index.
  const touched = new Date(Date.now() + 60_000);
  await utimes(join(empty.worktreePath, "README.txt"), touched, touched);

  const planned = await f.begin(repo, "Planned only");
  f.run(["tasks", "add", "--title", "Inspect", "--session", planned.id], repo);

  const delivered = await f.begin(repo, "Delivered work");
  await writeFile(join(delivered.worktreePath, "delivered.txt"), "done\n");
  f.git(["add", "delivered.txt"], delivered.worktreePath);
  f.git(["commit", "-m", "deliver"], delivered.worktreePath);
  f.git(["merge", "--ff-only", delivered.branch], repo);

  const dirty = await f.begin(repo, "Uncommitted work");
  await writeFile(join(dirty.worktreePath, "README.txt"), "edited\n");
  await writeFile(join(dirty.worktreePath, "draft.txt"), "draft\n");

  const committed = await f.begin(repo, "Unintegrated commit");
  await writeFile(join(committed.worktreePath, "feature.txt"), "feature\n");
  f.git(["add", "feature.txt"], committed.worktreePath);
  f.git(["commit", "-m", "feature"], committed.worktreePath);

  const finished = await f.clone(empty, "done", { status: "succeeded" });
  const noChanges = await f.clone(empty, "nochange", { status: "no_changes" });

  const queue = process.env.SESH_BUILD_QUEUE_HOME!;
  const refs = () =>
    [
      f.git(["for-each-ref", "--format=%(refname) %(objectname)"], repo),
      f.git(["worktree", "list", "--porcelain"], repo),
    ].join("\n");
  const beforeRefs = refs();
  const before = await snapshot([f.root, queue]);
  const report = f.audit(repo);
  const text = f.run(["sessions", "audit"], repo);
  expect(await snapshot([f.root, queue])).toEqual(before);
  expect(refs()).toBe(beforeRefs);

  expect(report.readOnly).toBe(true);
  expect(report.liveness).toBe("inferred, never proven");
  expect(report.sessions.map((audit) => audit.sessionId).sort()).toEqual(
    [empty.id, planned.id, delivered.id, dirty.id, committed.id].sort(),
  );
  for (const id of [finished.id, noChanges.id])
    expect(report.sessions.some((audit) => audit.sessionId === id)).toBe(false);

  const emptyAudit = byId(report, empty.id);
  expect(emptyAudit.bucket).toBe("empty");
  expect(emptyAudit.evidence).toEqual([
    `no commits since start ${empty.startCommit.slice(0, 12)}`,
    "worktree clean",
    "no checklist",
  ]);
  expect(emptyAudit.idleDays).toBe(0);
  expect(emptyAudit.lastActivity?.source).toBe("startedAt");

  const plannedAudit = byId(report, planned.id);
  expect(plannedAudit.bucket).toBe("other");
  expect(plannedAudit.evidence.join("\n")).toContain("checklist present");
  expect(plannedAudit.lastActivity?.source).toBe("tasksUpdatedAt");

  const deliveredAudit = byId(report, delivered.id);
  expect(deliveredAudit.bucket).toBe("delivered");
  expect(deliveredAudit.evidence[0]).toContain(
    "(1 commit(s) since start) is reachable from target main",
  );
  expect(deliveredAudit.facts.unintegratedCommits).toBe(0);

  const dirtyAudit = byId(report, dirty.id);
  expect(dirtyAudit.bucket).toBe("unsaved");
  expect(dirtyAudit.evidence).toEqual([
    "2 uncommitted path(s) in worktree: README.txt, draft.txt",
  ]);

  const committedAudit = byId(report, committed.id);
  expect(committedAudit.bucket).toBe("unsaved");
  expect(committedAudit.evidence[0]).toMatch(
    /^1 commit\(s\) at [0-9a-f]{12} not reachable from target main/,
  );

  expect(report.counts).toEqual({
    empty: 1,
    delivered: 1,
    unsaved: 2,
    corrupt: 0,
    lifecycle: 0,
    other: 1,
  });
  expect(text).toContain("Session audit (read-only; nothing was changed)");
  expect(text).toContain(
    "Liveness is inferred from session records, Git and file times, never proven.",
  );
  for (const label of ["[empty]", "[delivered]", "[unsaved work]", "[other]"])
    expect(text).toContain(label);
  expect(text).toContain(
    "Buckets: empty 1, delivered 1, unsaved work 2, corrupt 0, in lifecycle 0, other 1",
  );
});

it("classifies corrupt and in-lifecycle sessions, preferring lifecycle and unsaved work", async () => {
  const f = await fixture();
  const repo = await f.createRepo("repo");
  const base = await f.begin(repo, "Base for modelled states");

  const missingWorktree = await f.begin(repo, "Worktree removed");
  await rm(missingWorktree.worktreePath, { recursive: true, force: true });

  const missingBranch = await f.begin(repo, "Branch deleted");
  f.git(["checkout", "--quiet", "--detach"], missingBranch.worktreePath);
  f.git(["branch", "-D", missingBranch.branch], repo);

  const missingCoordinator = await f.clone(base, "coordinator", {
    coordinator: {
      ...base.coordinator!,
      cliPath: join(f.root, "missing-release", "dist", "cli.js"),
    },
  });
  // Unsaved work outranks corruption so batch closing never selects it.
  const corruptButDirty = await f.begin(repo, "Dirty with lost coordinator");
  await writeFile(join(corruptButDirty.worktreePath, "keep.txt"), "keep\n");
  await f.save({
    ...corruptButDirty,
    coordinator: {
      ...corruptButDirty.coordinator!,
      cliPath: join(f.root, "missing-release", "dist", "cli.js"),
    },
  });

  const lifecycle: Record<string, Session> = {};
  for (const status of [
    "ready",
    "validation_pending",
    "promotion_pending",
    "needs_review",
  ] as const)
    lifecycle[status] = await f.clone(base, status, { status });
  lifecycle.waiting = await f.clone(base, "waiting", { waitingForLock: true });
  lifecycle.recovery = await f.clone(base, "recovery", {
    recoveryPhase: "merge",
    awaitingConflictResolution: true,
  });
  // Lifecycle outranks corruption: recovery must use its own coordinator path.
  lifecycle.lostRecovery = await f.clone(base, "lostrecovery", {
    status: "promotion_pending",
    worktreePath: join(f.root, "gone"),
  });
  lifecycle.lockHolder = await f.clone(base, "lockholder", {});
  const lockPath = join(f.runtime, "locks", `${base.repositoryId}.lock`);
  const now = new Date().toISOString();
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      sessionId: lifecycle.lockHolder.id,
      acquiredAt: now,
      startedAt: now,
    }),
  );

  const before = await snapshot([f.root]);
  const report = f.audit(repo);
  const text = f.run(["sessions", "audit"], repo);
  expect(await snapshot([f.root])).toEqual(before);

  expect(byId(report, base.id).bucket).toBe("empty");
  const worktreeAudit = byId(report, missingWorktree.id);
  expect(worktreeAudit.bucket).toBe("corrupt");
  expect(worktreeAudit.evidence).toEqual([
    `worktree missing: ${missingWorktree.worktreePath}`,
  ]);
  const branchAudit = byId(report, missingBranch.id);
  expect(branchAudit.bucket).toBe("corrupt");
  expect(branchAudit.evidence).toEqual([
    `session branch missing: ${missingBranch.branch}`,
  ]);
  const coordinatorAudit = byId(report, missingCoordinator.id);
  expect(coordinatorAudit.bucket).toBe("corrupt");
  expect(coordinatorAudit.evidence[0]).toContain("pinned coordinator missing");
  const dirtyAudit = byId(report, corruptButDirty.id);
  expect(dirtyAudit.bucket).toBe("unsaved");
  expect(dirtyAudit.notes.join("\n")).toContain("pinned coordinator missing");

  const expected: Record<string, string> = {
    ready: "status ready",
    validation_pending: "status validation_pending",
    promotion_pending: "status promotion_pending",
    needs_review: "status needs_review",
    waiting: "waiting for the repository lock",
    recovery: "recovery phase merge",
    lostRecovery: "status promotion_pending",
    lockHolder: `holds repository lock ${lockPath}`,
  };
  for (const [name, session] of Object.entries(lifecycle)) {
    const row = byId(report, session.id);
    expect(row.bucket, name).toBe("lifecycle");
    expect(row.evidence.join("\n"), name).toContain(expected[name]);
  }
  expect(byId(report, lifecycle.recovery!.id).evidence).toContain(
    "awaiting conflict resolution",
  );
  expect(byId(report, lifecycle.lostRecovery!.id).notes.join("\n")).toContain(
    "worktree missing",
  );
  expect(report.counts.corrupt).toBe(3);
  expect(report.counts.lifecycle).toBe(8);
  expect(text).toContain("[corrupt]");
  expect(text).toContain("[in lifecycle]");
});

it("filters by repository and idle days using the activity fallback chain", async () => {
  const f = await fixture();
  const first = await f.createRepo("first");
  const second = await f.createRepo("second");
  const old = await f.begin(first, "Old work");
  const recent = await f.begin(first, "Recent work");
  const other = await f.begin(second, "Other repository");
  const day = 24 * 60 * 60 * 1000;
  await f.save({
    ...old,
    startedAt: new Date(Date.now() - 40 * day).toISOString(),
  });
  // A recent checklist edit keeps an old session active.
  await f.save({
    ...recent,
    startedAt: new Date(Date.now() - 40 * day).toISOString(),
    tasksUpdatedAt: new Date(Date.now() - 2 * day).toISOString(),
  });

  const firstOnly = f.audit(f.root, ["--repo", first]);
  expect(firstOnly.sessions.map((row) => row.sessionId).sort()).toEqual(
    [old.id, recent.id].sort(),
  );
  expect(byId(firstOnly, old.id).idleDays).toBe(40);
  expect(byId(firstOnly, old.id).lastActivity?.source).toBe("startedAt");
  expect(byId(firstOnly, recent.id).idleDays).toBe(2);
  expect(byId(firstOnly, recent.id).lastActivity?.source).toBe(
    "tasksUpdatedAt",
  );

  const idle = f.audit(f.root, ["--idle-days", "10"]);
  expect(idle.sessions.map((row) => row.sessionId)).toEqual([old.id]);
  const secondOnly = f.audit(f.root, ["--repo", second]);
  expect(secondOnly.sessions.map((row) => row.sessionId)).toEqual([other.id]);
  expect(secondOnly.sessions[0]!.facts.targetBranch).toBe("main");
  expect(f.run(["sessions", "audit", "--idle-days", "100"], f.root)).toContain(
    "No unfinished sessions match.",
  );
  for (const args of [
    ["sessions"],
    ["sessions", "audit", "--idle-days", "-1"],
    ["sessions", "audit", "--idle-days"],
    ["sessions", "audit", "--unknown"],
  ])
    expect(
      spawnSync(
        process.execPath,
        [join(process.cwd(), "dist/cli.js"), ...args],
        {
          cwd: f.root,
          env: { ...process.env, SESH_INTEGRATOR_HOME: f.runtime },
          encoding: "utf8",
        },
      ).stderr,
    ).toContain("Usage: seshx sessions audit");
});

it("derives last activity from tasksUpdatedAt, then startedAt, then worktree time", () => {
  const session: Session = {
    id: "session_idle",
    status: "active",
    repositoryPath: "/repo",
    repositoryId: "repo",
    worktreePath: "/source",
    branch: "task",
    startCommit: "base",
    integrationCommitAtStart: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    taskSummary: "Idle",
    dependsOn: [],
  };
  const now = new Date("2026-10-11T12:00:00.000Z");
  const worktree = "2026-10-09T00:00:00.000Z";
  expect(
    lastActivity({ ...session, tasksUpdatedAt: "2026-10-05T00:00:00.000Z" }),
  ).toEqual({ at: "2026-10-05T00:00:00.000Z", source: "tasksUpdatedAt" });
  expect(lastActivity(session, worktree)).toEqual({
    at: "2026-10-01T00:00:00.000Z",
    source: "startedAt",
  });
  const broken = { ...session, startedAt: "not a date" };
  expect(lastActivity(broken, worktree)).toEqual({
    at: worktree,
    source: "worktreeModifiedAt",
  });
  expect(lastActivity(broken)).toBeUndefined();
  expect(idleDays(lastActivity(session), now)).toBe(10);
  expect(idleDays(lastActivity(broken, worktree), now)).toBe(2);
  expect(idleDays(undefined, now)).toBeNull();
  expect(
    idleDays({ at: "2026-10-12T00:00:00.000Z", source: "startedAt" }, now),
  ).toBe(0);
});
