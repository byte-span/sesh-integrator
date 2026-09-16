import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sesh-install-transition-"));
  roots.push(root);
  const home = join(root, "home"),
    runtime = join(home, ".codex-handoff"),
    repo = join(root, "repo"),
    pkg = join(root, "package");
  await mkdir(home);
  await mkdir(repo);
  await mkdir(pkg);
  for (const name of [
    "dist",
    "skill",
    "scripts",
    "systemd",
    "package.json",
    "harnesses.json",
    "GLOBAL_AGENTS_SNIPPET.md",
  ])
    await cp(join(process.cwd(), name), join(pkg, name), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    SESH_INTEGRATOR_HOME: runtime,
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const run = (
    args: string[],
    cwd = repo,
    executable = join(pkg, "dist/cli.js"),
  ) => {
    const r = spawnSync(process.execPath, [executable, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    return { code: r.status, output: r.stdout + r.stderr };
  };
  const ok = (args: string[], cwd = repo, executable?: string) => {
    const r = run(args, cwd, executable);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };
  const sessions = async () =>
    Promise.all(
      (await readdir(join(runtime, "sessions")))
        .filter((n) => n.endsWith(".json"))
        .map(async (n) =>
          JSON.parse(await readFile(join(runtime, "sessions", n), "utf8")),
        ),
    );
  ok(["register"]);
  ok(["setup", "--harness", "codex", "--harness", "claude", "--yes"]);
  return { root, home, runtime, repo, pkg, env, git, run, ok, sessions };
}
it("keeps concurrent sessions recoverable across deferred uninstall, package removal and same-build reinstall", async () => {
  const f = await fixture();
  f.ok(["begin", "--create-worktree", "--summary", "first"]);
  f.ok(["begin", "--create-worktree", "--summary", "second"]);
  const sessions = await f.sessions();
  expect(sessions).toHaveLength(2);
  for (const s of sessions) {
    expect(s.coordinator.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(s.coordinator.cliPath.startsWith(f.runtime)).toBe(true);
    await writeFile(join(s.worktreePath, s.id), "work\n");
    f.git(s.worktreePath, "add", ".");
    f.ok(["commit", "--message", "work"], s.worktreePath);
  }
  const guidance = join(f.home, ".codex/AGENTS.md");
  const before = await readFile(guidance, "utf8");
  expect(f.ok(["uninstall", "--harness", "codex", "--yes"])).toContain(
    "Removal deferred",
  );
  expect(await readFile(guidance, "utf8")).toBe(before);
  expect(
    f.run(["begin", "--create-worktree", "--summary", "blocked"]).output,
  ).toContain("enrollment is stopped");
  expect(await readFile(join(f.home, ".claude/CLAUDE.md"), "utf8")).toContain(
    "managed:start",
  );
  // Direct package removal bypasses the tool entirely; independent assets survive.
  await rm(f.pkg, { recursive: true });
  for (const s of sessions)
    f.ok(
      ["integrate", "--summary", "done", "--rollout", "none"],
      s.worktreePath,
      s.coordinator.cliPath,
    );
  expect((await f.sessions()).every((s) => s.status === "succeeded")).toBe(
    true,
  );
  const retained = sessions[0]!.coordinator.cliPath;
  f.ok(["setup", "--harness", "codex", "--yes"], f.repo, retained);
  f.ok(
    ["begin", "--create-worktree", "--summary", "after reinstall"],
    f.repo,
    retained,
  );
  expect((await f.sessions())[2]!.coordinator.buildId).toBe(
    sessions[0]!.coordinator.buildId,
  );
});
it("accepts a compatible different build, diagnoses a missing executable, and rejects incompatible records before setup mutation", async () => {
  const f = await fixture();
  f.ok(["begin", "--create-worktree", "--summary", "upgrade"]);
  let s = (await f.sessions())[0]!;
  const old = s.coordinator.buildId;
  await rm(s.coordinator.cliPath);
  expect(f.ok(["status", "--session", s.id])).toContain("MISSING");
  // Same-build reinstall repairs by retaining a new independent copy, never
  // overwriting the damaged evidence. Compatible builds need not share versions.
  f.ok(["setup", "--harness", "codex", "--yes"]);
  await writeFile(
    join(f.pkg, "dist/cli.js"),
    (await readFile(join(f.pkg, "dist/cli.js"), "utf8")) +
      "\n// compatible local build\n",
  );
  f.ok(["setup", "--harness", "codex", "--yes"]);
  f.ok(["begin", "--create-worktree", "--summary", "new build"]);
  const newer = (await f.sessions())[1]!;
  expect(newer.coordinator.buildId).not.toBe(old);
  expect(newer.coordinator.version).toBe(s.coordinator.version);
  await writeFile(join(s.worktreePath, "upgrade.txt"), "upgrade\n");
  f.git(s.worktreePath, "add", ".");
  f.ok(["commit", "--message", "upgrade task"], s.worktreePath);
  await writeFile(join(f.repo, "old.txt"), "old\n");
  expect(
    f.run(
      ["integrate", "--summary", "upgrade done", "--rollout", "none"],
      s.worktreePath,
    ).code,
  ).toBe(1);
  f.git(f.repo, "add", ".");
  f.git(f.repo, "commit", "-m", "old work");
  s = (await f.sessions()).find((item) => item.id === s.id)!;
  const path = join(f.runtime, "sessions", s.id + ".json");
  s.coordinator.stateContract = 999;
  await writeFile(path, JSON.stringify(s));
  const guidance = await readFile(join(f.home, ".codex/AGENTS.md"), "utf8");
  const config = await readFile(join(f.runtime, "config.json"), "utf8");
  expect(f.run(["setup", "--harness", "codex", "--yes"]).output).toContain(
    "Incompatible session",
  );
  expect(f.run(["installation-check"]).code).toBe(1);
  expect(await readFile(join(f.home, ".codex/AGENTS.md"), "utf8")).toBe(
    guidance,
  );
  expect(await readFile(join(f.runtime, "config.json"), "utf8")).toBe(config);
  // Legacy records remain readable and unfinished; no fabricated build origin.
  delete s.coordinator;
  await writeFile(path, JSON.stringify(s));
  expect(f.ok(["status", "--session", s.id])).toContain(
    "legacy (no build identity)",
  );
  f.ok(["installation-check"]);
  f.ok(["resume"], s.worktreePath);
  const recovered = (await f.sessions()).find((item) => item.id === s.id)!;
  expect(recovered.status).toBe("succeeded");
  expect(recovered.recoveryCoordinator.buildId).toBe(newer.coordinator.buildId);
  expect(await readFile(join(f.repo, "upgrade.txt"), "utf8")).toBe("upgrade\n");
});

it.each([
  "active",
  "ready",
  "needs_review",
  "validation_pending",
  "promotion_pending",
])(
  "defers removal and preserves locks and records for %s sessions",
  async (status) => {
    const f = await fixture();
    f.ok(["begin", "--create-worktree", "--summary", "unfinished"]);
    const s = (await f.sessions())[0]!;
    s.status = status;
    s.waitingForLock = true;
    const path = join(f.runtime, "sessions", s.id + ".json");
    await writeFile(path, JSON.stringify(s));
    const lock = join(f.runtime, "locks", s.repositoryId + ".lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, sessionId: s.id }),
    );
    const before = await readFile(path, "utf8");
    expect(f.ok(["uninstall", "--yes"])).toContain("Removal deferred");
    f.ok(["setup", "--harness", "codex", "--yes"]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(
      JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).sessionId,
    ).toBe(s.id);
  },
);

it("retries interrupted guidance receipts and ignores incomplete unpublished coordinator copies", async () => {
  const f = await fixture();
  const guidance = join(f.home, ".codex/AGENTS.md");
  const receiptPath = join(f.runtime, "installation.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const next = `<!-- codex-handoff:managed:start -->\n${(await readFile(join(f.pkg, "GLOBAL_AGENTS_SNIPPET.md"), "utf8")).trim()}\nNew guidance.\n<!-- codex-handoff:managed:end -->`;
  await writeFile(join(f.pkg, "GLOBAL_AGENTS_SNIPPET.md"), next);
  receipt[guidance + ":previous"] = receipt[guidance];
  receipt[guidance] = createHash("sha256").update(next).digest("hex");
  await writeFile(receiptPath, JSON.stringify(receipt));
  await mkdir(join(f.runtime, "coordinators/.install-interrupted/dist"), {
    recursive: true,
  });
  await writeFile(
    join(f.runtime, "coordinators/.install-interrupted/dist/cli.js"),
    "incomplete",
  );
  f.ok(["setup", "--harness", "codex", "--yes"]);
  f.ok(["setup", "--harness", "codex", "--yes"]);
  expect(await readFile(guidance, "utf8")).toContain("New guidance.");
  expect(
    await readFile(
      join(f.runtime, "coordinators/.install-interrupted/dist/cli.js"),
      "utf8",
    ),
  ).toBe("incomplete");
});
