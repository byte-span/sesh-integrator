import { execFileSync, spawn, spawnSync } from "node:child_process";
import { repoId } from "../src/runtime.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const cli = join(process.cwd(), "dist/cli.js");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(unborn = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "seshx-enablement-")),
  );
  roots.push(root);
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  const env = {
    ...process.env,
    PARALLEL_INTEGRATOR_HOME: runtime,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
  };
  function git(args: string[], cwd = repo) {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  }
  await mkdir(repo);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  if (!unborn) git(["commit", "--allow-empty", "-m", "base"]);
  function run(args: string[], cwd = repo, code = 0) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(code);
    return result.stdout + result.stderr;
  }
  const config = async () =>
    JSON.parse(await readFile(join(runtime, "config.json"), "utf8"));
  return { root, repo, runtime, git, run, config, env };
}

it("opts out an unborn unregistered repo from subdirectories and enables without registering", async () => {
  const f = await fixture(true);
  const sub = join(f.repo, "nested");
  await mkdir(sub);
  f.run(["disable"], sub);
  f.run(["disable", f.repo], f.root);
  expect((await f.config()).disabledRepositories).toEqual([
    join(f.repo, ".git"),
  ]);
  expect(f.run(["status"], sub)).toContain(
    "Registration: unregistered\nEnablement: disabled",
  );
  f.run(["enable", sub], f.root);
  f.run(["enable"]);
  expect((await f.config()).repositories).toEqual([]);
  expect((await f.config()).disabledRepositories).toEqual([]);
  expect(f.run(["status"])).toContain("Enablement: enabled");
});

it("registration and auto-configuration preserve opt-outs and skip target creation", async () => {
  const f = await fixture();
  f.run(["disable"]);
  const config = await f.config();
  config.defaultTargetBranch = "dev";
  await writeFile(join(f.runtime, "config.json"), JSON.stringify(config));
  await writeFile(
    join(f.repo, "package.json"),
    JSON.stringify({ scripts: { test: "node --version" } }),
  );
  expect(f.run(["register", "--auto-config"])).toContain("remains disabled");
  f.run(["register", "--auto-config"]);
  const before = await f.config();
  f.run(["register", "--auto-config"]);
  expect(await f.config()).toEqual(before);
  expect(f.git(["branch", "--list", "dev"])).toBe("");
  expect(f.run(["begin", "--summary", "blocked"], f.repo, 1)).toContain(
    "Repository is disabled",
  );
  f.run(["enable"]);
  expect((await f.config()).repositories).toEqual(before.repositories);
  f.run(["register"]);
  expect(f.git(["branch", "--list", "dev"])).toContain("dev");
});

it("blocks all lifecycle commands across linked worktrees and preserves a usable session", async () => {
  const f = await fixture();
  f.run(["register"]);
  const linked = join(f.root, "linked");
  f.git(["worktree", "add", "-b", "task", linked]);
  f.run(["begin", "--summary", "preserve session"], linked);
  const before = await f.config();
  const sessionFiles = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(f.runtime, "sessions")),
  );
  const sessionPath = join(f.runtime, "sessions", sessionFiles[0]!);
  const sessionBefore = await readFile(sessionPath, "utf8");
  await writeFile(join(linked, "task.txt"), "task\n");
  f.git(["add", "task.txt"], linked);
  const gitBefore = f.git(["status", "--porcelain=v1"], linked);
  f.run(["disable"]);
  for (const args of [
    ["begin", "--summary", "blocked"],
    ["commit", "--message", "blocked"],
    ["validate"],
    ["integrate", "--summary", "blocked", "--rollout", "none"],
    ["resume"],
    ["reconcile", "--apply"],
  ]) {
    expect(f.run(args, linked, 1)).toContain("Repository is disabled");
  }
  expect(f.run(["status"], linked)).toContain(
    "Registration: registered\nEnablement: disabled",
  );
  expect(await readFile(sessionPath, "utf8")).toBe(sessionBefore);
  expect(f.git(["status", "--porcelain=v1"], linked)).toBe(gitBefore);
  f.run(["enable"], linked);
  expect((await f.config()).repositories).toEqual(before.repositories);
  f.run(["commit", "--message", "task"], linked);
  f.run(["validate"], linked);
  f.run(["integrate", "--summary", "task", "--rollout", "none"], linked);
  expect(f.git(["show", "main:task.txt"])).toBe("task");
});

