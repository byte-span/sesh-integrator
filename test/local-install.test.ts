import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sesh-local-install-")),
  );
  roots.push(root);
  const repo = join(root, "repo"),
    home = join(root, "home"),
    runtime = join(root, "runtime"),
    bin = join(root, "bin"),
    releases = join(root, "releases");
  await mkdir(repo);
  await mkdir(home);
  for (const path of [
    "src",
    "dist",
    "scripts",
    "skill",
    "systemd",
    "package.json",
    "harnesses.json",
    "GLOBAL_AGENTS_SNIPPET.md",
    "tsconfig.json",
    "tsconfig.build.json",
  ])
    await cp(join(process.cwd(), path), join(repo, path), { recursive: true });
  await symlink(
    join(process.cwd(), "node_modules"),
    join(repo, "node_modules"),
    "dir",
  );
  await writeFile(
    join(repo, ".gitignore"),
    "node_modules/\ndist/\n*.ignored\n",
  );
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    SESH_INTEGRATOR_HOME: runtime,
    SESH_INTEGRATOR_BIN_DIR: bin,
    SESH_INTEGRATOR_RELEASE_DIR: releases,
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const cli = (args: string[], expected = 0) => {
    const result = spawnSync(
      process.execPath,
      [join(repo, "dist/cli.js"), ...args],
      { cwd: repo, env, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(expected);
    return result.stdout + result.stderr;
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("add", ".");
  git("commit", "-m", "base");
  cli(["register"]);
  cli(["begin", "--summary", "local installation fixture"]);
  const name = (await readdir(join(runtime, "sessions"))).find((n) =>
    n.endsWith(".json"),
  )!;
  const sessionPath = join(runtime, "sessions", name);
  const session = () => readFile(sessionPath, "utf8").then(JSON.parse);
  const id = (await session()).id;
  const install = (expected = 0) => {
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts/install-local.mjs"), "--session", id],
      { cwd: repo, env, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(expected);
    return result.stdout + result.stderr;
  };
  const promote = async (docsOnly = false) => {
    await writeFile(
      join(repo, docsOnly ? "README.md" : "src/local-install-fixture.ts"),
      docsOnly
        ? "Documentation only\n"
        : "export const installedFixture = true;\n",
    );
    git("add", ".");
    cli(["commit", "--message", "fixture task"]);
    cli(["validate"]);
    cli(["integrate", "--summary", "fixture done", "--rollout", "none"]);
  };
  const receipt = async () =>
    JSON.parse(
      await readFile(
        join(
          runtime,
          "local-installations",
          (await session()).repositoryId + ".json",
        ),
        "utf8",
      ),
    );
  return {
    root,
    repo,
    home,
    runtime,
    bin,
    releases,
    env,
    git,
    cli,
    id,
    session,
    sessionPath,
    install,
    promote,
    receipt,
  };
}

it("installs the exact promoted tree, excludes ignored build contamination, refreshes guidance, and reuses a verified snapshot", async () => {
  const f = await fixture();
  f.cli(["setup", "--harness", "codex", "--yes"]);
  const pinned = (await f.session()).coordinator.cliPath;
  const pinnedBytes = await readFile(pinned);
  await f.promote();
  await writeFile(join(f.repo, "dist", "stale.js"), "unvalidated");
  await writeFile(join(f.repo, "scripts", "extra.ignored"), "unvalidated");
  const before = await readFile(f.sessionPath, "utf8");
  expect(f.install()).toContain("Local installation: verified");
  const first = await f.receipt();
  expect(first.phase).toBe("verified");
  expect(first.harnesses).toEqual(["codex"]);
  expect(first.promotedCommit).toBe((await f.session()).promotedCommit);
  expect(first.cliPath.startsWith(f.releases)).toBe(true);
  const release = join(first.cliPath, "../..");
  await expect(readFile(join(release, "dist", "stale.js"))).rejects.toThrow();
  await expect(
    readFile(join(release, "scripts", "extra.ignored")),
  ).rejects.toThrow();
  expect(
    await readFile(join(release, "dist/local-install-fixture.js"), "utf8"),
  ).toContain("installedFixture = true");
  expect(f.install()).toContain("Reusing verified installed snapshot");
  expect((await f.receipt()).cliPath).toBe(first.cliPath);
  expect(await readFile(pinned)).toEqual(pinnedBytes);
  expect(await readFile(f.sessionPath, "utf8")).toBe(before);
  for (const name of [
    "seshx",
    "sesh-integrator",
    "pintx",
    "parallel-integrator",
    "codex-handoff",
  ])
    expect(await realpath(join(f.bin, name))).toBe(first.cliPath);
});

it("preserves missing registered worktrees while still excluding their paths as installation destinations", async () => {
  const f = await fixture();
  await f.promote();
  const missing = join(f.root, "missing-worktree");
  f.git("worktree", "add", "--detach", missing, "HEAD");
  await rm(missing, { recursive: true });
  const before = f.git("worktree", "list", "--porcelain");
  f.env.SESH_INTEGRATOR_RELEASE_DIR = join(missing, "releases");
  expect(f.install(1)).toContain("outside all repository worktrees");
  f.env.SESH_INTEGRATOR_RELEASE_DIR = f.releases;
  expect(f.install()).toContain("Local installation: verified");
  expect(f.git("worktree", "list", "--porcelain")).toBe(before);
});

it("rejects unpromoted sessions, dirty source, and newer target commits before publication", async () => {
  const f = await fixture();
  expect(f.install(1)).toContain("requires validated local promotion");
  await f.promote();
  await writeFile(join(f.repo, "user-work"), "preserve\n");
  expect(f.install(1)).toContain("user changes were preserved");
  expect(await readFile(join(f.repo, "user-work"), "utf8")).toBe("preserve\n");
  f.git("add", "user-work");
  f.git("commit", "-m", "later work");
  f.git("update-ref", "refs/heads/main", f.git("rev-parse", "HEAD"));
  expect(f.install(1)).toContain("Target moved");
  await expect(readdir(f.bin)).rejects.toThrow();
});

it("skips documentation-only changes without publishing or refreshing guidance", async () => {
  const f = await fixture();
  await f.promote(true);
  expect(f.install()).toContain("not required");
  await expect(readdir(f.releases)).rejects.toThrow();
});

it("retains an installed CLI and records a guidance blocker, then retries without replacing its release", async () => {
  const f = await fixture();
  f.cli(["setup", "--harness", "codex", "--yes"]);
  await f.promote();
  const guidance = join(f.home, ".codex/AGENTS.md");
  const original = await readFile(guidance, "utf8");
  await writeFile(
    guidance,
    original.replace("# sesh-integrator", "# Personal sesh-integrator"),
  );
  expect(f.install(1)).toContain("Preserving customized guidance");
  const blocked = await f.receipt();
  expect(blocked.phase).toBe("refreshing-guidance");
  expect(await readFile(guidance, "utf8")).toContain(
    "# Personal sesh-integrator",
  );
  expect(await realpath(join(f.bin, "seshx"))).toBe(blocked.cliPath);
  await writeFile(guidance, original); // Fixture owner resolves the intentional edit.
  expect(f.install()).toContain("Local installation: verified");
  expect((await f.receipt()).cliPath).toBe(blocked.cliPath);
});

it("honors manual mode, opt-outs, incompatible state, and unknown installation locks", async () => {
  const f = await fixture();
  await f.promote();
  f.cli(["capabilities", "--mode", "manual"]);
  expect(f.install(1)).toContain("Manual handoff mode");
  f.cli(["capabilities", "--mode", "automatic"]);
  f.cli(["disable"]);
  expect(f.install(1)).toContain("disabled");
  f.cli(["enable"]);
  const unknownLock = join(f.runtime, "locks/local-install.lock");
  await writeFile(unknownLock, "unknown owner");
  expect(f.install(1)).toContain("preserve unknown locks");
  expect(await readFile(unknownLock, "utf8")).toBe("unknown owner");
  await rm(unknownLock); // Test-created fixture lock only.
  const s = await f.session();
  s.id = "future-session";
  s.status = "active";
  s.coordinator.stateContract = 999;
  await writeFile(
    join(f.runtime, "sessions/future-session.json"),
    JSON.stringify(s),
  );
  expect(f.install(1)).toContain("Incompatible session");
  await expect(readdir(f.bin)).rejects.toThrow();
});

it("permits verified local installation with only remote publishing pending, and preserves that recovery state", async () => {
  const f = await fixture();
  await f.promote();
  const session = await f.session();
  session.status = "needs_review";
  session.recoveryPhase = "pull_request";
  session.latestError = "Remote publishing denied";
  await writeFile(f.sessionPath, JSON.stringify(session));
  expect(f.install()).toContain("Local installation: verified");
  expect((await f.receipt()).remotePromotion).toBe("pending");
  expect(await f.session()).toEqual(session);
});

it("refuses release destinations inside a worktree even through a symlink", async () => {
  const f = await fixture();
  await f.promote();
  await symlink(f.repo, f.releases, "dir");
  expect(f.install(1)).toContain("outside all repository worktrees");
  await expect(readdir(f.bin)).rejects.toThrow();
});

it("reports partial alias publication, preserves the earlier release, and completes on retry", async () => {
  const f = await fixture();
  await f.promote();
  const tools = join(f.root, "tools");
  await mkdir(tools);
  const actualMv = execFileSync("sh", ["-c", "command -v mv"], {
    encoding: "utf8",
  }).trim();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    join(tools, "mv"),
    `#!/bin/sh\ncase "$3" in */pintx) exit 73;; esac\nexec ${quote(actualMv)} "$@"\n`,
    { mode: 0o755 },
  );
  f.env.PATH = `${tools}:${process.env.PATH}`;
  const output = f.install(1);
  expect(output).toContain("preserved release snapshot:");
  expect(output).toContain("exit 73");
  expect(output).toContain("Local installation incomplete (publishing)");
  const partiallyPublished = await realpath(join(f.bin, "seshx"));
  expect(await readFile(partiallyPublished, "utf8")).toContain("seshx");
  expect((await f.receipt()).phase).toBe("publishing");
  f.env.PATH = process.env.PATH;
  expect(f.install()).toContain("Local installation: verified");
  expect(await readFile(partiallyPublished, "utf8")).toContain("seshx");
});

it("preserves stopped harness enrollment during local installation", async () => {
  const f = await fixture();
  f.cli(["setup", "--harness", "codex", "--yes"]);
  await f.promote();
  f.cli(["begin", "--summary", "unfinished unrelated task"]);
  expect(f.cli(["uninstall", "--harness", "codex", "--yes"])).toContain(
    "Removal deferred",
  );
  const enrollment = await readFile(join(f.runtime, "enrollment.json"), "utf8");
  expect(f.install()).toContain("Stopped harnesses preserved: codex");
  expect((await f.receipt()).deferredHarnesses).toEqual(["codex"]);
  expect(await readFile(join(f.runtime, "enrollment.json"), "utf8")).toBe(
    enrollment,
  );
});
