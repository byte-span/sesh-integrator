import { harnesses } from "../src/harness.js";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { withGpgProgram } from "../src/handoff.js";
import { runSetupWithCache } from "../src/cache.js";
import { promoteByPullRequest } from "../src/pull-request.js";

interface Fixture {
  root: string;
  repo: string;
  runtime: string;
  auditHome: string;
  sourceCodexHome: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const temporaryRoots: string[] = [];
const cli =
  process.env.PARALLEL_INTEGRATOR_TEST_CLI ??
  join(process.cwd(), "dist", "cli.js");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential("sesh-integrator repository workflow", () => {
  it.each(["claude", "antigravity", "grok"])(
    "installs and checks %s without Codex",
    async (harness) => {
      const fixture = await createFixture();
      const home = fixture.auditHome;
      execFileSync(
        "sh",
        [join(process.cwd(), "scripts/install-skill.sh"), "--harness", harness],
        { env: { ...process.env, HOME: home } },
      );
      const bin = join(fixture.root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, harness === "antigravity" ? "agy" : harness),
        "#!/bin/sh\nprintf 'test harness 1.0\n'\n",
        { mode: 0o755 },
      );
      await updateConfig(fixture, (config) => {
        config.codexCommand = join(fixture.root, "no-codex");
        config.conflictResolutionMode = "nested-codex";
        config.repositories[0].sourceValidationCommands = [
          [process.execPath, "--version"],
        ];
        config.repositories[0].integrationValidationCommands = [
          [process.execPath, "--version"],
        ];
      });
      const result = await runCli(
        fixture,
        fixture.repo,
        ["doctor", "--harness", harness],
        { PATH: `${bin}:${process.env.PATH}` },
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("PASS  Workflow skill");
      expect(result.stdout).toContain("PASS  Global guidance");
      expect(result.stdout).not.toContain("FAIL");
      const installed = await runCli(
        fixture,
        fixture.repo,
        ["doctor", "--installed"],
        { PATH: `${bin}:${process.env.PATH}` },
      );
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);
      expect(installed.stdout).toContain("Harness:");
      expect(await exists(join(home, ".codex"))).toBe(false);
    },
  );

  it.each(
    harnesses.flatMap((harness) =>
      [false, true].map((leaveMarkers) => [harness, leaveMarkers] as const),
    ),
  )(
    "uses %s for nested conflict resolution (unresolved: %s)",
    async (harness, leaveMarkers) => {
      const fixture = await createFixture();
      const first = await addWorktree(fixture, "nested-first");
      const second = await addWorktree(fixture, "nested-second");
      const fake = join(fixture.root, "fake-resolver");
      await writeFile(
        fake,
        `#!/usr/bin/env node
const fs=require("fs");const cp=require("child_process");const args=process.argv.slice(2);
const prompt=args.includes("--print")?args[args.indexOf("--print")+1]:args.includes("--prompt-file")?fs.readFileSync(args[args.indexOf("--prompt-file")+1],"utf8"):fs.readFileSync(0,"utf8");
if(!prompt.includes("Do not commit")) process.exit(7);
if (!${leaveMarkers}) fs.writeFileSync("shared.txt","first\\nsecond\\n");
process.stdout.write(JSON.stringify({status:"SUCCESS",response:"resolved",text:"resolved",result:"resolved"}));
`,
        { mode: 0o755 },
      );
      await updateConfig(fixture, (config) => {
        config.conflictResolutionMode = "nested-agent";
        config.harnessCommands = { [harness]: fake };
        config.codexCommand = join(fixture.root, "wrong-agent");
      });
      await runCliOk(fixture, first, [
        "begin",
        "--harness",
        harness,
        "--summary",
        "first",
      ]);
      await runCliOk(fixture, second, [
        "begin",
        "--harness",
        harness,
        "--summary",
        "second",
      ]);
      commitFile(first, "shared.txt", "first\n", "first");
      commitFile(second, "shared.txt", "second\n", "second");
      await runCliOk(fixture, first, ["integrate", "--summary", "first"]);
      const result = await runCli(fixture, second, [
        "integrate",
        "--summary",
        "second",
      ]);
      if (leaveMarkers) {
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("left conflict markers");
        expect(await readFile(join(fixture.repo, "shared.txt"), "utf8")).toBe(
          "first\n",
        );
        const pending = (await sessions(fixture)).find(
          (session) => session.worktreePath === second,
        )!;
        expect(pending.status).toBe("needs_review");
        expect(
          git(
            pending.integrationWorktreePath,
            "diff",
            "--name-only",
            "--diff-filter=U",
          ),
        ).toBe("shared.txt");
        return;
      }
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(fixture.repo, "shared.txt"), "utf8")).toBe(
        "first\nsecond\n",
      );
      expect(
        (await sessions(fixture)).every(
          (session) => session.status === "succeeded",
        ),
      ).toBe(true);
      expect(git(second, "status", "--porcelain")).toBe("");
    },
  );

  it("rejects an unknown harness before creating a source worktree", async () => {
    const fixture = await createFixture();
    const before = git(fixture.repo, "worktree", "list", "--porcelain");
    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--create-worktree",
      "--summary",
      "bad harness",
      "--harness",
      "unknown",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--harness must be");
    expect(await sessions(fixture)).toEqual([]);
    expect(git(fixture.repo, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("requires and reports a technology-neutral external rollout classification", async () => {
    const fixture = await createFixture();
    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "external state contract",
    ]);
    commitFile(fixture.repo, "rollout.txt", "rollout\n", "rollout contract");

    const missing = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "missing classification"],
      { PARALLEL_INTEGRATOR_TEST_REQUIRE_ROLLOUT: "1" },
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("integrate requires --rollout");

    const manualWithoutStep = await runCli(fixture, fixture.repo, [
      "integrate",
      "--summary",
      "missing manual step",
      "--rollout",
      "manual",
    ]);
    expect(manualWithoutStep.code).toBe(1);
    expect(manualWithoutStep.stderr).toContain(
      "manual rollout requires at least one --follow-up",
    );

    const actions = [
      "On a trusted machine, add CWS_CLIENT_ID, CWS_CLIENT_SECRET, and CWS_REFRESH_TOKEN to the release repository's chrome-web-store GitHub environment.",
      "In the fixture repository's chrome-web-store GitHub environment, configure Actions variables FIXTURE_EXTENSION_ID and FIXTURE_CHANNEL. See docs/release.md for context.",
    ];
    const completed = await runCliOk(fixture, fixture.repo, [
      "integrate",
      "--summary",
      "classified rollout",
      "--rollout",
      "manual",
      "--follow-up",
      actions[0]!,
      "--follow-up",
      actions[1]!,
    ]);
    expect(completed.stdout).toContain(
      "External rollout: Manual action required.",
    );
    expect(completed.stdout).toContain("Required manual actions (2 recorded)");
    for (const action of actions)
      expect(completed.stdout).toContain(`Manual follow-up: ${action}`);
    expect(completed.stdout).not.toContain("No manual follow-up required.");
    const [session] = await sessions(fixture);
    expect(session.rolloutDisposition).toBe("manual");
    expect(session.rolloutFollowUps).toEqual(actions);
    const status = await runCliOk(fixture, fixture.repo, [
      "status",
      "--session",
      session.id,
    ]);
    for (const action of actions)
      expect(status.stdout).toContain(`Manual follow-up: ${action}`);
  });

  it("caches only fingerprinted advisory setup with an extant marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "sesh-integrator-setup-cache-"));
    temporaryRoots.push(root);
    const runtime = join(root, "runtime");
    const worktree = join(root, "worktree");
    const marker = join(root, "runs.log");
    await mkdir(worktree);
    await writeFile(join(worktree, "package.json"), '{"name":"cache"}\n');
    await writeFile(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const previousRuntime = process.env.PARALLEL_INTEGRATOR_HOME;
    process.env.PARALLEL_INTEGRATOR_HOME = runtime;
    try {
      const repository = {
        path: worktree,
        gitCommonDir: join(worktree, ".git"),
        defaultBranch: "main",
        integrationBranch: "sesh-integrator/integration",
        setupCommands: [
          [
            process.execPath,
            "-e",
            `const fs=require("fs");fs.mkdirSync("node_modules");fs.appendFileSync(${JSON.stringify(marker)},"run\\n")`,
            "pnpm",
          ],
        ],
        setupCommandPolicy: "advisory",
        sourceValidationCommands: [],
        integrationValidationCommands: [],
        validationTiers: [],
        postIntegrationCommands: [],
        conflictInstructions: "",
      } as any;
      expect((await runSetupWithCache(repository, worktree)).cacheHit).toBe(
        false,
      );
      expect((await runSetupWithCache(repository, worktree)).cacheHit).toBe(
        true,
      );
      expect(await readFile(marker, "utf8")).toBe("run\n");
    } finally {
      if (previousRuntime === undefined)
        delete process.env.PARALLEL_INTEGRATOR_HOME;
      else process.env.PARALLEL_INTEGRATOR_HOME = previousRuntime;
    }
  });

  it("keeps existing configuration without targetBranch and defaults it to defaultBranch", async () => {
    const fixture = await createFixture();
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    expect(config.repositories[0].targetBranch).toBeUndefined();
    expect(config.repositories[0].defaultBranch).toBe("main");
    const worktree = await addWorktree(fixture, "legacy-target-default");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "legacy config target",
    ]);
    commitFile(worktree, "legacy.txt", "legacy\n", "legacy config source");
    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "legacy config complete",
    ]);
    const completed = (await sessions(fixture))[0]!;
    expect(completed.targetBranch).toBe("main");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      completed.integratedCommit,
    );
  });

  it("applies a global target to an existing registration and creates it before begin", async () => {
    const fixture = await createFixture();
    const mainBefore = git(fixture.repo, "rev-parse", "main");
    await updateConfig(fixture, (config) => {
      config.defaultTargetBranch = "dev";
    });

    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "global target task",
    ]);
    expect(git(fixture.repo, "rev-parse", "dev")).toBe(mainBefore);
    commitFile(fixture.repo, "global.txt", "global\n", "global target source");
    await runCliOk(fixture, fixture.repo, [
      "integrate",
      "--summary",
      "global target complete",
    ]);

    const completed = (await sessions(fixture))[0]!;
    expect(completed.targetBranch).toBe("dev");
    expect(git(fixture.repo, "rev-parse", "dev")).toBe(
      completed.integratedCommit,
    );
    expect(git(fixture.repo, "rev-parse", "main")).toBe(mainBefore);
  });

  it("pushes the target and opens a configured promotion pull request", async () => {
    const fixture = await createFixture();
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "push", "origin", "main");
    await updateConfig(fixture, (config) => {
      config.defaultTargetBranch = "dev";
      config.defaultPromotion = {
        reviewers: ["reviewer-one", "reviewer-two"],
        assignees: ["assignee-one"],
      };
      config.repositories[0].promotion = {
        type: "pull-request",
        productionBranch: "main",
      };
    });
    const fake = await createFakeGh(fixture);

    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "remote promotion"],
      fake.env,
    );
    commitFile(fixture.repo, "remote.txt", "remote\n", "remote promotion");
    const result = await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "remote promotion complete"],
      fake.env,
    );

    expect(result.stdout).toContain("Completion summary:");
    expect(result.stdout).toContain("Source commit:");
    expect(result.stdout).toContain("Staging integration commit:");
    expect(result.stdout).toContain("Target promotion: dev at");
    expect(result.stdout).toContain(
      "Pull request: https://github.example/pull/17",
    );
    expect(result.stdout).toContain(
      "Manual follow-up: Review and merge https://github.example/pull/17.",
    );
    expect(git(remote, "rev-parse", "refs/heads/dev")).toBe(
      git(fixture.repo, "rev-parse", "dev"),
    );
    const calls = await readFile(fake.log, "utf8");
    expect(calls).toContain("pr list --state open --base main --head dev");
    expect(calls).toContain("--reviewer reviewer-one,reviewer-two");
    expect(calls).toContain("--assignee assignee-one");
    const completed = (await sessions(fixture))[0]!;
    expect(completed.pullRequestUrl).toBe("https://github.example/pull/17");
    expect(completed.remotePromotedAt).toBeTruthy();
  });

  it("fetches a fast-forwarded shared target before choosing the integration baseline", async () => {
    const fixture = await createFixture();
    const remote = await configureSharedTargetPromotion(fixture);
    const fake = await createFakeGh(fixture);
    const validationLog = join(fixture.root, "remote-recovery-validation.log");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          `require("fs").appendFileSync(${JSON.stringify(validationLog)}, "validated\\n")`,
        ],
      ];
    });
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "recover"],
      fake.env,
    );
    commitFile(fixture.repo, "local.txt", "local\n", "local change");
    advanceRemote(fixture, remote, "remote.txt", "remote\n");

    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "recovered"],
      fake.env,
    );

    const completed = (await sessions(fixture))[0]!;
    expect(completed.status).toBe("succeeded");
    expect(completed.remoteRecoveryAttempts).toBe(0);
    expect(git(remote, "rev-parse", "refs/heads/dev")).toBe(
      completed.promotedCommit,
    );
    expect(await readFile(validationLog, "utf8")).toBe("validated\n");
  });

  it("preserves a resumable conflict against the freshly fetched shared target", async () => {
    const fixture = await createFixture();
    const remote = await configureSharedTargetPromotion(fixture);
    const fake = await createFakeGh(fixture);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "conflict"],
      fake.env,
    );
    commitFile(fixture.repo, "shared.txt", "local\n", "local change");
    advanceRemote(fixture, remote, "shared.txt", "remote\n");

    const result = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "conflict"],
      fake.env,
    );

    expect(result.code).toBe(1);
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("needs_review");
    expect(pending.latestError).toContain("Merge conflict requires resolution");
    const integrationWorktree = join(
      fixture.runtime,
      "worktrees",
      pending.repositoryId,
    );
    await writeFile(join(integrationWorktree, "shared.txt"), "local\nremote\n");
    git(integrationWorktree, "add", "shared.txt");
    await runCliOkWithEnv(fixture, fixture.repo, ["resume"], fake.env);
    expect((await sessions(fixture))[0].status).toBe("succeeded");
  });

  it("stops shared-target recovery when full validation fails", async () => {
    const fixture = await createFixture();
    const remote = await configureSharedTargetPromotion(fixture);
    const fake = await createFakeGh(fixture);
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          "process.exit(require('fs').existsSync('remote.txt') ? 9 : 0)",
        ],
      ];
    });
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "validation"],
      fake.env,
    );
    commitFile(fixture.repo, "local.txt", "local\n", "local change");
    advanceRemote(fixture, remote, "remote.txt", "remote\n");

    const result = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "validation"],
      fake.env,
    );

    expect(result.code).toBe(1);
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("validation_pending");
    expect(pending.latestError).toContain("Validation failed (9)");
    expect(git(remote, "rev-parse", "refs/heads/dev")).not.toBe(
      pending.promotedCommit,
    );
  });

  it("stops after bounded retries when the shared remote keeps moving", async () => {
    const fixture = await createFixture();
    const remote = await configureSharedTargetPromotion(fixture);
    const fake = await createFakeGh(fixture);
    const moving = await createMovingGit(fixture, remote, fake.env);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "moving"],
      moving.env,
    );
    commitFile(fixture.repo, "local.txt", "local\n", "local change");

    const result = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "moving"],
      moving.env,
    );

    expect(result.code).toBe(1);
    const pending = (await sessions(fixture))[0]!;
    expect(pending.remoteRecoveryAttempts, pending.latestError).toBe(3);
    expect(await readFile(fake.log, "utf8")).toContain("auth status");
    expect(pending.latestError).toContain(
      "kept moving after 3 validated recovery attempts",
    );
  });

  it("stops explicitly when shared-target history was rewritten", async () => {
    const fixture = await createFixture();
    const remote = await configureSharedTargetPromotion(fixture);
    const fake = await createFakeGh(fixture);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "rewritten"],
      fake.env,
    );
    commitFile(fixture.repo, "local.txt", "local\n", "local change");
    replaceRemoteHistory(fixture, remote);

    const result = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "rewritten"],
      fake.env,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("history was replaced or diverged");
    expect(result.stderr).toContain(
      "Refusing to establish an integration baseline",
    );
    const pending = (await sessions(fixture))[0]!;
    expect(pending.promotedCommit).toBeUndefined();
  });

  it("opens independent pull requests for concurrent session branches and reuses only the same session PR", async () => {
    const fixture = await createFixture();
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "push", "origin", "main");
    git(fixture.repo, "branch", "dev", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "dev";
      config.repositories[0].promotion = {
        type: "pull-request",
        mode: "session-branch",
        productionBranch: "main",
        reviewers: ["reviewer-one"],
        assignees: ["assignee-one"],
      };
    });
    const fake = await createFakeGh(fixture);
    const first = await addWorktree(fixture, "session-one");
    const second = await addWorktree(fixture, "session-two");

    await runCliOkWithEnv(
      fixture,
      first,
      ["begin", "--summary", "one"],
      fake.env,
    );
    commitFile(first, "one.txt", "one\n", "session one");
    await runCliOkWithEnv(
      fixture,
      first,
      ["integrate", "--summary", "one complete"],
      fake.env,
    );
    await runCliOkWithEnv(
      fixture,
      second,
      ["begin", "--summary", "two"],
      fake.env,
    );
    commitFile(second, "two.txt", "two\n", "session two");
    await runCliOkWithEnv(
      fixture,
      second,
      ["integrate", "--summary", "two complete"],
      fake.env,
    );

    const completed = await sessions(fixture);
    expect(completed.map((session) => session.pullRequestUrl)).toEqual([
      "https://github.example/pull/17",
      "https://github.example/pull/18",
    ]);
    expect(git(remote, "rev-parse", "refs/heads/session-one")).toBe(
      completed[0].readyCommit,
    );
    expect(git(remote, "rev-parse", "refs/heads/session-two")).toBe(
      completed[1].readyCommit,
    );
    const callsBeforeRetry = await readFile(fake.log, "utf8");
    expect(callsBeforeRetry).toContain(
      "pr list --state open --base main --head session-one",
    );
    expect(callsBeforeRetry).toContain(
      "pr list --state open --base main --head session-two",
    );
    expect(callsBeforeRetry.match(/pr create/g)).toHaveLength(2);
    expect(callsBeforeRetry).toContain("--reviewer reviewer-one");
    expect(callsBeforeRetry).toContain("--assignee assignee-one");
  });

  it("detects and reuses an existing same-session PR on resume", async () => {
    const fixture = await createFixture();
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "push", "origin", "main");
    git(fixture.repo, "branch", "dev", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "dev";
      config.repositories[0].promotion = {
        type: "pull-request",
        mode: "session-branch",
        productionBranch: "main",
        reviewers: ["reviewer-one"],
      };
    });
    const fake = await createFakeGh(fixture);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "retry"],
      fake.env,
    );
    commitFile(fixture.repo, "retry.txt", "retry\n", "retry source");
    const failed = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "retry complete"],
      {
        ...fake.env,
        FAKE_GH_CREATE_THEN_FAIL: "1",
      },
    );
    expect(failed.code).toBe(1);
    await runCliOkWithEnv(fixture, fixture.repo, ["resume"], fake.env);
    const calls = await readFile(fake.log, "utf8");
    expect(calls.match(/pr create/g)).toHaveLength(1);
    expect(calls).toContain(
      "pr edit https://github.example/pull/17 --add-reviewer reviewer-one",
    );
    expect((await sessions(fixture))[0].pullRequestUrl).toBe(
      "https://github.example/pull/17",
    );
  });

  it("preserves session PR promotion failures for resume", async () => {
    const fixture = await createFixture();
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "push", "origin", "main");
    git(fixture.repo, "branch", "dev", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "dev";
      config.repositories[0].promotion = {
        type: "pull-request",
        mode: "session-branch",
        productionBranch: "main",
      };
    });
    const fake = await createFakeGh(fixture);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "failure"],
      fake.env,
    );
    commitFile(fixture.repo, "failure.txt", "failure\n", "failure source");
    const failed = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "failure complete"],
      {
        ...fake.env,
        FAKE_GH_FAIL_CREATE: "1",
      },
    );
    expect(failed.code).toBe(1);
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("needs_review");
    expect(pending.recoveryPhase).toBe("pull_request");
    expect(pending.latestError).toContain(
      "Could not create promotion pull request",
    );
    await runCliOkWithEnv(fixture, fixture.repo, ["resume"], fake.env);
    expect((await sessions(fixture))[0].pullRequestUrl).toBe(
      "https://github.example/pull/17",
    );
  });

  it("rejects invalid pull-request promotion modes and branch names", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].promotion = {
        type: "pull-request",
        mode: "per-task",
        productionBranch: "bad..branch",
      };
    });
    const result = await runCli(fixture, fixture.repo, ["status"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid validation configuration");
  });

  it("creates the global target while registering a new repository", async () => {
    const fixture = await createFixture();
    const main = git(fixture.repo, "rev-parse", "main");
    await updateConfig(fixture, (config) => {
      config.defaultTargetBranch = "dev";
      config.repositories = [];
    });

    const result = await runCliOk(fixture, fixture.repo, ["register"]);

    expect(result.stdout).toContain("Target branch: dev");
    expect(git(fixture.repo, "rev-parse", "dev")).toBe(main);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    expect(config.repositories[0].targetBranch).toBeUndefined();
  });

  it("tracks origin when the global target exists only as a remote branch", async () => {
    const fixture = await createFixture();
    const main = git(fixture.repo, "rev-parse", "main");
    git(fixture.repo, "remote", "add", "origin", join(fixture.root, "remote"));
    git(fixture.repo, "update-ref", "refs/remotes/origin/dev", main);
    await updateConfig(fixture, (config) => {
      config.defaultTargetBranch = "dev";
      config.repositories = [];
    });

    await runCliOk(fixture, fixture.repo, ["register"]);

    expect(git(fixture.repo, "rev-parse", "dev")).toBe(main);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
    expect(git(fixture.repo, "config", "branch.dev.remote")).toBe("origin");
    expect(git(fixture.repo, "config", "branch.dev.merge")).toBe(
      "refs/heads/dev",
    );
  });

  it("preserves an explicit repository target over the global default", async () => {
    const fixture = await createFixture();
    git(fixture.repo, "branch", "release", "main");
    await updateConfig(fixture, (config) => {
      config.defaultTargetBranch = "dev";
      config.repositories[0].targetBranch = "release";
    });

    const result = await runCliOk(fixture, fixture.repo, ["status"]);

    expect(result.stdout).toContain("target release (override)");
    expect(() => git(fixture.repo, "rev-parse", "dev")).toThrow();
  });

  it("rejects registration while the default branch is unborn", async () => {
    const fixture = await createFixture();
    const unborn = join(fixture.root, "unborn");
    await mkdir(unborn);
    git(unborn, "init", "-b", "main");

    const result = await runCli(fixture, unborn, ["register"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unborn default branch");
    expect(result.stderr).toContain("create its initial commit first");
  });

  it("rejects ambiguous historical configuration instead of guessing", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationBranch = "main";
      delete config.repositories[0].targetBranch;
    });

    const result = await runCli(fixture, fixture.repo, ["status"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Ambiguous branch configuration");
    expect(result.stderr).toContain("equals the default or effective target");
  });

  it("automatically creates a task branch from a clean detached worktree", async () => {
    const fixture = await createFixture();
    const detachedPath = join(fixture.root, "detached");
    git(fixture.repo, "worktree", "add", "--detach", detachedPath, "main");
    const worktree = await realpath(detachedPath);
    const startCommit = git(worktree, "rev-parse", "HEAD");

    const result = await runCli(fixture, worktree, [
      "begin",
      "--summary",
      "detached task",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const branch = git(worktree, "branch", "--show-current");
    expect(branch).toMatch(/^codex\/session-[a-z0-9-]+$/);
    expect(result.stdout).toContain(`Created task branch ${branch}`);
    const active = (await sessions(fixture))[0]!;
    expect(active.branch).toBe(branch);
    expect(active.startCommit).toBe(startCommit);
  });

  it("automatically leaves the default branch for a clean task", async () => {
    const fixture = await createFixture();
    const startCommit = git(fixture.repo, "rev-parse", "HEAD");

    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "default branch task",
    ]);

    const branch = git(fixture.repo, "branch", "--show-current");
    expect(branch).toMatch(/^codex\/session-[a-z0-9-]+$/);
    const active = (await sessions(fixture))[0]!;
    expect(active.branch).toBe(branch);
    expect(active.startCommit).toBe(startCommit);
  });

  it("automatically leaves an explicitly configured target branch", async () => {
    const fixture = await createFixture();
    git(fixture.repo, "switch", "-c", "develop");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "develop";
    });

    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "target branch task",
    ]);

    expect(git(fixture.repo, "branch", "--show-current")).toMatch(
      /^codex\/session-/,
    );
  });

  it("records and preserves a pre-existing accessible dirty file", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, "dirty.txt"), "dirty\n");

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "dirty task",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("pre-existing unstaged change recorded");
    expect(git(fixture.repo, "branch", "--show-current")).toMatch(
      /^codex\/session-/,
    );
    await writeFile(join(fixture.repo, "README.md"), "task\n");
    git(fixture.repo, "add", "README.md");
    git(fixture.repo, "commit", "-m", "README task", "--", "README.md");
    const validation = await runCli(fixture, fixture.repo, ["validate"]);
    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stderr).toContain("preserving and excluding it");
    const integration = await runCli(fixture, fixture.repo, [
      "integrate",
      "--summary",
      "README complete",
    ]);
    expect(integration.code, integration.stderr).toBe(0);
    expect(await readFile(join(fixture.repo, "dirty.txt"), "utf8")).toBe(
      "dirty\n",
    );
    expect(() =>
      git(fixture.repo, "show", "sesh-integrator/integration:dirty.txt"),
    ).toThrow();
  });

  it("allows a consistently inaccessible tracked file outside a README-only task", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".env.local"), "tracked secret\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "track environment file");
    const fakeGit = await createPermissionGit(fixture, ".env.local", true);

    const begin = await runCli(
      fixture,
      fixture.repo,
      ["begin", "--summary", "README only"],
      fakeGit.env,
    );
    expect(begin.code, begin.stderr).toBe(0);
    expect(begin.stderr).toContain("tracked path is inaccessible and unstaged");
    const active = (await sessions(fixture))[0];
    expect(active.gitBaseline.commands.status.code).toBe(1);
    expect(active.gitBaseline.commands.status.stderr).toContain(
      "Operation not permitted",
    );
    expect(active.gitBaseline.commands.worktreeDiff.stdout).toContain(
      ".env.local",
    );

    commitFile(fixture.repo, "README.md", "README task\n", "README task");
    const validation = await runCli(
      fixture,
      fixture.repo,
      ["validate"],
      fakeGit.env,
    );
    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stderr).toContain(
      "observably unchanged; preserving and excluding it",
    );
    expect(validation.stderr).toContain("disk contents were not verified");
    const integration = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "README complete"],
      fakeGit.env,
    );
    expect(integration.code, integration.stderr).toBe(0);
    expect(
      git(fixture.repo, "show", "sesh-integrator/integration:README.md"),
    ).toBe("README task");
    expect(
      git(fixture.repo, "show", "sesh-integrator/integration:.env.local"),
    ).toBe("tracked secret");
  });

  it("integrates when sandboxed Git omits an inaccessible tracked path from porcelain status", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".env.local"), "tracked secret\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "track environment file");
    const fakeGit = await createPermissionGit(
      fixture,
      ".env.local",
      true,
      "sandbox-status-omission",
    );

    const begin = await runCli(
      fixture,
      fixture.repo,
      ["begin", "--summary", "application change"],
      fakeGit.env,
    );
    expect(begin.code, begin.stderr).toBe(0);
    const active = (await sessions(fixture))[0];
    const inaccessiblePath = active.gitBaseline.paths.find(
      (path: { path: string }) => path.path === ".env.local",
    );
    expect(active.gitBaseline.commands.status.code).toBe(0);
    expect(active.gitBaseline.commands.status.stdout).toBe("");
    expect(inaccessiblePath.status).toBeNull();
    expect(inaccessiblePath.worktreeRaw).toMatch(/ D$/);

    commitFile(
      fixture.repo,
      "app.ts",
      "export const ready = true;\n",
      "application task",
    );
    const validation = await runCli(
      fixture,
      fixture.repo,
      ["validate"],
      fakeGit.env,
    );
    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stdout).toContain("Validation tier: full");

    const integration = await runCli(
      fixture,
      fixture.repo,
      ["integrate", "--summary", "Application change complete"],
      fakeGit.env,
    );
    expect(integration.code, integration.stderr).toBe(0);
    expect(integration.stderr).toContain(
      "remains inaccessible, tracked, unstaged, and outside the task diff",
    );
    expect(
      git(fixture.repo, "show", "sesh-integrator/integration:app.ts"),
    ).toBe("export const ready = true;");
    expect(
      git(fixture.repo, "show", "sesh-integrator/integration:.env.local"),
    ).toBe("tracked secret");
    const completed = (await sessions(fixture))[0];
    expect(completed.status).toBe("succeeded");
  });

  it("accepts a baseline-inaccessible path later omitted by Git when its index entry is unchanged", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".env.local"), "tracked secret\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "track environment file");
    const fakeGit = await createPermissionGit(
      fixture,
      ".env.local",
      true,
      "sandbox-status-omission",
    );
    const begin = await runCli(
      fixture,
      fixture.repo,
      ["begin", "--summary", "application change"],
      fakeGit.env,
    );
    expect(begin.code, begin.stderr).toBe(0);
    await writeFile(fakeGit.state, "normal\n");
    commitFile(
      fixture.repo,
      "app.ts",
      "export const ready = true;\n",
      "application task",
    );

    const validation = await runCli(
      fixture,
      fixture.repo,
      ["validate"],
      fakeGit.env,
    );

    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stderr).toContain(
      "omitted by current worktree observation",
    );
    expect(validation.stderr).toContain("disk contents were not verified");
  });

  it("blocks an initially inaccessible path when it becomes staged", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".env.local"), "one\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "track environment file");
    const fakeGit = await createPermissionGit(fixture, ".env.local", true);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "README"],
      fakeGit.env,
    );
    await writeFile(join(fixture.repo, ".env.local"), "two\n");
    git(fixture.repo, "add", ".env.local");
    await writeFile(join(fixture.repo, "README.md"), "task\n");
    git(fixture.repo, "add", "README.md");
    git(fixture.repo, "commit", "-m", "README task", "--", "README.md");

    const result = await runCli(
      fixture,
      fixture.repo,
      ["validate"],
      fakeGit.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("non-task path is staged");
  });

  it("blocks a task commit that explicitly targets an initially inaccessible path", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".env.local"), "one\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "track environment file");
    const fakeGit = await createPermissionGit(fixture, ".env.local", true);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "environment task"],
      fakeGit.env,
    );
    await writeFile(join(fixture.repo, ".env.local"), "two\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "change environment file");

    const result = await runCli(
      fixture,
      fixture.repo,
      ["validate"],
      fakeGit.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "task commit targets a path that was inaccessible at begin",
    );
  });

  it("blocks a newly appearing inaccessible path after begin", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".env.local"), "one\n");
    git(fixture.repo, "add", ".env.local");
    git(fixture.repo, "commit", "-m", "track environment file");
    const fakeGit = await createPermissionGit(fixture, ".env.local", false);
    await runCliOkWithEnv(
      fixture,
      fixture.repo,
      ["begin", "--summary", "README"],
      fakeGit.env,
    );
    await writeFile(fakeGit.state, "inaccessible\n");
    commitFile(fixture.repo, "README.md", "task\n", "README task");

    const result = await runCli(
      fixture,
      fixture.repo,
      ["validate"],
      fakeGit.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "new unrelated inaccessible or permission-error path",
    );
  });

  it("blocks a genuine tracked-file deletion introduced after begin", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, "kept.txt"), "keep\n");
    git(fixture.repo, "add", "kept.txt");
    git(fixture.repo, "commit", "-m", "add kept file");
    await runCliOk(fixture, fixture.repo, ["begin", "--summary", "README"]);
    await rm(join(fixture.repo, "kept.txt"));
    commitFile(fixture.repo, "README.md", "task\n", "README task");

    const result = await runCli(fixture, fixture.repo, ["validate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("new unrelated tracked-file deletion");
  });

  it("blocks setup commands that create changes after the captured baseline", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].setupCommands = [
        [
          process.execPath,
          "-e",
          'require("fs").writeFileSync("setup-created.txt", "created\\n")',
        ],
      ];
    });

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "task",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Observable Git state blocked setup");
    expect(result.stderr).toContain("new unrelated modification");
    expect(await sessions(fixture)).toEqual([]);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
  });

  it("fails legacy active sessions with a clear baseline migration message", async () => {
    const fixture = await createFixture();
    await runCliOk(fixture, fixture.repo, ["begin", "--summary", "legacy"]);
    const sessionDirectory = join(fixture.runtime, "sessions");
    const sessionPath = join(
      sessionDirectory,
      (await readdir(sessionDirectory))[0]!,
    );
    const legacy = JSON.parse(await readFile(sessionPath, "utf8"));
    delete legacy.gitBaseline;
    await writeFile(sessionPath, `${JSON.stringify(legacy, null, 2)}\n`);
    commitFile(fixture.repo, "README.md", "task\n", "README task");

    const result = await runCli(fixture, fixture.repo, ["validate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("predates observable Git baselines");
    expect(result.stderr).toContain("Start a new sesh-integrator session");
  });

  it("runs configured setup before beginning a session", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.root, "setup-ran");
    await updateConfig(fixture, (config) => {
      config.repositories[0].setupCommands = [
        [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "ready\\n")`,
        ],
      ];
    });

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "setup task",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Running setup command:");
    expect(await readFile(marker, "utf8")).toBe("ready\n");
  });

  it("does not create a session or branch when setup fails", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].setupCommands = [
        [process.execPath, "-e", "process.exit(7)"],
      ];
    });

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "failing setup",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Setup command failed (7)");
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
    expect(await sessions(fixture)).toEqual([]);
  });

  it("continues begin when auto-configured setup fails", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].setupCommands = [
        [process.execPath, "-e", "process.exit(7)"],
      ];
      config.repositories[0].setupCommandPolicy = "advisory";
    });

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "advisory setup",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "Warning: auto-configured setup failed during begin; continuing without it.",
    );
    expect(git(fixture.repo, "branch", "--show-current")).toMatch(
      /^codex\/session-[a-z0-9-]+$/,
    );
    expect(await sessions(fixture)).toHaveLength(1);

    commitFile(fixture.repo, "advisory.txt", "change\n", "advisory source");
    const integration = await runCli(fixture, fixture.repo, [
      "integrate",
      "--summary",
      "advisory setup complete",
    ]);
    expect(integration.code).toBe(1);
    expect(integration.stderr).toContain("Setup command failed (7)");
    expect((await sessions(fixture))[0].status).toBe("needs_review");
  });

  it("supports opting out of automatic branch creation", async () => {
    const fixture = await createFixture();

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "strict task",
      "--no-auto-branch",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot begin on target branch main");
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
  });

  it("creates a separate source worktree for a CLI checkout when requested", async () => {
    const fixture = await createFixture();

    const begin = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "isolated CLI task",
      "--create-worktree",
    ]);

    expect(begin.code, begin.stderr).toBe(0);
    const active = (await sessions(fixture))[0]!;
    expect(active.status).toBe("active");
    expect(active.launchWorktreePath).toBe(await realpath(fixture.repo));
    expect(active.managedSourceWorktree).toBe(true);
    expect(active.worktreePath).not.toBe(await realpath(fixture.repo));
    expect(active.worktreePath).toContain(
      join(fixture.runtime, "source-worktrees"),
    );
    expect(active.branch).toMatch(/^codex\/session-[a-z0-9-]+$/);
    expect(begin.stdout).toContain(`Continue task in: ${active.worktreePath}`);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");

    commitFile(
      active.worktreePath,
      "isolated.txt",
      "isolated\n",
      "isolated source",
    );
    const integration = await runCli(fixture, active.worktreePath, [
      "integrate",
      "--summary",
      "isolated CLI task complete",
    ]);
    expect(integration.code, integration.stderr).toBe(0);
    expect(git(fixture.repo, "show", "main:isolated.txt")).toBe("isolated");
  });

  it("allows concurrent managed sessions from one launch checkout and selects ambiguous sessions explicitly", async () => {
    const fixture = await createFixture();

    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "first isolated task",
      "--create-worktree",
    ]);
    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "second isolated task",
      "--create-worktree",
    ]);

    const active = await sessions(fixture);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((session) => session.worktreePath)).size).toBe(2);
    expect(active.every((session) => session.status === "active")).toBe(true);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");

    commitFile(active[0].worktreePath, "first.txt", "first\n", "first task");
    commitFile(active[1].worktreePath, "second.txt", "second\n", "second task");

    const ambiguous = await runCli(fixture, fixture.repo, ["validate"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("Multiple matching sessions");
    expect(ambiguous.stderr).toContain("--session <session-id>");

    await runCliOk(fixture, fixture.repo, [
      "validate",
      "--session",
      active[0].id,
    ]);
    const integrated = await runCliOk(fixture, fixture.repo, [
      "integrate",
      "--summary",
      "first complete",
      "--session",
      active[0].id,
    ]);
    expect(integrated.stdout).toContain(`Promoted ${active[0].id}`);

    const filteredStatus = await runCliOk(fixture, fixture.repo, [
      "status",
      "--session",
      active[1].id,
    ]);
    expect(filteredStatus.stdout).toContain(active[1].id);
    expect(filteredStatus.stdout).not.toContain(active[0].id);
  });

  it("bases a managed source worktree on the effective target instead of a stale launch checkout", async () => {
    const fixture = await createFixture();
    git(fixture.repo, "branch", "dev", "main");
    git(fixture.repo, "switch", "dev");
    commitFile(fixture.repo, "target-only.txt", "target\n", "advance target");
    const targetHead = git(fixture.repo, "rev-parse", "HEAD");
    git(fixture.repo, "switch", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "dev";
    });

    await runCliOk(fixture, fixture.repo, [
      "begin",
      "--summary",
      "target based task",
      "--create-worktree",
    ]);

    const active = (await sessions(fixture))[0]!;
    expect(active.startCommit).toBe(targetHead);
    expect(git(active.worktreePath, "show", "HEAD:target-only.txt")).toBe(
      "target",
    );
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
  });

  it("preserves dirty launch-checkout state when creating a source worktree", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, "user-state.txt"), "do not move\n");
    git(fixture.repo, "add", "user-state.txt");
    const before = git(fixture.repo, "status", "--porcelain=v1");

    const begin = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "preserve launch state",
      "--create-worktree",
    ]);

    expect(begin.code, begin.stderr).toBe(0);
    const active = (await sessions(fixture))[0]!;
    expect(git(fixture.repo, "status", "--porcelain=v1")).toBe(before);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
    expect(() =>
      git(active.worktreePath, "rev-parse", "--verify", "HEAD:user-state.txt"),
    ).toThrow();
  });

  it("records begin metadata, cleanly merges the exact commit, and leaves the source untouched", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "feature-clean");
    const begin = await runCli(fixture, worktree, [
      "begin",
      "--summary",
      "clean task",
    ]);
    expect(begin.code, begin.stderr).toBe(0);
    const active = (await sessions(fixture))[0]!;
    expect(active.status).toBe("active");
    expect(active.worktreePath).toBe(worktree);
    expect(active.startCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(active.integrationCommitAtStart).toBeNull();

    await writeFile(join(worktree, "clean.txt"), "source change\n");
    git(worktree, "add", "clean.txt");
    git(worktree, "commit", "-m", "clean source commit");
    const sourceHead = git(worktree, "rev-parse", "HEAD");
    const sourceStatus = git(worktree, "status", "--porcelain=v1");
    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "clean complete",
    ]);
    expect(result.code, result.stderr).toBe(0);

    const complete = (await sessions(fixture))[0]!;
    expect(complete.status).toBe("succeeded");
    expect(complete.readyCommit).toBe(sourceHead);
    expect(complete.integratedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(complete.targetBranch).toBe("main");
    expect(complete.promotedCommit).toBe(complete.integratedCommit);
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      complete.integratedCommit,
    );
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        sourceHead,
        "sesh-integrator/integration",
      ),
    ).toBe("");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(git(worktree, "status", "--porcelain=v1")).toBe(sourceStatus);
    expect(await readFile(join(worktree, "clean.txt"), "utf8")).toBe(
      "source change\n",
    );
  });

  it("selects a targeted validation tier and directly integrates validated documentation changes", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.root, "docs-validation-ran");
    await updateConfig(fixture, (config) => {
      config.repositories[0].validationTiers = [
        {
          name: "docs",
          paths: ["**/*.md"],
          sourceValidationCommands: [
            [
              process.execPath,
              "-e",
              `require("fs").writeFileSync(${JSON.stringify(marker)}, "ok\\n")`,
            ],
          ],
          integrationValidationCommands: [],
          bypassIntegrationWorktree: true,
        },
      ];
    });
    const worktree = await addWorktree(fixture, "docs-fast-path");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "document behavior",
    ]);
    const readyCommit = commitFile(
      worktree,
      "README.md",
      "documentation\n",
      "document behavior",
    );

    const validation = await runCli(fixture, worktree, ["validate"]);
    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stdout).toContain("Validation tier: docs");
    expect(await readFile(marker, "utf8")).toBe("ok\n");

    const integration = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "documented behavior",
    ]);
    expect(integration.code, integration.stderr).toBe(0);
    expect(integration.stdout).toContain("Promoted");
    expect(integration.stdout).toContain("directly");
    expect(git(fixture.repo, "rev-parse", "sesh-integrator/integration")).toBe(
      readyCommit,
    );
    expect(git(fixture.repo, "rev-parse", "main")).toBe(readyCommit);
    expect(await readdir(join(fixture.runtime, "worktrees"))).toEqual([]);
    const complete = (await sessions(fixture))[0]!;
    expect(complete.validationTier).toBe("docs");
    expect(complete.changedPaths).toEqual(["README.md"]);
    expect(complete.status).toBe("succeeded");
  });

  it("reuses exact-tree validation and records phased performance", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.root, "validation-count");
    const command = [
      process.execPath,
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(marker)}, "run\\n")`,
    ];
    await updateConfig(fixture, (config) => {
      config.repositories[0].sourceValidationCommands = [command];
      config.repositories[0].integrationValidationCommands = [command];
    });
    const worktree = await addWorktree(fixture, "validation-cache");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "cache validation",
    ]);
    commitFile(worktree, "cached.txt", "cached\n", "cache validation");
    await runCliOk(fixture, worktree, ["validate"]);
    const integration = await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "cached validation complete",
    ]);

    expect(integration.stdout).toContain("Using cached validation:");
    expect(await readFile(marker, "utf8")).toBe("run\n");
    const session = (await sessions(fixture))[0]!;
    expect(session.sourceValidatedTree).toMatch(/^[0-9a-f]{40}$/);
    expect(session.validationCacheEntries).toHaveLength(1);
    expect(
      await readdir(join(fixture.runtime, "indexes", "worktrees")),
    ).toHaveLength(1);
    expect(
      await readdir(
        join(fixture.runtime, "indexes", "repositories", session.repositoryId),
      ),
    ).toEqual([`${session.id}.json`]);
    const performance = JSON.parse(
      await readFile(
        join(fixture.runtime, "performance", `${session.id}.json`),
        "utf8",
      ),
    );
    expect(performance.runs.map((run: any) => run.command)).toEqual([
      "begin",
      "validate",
      "integrate",
    ]);
    expect(performance.runs.every((run: any) => run.subprocessCount > 0)).toBe(
      true,
    );
    expect(
      performance.runs.find((run: any) => run.command === "integrate").metrics
        .integrationValidationCacheHits,
    ).toBe(1);
  });

  it("runs explicitly grouped validation commands in parallel", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.root, "parallel-validation-events.log");
    const parallelCommand = (label: string) => [
      process.execPath,
      "-e",
      `const fs=require("fs");const p=${JSON.stringify(marker)};fs.appendFileSync(p,${JSON.stringify(`${label}-start\n`)});setTimeout(()=>fs.appendFileSync(p,${JSON.stringify(`${label}-end\n`)}),150)`,
    ];
    await updateConfig(fixture, (config) => {
      config.repositories[0].sourceValidationCommands = [
        { parallel: [parallelCommand("a"), parallelCommand("b")] },
      ];
    });
    const worktree = await addWorktree(fixture, "parallel-validation");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "parallel validation",
    ]);
    commitFile(worktree, "parallel.txt", "parallel\n", "parallel validation");
    await runCliOk(fixture, worktree, ["validate"]);

    const events = (await readFile(marker, "utf8")).trim().split("\n");
    expect(new Set(events.slice(0, 2))).toEqual(
      new Set(["a-start", "b-start"]),
    );
  });

  it("promotes to an explicit per-repository target without moving the default branch", async () => {
    const fixture = await createFixture();
    const originalMain = git(fixture.repo, "rev-parse", "main");
    git(fixture.repo, "branch", "release", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "release";
    });
    const worktree = await addWorktree(fixture, "target-override");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "release-only task",
    ]);
    commitFile(worktree, "release.txt", "release\n", "release task");

    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "release target complete",
    ]);

    const completed = (await sessions(fixture))[0]!;
    expect(completed.targetBranch).toBe("release");
    expect(git(fixture.repo, "rev-parse", "release")).toBe(
      completed.integratedCommit,
    );
    expect(git(fixture.repo, "rev-parse", "main")).toBe(originalMain);
  });

  it("supports explicitly choosing the staging branch as the final target", async () => {
    const fixture = await createFixture();
    const originalMain = git(fixture.repo, "rev-parse", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "sesh-integrator/integration";
    });
    const worktree = await addWorktree(fixture, "combined-staging-target");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "explicit combined target",
    ]);
    commitFile(worktree, "combined.txt", "combined\n", "combined source");

    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "combined target complete",
    ]);

    const completed = (await sessions(fixture))[0]!;
    expect(completed.status).toBe("succeeded");
    expect(completed.targetBranch).toBe("sesh-integrator/integration");
    expect(completed.promotedCommit).toBe(completed.integratedCommit);
    expect(git(fixture.repo, "rev-parse", "main")).toBe(originalMain);
  });

  it("atomically promotes when the target is not checked out", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "unheld-target");
    git(fixture.repo, "switch", "--detach");
    await runCliOk(fixture, worktree, ["begin", "--summary", "unheld target"]);
    commitFile(worktree, "unheld.txt", "safe\n", "unheld target commit");

    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "unheld target complete",
    ]);

    const completed = (await sessions(fixture))[0]!;
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      completed.integratedCommit,
    );
    expect(git(fixture.repo, "branch", "--show-current")).toBe("");
  });

  it("waits for a clean target checkout before running post-integration commands", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "unheld-post-target");
    git(fixture.repo, "switch", "--detach");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "unheld post target",
    ]);
    commitFile(worktree, "unheld-post.txt", "safe\n", "unheld post commit");
    const marker = join(fixture.root, "unheld-post-ran.txt");
    await updateConfig(fixture, (config) => {
      config.repositories[0].postIntegrationCommands = [
        [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)},process.cwd())`,
        ],
      ];
    });

    const blocked = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "unheld post target complete",
      "--rollout",
      "manual",
      "--follow-up",
      "On a trusted machine, add CWS_CLIENT_ID and CWS_CLIENT_SECRET to the chrome-web-store GitHub environment.",
      "--follow-up",
      "On a trusted machine, add CWS_REFRESH_TOKEN to the chrome-web-store GitHub environment.",
    ]);

    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain(
      "must be checked out in one clean worktree",
    );
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("promotion_pending");
    await expect(readFile(marker, "utf8")).rejects.toThrow();

    for (const action of pending.rolloutFollowUps)
      expect(blocked.stdout).toContain(`Manual follow-up: ${action}`);
    expect(blocked.stdout).toContain("Outstanding integration prerequisite:");
    expect(blocked.stdout).not.toContain("No manual follow-up required.");
    const pendingStatus = await runCliOk(fixture, worktree, [
      "status",
      "--session",
      pending.id,
    ]);
    expect(pendingStatus.stdout).toContain(
      "Outstanding integration prerequisite:",
    );
    expect(pendingStatus.stdout).not.toContain("No manual follow-up required.");

    const targetHolder = join(fixture.root, "target-holder");
    git(fixture.repo, "worktree", "add", targetHolder, "main");
    const resumed = await runCliOk(fixture, worktree, ["resume"]);
    const recoveredStatus = await runCliOk(fixture, worktree, [
      "status",
      "--session",
      pending.id,
    ]);
    for (const output of [resumed.stdout, recoveredStatus.stdout]) {
      for (const action of pending.rolloutFollowUps)
        expect(output).toContain(`Manual follow-up: ${action}`);
      expect(output).not.toContain("Outstanding integration prerequisite:");
      expect(output).not.toContain("must be checked out in one clean worktree");
      expect(output).not.toContain("No manual follow-up required.");
    }
    const completed = (await sessions(fixture))[0]!;
    expect(completed.status).toBe("succeeded");
    expect(completed.latestError).toBeUndefined();
    expect(completed.rolloutFollowUps).toEqual(pending.rolloutFollowUps);
    expect(await readFile(marker, "utf8")).toBe(await realpath(targetHolder));
    expect(git(targetHolder, "branch", "--show-current")).toBe("main");
    expect(git(targetHolder, "rev-parse", "HEAD")).toBe(
      completed.integratedCommit,
    );
  });

  it("never pushes target promotion", async () => {
    const fixture = await createFixture();
    const remote = join(fixture.root, "remote.git");
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "push", "origin", "main");
    const remoteBefore = git(remote, "rev-parse", "refs/heads/main");
    const worktree = await addWorktree(fixture, "no-push");
    await runCliOk(fixture, worktree, ["begin", "--summary", "no push"]);
    commitFile(worktree, "local-only.txt", "local\n", "local-only source");

    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "local promotion only",
    ]);

    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(remoteBefore);
    expect(git(fixture.repo, "rev-parse", "main")).not.toBe(remoteBefore);
  });

  it("preserves a validated integration when the checked-out target is dirty and resumes safely", async () => {
    const fixture = await createFixture();
    const originalMain = git(fixture.repo, "rev-parse", "main");
    const worktree = await addWorktree(fixture, "dirty-target");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "dirty target handling",
    ]);
    commitFile(worktree, "target-safe.txt", "safe\n", "target-safe commit");
    await writeFile(join(fixture.repo, "shared.txt"), "user change\n");

    const blocked = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "dirty target complete",
    ]);

    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("Target worktree");
    expect(blocked.stderr).toContain("dirty");
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("promotion_pending");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(originalMain);
    expect(git(fixture.repo, "rev-parse", "sesh-integrator/integration")).toBe(
      pending.integratedCommit,
    );
    expect(await readFile(join(fixture.repo, "shared.txt"), "utf8")).toBe(
      "user change\n",
    );

    await writeFile(join(fixture.repo, "shared.txt"), "base\n");
    await runCliOk(fixture, worktree, ["resume"]);
    const completed = (await sessions(fixture))[0]!;
    expect(completed.status).toBe("succeeded");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      completed.integratedCommit,
    );
  });

  it.each(["clean", "conflict", "validation"])(
    "reconciles a committed dirty target through same-session resume (%s)",
    async (mode) => {
      const fixture = await createFixture();
      await writeFile(join(fixture.repo, "old.txt"), "old uncommitted work\n");
      const started = await runCliOk(fixture, fixture.repo, [
        "begin",
        "--create-worktree",
        "--summary",
        "adopt existing work",
      ]);
      expect(started.stdout).toContain("existing dirty work is preserved");
      let session = (await sessions(fixture))[0]!;
      const worktree = session.worktreePath;
      expect(await readFile(join(fixture.repo, "old.txt"), "utf8")).toBe(
        "old uncommitted work\n",
      );
      const ready = commitFile(
        worktree,
        mode === "conflict" ? "shared.txt" : "task.txt",
        "task\n",
        "task",
      );
      if (mode === "conflict")
        await writeFile(join(fixture.repo, "shared.txt"), "old target\n");
      expect(
        (await runCli(fixture, worktree, ["integrate", "--summary", "done"]))
          .code,
      ).toBe(1);
      session = (await sessions(fixture))[0]!;
      expect(session.status).toBe("promotion_pending");
      const originalResult = session.integratedCommit;
      const preRecoverySession = structuredClone(session);
      const originalManifest = JSON.parse(
        await readFile(
          join(session.recoveryBundle.path, "manifest.json"),
          "utf8",
        ),
      );
      git(fixture.repo, "add", ".");
      git(fixture.repo, "commit", "-m", "settle old work");
      const oldWork = git(fixture.repo, "rev-parse", "HEAD");
      const marker = join(fixture.root, "validation-count");
      const gate = join(fixture.root, "validation-gate");
      const post = join(fixture.root, "post-count");
      await updateConfig(fixture, (c) => {
        c.repositories[0].integrationValidationCommands = [
          [
            process.execPath,
            "-e",
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'validated\\n');if(${mode === "validation"}&&!fs.existsSync(${JSON.stringify(gate)}))process.exit(1)`,
          ],
        ];
        c.repositories[0].postIntegrationCommands = [
          [
            process.execPath,
            "-e",
            `require('fs').appendFileSync(${JSON.stringify(post)},'post\\n')`,
          ],
        ];
      });
      const resumed = await runCli(fixture, worktree, ["resume"]);
      if (mode !== "clean") {
        expect(resumed.code, resumed.stderr).toBe(1);
        session = (await sessions(fixture))[0]!;
        expect(session.status).toBe(
          mode === "conflict" ? "needs_review" : "validation_pending",
        );
        expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(oldWork);
        expect(session.recoveryBundle.state).toBe("open");
        if (mode === "conflict") {
          await writeFile(
            join(session.integrationWorktreePath, "shared.txt"),
            "old target\ntask\n",
          );
          git(session.integrationWorktreePath, "add", "shared.txt");
        } else {
          await writeFile(gate, "pass");
          // Reconstruct the exact resolved tree even if the disposable worktree is gone.
          git(
            fixture.repo,
            "worktree",
            "remove",
            "--force",
            session.integrationWorktreePath,
          );
        }
        await runCliOk(fixture, worktree, ["resume"]);
      } else expect(resumed.code, resumed.stderr).toBe(0);
      session = (await sessions(fixture))[0]!;
      expect(session.status).toBe("succeeded");
      expect(session.readyCommit).toBe(ready);
      expect(session.localTargetRecovery.baseCommit).toBe(originalResult);
      for (const commit of [originalResult, ready, oldWork])
        git(
          fixture.repo,
          "merge-base",
          "--is-ancestor",
          commit,
          session.promotedCommit,
        );
      expect(git(fixture.repo, "status", "--porcelain")).toBe("");
      expect(await readFile(join(fixture.repo, "old.txt"), "utf8")).toBe(
        "old uncommitted work\n",
      );
      expect(await readFile(marker, "utf8")).toContain("validated");
      expect(await readFile(post, "utf8")).toContain("post");
      const manifest = JSON.parse(
        await readFile(
          join(session.recoveryBundle.path, "manifest.json"),
          "utf8",
        ),
      );
      expect(manifest.targetCommit).toBe(originalManifest.targetCommit);
      expect(
        manifest.snapshots.slice(0, originalManifest.snapshots.length),
      ).toEqual(originalManifest.snapshots);
      expect(
        manifest.snapshots.some((s: any) => s.kind === "local-target"),
      ).toBe(true);
      if (mode === "clean") {
        // Final session publication can be interrupted after target promotion.
        await writeFile(
          join(fixture.runtime, "sessions", session.id + ".json"),
          JSON.stringify(preRecoverySession),
        );
        await runCliOk(fixture, worktree, ["resume", "--session", session.id]);
        expect((await sessions(fixture))[0]!.promotedCommit).toBe(
          session.promotedCommit,
        );
      }
    },
  );

  it("bounds repeated local target movement and recovers interrupted bundle publication", async () => {
    const f = await createFixture();
    const worktree = await addWorktree(f, "moving-reconciliation");
    await runCliOk(f, worktree, [
      "begin",
      "--summary",
      "moving reconciliation",
    ]);
    commitFile(worktree, "task.txt", "task\n", "task");
    await writeFile(join(f.repo, "old.txt"), "old\n");
    expect(
      (await runCli(f, worktree, ["integrate", "--summary", "done"])).code,
    ).toBe(1);
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "old");
    const counter = join(f.root, "moves");
    await updateConfig(f, (c) => {
      c.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          `const fs=require('fs'),cp=require('child_process');const p=${JSON.stringify(counter)},repo=${JSON.stringify(f.repo)};const n=fs.existsSync(p)?Number(fs.readFileSync(p))+1:1;fs.writeFileSync(p,String(n));fs.writeFileSync(repo+'/move'+n+'.txt',String(n));cp.execFileSync('git',['add','.'],{cwd:repo});cp.execFileSync('git',['commit','-m','move'+n],{cwd:repo});`,
        ],
      ];
    });
    for (let i = 1; i <= 2; i++) {
      const r = await runCli(f, worktree, ["resume"]);
      expect(r.code, r.stderr).toBe(1);
      expect(r.stderr).toContain("moved unexpectedly");
      expect(await readFile(counter, "utf8")).toBe(String(i));
      expect((await sessions(f))[0]!.status).toBe("promotion_pending");
    }
    await updateConfig(f, (c) => {
      c.repositories[0].integrationValidationCommands = [
        [process.execPath, "-e", "process.exit(1)"],
      ];
    });
    const previous = (await sessions(f))[0]!;
    expect((await runCli(f, worktree, ["resume"])).code).toBe(1);
    const pending = (await sessions(f))[0]!;
    expect(pending.status).toBe("validation_pending");
    expect(pending.localTargetRecoveryHistory).toHaveLength(2);
    // Simulate interruption between durable evidence and publishing session pointer.
    const sessionPath = join(f.runtime, "sessions", pending.id + ".json");
    await writeFile(sessionPath, JSON.stringify(previous));
    await updateConfig(f, (c) => {
      c.repositories[0].integrationValidationCommands = [
        [process.execPath, "--version"],
      ];
    });
    await runCliOk(f, worktree, ["resume"]);
    const done = (await sessions(f))[0]!;
    expect(done.status).toBe("succeeded");
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect(await readFile(join(f.repo, "move2.txt"), "utf8")).toBe("2");
  });

  it("detects concurrent target movement after validation and refuses promotion", async () => {
    const fixture = await createFixture();
    const originalMain = git(fixture.repo, "rev-parse", "main");
    const worktree = await addWorktree(fixture, "moving-target");
    await runCliOk(fixture, worktree, ["begin", "--summary", "moving target"]);
    const readyCommit = commitFile(
      worktree,
      "movement.txt",
      "movement\n",
      "movement source",
    );
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        ["git", "update-ref", "refs/heads/main", readyCommit, originalMain],
      ];
    });

    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "movement complete",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("moved unexpectedly");
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("promotion_pending");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(readyCommit);
    expect(pending.integratedCommit).not.toBe(readyCommit);
  });

  it("preserves validated work when the target worktree becomes inaccessible", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "inaccessible-target-task");
    git(fixture.repo, "switch", "--detach");
    const targetHolder = join(fixture.root, "target-holder");
    git(fixture.repo, "worktree", "add", targetHolder, "main");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "inaccessible target",
    ]);
    commitFile(worktree, "inaccessible.txt", "safe\n", "safe source");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          `require("fs").rmSync(${JSON.stringify(targetHolder)},{recursive:true,force:true})`,
        ],
      ];
    });

    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "inaccessible target complete",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("inaccessible worktree");
    const pending = (await sessions(fixture))[0]!;
    expect(pending.status).toBe("promotion_pending");
    expect(git(fixture.repo, "rev-parse", "sesh-integrator/integration")).toBe(
      pending.integratedCommit,
    );
  });

  it("audits and explicitly reconciles historical succeeded integrations missing from the target", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "historical-promotion");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "historical integration",
    ]);
    commitFile(worktree, "historical.txt", "historical\n", "historical source");
    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "historical complete",
    ]);
    const completed = (await sessions(fixture))[0]!;
    const historicalTarget = completed.targetCommitBeforeIntegration;
    git(fixture.repo, "switch", "--detach");
    git(
      fixture.repo,
      "update-ref",
      "refs/heads/main",
      historicalTarget,
      completed.integratedCommit,
    );
    const historicalTargetWorktree = join(
      fixture.root,
      "historical-target-worktree",
    );
    git(fixture.repo, "worktree", "add", historicalTargetWorktree, "main");

    const audit = await runCli(fixture, fixture.repo, ["reconcile"]);
    expect(audit.code, audit.stderr).toBe(0);
    expect(audit.stdout).toContain("PENDING");
    expect(audit.stdout).toContain("safe fast-forward candidate");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(historicalTarget);
    const doctor = await runCli(fixture, fixture.repo, ["doctor"]);
    expect(doctor.stdout).toContain(
      "staging sesh-integrator/integration is ahead",
    );
    expect(doctor.stdout).toContain("seshx reconcile");

    const applied = await runCli(fixture, fixture.repo, [
      "reconcile",
      "--apply",
    ]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("PROMOTED");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      completed.integratedCommit,
    );
    expect(
      await readFile(join(historicalTargetWorktree, "historical.txt"), "utf8"),
    ).toBe("historical\n");
    expect(git(historicalTargetWorktree, "status", "--porcelain=v1")).toBe("");
  });

  it("refuses historical reconciliation when target and staging histories diverge", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "divergent-history");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "divergent history",
    ]);
    commitFile(worktree, "staged.txt", "staged\n", "staged source");
    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "staged complete",
    ]);
    const completed = (await sessions(fixture))[0]!;
    const base = completed.targetCommitBeforeIntegration;
    git(fixture.repo, "switch", "--detach");
    const tree = git(fixture.repo, "rev-parse", `${base}^{tree}`);
    const external = git(
      fixture.repo,
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "external target change",
    );
    git(fixture.repo, "update-ref", "refs/heads/main", external);

    const result = await runCli(fixture, fixture.repo, [
      "reconcile",
      "--apply",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("diverged");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(external);
    expect(git(fixture.repo, "rev-parse", "sesh-integrator/integration")).toBe(
      completed.integratedCommit,
    );
  });

  it("uses full validation and the integration worktree for non-tiered changes", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.root, "full-validation-ran");
    await updateConfig(fixture, (config) => {
      config.repositories[0].sourceValidationCommands = [
        [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "ok\\n")`,
        ],
      ];
      config.repositories[0].validationTiers = [
        {
          name: "docs",
          paths: ["**/*.md"],
          sourceValidationCommands: [],
          integrationValidationCommands: [],
          bypassIntegrationWorktree: true,
        },
      ];
    });
    const worktree = await addWorktree(fixture, "full-validation");
    await runCliOk(fixture, worktree, ["begin", "--summary", "change source"]);
    commitFile(worktree, "source.ts", "export {};\n", "change source");

    const validation = await runCli(fixture, worktree, ["validate"]);
    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stdout).toContain("Validation tier: full");
    expect(await readFile(marker, "utf8")).toBe("ok\n");
    const integration = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "changed source",
    ]);
    expect(integration.code, integration.stderr).toBe(0);
    expect(integration.stdout).not.toContain("directly");
    expect(await readdir(join(fixture.runtime, "worktrees"))).toHaveLength(1);
  });

  it("does not classify a source-to-documentation rename as trivial", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, "source.ts"), "export {};\n");
    git(fixture.repo, "add", "source.ts");
    git(fixture.repo, "commit", "-m", "add source");
    const marker = join(fixture.root, "rename-full-validation-ran");
    await updateConfig(fixture, (config) => {
      config.repositories[0].sourceValidationCommands = [
        [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "ok\\n")`,
        ],
      ];
      config.repositories[0].validationTiers = [
        {
          name: "docs",
          paths: ["**/*.md"],
          sourceValidationCommands: [],
          integrationValidationCommands: [],
          bypassIntegrationWorktree: true,
        },
      ];
    });
    const worktree = await addWorktree(fixture, "rename-validation");
    await runCliOk(fixture, worktree, ["begin", "--summary", "rename source"]);
    git(worktree, "mv", "source.ts", "source.md");
    git(worktree, "commit", "-m", "rename source to docs");

    const validation = await runCli(fixture, worktree, ["validate"]);
    expect(validation.code, validation.stderr).toBe(0);
    expect(validation.stdout).toContain("Validation tier: full");
    expect(await readFile(marker, "utf8")).toBe("ok\n");
  });

  it("removes only its clean integration worktree before a divergent direct integration", async () => {
    const fixture = await createFixture();
    const first = await addWorktree(fixture, "normal-first");
    await runCliOk(fixture, first, ["begin", "--summary", "normal first"]);
    const firstCommit = commitFile(first, "code.ts", "one\n", "normal first");
    await runCliOk(fixture, first, [
      "integrate",
      "--summary",
      "normal first complete",
    ]);
    expect(await readdir(join(fixture.runtime, "worktrees"))).toHaveLength(1);

    await updateConfig(fixture, (config) => {
      config.repositories[0].validationTiers = [
        {
          name: "docs",
          paths: ["**/*.md"],
          sourceValidationCommands: [],
          integrationValidationCommands: [],
          bypassIntegrationWorktree: true,
        },
      ];
    });
    const docs = await addWorktree(fixture, "docs-after-normal");
    await runCliOk(fixture, docs, ["begin", "--summary", "docs second"]);
    const docsCommit = commitFile(docs, "GUIDE.md", "guide\n", "docs second");
    await runCliOk(fixture, docs, ["validate"]);
    const result = await runCli(fixture, docs, [
      "integrate",
      "--summary",
      "docs second complete",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("directly");
    expect(await readdir(join(fixture.runtime, "worktrees"))).toEqual([]);
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        firstCommit,
        "sesh-integrator/integration",
      ),
    ).toBe("");
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        docsCommit,
        "sesh-integrator/integration",
      ),
    ).toBe("");
  });

  it("runs setup in the integration worktree before validation", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, ".gitignore"), ".setup-ready\n");
    git(fixture.repo, "add", ".gitignore");
    git(fixture.repo, "commit", "-m", "ignore setup marker");
    await updateConfig(fixture, (config) => {
      config.repositories[0].setupCommands = [
        [
          process.execPath,
          "-e",
          'require("fs").writeFileSync(".setup-ready", "ready\\n")',
        ],
      ];
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          'if (!require("fs").existsSync(".setup-ready")) process.exit(9)',
        ],
      ];
    });
    const worktree = await addWorktree(fixture, "setup-integration");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "integration setup task",
    ]);
    commitFile(worktree, "setup.txt", "change\n", "setup source commit");

    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "integration setup complete",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.indexOf("Running setup command:")).toBeLessThan(
      result.stdout.indexOf("Running validation:"),
    );
  });

  it("scopes the configured GPG program to integration commit commands", async () => {
    const fixture = await createFixture();
    const scopedProgram = join(fixture.root, "codex-gpg");
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = scopedProgram;
    });
    const worktree = await addWorktree(fixture, "scoped-gpg-program");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "scoped signing task",
    ]);
    commitFile(worktree, "signed.txt", "change\n", "source commit");

    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "scoped signing complete",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(withGpgProgram(scopedProgram, ["commit", "-m", "message"])).toEqual([
      "-c",
      `gpg.program=${scopedProgram}`,
      "commit",
      "-m",
      "message",
    ]);
    const repositoryConfig = await readFile(
      join(fixture.repo, ".git", "config"),
      "utf8",
    );
    expect(repositoryConfig).not.toContain(scopedProgram);
  });

  it("creates a signed source commit through the controlled commit command", async () => {
    const fixture = await createFixture();
    const signingProgram = await createFakeSigningProgram(fixture);
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = signingProgram;
    });
    const worktree = await addWorktree(fixture, "signed-source");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "controlled signed source",
    ]);
    await writeFile(join(worktree, "signed-source.txt"), "signed\n");
    git(worktree, "add", "signed-source.txt");
    git(worktree, "config", "commit.gpgSign", "true");
    git(worktree, "config", "user.signingkey", "TEST-SIGNING-KEY");

    const result = await runCli(fixture, worktree, [
      "commit",
      "--message",
      "signed source commit",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Signing preflight passed for source commit",
    );
    expect(git(worktree, "cat-file", "commit", "HEAD")).toContain(
      "gpgsig -----BEGIN PGP SIGNATURE-----",
    );
  });

  it("does not attempt a source commit when the signing preflight fails", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = "/usr/bin/false";
    });
    const worktree = await addWorktree(fixture, "failed-source-preflight");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "failed signed source",
    ]);
    const head = git(worktree, "rev-parse", "HEAD");
    await writeFile(join(worktree, "staged.txt"), "staged\n");
    git(worktree, "add", "staged.txt");
    git(worktree, "config", "commit.gpgSign", "true");

    const result = await runCli(fixture, worktree, [
      "commit",
      "--message",
      "must not be created",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("OpenPGP signing preflight failed");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
    expect(git(worktree, "diff", "--cached", "--name-only")).toBe("staged.txt");
  });

  it("creates a signed integration commit with the command-scoped GPG program", async () => {
    const fixture = await createFixture();
    const signingProgram = await createFakeSigningProgram(fixture);
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = signingProgram;
    });
    const worktree = await addWorktree(fixture, "signed-integration");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "signed integration task",
    ]);
    commitFile(worktree, "signed.txt", "change\n", "source commit");
    git(fixture.repo, "config", "commit.gpgSign", "true");
    git(fixture.repo, "config", "user.signingkey", "TEST-SIGNING-KEY");

    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "signed integration complete",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(
      git(fixture.repo, "cat-file", "commit", "sesh-integrator/integration"),
    ).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      git(fixture.repo, "rev-parse", "sesh-integrator/integration"),
    );
  });

  it("resumes an unchanged clean merge after a signing failure", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "retry-signing");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "retry signing task",
    ]);
    commitFile(worktree, "retry.txt", "change\n", "source commit");
    git(fixture.repo, "config", "commit.gpgSign", "true");
    git(fixture.repo, "config", "user.signingkey", "TEST-SIGNING-KEY");
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = "/usr/bin/false";
    });

    const targetBefore = git(fixture.repo, "rev-parse", "main");
    const failed = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "retry signing complete",
    ]);
    expect(failed.code).toBe(1);
    const preserved = (await sessions(fixture))[0]!;
    expect(preserved.status).toBe("needs_review");
    expect(preserved.awaitingConflictResolution).not.toBe(true);
    expect(git(fixture.repo, "rev-parse", "main")).toBe(targetBefore);

    const signingProgram = await createFakeSigningProgram(fixture);
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = signingProgram;
    });
    const resumed = await runCli(fixture, worktree, ["resume"]);

    expect(resumed.code, resumed.stderr).toBe(0);
    const completed = (await sessions(fixture))[0]!;
    expect(completed.status).toBe("succeeded");
    expect(
      git(fixture.repo, "cat-file", "commit", completed.integratedCommit!),
    ).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
  });

  it("resumes a preserved signing failure after the source branch advances", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "retry-after-advance");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "retry before later source work",
    ]);
    const readyCommit = commitFile(
      worktree,
      "ready.txt",
      "ready\n",
      "ready source commit",
    );
    git(fixture.repo, "config", "commit.gpgSign", "true");
    git(fixture.repo, "config", "user.signingkey", "TEST-SIGNING-KEY");
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = "/usr/bin/false";
    });

    const failed = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "preserve ready commit",
    ]);
    expect(failed.code).toBe(1);
    git(fixture.repo, "config", "commit.gpgSign", "false");
    commitFile(worktree, "later.txt", "later\n", "later source commit");
    git(fixture.repo, "config", "commit.gpgSign", "true");

    const signingProgram = await createFakeSigningProgram(fixture);
    await updateConfig(fixture, (config) => {
      config.repositories[0].gpgProgram = signingProgram;
    });
    const resumed = await runCli(fixture, worktree, ["resume"]);

    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain("source branch advanced");
    const completed = (await sessions(fixture))[0]!;
    expect(completed.status).toBe("succeeded");
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        readyCommit,
        "sesh-integrator/integration",
      ),
    ).toBe("");
    expect(() =>
      git(
        fixture.repo,
        "cat-file",
        "-e",
        "sesh-integrator/integration:later.txt",
      ),
    ).toThrow();
  });

  it("serializes simultaneous integrations and the final branch contains both exact snapshots", async () => {
    const fixture = await createFixture();
    const worktreeA = await addWorktree(fixture, "parallel-a");
    const worktreeB = await addWorktree(fixture, "parallel-b");
    await runCliOk(fixture, worktreeA, ["begin", "--summary", "parallel A"]);
    await runCliOk(fixture, worktreeB, ["begin", "--summary", "parallel B"]);
    const commitA = commitFile(worktreeA, "a.txt", "A\n", "commit A");
    const commitB = commitFile(worktreeB, "b.txt", "B\n", "commit B");
    await updateConfig(fixture, (config) => {
      config.lockWaitSeconds = 5;
      config.repositories[0].integrationValidationCommands = [
        [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
      ];
    });

    const [resultA, resultB] = await Promise.all([
      runCli(fixture, worktreeA, ["integrate", "--summary", "A complete"]),
      runCli(fixture, worktreeB, ["integrate", "--summary", "B complete"]),
    ]);
    expect(resultA.code, resultA.stderr).toBe(0);
    expect(resultB.code, resultB.stderr).toBe(0);
    const finalHead = git(
      fixture.repo,
      "rev-parse",
      "sesh-integrator/integration",
    );
    expect(
      git(fixture.repo, "merge-base", "--is-ancestor", commitA, finalHead),
    ).toBe("");
    expect(
      git(fixture.repo, "merge-base", "--is-ancestor", commitB, finalHead),
    ).toBe("");
    expect(
      (await sessions(fixture)).every(
        (session) => session.status === "succeeded",
      ),
    ).toBe(true);
    expect(
      await readFile(
        join(
          fixture.runtime,
          "worktrees",
          (await sessions(fixture))[0]!.repositoryId,
          "a.txt",
        ),
        "utf8",
      ),
    ).toBe("A\n");
    expect(
      await readFile(
        join(
          fixture.runtime,
          "worktrees",
          (await sessions(fixture))[0]!.repositoryId,
          "b.txt",
        ),
        "utf8",
      ),
    ).toBe("B\n");
  });

  it("gives the conflict resolver timing and later-integration context without granting start-time precedence", async () => {
    const fixture = await createFixture("base\n");
    const earlier = await addWorktree(fixture, "earlier");
    const later = await addWorktree(fixture, "later");
    await runCliOk(fixture, earlier, ["begin", "--summary", "earlier task"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runCliOk(fixture, later, ["begin", "--summary", "later task"]);
    commitFile(earlier, "shared.txt", "earlier result\n", "earlier change");
    commitFile(later, "shared.txt", "later result\n", "later change");
    await runCliOk(fixture, later, [
      "integrate",
      "--summary",
      "later integrated first",
    ]);

    const promptCapture = join(fixture.root, "prompt.txt");
    const invocationCapture = join(fixture.root, "resolver-invocation.json");
    const fakeCodex = join(fixture.root, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nconst fs=require('node:fs');const cp=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(
        promptCapture,
      )},input);fs.writeFileSync(${JSON.stringify(
        invocationCapture,
      )},JSON.stringify({args:process.argv.slice(2),codexHome:process.env.CODEX_HOME}));fs.writeFileSync('shared.txt','later result\\nearlier compatible addition\\n');cp.execFileSync('git',['add','shared.txt']);});\n`,
    );
    await chmod(fakeCodex, 0o755);
    await updateConfig(fixture, (config) => {
      config.codexCommand = fakeCodex;
      config.conflictResolutionMode = "nested-codex";
      config.repositories[0].conflictInstructions = "Keep compatible behavior.";
    });

    await runCliOk(fixture, earlier, [
      "integrate",
      "--summary",
      "earlier completed after later",
    ]);
    const prompt = await readFile(promptCapture, "utf8");
    const invocation = JSON.parse(await readFile(invocationCapture, "utf8"));
    expect(invocation.args).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-",
    ]);
    expect(invocation.codexHome).toBe(join(fixture.runtime, "codex-home"));
    expect(
      await readFile(join(invocation.codexHome, "auth.json"), "utf8"),
    ).toBe('{"test":true}\n');
    expect(
      await readFile(join(invocation.codexHome, "config.toml"), "utf8"),
    ).toBe('model = "test-model"\n');
    expect((await stat(invocation.codexHome)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(invocation.codexHome, "auth.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(prompt).toContain("Started at:");
    expect(prompt).toContain("Ready at:");
    expect(prompt).toContain("later integrated first");
    expect(prompt).toContain(
      "Timing does not determine which implementation wins",
    );
    expect(prompt).toContain("Start time is context only");
    const integrationPath = join(
      fixture.runtime,
      "worktrees",
      (await sessions(fixture))[0]!.repositoryId,
    );
    expect(await readFile(join(integrationPath, "shared.txt"), "utf8")).toBe(
      "later result\nearlier compatible addition\n",
    );
  });

  it("honors explicit dependencies before taking the integration lock", async () => {
    const fixture = await createFixture();
    const dependencyWorktree = await addWorktree(fixture, "dependency");
    const dependentWorktree = await addWorktree(fixture, "dependent");
    await runCliOk(fixture, dependencyWorktree, [
      "begin",
      "--summary",
      "dependency",
    ]);
    const dependencyId = (await sessions(fixture)).find(
      (session) => session.worktreePath === dependencyWorktree,
    )!.id;
    await runCliOk(fixture, dependentWorktree, [
      "begin",
      "--summary",
      "dependent",
      "--depends-on",
      dependencyId,
    ]);
    commitFile(
      dependencyWorktree,
      "dependency.txt",
      "dependency\n",
      "dependency commit",
    );
    commitFile(
      dependentWorktree,
      "dependent.txt",
      "dependent\n",
      "dependent commit",
    );

    const blocked = await runCli(fixture, dependentWorktree, [
      "integrate",
      "--summary",
      "dependent complete",
    ]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("has not been promoted successfully");
    const dependentReady = (await sessions(fixture)).find(
      (session) => session.worktreePath === dependentWorktree,
    )!;
    expect(dependentReady.status).toBe("ready");
    expect(
      await exists(
        join(fixture.runtime, "locks", `${dependentReady.repositoryId}.lock`),
      ),
    ).toBe(false);

    await runCliOk(fixture, dependencyWorktree, [
      "integrate",
      "--summary",
      "dependency complete",
    ]);
    const recovered = await runCliOk(fixture, dependentWorktree, [
      "integrate",
      "--summary",
      "dependent complete",
    ]);
    expect(recovered.stdout).toContain("No manual follow-up required.");
    const status = await runCliOk(fixture, dependentWorktree, [
      "status",
      "--session",
      dependentReady.id,
    ]);
    expect(status.stdout).not.toContain("has not been promoted successfully");
    expect(status.stdout).not.toContain(
      "Outstanding integration prerequisite:",
    );
    expect(
      (await sessions(fixture)).every(
        (session) => session.status === "succeeded",
      ),
    ).toBe(true);
  });

  it("does not commit a merge when integration validation fails", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "validation-failure");
    const later = await addWorktree(fixture, "validation-failure-later");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "validation failure",
    ]);
    await runCliOk(fixture, later, ["begin", "--summary", "later valid task"]);
    commitFile(worktree, "invalid.txt", "invalid\n", "invalid source commit");
    commitFile(later, "valid.txt", "valid\n", "valid source commit");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [process.execPath, "-e", "process.exit(7)"],
      ];
    });
    const before = git(fixture.repo, "rev-parse", "main");
    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "should fail validation",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Validation failed");
    expect(git(fixture.repo, "rev-parse", "sesh-integrator/integration")).toBe(
      before,
    );
    const pending = (await sessions(fixture)).find(
      (session) => session.worktreePath === worktree,
    )!;
    expect(pending.status).toBe("validation_pending");
    expect(pending.validationFailure?.classification).toBe("unclassified");
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");

    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [];
    });
    const completed = await runCli(fixture, later, [
      "integrate",
      "--summary",
      "later valid task complete",
    ]);
    expect(completed.code, completed.stderr).toBe(0);
    expect(completed.stdout).toContain("using isolated worktree");
    expect(git(fixture.repo, "show", "main:valid.txt")).toBe("valid");
  });

  it("preserves exhausted transient validation for resume", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "transient-validation");
    const attempts = join(fixture.root, "transient-attempts.log");
    const recovery = join(fixture.root, "transient-recovered");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "transient validation",
    ]);
    commitFile(worktree, "transient.txt", "transient\n", "transient source");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        {
          command: [
            process.execPath,
            "-e",
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(attempts)},'attempt\\n');if(!fs.existsSync(${JSON.stringify(recovery)}))process.exit(75)`,
          ],
          resources: { exclusive: ["generic:integration-fixture"] },
          failure: {
            classification: "transient",
            maxAttempts: 2,
            initialBackoffMs: 10,
            maxBackoffMs: 10,
          },
        },
      ];
    });

    const failed = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "transient validation complete",
    ]);
    expect(failed.code).toBe(1);
    let [pending] = await sessions(fixture);
    expect(pending.status).toBe("validation_pending");
    expect(pending.validationFailure).toMatchObject({
      classification: "transient",
      attempts: 2,
      exhausted: true,
      exclusiveResources: ["generic:integration-fixture"],
    });
    expect((await readFile(attempts, "utf8")).trim().split("\n")).toHaveLength(
      2,
    );

    await writeFile(recovery, "ready\n");
    await runCliOk(fixture, worktree, ["resume"]);
    [pending] = await sessions(fixture);
    expect(pending.status).toBe("succeeded");
    expect(pending.validationFailure).toBeUndefined();
  });

  it("recovers an older failed session from its bundle after a newer integration", async () => {
    const fixture = await createFixture();
    const older = await addWorktree(fixture, "bundle-older");
    const newer = await addWorktree(fixture, "bundle-newer");
    const allowValidation = join(fixture.root, "allow-validation");
    await runCliOk(fixture, older, [
      "begin",
      "--summary",
      "older bundled task",
    ]);
    await runCliOk(fixture, newer, ["begin", "--summary", "newer task"]);
    commitFile(older, "older.txt", "older\n", "older source");
    commitFile(newer, "newer.txt", "newer\n", "newer source");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          `if(!require('fs').existsSync(${JSON.stringify(allowValidation)}))process.exit(19)`,
        ],
      ];
    });

    const failed = await runCli(fixture, older, [
      "integrate",
      "--summary",
      "older attempted",
    ]);
    expect(failed.code).toBe(1);
    let olderSession = (await sessions(fixture)).find(
      (item) => item.worktreePath === older,
    )!;
    expect(olderSession.recoveryBundle.state).toBe("open");
    expect(olderSession.recoveryBundle.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      git(
        fixture.repo,
        "show-ref",
        olderSession.recoveryBundle
          ? `refs/codex-handoff/recovery/${olderSession.id}/${olderSession.recoveryBundle.attemptId}/source`
          : "missing",
      ),
    ).toContain(olderSession.readyCommit);

    await writeFile(allowValidation, "yes\n");
    await runCliOk(fixture, newer, [
      "integrate",
      "--summary",
      "newer complete",
    ]);
    const oldSharedPath = join(
      fixture.runtime,
      "worktrees",
      olderSession.repositoryId,
    );
    git(fixture.repo, "worktree", "remove", "--force", oldSharedPath);

    await runCliOk(fixture, older, ["resume"]);
    olderSession = (await sessions(fixture)).find(
      (item) => item.worktreePath === older,
    )!;
    expect(olderSession.status).toBe("succeeded");
    expect(olderSession.recoveryBundle.state).toBe("archived");
    expect(git(fixture.repo, "show", "main:older.txt")).toBe("older");
    expect(git(fixture.repo, "show", "main:newer.txt")).toBe("newer");
    expect(olderSession.integrationWorktreePath).toContain(
      "recovery-worktrees",
    );
  });

  it("reconstructs and snapshots a clean snapshotless legacy bundle from the current target", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "legacy-empty-clean");
    const allowValidation = join(fixture.root, "allow-legacy-validation");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "snapshotless clean recovery",
    ]);
    commitFile(worktree, "source.txt", "source\n", "legacy source");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          `if(!require('fs').existsSync(${JSON.stringify(allowValidation)}))process.exit(31)`,
        ],
      ];
    });
    expect(
      (
        await runCli(fixture, worktree, [
          "integrate",
          "--summary",
          "legacy clean failed validation",
        ])
      ).code,
    ).toBe(1);
    await makeRecoveryBundleSnapshotless(fixture, worktree);
    commitFile(fixture.repo, "target.txt", "advanced\n", "advance target");
    const advancedTarget = git(fixture.repo, "rev-parse", "main");
    await writeFile(allowValidation, "yes\n");

    await runCliOk(fixture, worktree, ["resume"]);

    const recovered = (await sessions(fixture)).find(
      (item) => item.worktreePath === worktree,
    )!;
    expect(recovered.status).toBe("succeeded");
    expect(recovered.targetCommitBeforeIntegration).toBe(advancedTarget);
    expect(git(fixture.repo, "show", "main:source.txt")).toBe("source");
    expect(git(fixture.repo, "show", "main:target.txt")).toBe("advanced");
    const manifest = JSON.parse(
      await readFile(
        join(recovered.recoveryBundle.path, "manifest.json"),
        "utf8",
      ),
    );
    expect(
      manifest.snapshots.some((item: any) => item.kind === "merged-tree"),
    ).toBe(true);
    expect(
      manifest.snapshots.some((item: any) => item.kind === "staging-commit"),
    ).toBe(true);
  });

  it("materializes snapshotless legacy conflicts and accepts staged resolution on repeated resume", async () => {
    const fixture = await createFixture("base\n");
    const worktree = await addWorktree(fixture, "legacy-empty-conflict");
    const allowValidation = join(fixture.root, "allow-conflict-validation");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "snapshotless conflict recovery",
    ]);
    commitFile(worktree, "shared.txt", "source\n", "legacy conflict source");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [
          process.execPath,
          "-e",
          `if(!require('fs').existsSync(${JSON.stringify(allowValidation)}))process.exit(32)`,
        ],
      ];
    });
    expect(
      (
        await runCli(fixture, worktree, [
          "integrate",
          "--summary",
          "legacy conflict failed validation",
        ])
      ).code,
    ).toBe(1);
    await makeRecoveryBundleSnapshotless(fixture, worktree);
    commitFile(
      fixture.repo,
      "shared.txt",
      "target\n",
      "concurrent target advancement",
    );

    const firstResume = await runCli(fixture, worktree, ["resume"]);
    expect(firstResume.code).toBe(1);
    expect(firstResume.stderr).toContain(
      "Resolve and stage all conflicts before resume",
    );
    expect(firstResume.stderr).not.toContain("original conflict index");
    let pending = (await sessions(fixture)).find(
      (item) => item.worktreePath === worktree,
    )!;
    let recoveryPath = pending.integrationWorktreePath;
    expect(git(recoveryPath, "diff", "--name-only", "--diff-filter=U")).toBe(
      "shared.txt",
    );
    let manifest = JSON.parse(
      await readFile(
        join(pending.recoveryBundle.path, "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.snapshots.map((item: any) => item.kind)).toContain(
      "conflict-index",
    );

    const secondResume = await runCli(fixture, worktree, ["resume"]);
    expect(secondResume.code).toBe(1);
    expect(secondResume.stderr).not.toContain("original conflict index");
    pending = (await sessions(fixture)).find(
      (item) => item.worktreePath === worktree,
    )!;
    recoveryPath = pending.integrationWorktreePath;
    await writeFile(join(recoveryPath, "shared.txt"), "target\nsource\n");
    git(recoveryPath, "add", "shared.txt");
    await writeFile(allowValidation, "yes\n");

    await runCliOk(fixture, worktree, ["resume"]);

    const recovered = (await sessions(fixture)).find(
      (item) => item.worktreePath === worktree,
    )!;
    expect(recovered.status).toBe("succeeded");
    expect(git(fixture.repo, "show", "main:shared.txt")).toBe("target\nsource");
    manifest = JSON.parse(
      await readFile(
        join(recovered.recoveryBundle.path, "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.snapshots.map((item: any) => item.kind)).toContain(
      "merged-tree",
    );
  });

  it("refuses resume when failure injection corrupts a recovery manifest", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "bundle-corruption");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "bundle integrity",
    ]);
    commitFile(worktree, "integrity.txt", "integrity\n", "integrity source");
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationValidationCommands = [
        [process.execPath, "-e", "process.exit(23)"],
      ];
    });
    const failed = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "inject failure",
    ]);
    expect(failed.code).toBe(1);
    const [session] = await sessions(fixture);
    const manifestPath = join(session.recoveryBundle.path, "manifest.json");
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")} `);
    const resumed = await runCli(fixture, worktree, ["resume"]);
    expect(resumed.code).toBe(1);
    expect(resumed.stderr).toContain("Recovery manifest hash mismatch");
    expect((await sessions(fixture))[0].status).not.toBe("succeeded");
  });

  it("runs post-integration commands on the promoted target worktree", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "post-integration");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "post-integration command",
    ]);
    commitFile(worktree, "post.txt", "post\n", "post source commit");
    const originalHead = git(fixture.repo, "rev-parse", "main");
    const marker = join(fixture.root, "post-integration-ran.txt");
    await updateConfig(fixture, (config) => {
      config.repositories[0].postIntegrationCommands = [
        [
          process.execPath,
          "-e",
          `const {execFileSync}=require("node:child_process");const fs=require("node:fs");const current=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();const staging=execFileSync("git",["rev-parse","sesh-integrator/integration"],{encoding:"utf8"}).trim();const target=execFileSync("git",["rev-parse","main"],{encoding:"utf8"}).trim();const branch=execFileSync("git",["branch","--show-current"],{encoding:"utf8"}).trim();if(current!==staging||current!==target||branch!=="main"||current===${JSON.stringify(
            originalHead,
          )})process.exit(9);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({branch,current,cwd:process.cwd()}));`,
        ],
      ];
    });

    await runCliOk(fixture, worktree, [
      "integrate",
      "--summary",
      "post-integration complete",
    ]);

    const complete = (await sessions(fixture))[0]!;
    expect(complete.status).toBe("succeeded");
    expect(complete.postIntegrationResults).toHaveLength(1);
    expect(complete.postIntegrationResults[0].exitCode).toBe(0);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      branch: "main",
      current: complete.integratedCommit,
      cwd: await realpath(fixture.repo),
    });

    const alreadyPresentPath = join(fixture.root, "already-present");
    git(
      fixture.repo,
      "worktree",
      "add",
      "-b",
      "already-present",
      alreadyPresentPath,
      complete.readyCommit,
    );
    const alreadyPresent = await realpath(alreadyPresentPath);
    await runCliOk(fixture, alreadyPresent, [
      "begin",
      "--summary",
      "already integrated",
    ]);
    await runCliOk(fixture, alreadyPresent, [
      "integrate",
      "--summary",
      "no branch advance",
    ]);
    const skipped = (await sessions(fixture)).find(
      (session) => session.worktreePath === alreadyPresent,
    )!;
    expect(skipped.status).toBe("succeeded");
    expect(skipped.postIntegrationResults).toEqual([]);
  });

  it("preserves an advanced integration commit when a post-integration command fails", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "post-integration-failure");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "post-integration failure",
    ]);
    const readyCommit = commitFile(
      worktree,
      "post-failure.txt",
      "failure\n",
      "post failure source commit",
    );
    await updateConfig(fixture, (config) => {
      config.repositories[0].postIntegrationCommands = [
        [process.execPath, "-e", "process.exit(8)"],
        [process.execPath, "-e", "process.exit(0)"],
      ];
    });

    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "post-integration should fail",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Post-integration check failed after target promotion",
    );
    const failed = (await sessions(fixture))[0]!;
    expect(failed.status).toBe("needs_review");
    expect(failed.integratedCommit).toBe(
      git(fixture.repo, "rev-parse", "sesh-integrator/integration"),
    );
    expect(failed.integratedAt).toBeTruthy();
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      failed.integratedCommit,
    );
    expect(failed.promotedCommit).toBe(failed.integratedCommit);
    expect(failed.postIntegrationResults).toHaveLength(1);
    expect(failed.postIntegrationResults[0].exitCode).toBe(8);
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        readyCommit,
        "sesh-integrator/integration",
      ),
    ).toBe("");
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");

    await updateConfig(fixture, (config) => {
      config.repositories[0].postIntegrationCommands = [
        [process.execPath, "-e", "process.exit(0)"],
      ];
    });
    await runCliOk(fixture, worktree, ["resume"]);
    const recovered = (await sessions(fixture))[0]!;
    expect(recovered.status).toBe("succeeded");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      recovered.integratedCommit,
    );
  });

  it.each(harnesses)(
    "lets %s resolve a preserved conflict and resume",
    async (harness) => {
      const fixture = await createFixture("base\n");
      if (harness !== "codex") {
        await updateConfig(fixture, (config) => {
          config.conflictResolutionMode = "current-session";
          config.codexCommand = join(fixture.root, "must-not-launch-codex");
          config.harnessCommands = {
            [harness]: join(fixture.root, "missing-agent"),
          };
        });
      }
      const instructionFile =
        harness === "claude"
          ? "CLAUDE.md"
          : harness === "antigravity"
            ? "GEMINI.md"
            : "AGENTS.md";
      commitFile(
        fixture.repo,
        instructionFile,
        "Keep compatible behavior.\n",
        "project instructions",
      );
      const first = await addWorktree(fixture, "conflict-first");
      const second = await addWorktree(fixture, "conflict-unresolved");
      await runCliOk(fixture, first, [
        "begin",
        "--harness",
        harness,
        "--summary",
        "first",
      ]);
      await runCliOk(fixture, second, [
        "begin",
        "--harness",
        harness,
        "--summary",
        "second",
      ]);
      commitFile(first, "shared.txt", "first\n", "first");
      commitFile(second, "shared.txt", "second\n", "second");
      await runCliOk(fixture, first, ["integrate", "--summary", "first done"]);
      const result = await runCli(
        fixture,
        second,
        ["integrate", "--summary", "second unresolved"],
        {
          PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK:
            harness === "codex" ? "1" : "0",
        },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "Merge conflict requires resolution by the current agent session",
      );
      expect(result.stderr).toContain("seshx resume");
      const failed = (await sessions(fixture)).find(
        (session) => session.worktreePath === second,
      )!;
      expect(failed.harness).toBe(harness);
      expect(await readFile(failed.conflictPromptPath, "utf8")).toContain(
        "Keep compatible behavior.",
      );
      if (harness !== "codex") {
        const incident = JSON.parse(
          await readFile(
            join(
              fixture.runtime,
              "incidents",
              `${failed.latestIncidentId}.json`,
            ),
            "utf8",
          ),
        );
        expect(incident.investigationError).toContain(
          harness === "antigravity"
            ? "does not enforce read-only"
            : "missing-agent",
        );
        expect(
          await exists(join(fixture.runtime, "codex-home", "auth.json")),
        ).toBe(false);
      }
      expect(failed.status).toBe("needs_review");
      expect(failed.awaitingConflictResolution).toBe(true);
      expect(failed.conflictPromptPath).toBeTruthy();
      const integrationPath = join(
        fixture.runtime,
        "worktrees",
        failed.repositoryId,
      );
      expect(
        git(integrationPath, "diff", "--name-only", "--diff-filter=U"),
      ).toBe("shared.txt");
      expect(git(second, "status", "--porcelain=v1")).toBe("");

      const prematureResume = await runCli(fixture, second, ["resume"]);
      expect(prematureResume.code).toBe(1);
      expect(prematureResume.stderr).toContain(
        "Resolve and stage all conflicts before resume",
      );

      const reconstructedPath = (await sessions(fixture)).find(
        (session) => session.worktreePath === second,
      )!.integrationWorktreePath;
      await writeFile(join(reconstructedPath, "shared.txt"), "first\nsecond\n");
      git(reconstructedPath, "add", "shared.txt");
      const resumed = await runCli(fixture, second, ["resume"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      const completed = (await sessions(fixture)).find(
        (session) => session.worktreePath === second,
      )!;
      expect(completed.status).toBe("succeeded");
      expect(completed.awaitingConflictResolution).toBe(false);
      expect(
        await readFile(
          join(completed.integrationWorktreePath, "shared.txt"),
          "utf8",
        ),
      ).toBe("first\nsecond\n");
    },
  );

  it("lets a later session integrate while another session preserves conflicts", async () => {
    const fixture = await createFixture("base\n");
    const first = await addWorktree(fixture, "blocking-first");
    const conflicted = await addWorktree(fixture, "blocking-conflict");
    const later = await addWorktree(fixture, "blocking-later");
    await runCliOk(fixture, first, ["begin", "--summary", "first"]);
    await runCliOk(fixture, conflicted, ["begin", "--summary", "conflict"]);
    await runCliOk(fixture, later, ["begin", "--summary", "later"]);
    commitFile(first, "shared.txt", "first\n", "first");
    commitFile(conflicted, "shared.txt", "conflicted\n", "conflicted");
    commitFile(later, "later.txt", "later\n", "later");
    await runCliOk(fixture, first, ["integrate", "--summary", "first done"]);
    const blocked = await runCli(fixture, conflicted, [
      "integrate",
      "--summary",
      "conflict pending",
    ]);
    expect(blocked.code).toBe(1);

    const completed = await runCli(fixture, later, [
      "integrate",
      "--summary",
      "later done",
    ]);

    expect(completed.code, completed.stderr).toBe(0);
    expect(completed.stdout).toContain("using isolated worktree");
    expect(git(fixture.repo, "show", "main:later.txt")).toBe("later");
    const pending = (await sessions(fixture)).find(
      (session) => session.worktreePath === conflicted,
    )!;
    expect(pending.status).toBe("needs_review");
    expect(pending.awaitingConflictResolution).toBe(true);
  });

  it("reconstructs resumable state from an orphaned preserved merge", async () => {
    const fixture = await createFixture("base\n");
    const first = await addWorktree(fixture, "orphan-first");
    const second = await addWorktree(fixture, "orphan-second");
    await runCliOk(fixture, first, ["begin", "--summary", "first"]);
    await runCliOk(fixture, second, ["begin", "--summary", "second"]);
    commitFile(first, "shared.txt", "first\n", "first");
    commitFile(second, "shared.txt", "second\n", "second");
    await runCliOk(fixture, first, ["integrate", "--summary", "first done"]);
    await runCli(fixture, second, ["integrate", "--summary", "second done"]);

    const sessionDirectory = join(fixture.runtime, "sessions");
    const sessionFiles = await readdir(sessionDirectory);
    const records = await Promise.all(
      sessionFiles.map(async (name) => ({
        name,
        value: JSON.parse(await readFile(join(sessionDirectory, name), "utf8")),
      })),
    );
    const record = records.find(({ value }) => value.worktreePath === second)!;
    record.value.status = "ready";
    delete record.value.awaitingConflictResolution;
    delete record.value.conflictIntegrationHead;
    await writeFile(
      join(sessionDirectory, record.name),
      `${JSON.stringify(record.value, null, 2)}\n`,
    );
    const integrationPath = join(
      fixture.runtime,
      "worktrees",
      record.value.repositoryId,
    );
    await writeFile(join(integrationPath, "shared.txt"), "first\nsecond\n");
    git(integrationPath, "add", "shared.txt");

    const resumed = await runCli(fixture, second, ["resume"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain("Recovered resumable merge state");
    expect(
      (await sessions(fixture)).find(
        ({ worktreePath }) => worktreePath === second,
      )?.status,
    ).toBe("succeeded");
  });

  it("treats an already-contained pull-request head as satisfied", async () => {
    const fixture = await createFixture();
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    const head = git(fixture.repo, "rev-parse", "main");
    git(fixture.repo, "push", "origin", "main");
    await updateConfig(fixture, (config) => {
      config.repositories[0].targetBranch = "dev";
      config.repositories[0].promotion = {
        type: "pull-request",
        productionBranch: "main",
      };
    });
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    const fake = await createFakeGh(fixture);
    const previousEnvironment = { ...process.env };
    Object.assign(process.env, fake.env);
    try {
      await expect(
        promoteByPullRequest(config.repositories[0], {
          id: "contained",
          branch: "codex/contained",
          promotedCommit: head,
          completionSummary: "already shipped",
        } as any),
      ).resolves.toBeUndefined();
      expect(await readFile(fake.log, "utf8")).not.toContain("pr create");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnvironment)) delete process.env[key];
      }
      Object.assign(process.env, previousEnvironment);
    }
  });

  it("refuses to remove a dead-owner lock over a dirty integration worktree", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "stale-lock");
    await runCliOk(fixture, worktree, ["begin", "--summary", "stale lock"]);
    commitFile(worktree, "stale.txt", "stale\n", "stale source commit");
    const session = (await sessions(fixture))[0]!;
    const integrationPath = join(
      fixture.runtime,
      "worktrees",
      session.repositoryId,
    );
    git(
      fixture.repo,
      "worktree",
      "add",
      "-b",
      "sesh-integrator/integration",
      integrationPath,
      "main",
    );
    await writeFile(join(integrationPath, "dirty.txt"), "do not discard\n");
    const lockPath = join(
      fixture.runtime,
      "locks",
      `${session.repositoryId}.lock`,
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 99_999_999,
        hostname: (await import("node:os")).hostname(),
        sessionId: "interrupted-session",
        acquiredAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
      }),
    );
    const result = await runCli(fixture, worktree, [
      "integrate",
      "--summary",
      "stale attempt",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("was not removed");
    expect(result.stderr).toContain("integration worktree is dirty");
    expect(await exists(lockPath)).toBe(true);
    expect(await readFile(join(integrationPath, "dirty.txt"), "utf8")).toBe(
      "do not discard\n",
    );
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");
  });

  it("audits legacy artifacts without mutating them", async () => {
    const fixture = await createFixture();
    const legacySource = join(
      fixture.auditHome,
      "Developer",
      "tools",
      "codex-integrator",
    );
    const legacyState = join(fixture.auditHome, ".codex-integrator");
    const legacySkill = join(
      fixture.auditHome,
      ".agents",
      "skills",
      "codex-integrator-workflow",
    );
    await mkdir(legacySource, { recursive: true });
    await mkdir(legacyState, { recursive: true });
    await mkdir(legacySkill, { recursive: true });
    await mkdir(join(fixture.auditHome, ".codex"), { recursive: true });
    await writeFile(join(legacySource, "keep.txt"), "keep source\n");
    await writeFile(join(legacyState, "state.json"), '{"keep":true}\n');
    await writeFile(join(legacySkill, "SKILL.md"), "legacy skill\n");
    await writeFile(
      join(fixture.auditHome, ".codex", "AGENTS.md"),
      "use codex-integrator\n",
    );
    const before = await snapshot(fixture.auditHome);
    const runtimeBefore = await snapshot(fixture.runtime);
    const result = await runCli(fixture, fixture.repo, ["audit-legacy"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("FOUND     Old source directory");
    expect(result.stdout).toContain("Nothing was changed");
    expect(await snapshot(fixture.auditHome)).toEqual(before);
    expect(await snapshot(fixture.runtime)).toEqual(runtimeBefore);
  });

  it("reports READY without requiring repository-managed guidance", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.codexCommand = process.execPath;
      config.repositories[0].sourceValidationCommands = [
        [process.execPath, "--version"],
      ];
      config.repositories[0].integrationValidationCommands = [
        [process.execPath, "--version"],
      ];
    });
    const skillRoot = join(
      fixture.auditHome,
      ".agents",
      "skills",
      "sesh-integrator-workflow",
    );
    await mkdir(join(skillRoot, "agents"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      await readFile(
        join(process.cwd(), "skill", "sesh-integrator-workflow", "SKILL.md"),
        "utf8",
      ),
    );
    await writeFile(
      join(skillRoot, "agents", "openai.yaml"),
      await readFile(
        join(
          process.cwd(),
          "skill",
          "sesh-integrator-workflow",
          "agents",
          "openai.yaml",
        ),
        "utf8",
      ),
    );
    await mkdir(join(fixture.auditHome, ".codex"), { recursive: true });
    await writeFile(
      join(fixture.auditHome, ".codex", "AGENTS.md"),
      managedBlock(
        await readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
      ),
    );
    await mkdir(join(fixture.auditHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    const beforeHome = await snapshot(fixture.auditHome);
    const beforeRuntime = await snapshot(fixture.runtime);

    const result = await runCli(fixture, fixture.repo, ["doctor"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("seshx doctor (read-only)");
    expect(result.stdout).toContain("PASS  Workflow skill");
    expect(result.stdout).toContain("PASS  Registered repository");
    expect(result.stdout).toContain("READY");
    expect(await snapshot(fixture.auditHome)).toEqual(beforeHome);
    expect(await snapshot(fixture.runtime)).toEqual(beforeRuntime);
    expect(await exists(join(fixture.repo, "AGENTS.md"))).toBe(false);
    for (const instructions of [
      "# Project conventions\nUse the repository's coding style.\n",
      "<!-- codex-handoff:managed:start -->\nOutdated generated instructions.\n",
    ]) {
      await writeFile(join(fixture.repo, "AGENTS.md"), instructions);
      const result = await runCli(fixture, fixture.repo, ["doctor"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Repository guidance");
      expect(await readFile(join(fixture.repo, "AGENTS.md"), "utf8")).toBe(
        instructions,
      );
    }
  });

  it("reports stale global detached/default-branch guidance", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.codexCommand = process.execPath;
    });
    await mkdir(join(fixture.auditHome, ".codex"), { recursive: true });
    await writeFile(
      join(fixture.auditHome, ".codex", "AGENTS.md"),
      "Use sesh-integrator-workflow. Do not begin the workflow on the repository default branch.\n",
    );

    const result = await runCli(fixture, fixture.repo, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  Global guidance");
    expect(result.stdout).toContain("contains stale wording");
  });

  it("auto-configures safe package scripts for an existing registration", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.repo, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    await writeFile(
      join(fixture.repo, "package.json"),
      `${JSON.stringify(
        {
          packageManager: "pnpm@10.14.0",
          scripts: {
            "format:check": "prettier --check .",
            typecheck: "tsc --noEmit",
            lint: "eslint .",
            test: "vitest run",
            build: "tsc",
            "test:e2e": "playwright test",
            deploy: "deploy-production",
            "handoff:post-integration": "notify-integration",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await runCli(fixture, fixture.repo, [
      "register",
      "--auto-config",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Auto-configuration detected pnpm");
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    expect(config.repositories[0].setupCommands).toEqual([
      ["corepack", "pnpm", "install", "--frozen-lockfile"],
    ]);
    expect(config.repositories[0].setupCommandPolicy).toBe("advisory");
    expect(config.repositories[0].sourceValidationCommands).toEqual([
      {
        parallel: [
          ["corepack", "pnpm", "run", "format:check"],
          ["corepack", "pnpm", "run", "typecheck"],
          ["corepack", "pnpm", "run", "lint"],
          ["corepack", "pnpm", "run", "test"],
        ],
      },
    ]);
    expect(config.repositories[0].integrationValidationCommands).toEqual([
      {
        parallel: [
          ["corepack", "pnpm", "run", "format:check"],
          ["corepack", "pnpm", "run", "typecheck"],
          ["corepack", "pnpm", "run", "lint"],
          ["corepack", "pnpm", "run", "test"],
        ],
      },
      ["corepack", "pnpm", "run", "build"],
    ]);
    expect(config.repositories[0].validationTiers).toEqual([
      {
        name: "docs",
        paths: [
          "**/*.md",
          "**/*.mdx",
          "LICENSE",
          "LICENSE.*",
          "NOTICE",
          "NOTICE.*",
        ],
        sourceValidationCommands: [],
        integrationValidationCommands: [],
        bypassIntegrationWorktree: true,
      },
      {
        name: "tests",
        paths: [
          "**/*.test.*",
          "**/*.spec.*",
          "**/__tests__/**",
          "test/**",
          "tests/**",
        ],
        sourceValidationCommands: [
          {
            parallel: [
              ["corepack", "pnpm", "run", "typecheck"],
              ["corepack", "pnpm", "run", "test"],
            ],
          },
        ],
        integrationValidationCommands: [
          {
            parallel: [
              ["corepack", "pnpm", "run", "typecheck"],
              ["corepack", "pnpm", "run", "test"],
            ],
          },
        ],
      },
    ]);
    expect(config.repositories[0].postIntegrationCommands).toEqual([
      ["corepack", "pnpm", "run", "handoff:post-integration"],
    ]);
    expect(JSON.stringify(config)).not.toContain("test:e2e");
    expect(JSON.stringify(config)).not.toContain("deploy-production");
  });

  it("auto-configures setup for a non-JavaScript repository", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, "uv.lock"), "version = 1\n");

    const result = await runCli(fixture, fixture.repo, [
      "register",
      "--auto-config",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Auto-configuration detected uv");
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    expect(config.repositories[0].setupCommands).toEqual([
      ["uv", "sync", "--frozen"],
    ]);
    expect(config.repositories[0].setupCommandPolicy).toBe("advisory");
  });

  it("stores an explicit setup command for an unknown ecosystem", async () => {
    const fixture = await createFixture();

    const result = await runCli(fixture, fixture.repo, [
      "register",
      "--setup-command",
      '["make","bootstrap"]',
    ]);

    expect(result.code, result.stderr).toBe(0);
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    expect(config.repositories[0].setupCommands).toEqual([
      ["make", "bootstrap"],
    ]);
    expect(config.repositories[0].setupCommandPolicy).toBe("required");
  });

  it("preserves configured commands and supports explicit handoff scripts", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].sourceValidationCommands = [
        [process.execPath, "--version"],
      ];
    });
    await writeFile(
      join(fixture.repo, "package.json"),
      `${JSON.stringify(
        {
          scripts: {
            "handoff:source": "custom-source-check",
            "handoff:integration": "custom-integration-check",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await runCli(fixture, fixture.repo, [
      "register",
      fixture.repo,
      "--auto-config",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Preserved existing: source validation");
    const config = JSON.parse(
      await readFile(join(fixture.runtime, "config.json"), "utf8"),
    );
    expect(config.repositories[0].sourceValidationCommands).toEqual([
      [process.execPath, "--version"],
    ]);
    expect(config.repositories[0].integrationValidationCommands).toEqual([
      ["npm", "run", "handoff:integration"],
    ]);
    expect(config.repositories[0].postIntegrationCommands).toEqual([]);
  });

  it("reports NOT READY with actionable installation and validation failures", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.codexCommand = process.execPath;
    });

    const result = await runCli(fixture, fixture.repo, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  Workflow skill");
    expect(result.stdout).toContain("FAIL  Global guidance");
    expect(result.stdout).toContain("no commands configured");
    expect(result.stdout).toContain("NOT READY");
  });

  it("checks registration for the sesh-integrator repository too", async () => {
    const fixture = await createFixture();

    const result = await runCli(fixture, process.cwd(), ["doctor"]);

    expect(result.stdout).toContain("Current repository: not registered");
    expect(result.code).toBe(1);
  });

  it("benchmarks disposable small, large, conflict, and concurrent scenarios", async () => {
    const fixture = await createFixture();
    const result = await runCli(fixture, fixture.repo, [
      "benchmark",
      "--runs",
      "1",
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.results.map((item: any) => item.scenario)).toEqual([
      "small-clean",
      "large-clean",
      "large-dirty",
      "conflict",
      "concurrent",
    ]);
    expect(report.results.every((item: any) => item.p95Ms >= 0)).toBe(true);
  });
});

async function createFixture(sharedContents?: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sesh-integrator-test-"));
  temporaryRoots.push(root);
  const fixture = {
    root,
    repo: join(root, "repo"),
    runtime: join(root, "runtime"),
    auditHome: join(root, "home"),
    sourceCodexHome: join(root, "source-codex-home"),
  };
  await mkdir(fixture.sourceCodexHome, { recursive: true });
  await writeFile(
    join(fixture.sourceCodexHome, "auth.json"),
    '{"test":true}\n',
  );
  await writeFile(
    join(fixture.sourceCodexHome, "config.toml"),
    'model = "test-model"\n',
  );
  await mkdir(fixture.repo, { recursive: true });
  git(fixture.repo, "init", "-b", "main");
  git(fixture.repo, "config", "user.name", "Test User");
  git(fixture.repo, "config", "user.email", "test@example.com");
  git(fixture.repo, "config", "commit.gpgSign", "false");
  await writeFile(join(fixture.repo, "shared.txt"), sharedContents ?? "base\n");
  git(fixture.repo, "add", "shared.txt");
  git(fixture.repo, "commit", "-m", "base");
  await runCliOk(fixture, fixture.repo, ["init"]);
  await runCliOk(fixture, fixture.repo, ["register"]);
  return fixture;
}

async function addWorktree(fixture: Fixture, branch: string): Promise<string> {
  const path = join(fixture.root, branch);
  git(fixture.repo, "worktree", "add", "-b", branch, path, "main");
  return await realpath(path);
}

async function configureSharedTargetPromotion(
  fixture: Fixture,
): Promise<string> {
  const remote = join(fixture.root, "remote.git");
  git(fixture.root, "init", "--bare", remote);
  git(fixture.repo, "remote", "add", "origin", remote);
  git(fixture.repo, "push", "origin", "main");
  await updateConfig(fixture, (config) => {
    config.defaultTargetBranch = "dev";
    config.repositories[0].promotion = {
      type: "pull-request",
      mode: "shared-target",
      productionBranch: "main",
    };
  });
  return remote;
}

function advanceRemote(
  fixture: Fixture,
  remote: string,
  name: string,
  contents: string,
): void {
  const clone = join(
    fixture.root,
    `remote-writer-${Date.now()}-${Math.random()}`,
  );
  git(fixture.root, "clone", remote, clone);
  git(clone, "config", "user.name", "Remote User");
  git(clone, "config", "user.email", "remote@example.com");
  git(clone, "switch", "-c", "dev", "origin/main");
  commitFile(clone, name, contents, "remote movement");
  git(clone, "push", "origin", "dev");
}

function replaceRemoteHistory(fixture: Fixture, remote: string): void {
  const writer = join(fixture.root, `rewritten-${Date.now()}`);
  git(fixture.root, "clone", remote, writer);
  git(writer, "config", "user.name", "Remote User");
  git(writer, "config", "user.email", "remote@example.com");
  git(writer, "switch", "--orphan", "replacement");
  commitFile(writer, "replacement.txt", "replacement\n", "replace history");
  git(writer, "push", "--force", "origin", "HEAD:dev");
}

async function createMovingGit(
  fixture: Fixture,
  remote: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv }> {
  const bin = join(fixture.root, "moving-git-bin");
  const writer = join(fixture.root, "moving-writer");
  await mkdir(bin, { recursive: true });
  git(fixture.root, "clone", remote, writer);
  git(writer, "config", "user.name", "Remote User");
  git(writer, "config", "user.email", "remote@example.com");
  git(writer, "switch", "-c", "dev", "origin/main");
  const executable = join(bin, "git");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "push" && args.some((arg) => arg.includes("refs/heads/dev"))) {
  const writer = process.env.FAKE_MOVING_WRITER;
  const countPath = process.env.FAKE_MOVING_COUNT;
  const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
  fs.writeFileSync(countPath, String(count));
  spawnSync("/usr/bin/git", ["fetch", "origin", "dev"], { cwd: writer });
  const synced = spawnSync("/usr/bin/git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd: writer, stdio: "inherit" });
  if (synced.status !== 0) process.exit(synced.status || 1);
  fs.writeFileSync(writer + "/movement-" + count + ".txt", String(count) + "\\n");
  spawnSync("/usr/bin/git", ["add", "."], { cwd: writer });
  spawnSync("/usr/bin/git", ["commit", "-m", "movement " + count], { cwd: writer });
  const moved = spawnSync("/usr/bin/git", ["push", "origin", "dev"], { cwd: writer, stdio: "inherit" });
  if (moved.status !== 0) process.exit(moved.status || 1);
}
const result = spawnSync("/usr/bin/git", args, { cwd: process.cwd(), stdio: "inherit" });
process.exit(result.status == null ? 1 : result.status);
`,
  );
  await chmod(executable, 0o755);
  return {
    env: {
      ...baseEnv,
      PATH: `${bin}:${baseEnv.PATH ?? process.env.PATH ?? ""}`,
      FAKE_MOVING_WRITER: writer,
      FAKE_MOVING_COUNT: join(fixture.root, "moving-count"),
    },
  };
}

function commitFile(
  worktree: string,
  name: string,
  contents: string,
  message: string,
): string {
  execFileSync(process.execPath, [
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(
      join(worktree, name),
    )},${JSON.stringify(contents)})`,
  ]);
  git(worktree, "add", name);
  git(worktree, "commit", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function runCli(
  fixture: Fixture,
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const effectiveArgs =
    args[0] === "integrate" &&
    !args.includes("--rollout") &&
    extraEnv.PARALLEL_INTEGRATOR_TEST_REQUIRE_ROLLOUT !== "1"
      ? [...args, "--rollout", "none"]
      : args;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...effectiveArgs], {
      cwd,
      env: {
        ...process.env,
        PARALLEL_INTEGRATOR_HOME: fixture.runtime,
        PARALLEL_INTEGRATOR_AUDIT_HOME: fixture.auditHome,
        PARALLEL_INTEGRATOR_DOCTOR_HOME: fixture.auditHome,
        PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
        CODEX_HOME: fixture.sourceCodexHome,
        ...extraEnv,
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

async function runCliOkWithEnv(
  fixture: Fixture,
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<CliResult> {
  const result = await runCli(fixture, cwd, args, extraEnv);
  expect(result.code, result.stderr).toBe(0);
  return result;
}

async function createPermissionGit(
  fixture: Fixture,
  path: string,
  inaccessible: boolean,
  mode: "porcelain-deletion" | "sandbox-status-omission" = "porcelain-deletion",
): Promise<{ env: NodeJS.ProcessEnv; state: string }> {
  const bin = join(fixture.root, "fake-git-bin");
  const state = join(fixture.root, "fake-git-state");
  await mkdir(bin, { recursive: true });
  await writeFile(state, inaccessible ? "inaccessible\n" : "normal\n");
  const wrapper = join(bin, "git");
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync("/usr/bin/git", args, { cwd: process.cwd(), encoding: null });
let stdout = result.stdout || Buffer.alloc(0);
let stderr = result.stderr || Buffer.alloc(0);
let code = result.status == null ? 1 : result.status;
const inaccessible = readFileSync(process.env.FAKE_GIT_STATE, "utf8").trim() === "inaccessible";
const target = process.env.FAKE_GIT_PATH;
const isStatus = args.includes("status") && args.includes("--porcelain=v1");
const isWorktreeRaw = args[0] === "diff" && args.includes("--raw") && !args.includes("--cached");
if (inaccessible && (isStatus || isWorktreeRaw)) {
  const blob = spawnSync("/usr/bin/git", ["rev-parse", "HEAD:" + target], { cwd: process.cwd(), encoding: "utf8" }).stdout.trim();
  const sandboxStatusOmission = process.env.FAKE_GIT_MODE === "sandbox-status-omission";
  if (!sandboxStatusOmission || isWorktreeRaw) {
    const injected = isStatus
      ? Buffer.from(" D " + target + "\\0")
      : Buffer.from(":100644 000000 " + blob + " 0000000000000000000000000000000000000000 D\\t" + target + "\\0");
    stdout = Buffer.concat([stdout, injected]);
  }
  if (!sandboxStatusOmission || isStatus) {
    stderr = Buffer.concat([stderr, Buffer.from(target + ": Operation not permitted\\n")]);
  }
  if (!sandboxStatusOmission) code = 1;
}
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(code);
`,
  );
  await chmod(wrapper, 0o755);
  return {
    state,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GIT_STATE: state,
      FAKE_GIT_PATH: path,
      FAKE_GIT_MODE: mode,
    },
  };
}

async function createFakeSigningProgram(fixture: Fixture): Promise<string> {
  const signingProgram = join(fixture.root, "fake-gpg");
  await writeFile(
    signingProgram,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("[GNUPG:] SIG_CREATED D 1 10 00 0 0000000000000000000000000000000000000000\\n");
  process.stdout.write("-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n=ZmFr\\n-----END PGP SIGNATURE-----\\n");
});
`,
  );
  await chmod(signingProgram, 0o755);
  return signingProgram;
}

async function createFakeGh(
  fixture: Fixture,
): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
  const bin = join(fixture.root, "fake-gh-bin");
  const log = join(fixture.root, "gh.log");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "gh");
  const state = join(fixture.root, "gh-state.json");
  await writeFile(state, "[]\n");
  await writeFile(
    executable,
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
  if (process.env.FAKE_GH_FAIL_CREATE) { process.stderr.write("create failed\\n"); process.exit(1); }
  const pr = { url: "https://github.example/pull/" + (17 + prs.length), body: value("--body"), base: value("--base"), head: value("--head") };
  prs.push(pr); fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(prs));
  if (process.env.FAKE_GH_CREATE_THEN_FAIL) { process.stderr.write("connection lost after create\\n"); process.exit(1); }
  process.stdout.write(pr.url + "\\n");
} else if (args[0] === "pr" && args[1] === "edit") process.exit(process.env.FAKE_GH_FAIL_EDIT ? 1 : 0);
else process.exit(2);
`,
  );
  await chmod(executable, 0o755);
  return {
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
    },
  };
}

async function runCliOk(
  fixture: Fixture,
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const result = await runCli(fixture, cwd, args);
  expect(result.code, result.stderr).toBe(0);
  return result;
}

async function sessions(fixture: Fixture): Promise<any[]> {
  const directory = join(fixture.runtime, "sessions");
  const names = await readdir(directory);
  const values = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")),
      ),
  );
  return values.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function makeRecoveryBundleSnapshotless(
  fixture: Fixture,
  worktree: string,
): Promise<void> {
  const directory = join(fixture.runtime, "sessions");
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  for (const name of names) {
    const sessionPath = join(directory, name);
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    if (session.worktreePath !== worktree) continue;
    const manifestPath = join(session.recoveryBundle.path, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.snapshots = [];
    delete manifest.previousManifestHash;
    const snapshotRefs = git(
      fixture.repo,
      "for-each-ref",
      "--format=%(refname)",
      `refs/codex-handoff/recovery/${session.id}/${session.recoveryBundle.attemptId}`,
    )
      .split("\n")
      .filter((ref) => /\/(?:index|tree|validation|staging)-\d+$/.test(ref));
    for (const ref of snapshotRefs) git(fixture.repo, "update-ref", "-d", ref);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, serialized);
    session.recoveryBundle.manifestHash = createHash("sha256")
      .update(serialized)
      .digest("hex");
    const integrationPath = session.integrationWorktreePath;
    if (integrationPath && (await exists(integrationPath))) {
      git(fixture.repo, "worktree", "remove", "--force", integrationPath);
    }
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    return;
  }
  throw new Error(`Session not found for ${worktree}`);
}

async function updateConfig(
  fixture: Fixture,
  mutate: (config: any) => void,
): Promise<void> {
  const path = join(fixture.runtime, "config.json");
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

function managedBlock(contents: string): string {
  const trimmed = contents.trim();
  return trimmed.startsWith("<!-- codex-handoff:managed:start -->")
    ? `${trimmed}\n`
    : `<!-- codex-handoff:managed:start -->\n${trimmed}\n<!-- codex-handoff:managed:end -->\n`;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, relative: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const childRelative = join(relative, name);
      const info = await stat(child);
      if (info.isDirectory()) await visit(child, childRelative);
      else result[childRelative] = await readFile(child, "utf8");
    }
  }
  await visit(root, "");
  return result;
}
