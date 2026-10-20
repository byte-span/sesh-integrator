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
  applyBatchAbandon,
  batchOutcomeLines,
  planBatchAbandon,
} from "../src/abandon.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const cli = join(process.cwd(), "dist", "cli.js");
const day = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) =>
  new Date(Date.now() - days * day).toISOString();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sesh-abandon-batch-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const env = {
    ...process.env,
    SESH_INTEGRATOR_HOME: runtime,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
  };
  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const exec = (args: string[], cwd = root) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    return { code: result.status, output: result.stdout + result.stderr };
  };
  const run = (args: string[], cwd = root, code = 0) => {
    const result = exec(args, cwd);
    expect(result.code, `${args.join(" ")}\n${result.output}`).toBe(code);
    return result.output;
  };
  const createRepo = async (name: string) => {
    const repo = join(root, name);
    await mkdir(repo);
    git(["init", "-b", "main"], repo);
    git(["config", "user.name", "Test"], repo);
    git(["config", "user.email", "test@example.test"], repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    git(["add", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    run(["register"], repo);
    return repo;
  };
  const recordPath = (id: string) => join(runtime, "sessions", `${id}.json`);
  const raw = (id: string) => readFile(recordPath(id), "utf8");
  const record = async (id: string) => JSON.parse(await raw(id)) as Session;
  const save = (session: Session) =>
    writeFile(recordPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
  const begin = async (repo: string, summary: string) => {
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
  ) => {
    const copy = { ...session, ...changes, id: `${session.id}_${suffix}` };
    await save(copy);
    return copy;
  };
  const deliver = async (repo: string, session: Session) => {
    await writeFile(join(session.worktreePath, "delivered.txt"), "done\n");
    git(["add", "delivered.txt"], session.worktreePath);
    git(["commit", "-m", "deliver"], session.worktreePath);
    git(["merge", "--ff-only", session.branch], repo);
  };
  /** Git refs and worktrees, which batch abandon must never change. */
  const gitState = (repo: string) => [
    git(["for-each-ref", "--format=%(refname) %(objectname)"], repo),
    git(["worktree", "list", "--porcelain"], repo),
  ];
  const lockOwner = (sessionId: string) =>
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      sessionId,
      acquiredAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });
  return {
    root,
    runtime,
    locks: join(runtime, "locks"),
    git,
    exec,
    run,
    createRepo,
    raw,
    record,
    save,
    begin,
    clone,
    deliver,
    gitState,
    lockOwner,
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

/** Whether the output lists the session's full audit for closing. */
const listed = (output: string, session: Session, label: string) =>
  output.includes(`\n${session.id}  [${label}]  idle `);

it("previews the default selection without changing anything and lists unsaved sessions individually", async () => {
  const f = await fixture();
  const repo = await f.createRepo("repo");
  const empty = await f.begin(repo, "Empty");
  const delivered = await f.begin(repo, "Delivered");
  await f.deliver(repo, delivered);
  const corrupt = await f.clone(empty, "corrupt", {
    worktreePath: join(f.root, "missing-worktree"),
  });
  const dirty = await f.begin(repo, "Dirty");
  await writeFile(join(dirty.worktreePath, "draft.txt"), "draft\n");
  const lifecycle = await f.clone(empty, "lifecycle", {
    status: "validation_pending",
  });
  const planned = await f.begin(repo, "Planned");
  f.run(["tasks", "add", "--title", "Plan", "--session", planned.id], repo);

  const queue = process.env.SESH_BUILD_QUEUE_HOME!;
  const refs = f.gitState(repo);
  const before = await snapshot([f.root, queue]);
  const preview = f.run(["abandon", "--all"]);
  const withUnsaved = f.run([
    "abandon",
    "--all",
    "--include-unsaved",
    "--reason",
    "Stale cleanup",
  ]);
  const none = f.run(["abandon", "--all", "--idle-days", "100"], repo);
  // Strictly read-only: no record, index, lock, queue, Git or file change.
  expect(await snapshot([f.root, queue])).toEqual(before);
  expect(f.gitState(repo)).toEqual(refs);

  expect(preview).toContain(
    "Batch abandon preview (read-only; nothing was changed)",
  );
  expect(preview).toContain("An agent may still be working");
  expect(preview).toContain(
    "Selected buckets: empty, delivered, corrupt (default)",
  );
  expect(preview).toContain("Filters: none");
  expect(preview).toContain("Would abandon: 3\n");
  expect(listed(preview, empty, "empty")).toBe(true);
  expect(listed(preview, delivered, "delivered")).toBe(true);
  expect(listed(preview, corrupt, "corrupt")).toBe(true);
  expect(preview).toContain("worktree missing: ");
  expect(preview).toContain("Left alone: 3\n");
  expect(listed(preview, dirty, "unsaved work")).toBe(false);
  expect(preview).toContain(
    `  ${dirty.id}  [unsaved work]  unsaved work; selected only with --include-unsaved`,
  );
  expect(preview).toContain(
    `  ${lifecycle.id}  [in lifecycle]  in lifecycle; never batch-abandoned`,
  );
  expect(preview).toContain(
    `  ${planned.id}  [other]  bucket other; never batch-abandoned. Review it and use seshx abandon --session ${planned.id}`,
  );
  expect(preview).toContain(
    "Buckets of matching sessions: empty 1, delivered 1, unsaved work 1, corrupt 1, in lifecycle 1, other 1",
  );
  expect(preview).toContain(
    'Nothing was changed. To abandon the 3 session(s) listed above, run:\n  seshx abandon --all --apply --reason "..."',
  );
  expect(preview).toContain("rechecked under its record lock");

  // --include-unsaved lists each unsaved session with its evidence.
  expect(withUnsaved).toContain(
    "Selected buckets: empty, delivered, unsaved work, corrupt (default plus --include-unsaved)",
  );
  expect(withUnsaved).toContain("Reason: Stale cleanup");
  expect(withUnsaved).toContain("Would abandon: 4\n");
  expect(listed(withUnsaved, dirty, "unsaved work")).toBe(true);
  expect(withUnsaved).toContain("uncommitted path(s) in worktree: draft.txt");
  expect(withUnsaved).toContain(
    "  unsaved work: included only because --include-unsaved was given. The work stays in its branch and worktree.",
  );
  expect(withUnsaved).toContain(
    "  seshx abandon --all --include-unsaved --apply --reason 'Stale cleanup'",
  );
  expect(withUnsaved).toContain("Left alone: 2\n");

  expect(none).toContain("Filters: idle at least 100 day(s)");
  expect(none).toContain("Would abandon: 0\n");
  expect(none).toContain(
    "Nothing was changed; no sessions would be abandoned.",
  );
}, 60000);

it("closes only the selected sessions and preserves Git state, files, locks and recovery evidence", async () => {
  const f = await fixture();
  const repo = await f.createRepo("repo");
  const empty = await f.begin(repo, "Empty");
  const delivered = await f.begin(repo, "Delivered");
  await f.deliver(repo, delivered);
  const corrupt = await f.clone(empty, "corrupt", {
    worktreePath: join(f.root, "missing-worktree"),
  });
  const dirty = await f.begin(repo, "Dirty");
  await writeFile(join(dirty.worktreePath, "draft.txt"), "draft\n");
  const lifecycle = await f.clone(empty, "lifecycle", {
    status: "promotion_pending",
  });
  // An archived recovery bundle leaves the session in a closable bucket, but
  // it is recovery evidence, so the batch leaves it alone.
  const bundle = join(f.runtime, "recovery-bundles", "attempt");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "manifest.json"), '{"version":1}\n');
  const bundled = await f.clone(empty, "bundle", {
    recoveryBundle: {
      version: 1,
      attemptId: "attempt",
      path: bundle,
      manifestHash: "hash",
      state: "archived",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  });
  const locked = await f.clone(empty, "repolock", {});
  const repoLock = join(f.locks, `${empty.repositoryId}.lock`);
  await writeFile(repoLock, f.lockOwner(locked.id));

  const untouched = [dirty, lifecycle, bundled, locked];
  const recordsBefore = await Promise.all(
    untouched.map((session) => f.raw(session.id)),
  );
  const refs = f.gitState(repo);
  const preserved = [
    repo,
    empty.worktreePath,
    delivered.worktreePath,
    dirty.worktreePath,
    bundle,
    repoLock,
  ];
  const filesBefore = await snapshot(preserved);

  const output = f.run([
    "abandon",
    "--all",
    "--apply",
    "--reason",
    "Batch cleanup",
  ]);
  expect(output).toContain(
    "Batch abandon: closing the sessions below. Each is rechecked under its record lock first.",
  );
  expect(output).toContain("Reason: Batch cleanup");
  expect(output).toContain("Sessions to abandon: 3\n");
  expect(output).toContain(
    `  ${bundled.id}  [empty]  it has integration or recovery state (archived recovery bundle ${bundle})`,
  );
  expect(output).toContain(`  ${locked.id}  [in lifecycle]  in lifecycle`);
  expect(output).toContain("Closed: 3\n");
  expect(output).toContain("Skipped: 0\n");
  expect(output).toContain(
    "Preserved: every branch, worktree, uncommitted file, commit, recovery bundle and ref, incident and lock.",
  );
  for (const [session, bucket, label] of [
    [empty, "empty", "empty"],
    [delivered, "delivered", "delivered"],
    [corrupt, "corrupt", "corrupt"],
  ] as const) {
    expect(output).toMatch(
      new RegExp(
        `  ${session.id}  \\[${label}\\]  abandoned at \\S+; restore: seshx restore --session ${session.id}`,
      ),
    );
    const saved = await f.record(session.id);
    expect(saved.status).toBe("abandoned");
    expect(saved.abandonment).toMatchObject({
      reason: "Batch cleanup",
      previousStatus: "active",
      bucket,
    });
    expect(saved.abandonment!.includedUnsaved).toBeUndefined();
  }
  for (const [index, session] of untouched.entries())
    expect(await f.raw(session.id), session.id).toBe(recordsBefore[index]);
  expect(f.gitState(repo)).toEqual(refs);
  expect(await snapshot(preserved)).toEqual(filesBefore);

  // Unsaved work is closed only on request, and the work itself stays.
  const unsaved = f.run([
    "abandon",
    "--all",
    "--include-unsaved",
    "--apply",
    "--reason",
    "Work kept on its branch",
  ]);
  expect(unsaved).toContain("Sessions to abandon: 1\n");
  expect(unsaved).toContain("uncommitted path(s) in worktree: draft.txt");
  expect(unsaved).toContain("Closed: 1\n");
  expect(await f.record(dirty.id)).toMatchObject({
    status: "abandoned",
    abandonment: {
      bucket: "unsaved",
      includedUnsaved: true,
      reason: "Work kept on its branch",
    },
  });
  expect(
    f.git(["--no-optional-locks", "status", "--porcelain"], dirty.worktreePath),
  ).toBe("?? draft.txt");
  for (const session of [lifecycle, bundled, locked])
    expect((await f.record(session.id)).status).not.toBe("abandoned");
  expect(f.gitState(repo)).toEqual(refs);
  expect(await snapshot(preserved)).toEqual(filesBefore);

  expect(
    f.run([
      "abandon",
      "--all",
      "--include-unsaved",
      "--apply",
      "--reason",
      "Again",
    ]),
  ).toContain("Nothing to abandon; nothing was changed.");
  expect(f.run(["status"])).toContain("Abandoned sessions: 4 ");
  // A batch-abandoned session restores normally.
  expect(f.run(["restore", "--session", delivered.id])).toContain(
    `Restored ${delivered.id} to active.`,
  );
}, 90000);

it("filters by repository, idle days and bucket, and rejects invalid selections", async () => {
  const f = await fixture();
  const first = await f.createRepo("first");
  const second = await f.createRepo("second");
  const legacy = ({ lastActivityAt: _, ...session }: Session): Session =>
    session;
  const old = await f.begin(first, "Old");
  await f.save({ ...legacy(old), startedAt: daysAgo(40) });
  const recent = await f.begin(first, "Recent");
  const delivered = await f.begin(first, "Delivered");
  await f.deliver(first, delivered);
  await f.save({
    ...(await f.record(delivered.id)),
    startedAt: daysAgo(30),
    lastActivityAt: daysAgo(20),
  });
  const elsewhere = await f.begin(second, "Elsewhere");
  const all = [old, recent, delivered, elsewhere];
  const closing = (output: string) =>
    all
      .filter((session) => output.includes(`\n${session.id}  [`))
      .map((session) => session.id)
      .sort();
  const ids = (...sessions: Session[]) =>
    sessions.map((session) => session.id).sort();

  const firstOnly = f.run(["abandon", "--all", "--repo", first]);
  expect(firstOnly).toContain(`Filters: repository ${first}`);
  expect(closing(firstOnly)).toEqual(ids(old, recent, delivered));
  expect(firstOnly).not.toContain(elsewhere.id);
  // Any path inside the repository selects it.
  const inside = f.run(["abandon", "--all", "--repo", elsewhere.worktreePath]);
  expect(closing(inside)).toEqual(ids(elsewhere));

  const idle = f.run(["abandon", "--all", "--idle-days", "10"]);
  expect(closing(idle)).toEqual(ids(old, delivered));
  expect(idle).toContain(`${old.id}  [empty]  idle 40 day(s)`);

  const deliveredOnly = f.run(["abandon", "--all", "--bucket", "delivered"]);
  expect(deliveredOnly).toContain("Selected buckets: delivered\n");
  expect(closing(deliveredOnly)).toEqual(ids(delivered));
  expect(deliveredOnly).toContain(
    `  ${recent.id}  [empty]  bucket empty not selected by --bucket`,
  );

  const combined = ["--repo", first, "--idle-days", "10", "--bucket", "empty"];
  const narrowed = f.run(["abandon", "--all", ...combined]);
  expect(closing(narrowed)).toEqual(ids(old));
  expect(narrowed).toContain(
    `  seshx abandon --all --repo ${first} --idle-days 10 --bucket empty --apply --reason "..."`,
  );
  const others = [recent, delivered, elsewhere];
  const othersBefore = await Promise.all(
    others.map((session) => f.raw(session.id)),
  );
  const applied = f.run([
    "abandon",
    "--all",
    ...combined,
    "--apply",
    "--reason",
    "Old and empty",
  ]);
  expect(applied).toContain("Closed: 1\n");
  expect((await f.record(old.id)).status).toBe("abandoned");
  for (const [index, session] of others.entries())
    expect(await f.raw(session.id)).toBe(othersBefore[index]);

  // Invalid selections change nothing.
  const queue = process.env.SESH_BUILD_QUEUE_HOME!;
  const before = await snapshot([f.root, queue]);
  for (const [args, message] of [
    [["--all", "--bucket", "lifecycle"], "never abandoned"],
    [["--all", "--bucket", "empty,other"], "cannot be batch-abandoned"],
    [["--all", "--bucket", "bogus"], 'Unknown bucket "bogus"'],
    [["--all", "--bucket", "unsaved"], "requires --include-unsaved"],
    [
      ["--all", "--bucket", "empty", "--include-unsaved"],
      "add unsaved to --bucket",
    ],
    [["--all", "--bucket", "empty,,delivered"], "comma-separated list"],
    [["--all", "--session", recent.id], "not both"],
    [["--apply"], "require --all"],
    [
      ["--session", recent.id, "--reason", "x", "--bucket", "empty"],
      "require --all",
    ],
    [["--all", "--apply"], 'requires --reason "..."'],
    [["--all", "--apply", "--reason", "two\nlines"], "one line"],
    [["--all", "--apply", "--reason", " "], "non-empty"],
    [["--all", "--idle-days", "-1"], "whole number"],
    [["--all", "--idle-days", "soon"], "whole number"],
    [["--all", "--repo"], "Usage: seshx abandon"],
    [["--all", "--all"], "Usage: seshx abandon"],
    [["--all", "--force"], "Usage: seshx abandon"],
  ] as const) {
    const result = f.exec(["abandon", ...args]);
    expect(result.code, args.join(" ")).toBe(1);
    expect(result.output, args.join(" ")).toContain(message);
  }
  expect(await snapshot([f.root, queue])).toEqual(before);
}, 90000);

it("rechecks each session under its record lock and skips those that changed since the preview", async () => {
  const f = await fixture();
  vi.stubEnv("SESH_INTEGRATOR_HOME", f.runtime);
  const repo = await f.createRepo("repo");
  const begin = (summary: string) => f.begin(repo, summary);
  const kept = await begin("Kept");
  const edited = await begin("Edited");
  const recordLocked = await begin("Record locked");
  const lifecycle = await begin("Enters lifecycle");
  const waiting = await begin("Waits for lock");
  const repoLocked = await begin("Takes repository lock");
  const dirtied = await begin("Gains unsaved work");
  const unsaved = await begin("Unsaved at preview");
  await writeFile(join(unsaved.worktreePath, "draft.txt"), "draft\n");

  const plan = await planBatchAbandon({ includeUnsaved: true });
  const all = [
    kept,
    edited,
    recordLocked,
    lifecycle,
    waiting,
    repoLocked,
    dirtied,
    unsaved,
  ];
  expect(plan.selected.map(({ session }) => session.id).sort()).toEqual(
    all.map((session) => session.id).sort(),
  );
  await expect(applyBatchAbandon(plan, "  ")).rejects.toThrow("non-empty");

  // Changes after the preview.
  f.run(["tasks", "add", "--title", "Plan", "--session", edited.id], repo);
  const recordLock = join(f.locks, `session-record-${recordLocked.id}`);
  await writeFile(recordLock, f.lockOwner(recordLocked.id));
  await f.save({
    ...(await f.record(lifecycle.id)),
    status: "validation_pending",
  });
  await f.save({ ...(await f.record(waiting.id)), waitingForLock: true });
  const repoLock = join(f.locks, `${repoLocked.repositoryId}.lock`);
  await writeFile(repoLock, f.lockOwner(repoLocked.id));
  await writeFile(join(dirtied.worktreePath, "late.txt"), "late\n");

  const skippedSessions = all.filter(
    (session) => session !== kept && session !== unsaved,
  );
  const recordsBefore = await Promise.all(
    skippedSessions.map((session) => f.raw(session.id)),
  );
  const refs = f.gitState(repo);
  const locksBefore = await snapshot([recordLock, repoLock]);

  const outcome = await applyBatchAbandon(plan, "Batch recheck");
  expect(outcome.closed.map(({ session }) => session.id).sort()).toEqual(
    [kept.id, unsaved.id].sort(),
  );
  const skipped = Object.fromEntries(
    outcome.skipped.map((entry) => [entry.sessionId, entry]),
  );
  expect(Object.keys(skipped).sort()).toEqual(
    skippedSessions.map((session) => session.id).sort(),
  );
  expect(skipped[edited.id]!.reason).toContain(
    "changed after it was inspected",
  );
  expect(skipped[edited.id]!.audit?.bucket).toBe("other");
  expect(skipped[recordLocked.id]!.reason).toContain(
    `its session record lock ${recordLock} appeared after it was inspected`,
  );
  expect(skipped[lifecycle.id]!.reason).toMatch(
    /Only an active session can be abandoned; \S+ is validation_pending/,
  );
  expect(skipped[waiting.id]!.reason).toContain(
    "it has integration or recovery state (waiting for the repository lock)",
  );
  expect(skipped[repoLocked.id]!.reason).toContain(
    "it is in lifecycle (holds repository lock",
  );
  // --include-unsaved covers only sessions the preview showed as unsaved.
  expect(skipped[dirtied.id]!.reason).toContain("it has unsaved work");
  for (const entry of outcome.skipped)
    expect(entry.reason, entry.sessionId).toContain("Nothing was changed.");

  for (const [index, session] of skippedSessions.entries())
    expect(await f.raw(session.id), session.id).toBe(recordsBefore[index]);
  expect(await snapshot([recordLock, repoLock])).toEqual(locksBefore);
  expect(f.gitState(repo)).toEqual(refs);
  expect(await f.record(kept.id)).toMatchObject({
    status: "abandoned",
    abandonment: { bucket: "empty", reason: "Batch recheck" },
  });
  expect(
    (await f.record(kept.id)).abandonment!.includedUnsaved,
  ).toBeUndefined();
  expect(await f.record(unsaved.id)).toMatchObject({
    status: "abandoned",
    abandonment: { bucket: "unsaved", includedUnsaved: true },
  });

  const text = batchOutcomeLines(outcome).join("\n");
  expect(text).toContain("Closed: 2\n");
  expect(text).toContain(
    `  ${kept.id}  [empty]  abandoned at ${(await f.record(kept.id)).abandonment!.abandonedAt}; restore: seshx restore --session ${kept.id}`,
  );
  expect(text).toContain("Skipped: 6\n");
  expect(text).toContain(
    `  ${edited.id}  Refusing to abandon ${edited.id}: it changed after it was inspected`,
  );
  expect(text).toContain("    recheck: [other] no commits since start");
  expect(text).toContain(
    "Skipped sessions were not changed. Review them with seshx sessions audit.",
  );
}, 90000);
