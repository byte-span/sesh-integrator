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
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDeliveryPolicy,
  repositoryFromRemoteUrl,
} from "../src/delivery-policy.js";
import type { Session } from "../src/types.js";

const cli = join(process.cwd(), "dist", "cli.js");
const roots: string[] = [];
const SLUG_URL = "https://github.com/Acme/Widget.git";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const prPolicy = {
  schema: "sesh-integrator/delivery-policy@1",
  version: "policy-v1",
  defaults: {
    targetBranch: "dev",
    promotion: {
      type: "pull-request",
      mode: "shared-target",
      productionBranch: "main",
      remote: "origin",
    },
    completion: "production-merged",
  },
  repositories: {
    "byte-span/secret-sync": {
      promotion: { type: "none" },
      completion: "local",
    },
  },
};

const localPolicy = {
  ...prPolicy,
  version: "policy-v2",
  repositories: {
    "acme/widget": { promotion: { type: "none" }, completion: "local" },
  },
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function fixture(
  options: { remoteDev?: boolean; origin?: string | null } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sesh-delivery-policy-")),
  );
  roots.push(root);
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const ghLog = join(root, "gh.log");
  const ghState = join(root, "gh-state.json");
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(ghState, "[]\n");
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(" ") + "\\n");
const prs = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const value = (name) => args[args.indexOf(name) + 1];
if (args[0] === "auth" && args[1] === "status") process.exit(process.env.FAKE_GH_FAIL_AUTH ? 1 : 0);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(prs.filter((pr) => pr.base === value("--base") && pr.head === value("--head"))) + "\\n");
} else if (args[0] === "pr" && args[1] === "create") {
  const pr = { url: "https://github.example/pull/" + (17 + prs.length), base: value("--base"), head: value("--head") };
  prs.push(pr); fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(prs));
  process.stdout.write(pr.url + "\\n");
} else if (args[0] === "pr" && args[1] === "edit") process.exit(0);
else process.exit(2);
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESH_INTEGRATOR_HOME: runtime,
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_STATE: ghState,
  };
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const run = (
    args: string[],
    cwd = repo,
    extra: NodeJS.ProcessEnv = {},
  ): Result => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 60000,
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const ok = (args: string[], cwd = repo, extra: NodeJS.ProcessEnv = {}) => {
    const result = run(args, cwd, extra);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    return result;
  };
  const commit = (cwd: string, name: string, contents: string) => {
    execFileSync(process.execPath, [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(join(cwd, name))}, ${JSON.stringify(contents)})`,
    ]);
    git(["add", name], cwd);
    git(["commit", "-m", `add ${name}`], cwd);
    return git(["rev-parse", "HEAD"], cwd);
  };
  /** Push a new commit to the remote target from an independent clone. */
  const advanceRemote = (name: string, branch = "dev") => {
    const writer = join(root, `writer-${Math.random().toString(36).slice(2)}`);
    git(["clone", "--quiet", remote, writer], root);
    git(["config", "user.name", "Remote"], writer);
    git(["config", "user.email", "remote@example.test"], writer);
    git(["switch", "--quiet", branch], writer);
    const head = commit(writer, name, `${name}\n`);
    git(["push", "--quiet", "origin", branch], writer);
    return head;
  };
  const sessions = async (): Promise<Session[]> => {
    const directory = join(runtime, "sessions");
    let names: string[] = [];
    try {
      names = (await readdir(directory)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return (
      await Promise.all(
        names.map(
          async (name) =>
            JSON.parse(
              await readFile(join(directory, name), "utf8"),
            ) as Session,
        ),
      )
    ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  };
  const updateConfig = async (mutate: (config: any) => void) => {
    const path = join(runtime, "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    mutate(config);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  };
  const writePolicy = async (value: unknown, name = "policy.json") => {
    const path = join(root, name);
    await writeFile(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    return path;
  };

  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "commit.gpgSign", "false"]);
  commit(repo, "base.txt", "base\n");
  git(["init", "--quiet", "--bare", remote], root);
  const origin = options.origin === undefined ? SLUG_URL : options.origin;
  if (origin !== null) {
    git(["remote", "add", "origin", origin]);
    // The GitHub identity stays in remote.origin.url; Git talks to the bare repo.
    if (origin === SLUG_URL) git(["config", `url.${remote}.insteadOf`, origin]);
    git(["push", "--quiet", "origin", "main"]);
    if (options.remoteDev !== false)
      git(["push", "--quiet", "origin", "main:refs/heads/dev"]);
    git(["fetch", "--quiet", "origin"]);
  }
  ok(["register"]);
  return {
    root,
    repo,
    runtime,
    remote,
    ghLog,
    git,
    run,
    ok,
    commit,
    advanceRemote,
    sessions,
    updateConfig,
    writePolicy,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function parseOnlyDocument(result: Result): any {
  // stdout must be exactly one JSON document.
  return JSON.parse(result.stdout);
}

const sha = /^[a-f0-9]{40}$/;

/** Mirror of the contract's seshStatusDocumentSchema field types. */
function expectStatusDocument(document: any): void {
  expect(document.schema).toBe("sesh-integrator/session-status@1");
  const s = document.session;
  expect(s.id).toMatch(/^session_/);
  expect([
    "active",
    "ready",
    "validation_pending",
    "promotion_pending",
    "succeeded",
    "no_changes",
    "abandoned",
    "needs_review",
  ]).toContain(s.status);
  for (const key of ["repositoryPath", "worktreePath", "branch"])
    expect(typeof s[key]).toBe("string");
  expect(s.startCommit).toMatch(sha);
  expect(Array.isArray(s.dependsOn)).toBe(true);
  for (const key of ["readyCommit", "integratedCommit", "promotedCommit"])
    if (s[key] !== null) expect(s[key]).toMatch(sha);
  for (const key of [
    "harness",
    "targetBranch",
    "pullRequestUrl",
    "remotePromotedAt",
    "latestError",
    "integrationWorktreePath",
    "conflictPromptPath",
  ])
    expect(s[key] === null || typeof s[key] === "string").toBe(true);
  if (s.pullRequestUrl !== null) new URL(s.pullRequestUrl);
  expect([
    null,
    "merge",
    "post_integration",
    "promotion",
    "pull_request",
    "remote_promotion",
    "local_target",
  ]).toContain(s.recoveryPhase);
  expect(typeof s.awaitingConflictResolution).toBe("boolean");
  expect([null, "none", "applied", "automated", "manual"]).toContain(
    s.rolloutDisposition,
  );
  expect(Array.isArray(s.rolloutFollowUps)).toBe(true);
  if (s.delivery !== null) {
    expect(s.delivery.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(s.delivery.repository).toMatch(/^[a-z0-9-]+\/[a-z0-9._-]+$/);
    expect(typeof s.delivery.targetBranch).toBe("string");
    expect(["local", "target-pushed", "production-merged"]).toContain(
      s.delivery.completion,
    );
    expect(
      s.delivery.version === null || typeof s.delivery.version === "string",
    ).toBe(true);
    expect(["none", "pull-request"]).toContain(s.delivery.promotion.type);
  }
  if (document.resumeCommand !== null) {
    expect(document.resumeCommand.length).toBeGreaterThan(0);
    for (const part of document.resumeCommand)
      expect(typeof part).toBe("string");
  }
  if ("sync" in document) {
    expect(
      document.sync.remote === null || typeof document.sync.remote === "string",
    ).toBe(true);
    expect([
      "fast-forwarded",
      "up-to-date",
      "local-ahead",
      "no-remote-branch",
    ]).toContain(document.sync.result);
  }
}

function expectError(result: Result, code: string): void {
  expect(result.code, result.stdout + result.stderr).not.toBe(0);
  const document = parseOnlyDocument(result);
  expect(document.schema).toBe("sesh-integrator/error@1");
  expect(document.error.code, document.error.message).toBe(code);
  expect(typeof document.error.message).toBe("string");
}

async function beginJson(
  f: Fixture,
  extra: string[],
  cwd = f.repo,
): Promise<Result> {
  return f.run(
    [
      "begin",
      "--create-worktree",
      "--harness",
      "claude",
      "--json",
      "--summary",
      "Policy task",
      ...extra,
    ],
    cwd,
  );
}

describe("delivery policy format", () => {
  it("normalizes defaults and validates every rule strictly", () => {
    const parsed = parseDeliveryPolicy(prPolicy);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy!.defaults.promotion).toEqual({
      type: "pull-request",
      mode: "shared-target",
      productionBranch: "main",
      remote: "origin",
    });
    const minimal = parseDeliveryPolicy({
      schema: "sesh-integrator/delivery-policy@1",
      defaults: {
        targetBranch: "dev",
        promotion: { type: "pull-request", reviewers: ["org/team"] },
        completion: "target-pushed",
      },
    });
    expect(minimal.policy).toEqual({
      schema: "sesh-integrator/delivery-policy@1",
      defaults: {
        targetBranch: "dev",
        promotion: {
          type: "pull-request",
          mode: "shared-target",
          productionBranch: "main",
          remote: "origin",
          reviewers: ["org/team"],
        },
        completion: "target-pushed",
      },
      repositories: {},
    });

    const invalid = (value: unknown) => parseDeliveryPolicy(value).issues;
    expect(invalid({ ...prPolicy, extra: 1 })).toEqual([
      "extra: unknown field",
    ]);
    expect(
      invalid({ ...prPolicy, defaults: { ...prPolicy.defaults, x: 1 } }),
    ).toEqual(["defaults.x: unknown field"]);
    expect(
      invalid({
        ...prPolicy,
        defaults: { targetBranch: "dev", completion: "local" },
      }),
    ).toEqual(["defaults.promotion: required"]);
    expect(
      invalid({
        ...prPolicy,
        repositories: { "Acme/Widget": { completion: "local" } },
      })[0],
    ).toContain("lowercase GitHub owner/name");
    expect(
      invalid({
        ...prPolicy,
        repositories: { "acme/widget": { promotion: { type: "none", x: 1 } } },
      })[0],
    ).toBe("repositories.acme/widget.promotion.x: unknown field");
    // Whole-field override: promotion none with the default completion is inconsistent.
    expect(
      invalid({
        ...prPolicy,
        repositories: { "acme/widget": { promotion: { type: "none" } } },
      }),
    ).toEqual([
      'repositories.acme/widget: promotion "none" pushes nothing, so completion must be "local"',
    ]);
    expect(
      invalid({
        ...prPolicy,
        repositories: { "acme/widget": { targetBranch: "main" } },
      }),
    ).toEqual([
      "repositories.acme/widget: productionBranch must differ from targetBranch",
    ]);
    expect(
      invalid({
        ...prPolicy,
        defaults: {
          ...prPolicy.defaults,
          promotion: { type: "pull-request", mode: "session-branch" },
          completion: "target-pushed",
        },
      })[0],
    ).toContain("session-branch mode never pushes the target");
    expect(
      invalid({ ...prPolicy, schema: "sesh-integrator/delivery-policy@2" }),
    ).toEqual(['schema: must be "sesh-integrator/delivery-policy@1"']);
    expect(invalid({ ...prPolicy, version: "" })[0]).toContain("version");
    expect(
      invalid({
        ...prPolicy,
        defaults: { ...prPolicy.defaults, targetBranch: "bad..branch" },
      }),
    ).toEqual(["defaults.targetBranch: must be a branch name"]);
  });

  it("identifies GitHub repositories from fetch URLs", () => {
    for (const url of [
      "https://github.com/Byte-Span/Sesh-Integrator.git",
      "https://github.com/byte-span/sesh-integrator",
      "git@github.com:byte-span/sesh-integrator.git",
      "ssh://git@github.com/byte-span/sesh-integrator.git",
    ])
      expect(repositoryFromRemoteUrl(url)).toBe("byte-span/sesh-integrator");
    expect(repositoryFromRemoteUrl("https://gitlab.com/a/b.git")).toBeNull();
    expect(repositoryFromRemoteUrl("/tmp/remote.git")).toBeNull();
  });
});

describe.sequential("delivery policy CLI", () => {
  it("checks policy files and resolves repository rules as JSON", async () => {
    const f = await fixture({ origin: null });
    const path = await f.writePolicy(prPolicy);
    const normalized = parseOnlyDocument(
      f.ok(["policy", "check", "--file", path]),
    );
    expect(normalized.defaults.promotion.remote).toBe("origin");
    const bytes = await readFile(path);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(
      parseOnlyDocument(
        f.ok([
          "policy",
          "check",
          "--file",
          path,
          "--repository",
          "Byte-Span/Secret-Sync",
        ]),
      ),
    ).toEqual({
      version: "policy-v1",
      sha256: digest,
      repository: "byte-span/secret-sync",
      targetBranch: "dev",
      promotion: { type: "none" },
      completion: "local",
      source: "repository",
    });
    expect(
      parseOnlyDocument(
        f.ok(["policy", "check", "--file", path, "--repository", "a/b"]),
      ).source,
    ).toBe("defaults");
    expectError(
      f.run(["policy", "check", "--file", join(f.root, "missing.json")]),
      "policy_missing",
    );
    expectError(
      f.run([
        "policy",
        "check",
        "--file",
        await f.writePolicy("{not json", "broken.json"),
      ]),
      "policy_invalid",
    );
    expectError(f.run(["policy", "check"]), "usage");
  });

  it("fails begin on a missing or invalid policy without changing anything", async () => {
    const f = await fixture();
    const before = f.git(["for-each-ref"]);
    expectError(
      await beginJson(f, ["--policy-file", join(f.root, "absent.json")]),
      "policy_missing",
    );
    const invalid = await f.writePolicy({
      ...prPolicy,
      repositories: { "acme/widget": { promotion: { type: "none" } } },
    });
    const failed = await beginJson(f, [
      "--policy-file",
      invalid,
      "--sync-target",
    ]);
    expectError(failed, "policy_invalid");
    expect(parseOnlyDocument(failed).error.message).toContain(
      "repositories.acme/widget",
    );
    // A configured global policy file is equally required.
    await f.updateConfig((config) => {
      config.deliveryPolicyFile = "missing-policy.json";
    });
    expectError(await beginJson(f, []), "policy_missing");
    expect(await f.sessions()).toEqual([]);
    expect(f.git(["for-each-ref"])).toBe(before);
    expect(f.git(["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("records the delivery rule and promotes by pull request even when the repository is local-only", async () => {
    const f = await fixture();
    await f.updateConfig((config) => {
      config.defaultPromotion = {
        reviewers: ["global-reviewer"],
        assignees: ["global-assignee"],
      };
    });
    const policy = await f.writePolicy(prPolicy);
    const begun = await beginJson(f, ["--policy-file", policy]);
    expect(begun.code, begun.stderr).toBe(0);
    expect(begun.stderr).toContain("Started session_");
    const document = parseOnlyDocument(begun);
    expectStatusDocument(document);
    expect(document.sync).toBeUndefined();
    expect(document.resumeCommand).toBeNull();
    expect(document.session).toMatchObject({
      status: "active",
      harness: "claude",
      targetBranch: "dev",
      readyCommit: null,
      delivery: {
        version: "policy-v1",
        repository: "acme/widget",
        targetBranch: "dev",
        promotion: {
          type: "pull-request",
          mode: "shared-target",
          productionBranch: "main",
          remote: "origin",
        },
        completion: "production-merged",
        source: "defaults",
      },
    });
    const id = document.session.id as string;
    const worktree = document.session.worktreePath as string;
    expect(document.session.startCommit).toBe(f.git(["rev-parse", "dev"]));
    const recorded = (await f.sessions())[0]!;
    expect(recorded.coordinator?.stateContract).toBe(2);
    expect(recorded.delivery?.sha256).toBe(document.session.delivery.sha256);

    // Policy changes affect new sessions only.
    await writeFile(policy, JSON.stringify(localPolicy));
    f.commit(worktree, "feature.txt", "feature\n");
    f.ok(["integrate", "--summary", "done", "--rollout", "none"], worktree);
    const calls = await readFile(f.ghLog, "utf8");
    expect(calls).toContain("pr create");
    expect(calls).toContain("--base main --head dev");
    expect(calls).toContain("--reviewer global-reviewer");
    expect(calls).toContain("--assignee global-assignee");
    expect(f.git(["rev-parse", "refs/heads/dev"], f.remote)).toBe(
      f.git(["rev-parse", "dev"]),
    );
    const status = f.ok(["status", "--session", id, "--json"]);
    expect(status.stderr).toBe("");
    const final = parseOnlyDocument(status);
    expectStatusDocument(final);
    expect(final.sync).toBeUndefined();
    expect(final.session).toMatchObject({
      status: "succeeded",
      pullRequestUrl: "https://github.example/pull/17",
      targetBranch: "dev",
      rolloutDisposition: "none",
      delivery: { version: "policy-v1" },
    });
    expect(final.session.readyCommit).toMatch(sha);
    expect(final.session.promotedCommit).toBe(f.git(["rev-parse", "dev"]));
    expect(f.ok(["status", "--session", id]).stdout).toContain(
      "delivery policy: acme/widget (defaults), PR (shared-target) to main via origin, completion production-merged",
    );
  });

  it("keeps a policy repository local even when the registration promotes by pull request", async () => {
    const f = await fixture();
    await f.updateConfig((config) => {
      config.repositories[0].targetBranch = "dev";
      config.repositories[0].promotion = {
        type: "pull-request",
        productionBranch: "main",
      };
    });
    f.git(["branch", "dev", "origin/dev"]);
    const remoteDev = f.git(["rev-parse", "refs/heads/dev"], f.remote);
    const begun = parseOnlyDocument(
      await beginJson(f, ["--policy-file", await f.writePolicy(localPolicy)]),
    );
    expect(begun.session.delivery).toMatchObject({
      promotion: { type: "none" },
      completion: "local",
      source: "repository",
      version: "policy-v2",
    });
    f.commit(begun.session.worktreePath, "local.txt", "local\n");
    f.ok(
      ["integrate", "--summary", "local", "--rollout", "none"],
      begun.session.worktreePath,
    );
    const final = parseOnlyDocument(
      f.ok(["status", "--session", begun.session.id, "--json"]),
    );
    expect(final.session.status).toBe("succeeded");
    expect(final.session.pullRequestUrl).toBeNull();
    expect(f.git(["rev-parse", "refs/heads/dev"], f.remote)).toBe(remoteDev);
    await expect(readFile(f.ghLog, "utf8")).rejects.toThrow();
  });

  it("resumes with the recorded rule and reports the resume command", async () => {
    const f = await fixture();
    const begun = parseOnlyDocument(
      await beginJson(f, ["--policy-file", await f.writePolicy(prPolicy)]),
    );
    const id = begun.session.id as string;
    const worktree = begun.session.worktreePath as string;
    f.commit(worktree, "resume.txt", "resume\n");
    const failed = f.run(
      ["integrate", "--summary", "resume", "--rollout", "none"],
      worktree,
      { FAKE_GH_FAIL_AUTH: "1" },
    );
    expect(failed.code).not.toBe(0);
    const pending = parseOnlyDocument(
      f.ok(["status", "--session", id, "--json"]),
    );
    expectStatusDocument(pending);
    expect(pending.session.status).toBe("needs_review");
    expect(pending.session.recoveryPhase).toBe("pull_request");
    expect(pending.session.latestError).toContain("GitHub authentication");
    expect(pending.resumeCommand).toEqual(["seshx", "resume", "--session", id]);
    // The registration still has no promotion; resume must use the recorded rule.
    f.ok(["resume", "--session", id], worktree);
    const resumed = parseOnlyDocument(
      f.ok(["status", "--session", id, "--json"]),
    );
    expect(resumed.session.status).toBe("succeeded");
    expect(resumed.session.pullRequestUrl).toBe(
      "https://github.example/pull/17",
    );
    expect(resumed.resumeCommand).toBeNull();
  });

  it("reports JSON errors for status", async () => {
    const f = await fixture({ origin: null });
    expectError(f.run(["status", "--json"]), "usage");
    expectError(
      f.run(["status", "--session", "session_missing", "--json"]),
      "unknown_session",
    );
  });
});

describe.sequential("begin --sync-target", () => {
  it("fast-forwards an unchecked-out target before branching", async () => {
    const f = await fixture();
    f.git(["branch", "dev", "origin/dev"]);
    const before = f.git(["rev-parse", "dev"]);
    const remoteHead = f.advanceRemote("remote.txt");
    const result = await beginJson(f, [
      "--sync-target",
      "--policy-file",
      await f.writePolicy(prPolicy),
    ]);
    expect(result.code, result.stderr).toBe(0);
    const document = parseOnlyDocument(result);
    expectStatusDocument(document);
    expect(document.sync).toEqual({
      remote: "origin",
      result: "fast-forwarded",
      branch: "dev",
      before,
      after: remoteHead,
    });
    expect(f.git(["rev-parse", "dev"])).toBe(remoteHead);
    expect(document.session.startCommit).toBe(remoteHead);
  });

  it("creates a missing local target from the remote", async () => {
    const f = await fixture();
    const remoteHead = f.advanceRemote("remote.txt");
    const document = parseOnlyDocument(
      await beginJson(f, [
        "--sync-target",
        "--policy-file",
        await f.writePolicy(prPolicy),
      ]),
    );
    expect(document.sync).toMatchObject({
      result: "fast-forwarded",
      before: null,
      after: remoteHead,
    });
    expect(f.git(["rev-parse", "dev"])).toBe(remoteHead);
  });

  it("reports up-to-date and local-ahead targets without moving them", async () => {
    const f = await fixture();
    const policy = await f.writePolicy(prPolicy);
    f.git(["branch", "dev", "origin/dev"]);
    const upToDate = parseOnlyDocument(
      await beginJson(f, ["--sync-target", "--policy-file", policy]),
    );
    expect(upToDate.sync).toMatchObject({
      remote: "origin",
      result: "up-to-date",
    });
    const g = await fixture();
    g.git(["switch", "--quiet", "-c", "dev", "origin/dev"]);
    const ahead = g.commit(g.repo, "local.txt", "local\n");
    g.git(["switch", "--quiet", "main"]);
    const document = parseOnlyDocument(
      await beginJson(g, [
        "--sync-target",
        "--policy-file",
        await g.writePolicy(prPolicy),
      ]),
    );
    expect(document.sync).toMatchObject({
      result: "local-ahead",
      before: ahead,
      after: ahead,
    });
    expect(document.session.startCommit).toBe(ahead);
  });

  it("continues without a remote branch or remote", async () => {
    const f = await fixture({ remoteDev: false });
    const document = parseOnlyDocument(
      await beginJson(f, [
        "--sync-target",
        "--policy-file",
        await f.writePolicy(prPolicy),
      ]),
    );
    expect(document.sync).toMatchObject({
      remote: "origin",
      result: "no-remote-branch",
      before: null,
    });
    // The managed policy target is created from the default branch.
    expect(f.git(["rev-parse", "dev"])).toBe(f.git(["rev-parse", "main"]));
    expect(document.session.delivery.targetBranch).toBe("dev");

    const g = await fixture({ origin: null });
    const noRemote = parseOnlyDocument(await beginJson(g, ["--sync-target"]));
    expectStatusDocument(noRemote);
    expect(noRemote.sync).toMatchObject({
      remote: null,
      result: "no-remote-branch",
    });
    expect(noRemote.session.delivery).toBeNull();
    expect(noRemote.session.targetBranch).toBeNull();
  });

  it("fast-forwards a clean checked-out target in place", async () => {
    const f = await fixture();
    const target = join(f.root, "dev-checkout");
    f.git(["worktree", "add", "--quiet", "-b", "dev", target, "origin/dev"]);
    const remoteHead = f.advanceRemote("remote.txt");
    const document = parseOnlyDocument(
      await beginJson(f, [
        "--sync-target",
        "--policy-file",
        await f.writePolicy(prPolicy),
      ]),
    );
    expect(document.sync.result).toBe("fast-forwarded");
    expect(f.git(["rev-parse", "HEAD"], target)).toBe(remoteHead);
    expect(f.git(["status", "--porcelain"], target)).toBe("");
    expect(await readFile(join(target, "remote.txt"), "utf8")).toBe(
      "remote.txt\n",
    );
  });

  it("fails on a dirty checked-out target, divergence, or fetch failure without changing anything", async () => {
    const f = await fixture();
    const policy = await f.writePolicy(prPolicy);
    const target = join(f.root, "dev-checkout");
    f.git(["worktree", "add", "--quiet", "-b", "dev", target, "origin/dev"]);
    await writeFile(join(target, "base.txt"), "user edit\n");
    f.advanceRemote("remote.txt");
    const before = f.git(["rev-parse", "dev"]);
    const refs = f.git(["for-each-ref", "refs/heads"]);
    expectError(
      await beginJson(f, ["--sync-target", "--policy-file", policy]),
      "target_dirty",
    );
    expect(f.git(["rev-parse", "dev"])).toBe(before);
    expect(await readFile(join(target, "base.txt"), "utf8")).toBe(
      "user edit\n",
    );
    expect(f.git(["for-each-ref", "refs/heads"])).toBe(refs);

    const g = await fixture();
    g.git(["switch", "--quiet", "-c", "dev", "origin/dev"]);
    const local = g.commit(g.repo, "local.txt", "local\n");
    g.git(["switch", "--quiet", "main"]);
    g.advanceRemote("remote.txt");
    expectError(
      await beginJson(g, [
        "--sync-target",
        "--policy-file",
        await g.writePolicy(prPolicy),
      ]),
      "target_diverged",
    );
    expect(g.git(["rev-parse", "dev"])).toBe(local);

    const h = await fixture();
    h.git(["branch", "dev", "origin/dev"]);
    h.git(["config", "--remove-section", `url.${h.remote}`]);
    h.git(["config", `url.${join(h.root, "gone.git")}.insteadOf`, SLUG_URL]);
    const unchanged = h.git(["rev-parse", "dev"]);
    expectError(
      await beginJson(h, [
        "--sync-target",
        "--policy-file",
        await h.writePolicy(prPolicy),
      ]),
      "fetch_failed",
    );
    expect(h.git(["rev-parse", "dev"])).toBe(unchanged);
    for (const fixture of [f, g, h])
      expect(await fixture.sessions()).toEqual([]);
  });
});
