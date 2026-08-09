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
import { withGpgProgram } from "../src/handoff.js";

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
  process.env.CODEX_HANDOFF_TEST_CLI ?? join(process.cwd(), "dist", "cli.js");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential("codex-handoff disposable repository workflow", () => {
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

  it("rejects ambiguous historical configuration instead of guessing", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].integrationBranch = "main";
      delete config.repositories[0].targetBranch;
    });

    const result = await runCli(fixture, fixture.repo, ["status"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Ambiguous historical configuration");
    expect(result.stderr).toContain("integrationBranch equals defaultBranch");
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
      git(fixture.repo, "show", "codex-handoff/integration:dirty.txt"),
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
      git(fixture.repo, "show", "codex-handoff/integration:README.md"),
    ).toBe("README task");
    expect(
      git(fixture.repo, "show", "codex-handoff/integration:.env.local"),
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
    expect(git(fixture.repo, "show", "codex-handoff/integration:app.ts")).toBe(
      "export const ready = true;",
    );
    expect(
      git(fixture.repo, "show", "codex-handoff/integration:.env.local"),
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
    expect(result.stderr).toContain("Start a new codex-handoff session");
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
        "codex-handoff/integration",
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
    expect(git(fixture.repo, "rev-parse", "codex-handoff/integration")).toBe(
      readyCommit,
    );
    expect(git(fixture.repo, "rev-parse", "main")).toBe(readyCommit);
    expect(await readdir(join(fixture.runtime, "worktrees"))).toEqual([]);
    const complete = (await sessions(fixture))[0]!;
    expect(complete.validationTier).toBe("docs");
    expect(complete.changedPaths).toEqual(["README.md"]);
    expect(complete.status).toBe("succeeded");
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
      config.repositories[0].targetBranch = "codex-handoff/integration";
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
    expect(completed.targetBranch).toBe("codex-handoff/integration");
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
    expect(git(fixture.repo, "rev-parse", "codex-handoff/integration")).toBe(
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
      config.repositories[0].postIntegrationCommands = [
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
      config.repositories[0].postIntegrationCommands = [
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
    expect(git(fixture.repo, "rev-parse", "codex-handoff/integration")).toBe(
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
      "staging codex-handoff/integration is ahead",
    );
    expect(doctor.stdout).toContain("codex-handoff reconcile");

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
    expect(git(fixture.repo, "rev-parse", "codex-handoff/integration")).toBe(
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
        "codex-handoff/integration",
      ),
    ).toBe("");
    expect(
      git(
        fixture.repo,
        "merge-base",
        "--is-ancestor",
        docsCommit,
        "codex-handoff/integration",
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
      git(fixture.repo, "cat-file", "commit", "codex-handoff/integration"),
    ).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    expect(git(fixture.repo, "rev-parse", "main")).toBe(
      git(fixture.repo, "rev-parse", "codex-handoff/integration"),
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
        "codex-handoff/integration",
      ),
    ).toBe("");
    expect(() =>
      git(
        fixture.repo,
        "cat-file",
        "-e",
        "codex-handoff/integration:later.txt",
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

  it("runs post-integration commands only after the staging branch advances", async () => {
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
      "Post-integration check failed before target promotion",
    );
    const failed = (await sessions(fixture))[0]!;
    expect(failed.status).toBe("needs_review");
    expect(failed.integratedCommit).toBe(
      git(fixture.repo, "rev-parse", "codex-handoff/integration"),
    );
    expect(failed.integratedAt).toBeTruthy();
    expect(git(fixture.repo, "rev-parse", "main")).not.toBe(
      failed.integratedCommit,
    );
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

  it("lets the current session resolve a preserved conflict and resume", async () => {
    const fixture = await createFixture("base\n");
    const first = await addWorktree(fixture, "conflict-first");
    const second = await addWorktree(fixture, "conflict-unresolved");
    await runCliOk(fixture, first, ["begin", "--summary", "first"]);
    await runCliOk(fixture, second, ["begin", "--summary", "second"]);
    commitFile(first, "shared.txt", "first\n", "first");
    commitFile(second, "shared.txt", "second\n", "second");
    await runCliOk(fixture, first, ["integrate", "--summary", "first done"]);
    const result = await runCli(fixture, second, [
      "integrate",
      "--summary",
      "second unresolved",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Merge conflict requires resolution by the current Codex session",
    );
    expect(result.stderr).toContain("codex-handoff resume");
    const failed = (await sessions(fixture)).find(
      (session) => session.worktreePath === second,
    )!;
    expect(failed.status).toBe("needs_review");
    expect(failed.awaitingConflictResolution).toBe(true);
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

    const prematureResume = await runCli(fixture, second, ["resume"]);
    expect(prematureResume.code).toBe(1);
    expect(prematureResume.stderr).toContain(
      "Resolve and stage all conflicts before resume",
    );

    await writeFile(join(integrationPath, "shared.txt"), "first\nsecond\n");
    git(integrationPath, "add", "shared.txt");
    const resumed = await runCli(fixture, second, ["resume"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    const completed = (await sessions(fixture)).find(
      (session) => session.worktreePath === second,
    )!;
    expect(completed.status).toBe("succeeded");
    expect(completed.awaitingConflictResolution).toBe(false);
    expect(await readFile(join(integrationPath, "shared.txt"), "utf8")).toBe(
      "first\nsecond\n",
    );
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
      await readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
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

  it("reports stale global detached/default-branch guidance", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.codexCommand = process.execPath;
    });
    await mkdir(join(fixture.auditHome, ".codex"), { recursive: true });
    await writeFile(
      join(fixture.auditHome, ".codex", "AGENTS.md"),
      "Use codex-handoff-workflow. Do not begin the workflow on the repository default branch.\n",
    );

    const result = await runCli(fixture, fixture.repo, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  Global guidance");
    expect(result.stdout).toContain(
      "contains a stale detached/default-branch prohibition",
    );
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
});

async function createFixture(sharedContents?: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codex-handoff-test-"));
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
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        CODEX_HANDOFF_HOME: fixture.runtime,
        CODEX_HANDOFF_AUDIT_HOME: fixture.auditHome,
        CODEX_HANDOFF_DOCTOR_HOME: fixture.auditHome,
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
