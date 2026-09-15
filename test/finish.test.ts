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
import { writeSession, readSession } from "../src/runtime.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sesh-finish-"));
  roots.push(root);
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  await mkdir(repo);
  const env = {
    ...process.env,
    SESH_INTEGRATOR_HOME: runtime,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const run = (args: string[], code = 0, cwd = repo) => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "dist/cli.js"), ...args],
      { cwd, env, encoding: "utf8", timeout: 15000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(code);
    return result.stdout + result.stderr;
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  git(["commit", "--allow-empty", "-m", "base"]);
  run(["register"]);
  const sessions = async (): Promise<Session[]> =>
    Promise.all(
      (await readdir(join(runtime, "sessions")))
        .filter((p) => p.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(
              await readFile(join(runtime, "sessions", name), "utf8"),
            ) as Session,
        ),
    );
  const begin = async () => {
    run([
      "begin",
      "--create-worktree",
      "--summary",
      "Inspect already fixed work",
    ]);
    return (await sessions())
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(-1)!;
  };
  return { repo, runtime, git, run, sessions, begin };
}

it("finishes an all-skipped session without commits, preserves user state, and is idempotent", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "user.txt"), "user state");
  f.git(["add", "user.txt"]);
  const before = f.git(["status", "--porcelain=v1"]);
  const session = await f.begin();
  const sourceBefore = f.git(["rev-parse", "HEAD"], session.worktreePath);
  f.run(["tasks", "add", "--title", "Implement", "--title", "Integrate"]);
  expect(
    f.run(["finish", "--no-changes", "--summary", "Not needed"], 1),
  ).toContain("every task");
  for (const id of [1, 2])
    f.run([
      "tasks",
      "update",
      String(id),
      "--status",
      "skipped",
      "--reason",
      "Already implemented",
    ]);
  const output = f.run([
    "finish",
    "--no-changes",
    "--summary",
    "Already implemented",
  ]);
  expect(output).toContain("Finished - no changes needed");
  expect(output).toContain("No new commit");
  expect(output).not.toContain("Outstanding integration prerequisite");
  const saved = (await f.sessions())[0]!;
  expect(saved.status).toBe("no_changes");
  expect(saved.closedAt).toBeTruthy();
  expect(saved.readyCommit).toBeUndefined();
  expect(saved.promotedCommit).toBeUndefined();
  f.run([
    "finish",
    "--no-changes",
    "--summary",
    "Already implemented",
    "--session",
    saved.id,
  ]);
  expect((await f.sessions())[0]).toEqual(saved);
  expect(f.run(["status", "--session", saved.id])).toContain(
    "Finished - no changes needed",
  );
  expect(
    f.run(["tasks", "add", "--title", "New work", "--session", saved.id], 1),
  ).toContain("start a new session");
  expect(f.git(["status", "--porcelain=v1"])).toBe(before);
  expect(f.git(["rev-parse", "HEAD"], session.worktreePath)).toBe(sourceBefore);
  vi.stubEnv("SESH_INTEGRATOR_HOME", f.runtime);
  await expect(writeSession({ ...saved, status: "ready" })).rejects.toThrow(
    "already finished",
  );
  expect((await readSession(saved.id))!.status).toBe("no_changes");
});

it("rejects new uncommitted work, commits, invalid references and missing explicit intent", async () => {
  const f = await fixture();
  const session = await f.begin();
  const finish = ["finish", "--no-changes", "--summary", "Nothing needed"];
  expect(f.run(["finish", "--summary", "Nothing needed"], 1)).toContain(
    "--no-changes",
  );
  expect(f.run([...finish, "--satisfied-by", session.id], 1)).toContain(
    "successfully promoted",
  );
  expect(f.run([...finish, "--satisfied-by", "../config"], 1)).toContain(
    "Invalid session ID",
  );
  await writeFile(join(session.worktreePath, "new.txt"), "new work");
  expect(f.run(finish, 1)).toContain("Observable Git state blocked");
  f.git(["add", "new.txt"], session.worktreePath);
  expect(f.run(finish, 1)).toContain("Observable Git state blocked");
  f.git(["commit", "-m", "new work"], session.worktreePath);
  expect(f.run(finish, 1)).toContain("commit changed since begin");
  expect((await f.sessions())[0]!.status).toBe("active");
});

it("links verified earlier integration and retains its outstanding review and rollout obligations", async () => {
  const f = await fixture();
  const prior = await f.begin();
  await writeFile(join(prior.worktreePath, "fix.txt"), "already fixed");
  f.git(["add", "fix.txt"], prior.worktreePath);
  f.git(["commit", "-m", "fix"], prior.worktreePath);
  f.run(["validate"]);
  f.run([
    "integrate",
    "--summary",
    "Fix implemented",
    "--rollout",
    "manual",
    "--follow-up",
    "Enable fixture job in the sandbox project",
  ]);
  const previous = (await f.sessions())[0]!;
  // Fixture review URL stands in for configured hosting, without remote access.
  previous.pullRequestUrl = "https://example.test/pr/1";
  await writeFile(
    join(f.runtime, "sessions", `${previous.id}.json`),
    JSON.stringify(previous),
  );
  const current = await f.begin();
  const out = f.run([
    "finish",
    "--no-changes",
    "--summary",
    "Fix already present",
    "--session",
    current.id,
    "--satisfied-by",
    previous.id,
  ]);
  expect(out).toContain(`Satisfied by session: ${previous.id}`);
  expect(out).toContain("Review and merge https://example.test/pr/1");
  expect(out).toContain("Enable fixture job in the sandbox project");
  expect(out).not.toContain("No manual follow-up required");
  const saved = (await f.sessions()).find((s) => s.id === current.id)!;
  expect(saved.status).toBe("no_changes");
  expect(saved.readyCommit).toBeUndefined();
  expect(saved.satisfiedBySessionId).toBe(previous.id);
});

it("refuses preserved integration state and an existing repository lock without changing either", async () => {
  const f = await fixture();
  const session = await f.begin();
  const args = ["finish", "--no-changes", "--summary", "Nothing needed"];
  const path = join(f.runtime, "sessions", `${session.id}.json`);
  const preserved = { ...session, readyCommit: session.startCommit };
  await writeFile(path, JSON.stringify(preserved));
  expect(f.run(args, 1)).toContain("integration or recovery state");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(preserved);
  await writeFile(path, JSON.stringify(session));
  const lock = join(f.runtime, "locks", `${session.repositoryId}.lock`);
  await mkdir(lock);
  expect(f.run(args, 1)).toContain("Cannot finish a session");
  expect(await readdir(lock)).toEqual([]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(session);
});
