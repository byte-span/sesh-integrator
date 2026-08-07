import { execFileSync, spawn } from "node:child_process";
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

interface Fixture {
  root: string;
  repo: string;
  runtime: string;
  auditHome: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const temporaryRoots: string[] = [];
const cli = join(process.cwd(), "dist", "cli.js");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential("codex-handoff disposable repository workflow", () => {
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

  it("does not create an automatic branch when the worktree is dirty", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repo, "dirty.txt"), "dirty\n");

    const result = await runCli(fixture, fixture.repo, [
      "begin",
      "--summary",
      "dirty task",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Worktree must be clean before begin");
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
    expect(await sessions(fixture)).toEqual([]);
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
    expect(result.stderr).toContain("Cannot begin on default branch main");
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
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
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        sourceHead,
        "codex-handoff/integration",
      ),
    ).toBe("");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(git(worktree, "status", "--porcelain=v1")).toBe(sourceStatus);
    expect(await readFile(join(worktree, "clean.txt"), "utf8")).toBe(
      "source change\n",
    );
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
      "codex-handoff/integration",
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
    const fakeCodex = join(fixture.root, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nconst fs=require('node:fs');const cp=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(
        promptCapture,
      )},input);fs.writeFileSync('shared.txt','later result\\nearlier compatible addition\\n');cp.execFileSync('git',['add','shared.txt']);});\n`,
    );
    await chmod(fakeCodex, 0o755);
    await updateConfig(fixture, (config) => {
      config.codexCommand = fakeCodex;
      config.repositories[0].conflictInstructions = "Keep compatible behavior.";
    });

    await runCliOk(fixture, earlier, [
      "integrate",
      "--summary",
      "earlier completed after later",
    ]);
    const prompt = await readFile(promptCapture, "utf8");
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
    expect(blocked.stderr).toContain("has not integrated successfully");
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
    await runCliOk(fixture, dependentWorktree, [
      "integrate",
      "--summary",
      "dependent complete",
    ]);
    expect(
      (await sessions(fixture)).every(
        (session) => session.status === "succeeded",
      ),
    ).toBe(true);
  });

  it("does not commit a merge when integration validation fails", async () => {
    const fixture = await createFixture();
    const worktree = await addWorktree(fixture, "validation-failure");
    await runCliOk(fixture, worktree, [
      "begin",
      "--summary",
      "validation failure",
    ]);
    commitFile(worktree, "invalid.txt", "invalid\n", "invalid source commit");
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
    expect(git(fixture.repo, "rev-parse", "codex-handoff/integration")).toBe(
      before,
    );
    expect((await sessions(fixture))[0]!.status).toBe("needs_review");
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");
  });

  it("runs post-integration commands only after the integration branch advances", async () => {
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
          `const {execFileSync}=require("node:child_process");const fs=require("node:fs");const current=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();const branch=execFileSync("git",["rev-parse","codex-handoff/integration"],{encoding:"utf8"}).trim();if(current!==branch||branch===${JSON.stringify(
            originalHead,
          )})process.exit(9);fs.writeFileSync(${JSON.stringify(marker)},branch);`,
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
    expect(await readFile(marker, "utf8")).toBe(complete.integratedCommit);

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
      "Post-integration command failed after codex-handoff/integration advanced",
    );
    const failed = (await sessions(fixture))[0]!;
    expect(failed.status).toBe("needs_review");
    expect(failed.integratedCommit).toBe(
      git(fixture.repo, "rev-parse", "codex-handoff/integration"),
    );
    expect(failed.integratedAt).toBeTruthy();
    expect(failed.postIntegrationResults).toHaveLength(1);
    expect(failed.postIntegrationResults[0].exitCode).toBe(8);
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        readyCommit,
        "codex-handoff/integration",
      ),
    ).toBe("");
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");
  });

  it("marks unresolved conflicts needs_review and preserves the integration worktree", async () => {
    const fixture = await createFixture("base\n");
    const first = await addWorktree(fixture, "conflict-first");
    const second = await addWorktree(fixture, "conflict-unresolved");
    await runCliOk(fixture, first, ["begin", "--summary", "first"]);
    await runCliOk(fixture, second, ["begin", "--summary", "second"]);
    commitFile(first, "shared.txt", "first\n", "first");
    commitFile(second, "shared.txt", "second\n", "second");
    await runCliOk(fixture, first, ["integrate", "--summary", "first done"]);
    const fakeCodex = join(fixture.root, "fake-unresolved.cjs");
    await writeFile(
      fakeCodex,
      "#!/usr/bin/env node\nprocess.stdin.resume();\n",
    );
    await chmod(fakeCodex, 0o755);
    await updateConfig(fixture, (config) => {
      config.codexCommand = fakeCodex;
    });
    const result = await runCli(fixture, second, [
      "integrate",
      "--summary",
      "second unresolved",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unresolved conflicts remain");
    const failed = (await sessions(fixture)).find(
      (session) => session.worktreePath === second,
    )!;
    expect(failed.status).toBe("needs_review");
    expect(failed.conflictPromptPath).toBeTruthy();
    const integrationPath = join(
      fixture.runtime,
      "worktrees",
      failed.repositoryId,
    );
    expect(git(integrationPath, "diff", "--name-only", "--diff-filter=U")).toBe(
      "shared.txt",
    );
    expect(git(second, "status", "--porcelain=v1")).toBe("");
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
      "codex-handoff/integration",
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

  it("reports READY when installation and current repository checks pass", async () => {
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
      "codex-handoff-workflow",
    );
    await mkdir(join(skillRoot, "agents"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      await readFile(
        join(process.cwd(), "skill", "codex-handoff-workflow", "SKILL.md"),
        "utf8",
      ),
    );
    await writeFile(
      join(skillRoot, "agents", "openai.yaml"),
      await readFile(
        join(
          process.cwd(),
          "skill",
          "codex-handoff-workflow",
          "agents",
          "openai.yaml",
        ),
        "utf8",
      ),
    );
    await mkdir(join(fixture.auditHome, ".codex"), { recursive: true });
    await writeFile(
      join(fixture.auditHome, ".codex", "AGENTS.md"),
      "Use codex-handoff-workflow.\n",
    );
    await mkdir(join(fixture.auditHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    const beforeHome = await snapshot(fixture.auditHome);
    const beforeRuntime = await snapshot(fixture.runtime);

    const result = await runCli(fixture, fixture.repo, ["doctor"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("codex-handoff doctor (read-only)");
    expect(result.stdout).toContain("PASS  Workflow skill");
    expect(result.stdout).toContain("PASS  Registered repository");
    expect(result.stdout).toContain("READY");
    expect(await snapshot(fixture.auditHome)).toEqual(beforeHome);
    expect(await snapshot(fixture.runtime)).toEqual(beforeRuntime);
  });

  it("auto-configures safe package scripts for an existing registration", async () => {
    const fixture = await createFixture();
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
    expect(config.repositories[0].sourceValidationCommands).toEqual([
      ["corepack", "pnpm", "run", "format:check"],
      ["corepack", "pnpm", "run", "typecheck"],
      ["corepack", "pnpm", "run", "lint"],
      ["corepack", "pnpm", "run", "test"],
    ]);
    expect(config.repositories[0].integrationValidationCommands).toEqual([
      ["corepack", "pnpm", "run", "format:check"],
      ["corepack", "pnpm", "run", "typecheck"],
      ["corepack", "pnpm", "run", "lint"],
      ["corepack", "pnpm", "run", "test"],
      ["corepack", "pnpm", "run", "build"],
    ]);
    expect(config.repositories[0].postIntegrationCommands).toEqual([
      ["corepack", "pnpm", "run", "handoff:post-integration"],
    ]);
    expect(JSON.stringify(config)).not.toContain("test:e2e");
    expect(JSON.stringify(config)).not.toContain("deploy-production");
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
});

async function createFixture(sharedContents?: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codex-handoff-test-"));
  temporaryRoots.push(root);
  const fixture = {
    root,
    repo: join(root, "repo"),
    runtime: join(root, "runtime"),
    auditHome: join(root, "home"),
  };
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
): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        CODEX_HANDOFF_HOME: fixture.runtime,
        CODEX_HANDOFF_AUDIT_HOME: fixture.auditHome,
        CODEX_HANDOFF_DOCTOR_HOME: fixture.auditHome,
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
