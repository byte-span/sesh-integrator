import { spawn } from "node:child_process";
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
import { expect } from "vitest";
import type { Config, Session } from "../src/types.js";

// Deliberately do not inherit provider credentials, Git configuration or runtime homes.
export async function smokeFixture(
  cli = join(process.cwd(), "dist/cli.js"),
  liveHome?: string,
  suppressOutput = Boolean(liveHome),
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sesh-smoke-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  await mkdir(home);
  await mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: liveHome ?? home,
    XDG_CONFIG_HOME: join(liveHome ?? home, ".config"),
    CODEX_HOME: join(liveHome ?? home, ".codex"),
    SESH_INTEGRATOR_HOME: runtime,
    PARALLEL_INTEGRATOR_AUDIT_HOME: home,
    PARALLEL_INTEGRATOR_DOCTOR_HOME: home,
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Smoke Test",
    GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "Smoke Test",
    GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(home, "npm-globalrc"),
  };
  async function command(
    command: string,
    args: string[],
    cwd = repo,
    timeout = 120_000,
  ) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        const timer = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }
        }, timeout);
        child.stdout.on("data", (part) => {
          stdout += part;
        });
        child.stderr.on("data", (part) => {
          stderr += part;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr });
        });
      },
    );
  }
  async function git(cwd: string, ...args: string[]) {
    const result = await command("git", args, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  async function run(cwd: string, args: string[], expected = 0) {
    const result = await command(process.execPath, [cli, ...args], cwd);
    // Live provider output is intentionally never included in assertion messages.
    expect(
      result.code,
      suppressOutput
        ? `seshx ${args[0]} failed (provider output suppressed)`
        : result.stdout + result.stderr,
    ).toBe(expected);
    return result;
  }
  async function sessions(): Promise<Session[]> {
    return await Promise.all(
      (await readdir(join(runtime, "sessions")))
        .filter((p) => p.endsWith(".json"))
        .map(async (p) =>
          JSON.parse(await readFile(join(runtime, "sessions", p), "utf8")),
        ),
    );
  }
  async function configure(edit: (config: Config) => void) {
    const path = join(runtime, "config.json");
    const config = JSON.parse(await readFile(path, "utf8")) as Config;
    edit(config);
    await writeFile(path, JSON.stringify(config));
  }
  async function begin(harness = "codex") {
    await run(repo, [
      "begin",
      "--create-worktree",
      "--harness",
      harness,
      "--summary",
      "smoke fixture",
    ]);
    const all = await sessions();
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;
  }
  async function commit(source: string, content: string) {
    await writeFile(join(source, "features.json"), content);
    await git(source, "add", "features.json");
    await run(source, ["commit", "--message", "smoke change"]);
    await run(source, ["validate"]);
  }
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "commit.gpgSign", "false");
  await writeFile(
    join(repo, "features.json"),
    '{"alpha":false,"beta":false}\n',
  );
  await writeFile(join(repo, "unrelated.txt"), "preserve me\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const dispose = () =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return {
    root,
    home,
    repo,
    runtime,
    env,
    command,
    git,
    run,
    sessions,
    configure,
    begin,
    commit,
    dispose,
  };
}

export async function registerSmoke(
  f: Awaited<ReturnType<typeof smokeFixture>>,
) {
  await f.run(f.repo, ["register", "--auto-config"]);
  await f.configure((c) => {
    const repo = c.repositories[0]!;
    repo.sourceValidationCommands = [
      [
        process.execPath,
        "-e",
        "JSON.parse(require('fs').readFileSync('features.json','utf8'))",
      ],
    ];
    repo.integrationValidationCommands = repo.sourceValidationCommands;
    repo.promotion = { type: "none" };
  });
}

export async function conflictingSmoke(
  f: Awaited<ReturnType<typeof smokeFixture>>,
  harness: string,
) {
  const first = await f.begin(harness);
  const second = await f.begin(harness);
  await f.commit(first.worktreePath, '{"alpha":true,"beta":false}\n');
  await f.commit(second.worktreePath, '{"alpha":false,"beta":true}\n');
  await f.run(first.worktreePath, [
    "integrate",
    "--summary",
    "enable alpha",
    "--rollout",
    "none",
  ]);
  await f.configure((c) => {
    c.repositories[0]!.conflictInstructions =
      "Combine both changes: features.json must have alpha=true AND beta=true. Preserve unrelated.txt. Do not commit.";
    c.repositories[0]!.integrationValidationCommands = [
      [
        process.execPath,
        "-e",
        "const assert=require('assert/strict');const fs=require('fs');assert.deepEqual(JSON.parse(fs.readFileSync('features.json','utf8')),{alpha:true,beta:true});assert.equal(fs.readFileSync('unrelated.txt','utf8'),'preserve me\\n')",
      ],
    ];
  });
  return second;
}
