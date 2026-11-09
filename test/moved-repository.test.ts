import { execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// A registered checkout moved to a new folder (as a tool that renames
// checkouts moves ~/code/old-name to ~/code/new-name), followed by
// `git worktree repair`, must keep integrating at its new path.

interface Fixture {
  root: string;
  code: string;
  runtime: string;
  home: string;
  oldPath: string;
  newPath: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const cliPath =
  process.env.PARALLEL_INTEGRATOR_TEST_CLI ??
  join(process.cwd(), "dist", "cli.js");
const TIMEOUT = 120_000;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential("a registered repository whose checkout moved", () => {
  it(
    "integrates at the new path after git worktree repair, reusing the old integration worktree",
    async () => {
      const f = await createFixture();
      const first = await begin(f, f.oldPath, "before the move");
      commitFile(first, "before.txt", "before\n", "before the move");
      const integrated = await cli(f, first, ["integrate", "--summary", "x"]);
      expect(integrated.code, output(integrated)).toBe(0);
      const oldId = (await sessionFor(f, first)).repositoryId;
      const oldWorktree = join(f.runtime, "worktrees", oldId);
      expect(git(oldWorktree, "branch", "--show-current")).toBe(
        "sesh-integrator/integration",
      );
      // An unfinished session of the old path must stay exactly as it is.
      const unfinished = await begin(f, f.oldPath, "left unfinished");
      const unfinishedBefore = await sessionFor(f, unfinished);

      await moveCheckout(f);
      // Shared configuration registers the new path in an include file; the local
      // registration of the old path is left behind.
      const old = JSON.parse(
        await readFile(join(f.runtime, "config.json"), "utf8"),
      ).repositories[0];
      const check = [process.execPath, "--version"];
      await writeFile(
        join(f.root, "sesh.json"),
        JSON.stringify({
          repositories: [
            {
              ...old,
              path: f.newPath,
              gitCommonDir: join(f.newPath, ".git"),
              sourceValidationCommands: [check],
              integrationValidationCommands: [check],
            },
          ],
        }),
      );
      await updateConfig(f, (config) => {
        config.include = [{ path: join(f.root, "sesh.json") }];
      });

      const status = await cliOk(f, f.newPath, ["status"]);
      expect(status.stdout).toContain(
        `Stale registration: ${f.oldPath} (this repository moved here`,
      );

      const second = await begin(f, f.newPath, "after the move");
      const began = (await sessionFor(f, second)).id;
      expect(began).toBeTruthy();
      const local = JSON.parse(
        await readFile(join(f.runtime, "config.json"), "utf8"),
      );
      expect(local.repositories).toEqual([]);
      expect(await readdir(join(f.runtime, "config-history"))).not.toHaveLength(
        0,
      );

      commitFile(second, "after.txt", "after\n", "after the move");
      const result = await cli(f, second, ["integrate", "--summary", "y"]);
      expect(result.code, output(result)).toBe(0);
      const newWorktree = join(
        f.runtime,
        "worktrees",
        (await sessionFor(f, second)).repositoryId,
      );
      expect(result.stdout).toContain(
        `Moved integration worktree ${oldWorktree} to ${newWorktree}`,
      );
      expect(await exists(oldWorktree)).toBe(false);
      expect(git(newWorktree, "branch", "--show-current")).toBe(
        "sesh-integrator/integration",
      );
      expect(git(f.newPath, "show", "main:after.txt")).toBe("after");
      expect(git(f.newPath, "show", "main:before.txt")).toBe("before");
      expect((await sessionFor(f, second)).status).toBe("succeeded");
      expect(await sessionFor(f, unfinished)).toEqual(unfinishedBefore);
    },
    TIMEOUT,
  );

  it(
    "adopts the old registration, preserves a dirty old integration worktree, then moves it once clean",
    async () => {
      const f = await createFixture();
      const check = [process.execPath, "--version"];
      await updateConfig(f, (config) => {
        config.repositories[0].sourceValidationCommands = [check];
      });
      const first = await begin(f, f.oldPath, "before the move");
      commitFile(first, "before.txt", "before\n", "before the move");
      expect((await cli(f, first, ["integrate", "--summary", "x"])).code).toBe(
        0,
      );
      const oldWorktree = join(
        f.runtime,
        "worktrees",
        (await sessionFor(f, first)).repositoryId,
      );

      await moveCheckout(f);
      // The skill's first step on an unregistered checkout adopts the old entry.
      const registered = await cliOk(f, f.newPath, [
        "register",
        "--auto-config",
      ]);
      expect(registered.stdout).toContain(
        `Registration moved: ${f.oldPath} -> ${f.newPath}.`,
      );
      expect(
        JSON.parse(await readFile(join(f.runtime, "config.json"), "utf8"))
          .repositories,
      ).toMatchObject([
        {
          path: f.newPath,
          gitCommonDir: join(f.newPath, ".git"),
          sourceValidationCommands: [check],
        },
      ]);

      await writeFile(join(oldWorktree, "notes.txt"), "keep me\n");
      const second = await begin(f, f.newPath, "after the move");
      commitFile(second, "after.txt", "after\n", "after the move");
      const refused = await cli(f, second, ["integrate", "--summary", "y"]);
      expect(refused.code).not.toBe(0);
      expect(output(refused)).toContain(
        `Integration branch sesh-integrator/integration is checked out in ${oldWorktree}; it has changes or a merge in progress, so seshx preserves it.`,
      );
      expect(output(refused)).toContain("Nothing was moved or removed.");
      expect(await readFile(join(oldWorktree, "notes.txt"), "utf8")).toBe(
        "keep me\n",
      );

      // The owner keeps what they need, then reruns integrate for the same
      // session (worktree preparation failed before any merge).
      expect((await sessionFor(f, second)).status).toBe("ready");
      await rm(join(oldWorktree, "notes.txt"));
      const resumed = await cli(f, second, ["integrate", "--summary", "y"]);
      expect(resumed.code, output(resumed)).toBe(0);
      expect(resumed.stdout).toContain(
        `Moved integration worktree ${oldWorktree}`,
      );
      expect(git(f.newPath, "show", "main:after.txt")).toBe("after");
    },
    TIMEOUT,
  );
});

async function createFixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "seshx-moved-repo-")),
  );
  temporaryRoots.push(root);
  const code = join(root, "code");
  const f: Fixture = {
    root,
    code,
    runtime: join(root, "runtime"),
    home: join(root, "home"),
    oldPath: join(code, "old-name"),
    newPath: join(code, "new-name"),
  };
  await mkdir(f.oldPath, { recursive: true });
  await mkdir(f.home, { recursive: true });
  git(f.oldPath, "init", "-b", "main");
  git(f.oldPath, "config", "user.name", "Test User");
  git(f.oldPath, "config", "user.email", "test@example.com");
  git(f.oldPath, "config", "commit.gpgSign", "false");
  commitFile(f.oldPath, "README.md", "readme\n", "base");
  await cliOk(f, f.oldPath, ["init"]);
  await cliOk(f, f.oldPath, ["register"]);
  return f;
}

