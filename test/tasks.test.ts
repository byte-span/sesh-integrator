import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { editTasks, currentTask, taskProgress } from "../src/tasks.js";
import {
  readSession,
  updateSessionTasks,
  writeSession,
} from "../src/runtime.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const sample = (): Session => ({
  id: "session_tasks",
  repositoryPath: "/repo",
  repositoryId: "repo",
  worktreePath: "/source",
  branch: "task",
  status: "active",
  startCommit: "base",
  integrationCommitAtStart: null,
  startedAt: "2026-09-15T00:00:00Z",
  taskSummary: "Checklist",
  dependsOn: [],
});

it("keeps stable IDs through changing plans, and distinguishes skipped from completed", () => {
  let tasks = editTasks([], {
    action: "add",
    titles: ["Inspect", "Build", "Verify"],
  });
  expect(tasks.map((t) => t.status)).toEqual(["pending", "pending", "pending"]);
  expect(currentTask({ ...sample(), tasks })).toBe("Not started");
  tasks = editTasks(tasks, { action: "update", id: 1, status: "completed" });
  expect(currentTask({ ...sample(), tasks })).toBe("Between tasks");
  tasks = editTasks(tasks, {
    action: "update",
    id: 2,
    status: "in_progress",
    title: "Build CLI",
    description: "Support safe edits",
  });
  expect(currentTask({ ...sample(), tasks })).toBe("Build CLI");
  tasks = editTasks(tasks, { action: "move", id: 3, position: 2 });
  expect(tasks.map((t) => t.id)).toEqual([1, 3, 2]);
  tasks = editTasks(tasks, {
    action: "update",
    id: 2,
    status: "blocked",
    reason: "Need fixture",
  });
  expect(currentTask({ ...sample(), tasks })).toBe("Blocked");
  tasks = editTasks(tasks, { action: "update", id: 2, status: "pending" });
  expect(tasks[2]!.reason).toBeUndefined();
  tasks = editTasks(tasks, { action: "update", id: 2, status: "completed" });
  tasks = editTasks(tasks, {
    action: "update",
    id: 3,
    status: "skipped",
    reason: "Covered by integration checks",
  });
  expect(currentTask({ ...sample(), tasks })).toBe("Complete");
  expect(taskProgress({ ...sample(), tasks })).toBe("2/3 completed, 1 skipped");
  tasks = editTasks(tasks, { action: "add", titles: ["New discovery"] });
  expect(tasks[3]!.id).toBe(4);
  expect(tasks[0]!.status).toBe("completed");
  expect(tasks[1]!.status).toBe("skipped");
});

it("rejects ambiguous activity, missing reasons, and invalid edits without mutating the input", () => {
  const tasks = editTasks(
    editTasks([], { action: "add", titles: ["First", "Second"] }),
    { action: "update", id: 1, status: "in_progress" },
  );
  const saved = JSON.stringify(tasks);
  for (const status of ["blocked", "skipped"] as const)
    expect(() => editTasks(tasks, { action: "update", id: 1, status })).toThrow(
      "requires --reason",
    );
  expect(() =>
    editTasks(tasks, { action: "update", id: 2, status: "in_progress" }),
  ).toThrow("Only one");
  expect(() =>
    editTasks(tasks, { action: "update", id: 9, title: "Unknown" }),
  ).toThrow("Unknown task");
  expect(() =>
    editTasks(tasks, { action: "update", id: 1, title: " " }),
  ).toThrow("empty");
  expect(() =>
    editTasks(tasks, { action: "move", id: 1, position: 9 }),
  ).toThrow("Position");
  expect(() =>
    editTasks(tasks, { action: "update", id: 1, reason: "unrelated" }),
  ).toThrow("only for");
  expect(JSON.stringify(tasks)).toBe(saved);
});

it("serializes competing checklist edits and preserves them across stale lifecycle writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-storage-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", root);
  const stale = sample();
  await writeSession(stale);
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      updateSessionTasks(stale.id, (tasks) =>
        editTasks(tasks, { action: "add", titles: [`Task ${i}`] }),
      ),
    ),
  );
  stale.status = "ready";
  stale.readyCommit = "exact-source";
  await writeSession(stale);
  const saved = (await readSession(stale.id))!;
  expect(saved.tasks).toHaveLength(6);
  expect(new Set(saved.tasks!.map((task) => task.id)).size).toBe(6);
  expect(saved.tasksUpdatedAt).toBeTruthy();
  expect(saved.status).toBe("ready");
  expect(saved.readyCommit).toBe("exact-source");
  await expect(
    updateSessionTasks(stale.id, (tasks) =>
      editTasks(tasks, { action: "update", id: 1, status: "blocked" }),
    ),
  ).rejects.toThrow("requires --reason");
  expect(await readSession(stale.id)).toEqual(saved);
  expect(
    (await readdir(join(root, "locks"))).filter((name) =>
      name.startsWith("session-record"),
    ),
  ).toEqual([]);
});

it("supports task CLI lifecycle in a disposable repo, resolves sessions safely, and preserves Git state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasks-cli-"));
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
  run(["begin", "--create-worktree", "--summary", "Test tasks"]);
  const first = (await readdir(join(runtime, "sessions")))[0]!;
  const path = join(runtime, "sessions", first);
  const session = JSON.parse(await readFile(path, "utf8")) as Session;
  expect(run(["tasks", "list"])).toContain("No tasks yet");
  await writeFile(join(repo, "user.txt"), "preserve staged user work");
  git(["add", "user.txt"]);
  const before = git(["status", "--porcelain=v1"]);
  expect(
    run(["tasks", "add", "--title", "Build CLI", "--title", "Check terminal"]),
  ).toContain("0/2 completed");
  run(
    ["tasks", "update", "1", "--status", "in_progress"],
    0,
    session.worktreePath,
  );
  expect(run(["tasks", "update", "2", "--status", "in_progress"], 1)).toContain(
    "Only one",
  );
  expect(run(["tasks", "update", "1", "--status", "unknown"], 1)).toContain(
    "Status must be",
  );
  run([
    "tasks",
    "update",
    "1",
    "--title",
    "Implement CLI",
    "--description",
    "Details that wrap",
    "--status",
    "completed",
  ]);
  run(["tasks", "move", "2", "--position", "1"]);
  run([
    "tasks",
    "update",
    "2",
    "--status",
    "skipped",
    "--reason",
    "Replaced by PTY check",
  ]);
  expect(run(["status", "--session", session.id])).toContain(
    "1/2 completed, 1 skipped",
  );
  expect(run(["tasks", "list", "--session", session.id], 0, root)).toContain(
    "Current: Complete",
  );
  expect(git(["status", "--porcelain=v1"])).toBe(before);
  expect(git(["status", "--porcelain=v1"], session.worktreePath)).toBe("");
  run(["begin", "--create-worktree", "--summary", "Another session"]);
  expect(run(["tasks", "add", "--title", "ambiguous"], 1)).toContain(
    "Multiple matching sessions",
  );
  run([
    "tasks",
    "add",
    "--title",
    "Explicit discovery",
    "--session",
    session.id,
  ]);
  run(["disable"]);
  expect(
    run(["tasks", "add", "--title", "blocked", "--session", session.id], 1),
  ).toContain("disabled");
  expect(run(["tasks", "list", "--session", session.id])).toContain(
    "Explicit discovery",
  );
  expect(run(["tasks", "list", "--session", "../config"], 1)).toContain(
    "Invalid session ID",
  );
  expect(run(["tasks", "remove", "1"], 1)).toContain("Usage");
});
