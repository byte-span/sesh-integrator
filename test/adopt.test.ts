import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
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
import { afterEach, expect, it } from "vitest";
import type { Session } from "../src/types.js";

// Each test runs several complete adopt lifecycles through the CLI.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A registered repository whose `origin` is a bare remote, plus a separate
 * clone that plays the cloud sandbox pushing `claude/*` branches.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sesh-adopt-")));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const sandbox = join(root, "sandbox");
  const runtime = join(root, "runtime");
  const checks = join(root, "checks.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESH_INTEGRATOR_HOME: runtime,
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const cli = (args: string[], cwd = repo, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "dist/cli.js"), ...args],
      { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 },
    );
    return {
      code: result.status,
      stdout: result.stdout,
      output: result.stdout + result.stderr,
    };
  };
  const adopt = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = cli(["adopt", ...args, "--json"], repo, extra);
    let document: any;
    try {
      document = JSON.parse(result.stdout);
    } catch {
      throw new Error(`adopt printed no JSON document:\n${result.output}`);
    }
    return { ...result, document };
  };
  const commit = (
    cwd: string,
    file: string,
    contents: string,
    message: string,
  ) => {
    execFileSync(process.execPath, [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(join(cwd, file))}, ${JSON.stringify(contents)})`,
    ]);
    git(["add", file], cwd);
    git(["commit", "-m", message], cwd);
    return git(["rev-parse", "HEAD"], cwd);
  };
  const identify = (cwd: string) => {
    git(["config", "user.name", "Test"], cwd);
    git(["config", "user.email", "test@example.test"], cwd);
    git(["config", "commit.gpgSign", "false"], cwd);
  };

  await mkdir(repo);
  git(["init", "--bare", remote], root);
  git(["init", "-b", "main"]);
  identify(repo);
  commit(repo, "app.txt", "base\n", "base");
  git(["remote", "add", "origin", remote]);
  git(["push", "origin", "main"]);
  git(["clone", remote, sandbox], root);
  identify(sandbox);
  const registered = cli(["register"]);
  expect(registered.code, registered.output).toBe(0);
  // Local checks record where they ran; a file named bad.txt fails them.
  const check = (phase: string) => [
    process.execPath,
    "-e",
    `const fs=require("fs");fs.appendFileSync(${JSON.stringify(checks)}, ${JSON.stringify(phase)} + " " + process.cwd() + "\\n");process.exit(fs.existsSync("bad.txt") ? 1 : 0)`,
  ];
  const configPath = join(runtime, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.repositories[0].sourceValidationCommands = [check("source")];
  config.repositories[0].integrationValidationCommands = [check("integration")];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  /** Push a sandbox branch built on origin/main and return its head. */
  const pushBranch = (
    name: string,
    files: Record<string, string>,
    base = "origin/main",
  ) => {
    git(["fetch", "origin"], sandbox);
    git(["switch", "-C", name, base], sandbox);
    for (const [file, contents] of Object.entries(files))
      commit(sandbox, file, contents, `sandbox: ${file}`);
    git(["push", "-f", "origin", name], sandbox);
    return git(["rev-parse", "HEAD"], sandbox);
  };
  const sessions = async (): Promise<Session[]> => {
    const directory = join(runtime, "sessions");
    const names = (await readdir(directory)).filter((n) => n.endsWith(".json"));
    return Promise.all(
      names.map(
        async (name) =>
          JSON.parse(await readFile(join(directory, name), "utf8")) as Session,
      ),
    );
  };
  const checkLog = async () => {
    try {
      return (await readFile(checks, "utf8")).trim().split("\n");
    } catch {
      return [];
    }
  };
  return {
    root,
    repo,
    remote,
    sandbox,
    git,
    cli,
    adopt,
    commit,
    pushBranch,
    sessions,
    checkLog,
  };
}

it("adopts a sandbox branch as one locally validated commit and reports it again on rerun", async () => {
  const f = await fixture();
  const base = f.git(["rev-parse", "main"]);
  const head = f.pushBranch("claude/greeting", {
    "greeting.txt": "hello\n",
    "app.txt": "base\nchanged\n",
  });

  const first = f.adopt([
    "claude/greeting",
    "--rollout",
    "none",
    "--harness",
    "claude",
    "--summary",
    "Add greeting",
  ]);
  expect(first.code, first.output).toBe(0);
  const doc = first.document;
  expect(doc.schema).toBe("sesh-integrator/session-status@1");
  expect(doc.adopt).toEqual({
    outcome: "promoted",
    reusedSession: false,
    error: null,
    validationFiles: [],
  });
  expect(doc.session.status).toBe("succeeded");
  expect(doc.session.harness).toBe("claude");
  expect(doc.session.startCommit).toBe(base);
  expect(doc.session.adoption).toMatchObject({
    remote: "origin",
    branch: "claude/greeting",
    headSha: head,
    pullRequestUrl: null,
    baseCommit: base,
    commitCount: 2,
  });

  // One new non-merge commit on the target, with the branch's exact tree and
  // provenance; integration adds only its usual staging merge.
  const adopted = doc.session.adoption.adoptedCommit;
  expect(f.git(["rev-list", "--no-merges", `${base}..main`])).toBe(adopted);
  expect(f.git(["rev-parse", "main"])).toBe(doc.session.promotedCommit);
  expect(f.git(["rev-parse", "main^{tree}"])).toBe(
    f.git(["rev-parse", `${head}^{tree}`]),
  );
  expect(f.git(["rev-list", "--parents", "-1", adopted])).toBe(
    `${adopted} ${base}`,
  );
  expect(
    f.git([
      "log",
      "-1",
      "--format=%(trailers:key=Adopted-Head,valueonly)",
      adopted,
    ]),
  ).toBe(head);
  expect(
    f.git([
      "log",
      "-1",
      "--format=%(trailers:key=Adopted-Branch,valueonly)",
      adopted,
    ]),
  ).toBe("claude/greeting");

  // Both phases ran locally: source checks in the session's worktree,
  // integration checks after merging.
  const log = await f.checkLog();
  expect(log).toContain(`source ${doc.session.worktreePath}`);
  expect(log.some((line) => line.startsWith("integration "))).toBe(true);
  // The remote branch is left in place.
  expect(
    f.git(["ls-remote", "--heads", "origin", "claude/greeting"]),
  ).toContain(head);

  const again = f.adopt(["claude/greeting", "--rollout", "none"]);
  expect(again.code, again.output).toBe(0);
  expect(again.document.adopt).toEqual({
    outcome: "already-promoted",
    reusedSession: true,
    error: null,
    validationFiles: [],
  });
  expect(again.document.session.id).toBe(doc.session.id);
  expect((await f.sessions()).filter((s) => s.adoption)).toHaveLength(1);
  expect(f.git(["rev-parse", "main"])).toBe(doc.session.promotedCommit);

  const status = f.cli(["status", "--session", doc.session.id, "--json"]);
  expect(JSON.parse(status.stdout).session.adoption.headSha).toBe(head);
}, 120_000);

it("stops on a failing local check whatever the sandbox reported, then continues the same session on rerun", async () => {
  const f = await fixture();
  const before = f.git(["rev-parse", "main"]);
  f.pushBranch("claude/broken", {
    "feature.txt": "feature\n",
    "bad.txt": "the sandbox said all checks passed\n",
  });

  const failed = f.adopt(["claude/broken", "--rollout", "none"]);
  expect(failed.code, failed.output).toBe(3);
  expect(failed.document.adopt.outcome).toBe("incomplete");
  expect(failed.document.adopt.error.code).toBe("validation_failed");
  expect(failed.document.session.status).toBe("active");
  expect(failed.document.session.adoption.adoptedCommit).toMatch(
    /^[0-9a-f]{40}$/,
  );
  expect(f.git(["rev-parse", "main"])).toBe(before);
  expect(
    (await f.checkLog()).filter((line) => line.startsWith("integration ")),
  ).toEqual([]);

  // A local fix in the session's worktree is validated and integrated by
  // rerunning the same command.
  const worktree = failed.document.session.worktreePath;
  f.git(["rm", "-q", "bad.txt"], worktree);
  const fixed = f.cli(
    [
      "commit",
      "--session",
      failed.document.session.id,
      "--message",
      "Drop bad.txt",
    ],
    worktree,
  );
  expect(fixed.code, fixed.output).toBe(0);
  const retried = f.adopt(["claude/broken", "--rollout", "none"]);
  expect(retried.code, retried.output).toBe(0);
  expect(retried.document.adopt.outcome).toBe("promoted");
  expect(retried.document.adopt.reusedSession).toBe(true);
  expect(retried.document.session.id).toBe(failed.document.session.id);
  expect(f.git(["show", "main:feature.txt"])).toBe("feature");
  expect(f.git(["ls-tree", "--name-only", "main"])).not.toContain("bad.txt");
}, 120_000);

it("flags adopted changes that can alter validation, lists only those, and still adopts", async () => {
  const f = await fixture();
  const manifest = (scripts: Record<string, string>) =>
    `${JSON.stringify({ name: "app", scripts }, null, 2)}\n`;
  f.commit(
    f.repo,
    "package.json",
    manifest({ test: "node -e 0" }),
    "add package.json",
  );
  f.git(["push", "origin", "main"]);
  // The sandbox rewrites what `test` runs and changes ordinary source.
  f.pushBranch("claude/scripts", {
    "package.json": manifest({ test: "node -e 'process.exit(0)'" }),
    "app.txt": "base\nfeature\n",
  });

  const adopted = f.adopt(["claude/scripts", "--rollout", "none"]);
  expect(adopted.code, adopted.output).toBe(0);
  const doc = adopted.document;
  expect(doc.adopt).toMatchObject({
    outcome: "promoted",
    validationFiles: ["package.json"],
  });
  expect(doc.session.adoption.validationFiles).toEqual(["package.json"]);
  expect(adopted.output).toContain(
    "Adopted validation files: 1 (package.json)",
  );
  // Flagged, not refused: the new scripts landed after local checks passed.
  expect(doc.session.status).toBe("succeeded");
  expect(f.git(["show", "main:package.json"])).toContain("process.exit(0)");
  expect(f.git(["show", "main:app.txt"])).toBe("base\nfeature");
  const trailer = (key: string) =>
    f.git([
      "log",
      "-1",
      `--format=%(trailers:key=${key},valueonly)`,
      doc.session.adoption.adoptedCommit,
    ]);
  expect(trailer("Adopted-Validation-Files")).toBe("1");
  expect(trailer("Adopted-Validation-File")).toBe("package.json");

  const id = doc.session.id;
  const status = f.cli(["status", "--session", id]);
  expect(status.output).toContain(
    "  Adopted validation files: 1 (package.json)\n",
  );
  const json = JSON.parse(f.cli(["status", "--session", id, "--json"]).stdout);
  expect(json.session.adoption.validationFiles).toEqual(["package.json"]);
}, 120_000);

it("refuses missing, protected, merged-in and out-of-date branches before creating a session", async () => {
  const f = await fixture();
  const refusal = (args: string[]) => {
    const result = f.adopt([...args, "--rollout", "none"]);
    expect(result.code, result.output).toBe(1);
    expect(result.document.schema).toBe("sesh-integrator/error@1");
    return result.document.error.code;
  };
  expect(refusal(["claude/missing"])).toBe("branch_not_found");
  expect(refusal(["main"])).toBe("branch_not_adoptable");
  // Nothing to adopt when the target already contains the branch.
  f.pushBranch("claude/empty", {});
  expect(refusal(["claude/empty"])).toBe("no_changes");

  // A merge that brings in other work the target does not have.
  f.pushBranch("side", { "side.txt": "side\n" });
  f.pushBranch("claude/merged", { "own.txt": "own\n" });
  f.git(["merge", "--no-edit", "side"], f.sandbox);
  f.git(["push", "origin", "claude/merged"], f.sandbox);
  expect(refusal(["claude/merged"])).toBe("unrelated_history");

  // Built on remote target commits the local target has not received.
  f.git(["switch", "-C", "remote-main", "origin/main"], f.sandbox);
  f.commit(f.sandbox, "upstream.txt", "upstream\n", "upstream work");
  f.git(["push", "origin", "remote-main:main"], f.sandbox);
  f.pushBranch("claude/ahead", { "ahead.txt": "ahead\n" });
  expect(refusal(["claude/ahead"])).toBe("base_not_in_target");

  const usage = f.adopt(["claude/ahead"]);
  expect(usage.code, usage.output).toBe(2);
  expect(usage.document.error.code).toBe("usage");
  expect((await f.sessions()).filter((s) => s.adoption)).toHaveLength(0);
}, 120_000);

it("adopts a same-repository pull request by URL and refuses one from a fork", async () => {
  const f = await fixture();
  // Present the bare remote under a GitHub URL, as a real clone would.
  const url = "https://github.com/acme/widget.git";
  f.git(["remote", "set-url", "origin", url]);
  f.git(["config", `url.${f.remote}.insteadOf`, url]);
  const head = f.pushBranch("claude/pr", { "pr.txt": "pr\n" });
  const bin = join(f.root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fork = process.argv[4].endsWith("/2");
process.stdout.write(JSON.stringify({ headRefName: "claude/pr", headRefOid: ${JSON.stringify(head)}, isCrossRepository: fork, state: "OPEN" }));
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

  const fork = f.adopt(
    ["https://github.com/acme/widget/pull/2", "--rollout", "none"],
    env,
  );
  expect(fork.code, fork.output).toBe(1);
  expect(fork.document.error.code).toBe("pull_request_invalid");

  const other = f.adopt(
    ["https://github.com/other/widget/pull/1", "--rollout", "none"],
    env,
  );
  expect(other.document.error.code).toBe("pull_request_invalid");

  const adopted = f.adopt(
    ["https://github.com/acme/widget/pull/1/files", "--rollout", "none"],
    env,
  );
  expect(adopted.code, adopted.output).toBe(0);
  expect(adopted.document.session.adoption).toMatchObject({
    branch: "claude/pr",
    headSha: head,
    pullRequestUrl: "https://github.com/acme/widget/pull/1",
  });
  expect(
    f.git([
      "log",
      "-1",
      "--format=%(trailers:key=Adopted-Pull-Request,valueonly)",
      adopted.document.session.adoption.adoptedCommit,
    ]),
  ).toBe("https://github.com/acme/widget/pull/1");
}, 120_000);

it("prints the cloud-sandbox guidance as one managed block", async () => {
  const f = await fixture();
  const printed = f.cli(["guidance", "cloud-sandbox"]);
  expect(printed.code, printed.output).toBe(0);
  const text = printed.stdout.trim();
  expect(text.startsWith("<!-- sesh-integrator-cloud:managed:start -->")).toBe(
    true,
  );
  expect(text.endsWith("<!-- sesh-integrator-cloud:managed:end -->")).toBe(
    true,
  );
  expect(text.match(/managed:start/g)).toHaveLength(1);
  expect(text).toBe(
    (
      await readFile(join(process.cwd(), "CLOUD_SANDBOX_SNIPPET.md"), "utf8")
    ).trim(),
  );
});