/** Move the checkout as a rename tool would, then repair worktrees. */
async function moveCheckout(f: Fixture): Promise<void> {
  await rename(f.oldPath, f.newPath);
  git(f.newPath, "worktree", "repair");
}

async function begin(
  f: Fixture,
  cwd: string,
  summary: string,
): Promise<string> {
  const result = await cliOk(f, cwd, [
    "begin",
    "--create-worktree",
    "--harness",
    "claude",
    "--summary",
    summary,
  ]);
  const path = result.stdout.match(/Continue task in: (.+)\n/)?.[1];
  if (!path)
    throw new Error(`begin printed no source path:\n${output(result)}`);
  return path;
}

async function sessions(f: Fixture): Promise<any[]> {
  const directory = join(f.runtime, "sessions");
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")),
      ),
  );
}

async function sessionFor(f: Fixture, worktree: string): Promise<any> {
  const found = (await sessions(f)).find(
    (session) => session.worktreePath === worktree,
  );
  if (!found) throw new Error(`No session for ${worktree}`);
  return found;
}

function commitFile(
  worktree: string,
  name: string,
  contents: string,
  message: string,
): void {
  execFileSync(process.execPath, [
    "-e",
    `require("fs").writeFileSync(${JSON.stringify(join(worktree, name))}, ${JSON.stringify(contents)})`,
  ]);
  git(worktree, "add", name);
  git(worktree, "commit", "-m", message);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function output(result: CliResult): string {
  return result.stdout + result.stderr;
}

async function cli(
  f: Fixture,
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const effective =
    args[0] === "integrate" ? [...args, "--rollout", "none"] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...effective], {
      cwd,
      env: {
        ...process.env,
        PARALLEL_INTEGRATOR_HOME: f.runtime,
        PARALLEL_INTEGRATOR_AUDIT_HOME: f.home,
        PARALLEL_INTEGRATOR_DOCTOR_HOME: f.home,
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

async function cliOk(
  f: Fixture,
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const result = await cli(f, cwd, args);
  expect(result.code, output(result)).toBe(0);
  return result;
}

async function updateConfig(
  f: Fixture,
  mutate: (config: any) => void,
): Promise<void> {
  const path = join(f.runtime, "config.json");
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