it("refuses existing integration locks without overwriting config or reclaiming unknown owners", async () => {
  const f = await fixture();
  f.run(["register"]);
  const before = await readFile(join(f.runtime, "config.json"), "utf8");
  const id = repoId(join(f.repo, ".git"));
  const lock = join(f.runtime, "locks", `${id}.lock`);
  await mkdir(lock);
  expect(f.run(["disable"], f.repo, 1)).toContain("integration lock exists");
  expect(await readFile(join(f.runtime, "config.json"), "utf8")).toBe(before);
  await rm(lock, { recursive: true });
  f.run(["disable"]);
});

it("rejects invalid command arguments and malformed opt-out configuration", async () => {
  const f = await fixture();
  f.run(["disable", "--unknown"], f.repo, 1);
  f.run(["enable", f.repo, f.repo], f.repo, 1);
  f.run(["disable"], f.root, 1);
  f.run(["init"]);
  const config = await f.config();
  config.disabledRepositories = [false];
  await writeFile(join(f.runtime, "config.json"), JSON.stringify(config));
  expect(f.run(["status"], f.repo, 1)).toContain("Invalid configuration");
});

it("serializes concurrent registration and opt-out without losing either", async () => {
  const f = await fixture();
  const results = await Promise.all(
    [["register", "--auto-config"], ["disable"]].map(
      (args) =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(process.execPath, [cli, ...args], {
            cwd: f.repo,
            env: f.env,
            stdio: "ignore",
            timeout: 15000,
          });
          child.on("error", reject);
          child.on("close", resolve);
        }),
    ),
  );
  expect(results).toEqual([0, 0]);
  const config = await f.config();
  expect(config.repositories).toHaveLength(1);
  expect(config.disabledRepositories).toEqual([join(f.repo, ".git")]);
});

it("rechecks an opt-out after a waiting integration acquires its lock", async () => {
  const f = await fixture();
  f.run(["register"]);
  f.run(["begin", "--summary", "waiting integration"]);
  await writeFile(join(f.repo, "task.txt"), "task\n");
  f.git(["add", "task.txt"]);
  f.run(["commit", "--message", "task"]);
  const commonDir = join(f.repo, ".git");
  const lock = join(f.runtime, "locks", `${repoId(commonDir)}.lock`);
  await mkdir(lock);
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      sessionId: "test-lock",
      acquiredAt: new Date().toISOString(),
    }),
  );
  const child = spawn(
    process.execPath,
    [cli, "integrate", "--summary", "waiting", "--rollout", "none"],
    { cwd: f.repo, env: f.env, timeout: 15000 },
  );
  let output = "";
  let announce: () => void;
  const waiting = new Promise<void>((resolve) => {
    announce = resolve;
  });
  child.stdout.on("data", (data) => {
    output += String(data);
    if (output.includes("waiting...")) announce();
  });
  child.stderr.on("data", (data) => {
    output += String(data);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  try {
    await Promise.race([
      waiting,
      closed.then(() => {
        throw new Error(`Integration exited before waiting: ${output}`);
      }),
    ]);
    // Model a disable winning the lock before this queued integration.
    const config = await f.config();
    config.disabledRepositories = [commonDir];
    await writeFile(join(f.runtime, "config.json"), JSON.stringify(config));
    await rm(lock, { recursive: true });
    expect(await closed, output).toBe(1);
    expect(output).toContain("Repository is disabled");
    expect(f.git(["branch", "--list", "sesh-integrator/integration"])).toBe("");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await closed;
    }
  }
});
