import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { detectAutoConfig } from "./auto-config.js";
import {
  detectDefaultBranch,
  git,
  hasMergeInProgress,
  inspectGit,
  isClean,
  refCommit,
  unmergedFiles,
} from "./git.js";
import { acquireRepoLock, releaseRepoLock, type LockHandle } from "./lock.js";
import {
  run,
  runCommandList,
  runRequiredCommands,
  runValidation,
} from "./process.js";
import {
  DEFAULT_INTEGRATION_BRANCH,
  ensureRuntime,
  makeSessionId,
  readConfig,
  readSessions,
  repoId,
  runtimePaths,
  writeConfig,
  writeLog,
  writeSession,
} from "./runtime.js";
import type { Command, Config, RepositoryConfig, Session } from "./types.js";

export async function initCommand(): Promise<void> {
  const paths = await ensureRuntime();
  process.stdout.write(`Initialized codex-handoff runtime at ${paths.root}\n`);
  process.stdout.write(`Configuration: ${paths.config}\n`);
}

export async function registerCommand(
  pathArgument?: string,
  autoConfig = false,
  setupCommands: Command[] = [],
): Promise<RepositoryConfig> {
  const context = await inspectGit(pathArgument ?? process.cwd());
  const config = await readConfig();
  const existing = config.repositories.find(
    (repo) => repo.gitCommonDir === context.gitCommonDir,
  );
  if (existing) {
    configureExplicitSetup(existing, setupCommands);
    if (autoConfig) {
      await autoConfigureRepository(existing);
    }
    if (autoConfig || setupCommands.length > 0) await writeConfig(config);
    process.stdout.write(
      `Repository already registered:\n${JSON.stringify(existing, null, 2)}\n`,
    );
    return existing;
  }
  const repository: RepositoryConfig = {
    path: context.worktreePath,
    gitCommonDir: context.gitCommonDir,
    defaultBranch: await detectDefaultBranch(context.worktreePath),
    integrationBranch: DEFAULT_INTEGRATION_BRANCH,
    setupCommands,
    sourceValidationCommands: [],
    integrationValidationCommands: [],
    postIntegrationCommands: [],
    conflictInstructions: "",
  };
  if (autoConfig) await autoConfigureRepository(repository);
  config.repositories.push(repository);
  await writeConfig(config);
  process.stdout.write(`Registered ${repository.path}\n`);
  process.stdout.write(`Integration branch: ${repository.integrationBranch}\n`);
  return repository;
}

function configureExplicitSetup(
  repository: RepositoryConfig,
  setupCommands: Command[],
): void {
  if (setupCommands.length === 0) return;
  if (repository.setupCommands.length > 0) {
    throw new Error(
      "Setup commands are already configured; edit the central config explicitly to replace them",
    );
  }
  repository.setupCommands = setupCommands;
}

async function autoConfigureRepository(
  repository: RepositoryConfig,
): Promise<void> {
  const detected = await detectAutoConfig(repository.path);
  if (!detected) {
    process.stdout.write(
      "Auto-configuration found no supported setup convention, lockfile, or package scripts.\n",
    );
    return;
  }

  const configured: string[] = [];
  const preserved: string[] = [];
  for (const [label, key] of [
    ["setup", "setupCommands"],
    ["source validation", "sourceValidationCommands"],
    ["integration validation", "integrationValidationCommands"],
    ["post-integration", "postIntegrationCommands"],
  ] as const) {
    if (repository[key].length > 0) {
      preserved.push(label);
      continue;
    }
    if (detected[key].length > 0) {
      repository[key] = detected[key];
      configured.push(label);
    }
  }

  process.stdout.write(
    `Auto-configuration detected ${detected.environments.join(", ")}.\n`,
  );
  process.stdout.write(
    configured.length > 0
      ? `Configured: ${configured.join(", ")}.\n`
      : "No empty command lists had matching scripts.\n",
  );
  if (preserved.length > 0) {
    process.stdout.write(`Preserved existing: ${preserved.join(", ")}.\n`);
  }
  if (repository.postIntegrationCommands.length === 0) {
    process.stdout.write(
      "Post-integration remains empty; add a handoff:post-integration script to opt in.\n",
    );
  }
}

export async function beginCommand(
  summary: string,
  dependsOn: string[],
  autoBranch = true,
): Promise<Session> {
  if (!summary.trim()) throw new Error('begin requires --summary "..."');
  const context = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, context.gitCommonDir);
  if (!(await isClean(context.worktreePath)))
    throw new Error("Worktree must be clean before begin");
  if (context.branch === repository.integrationBranch) {
    throw new Error(`Cannot begin on integration branch ${context.branch}`);
  }
  const sessions = await readSessions();
  const duplicate = sessions.find(
    (session) =>
      session.worktreePath === context.worktreePath &&
      (session.status === "active" || session.status === "ready"),
  );
  if (duplicate)
    throw new Error(`Worktree already has active session ${duplicate.id}`);
  for (const dependency of dependsOn) {
    if (!sessions.some((session) => session.id === dependency)) {
      throw new Error(`Unknown dependency session: ${dependency}`);
    }
  }
  await runRequiredCommands(
    repository.setupCommands,
    context.worktreePath,
    "setup command",
  );
  if (!(await isClean(context.worktreePath))) {
    throw new Error("Setup command left the worktree dirty");
  }
  const sessionId = makeSessionId();
  let branch = context.branch;
  if (!branch || branch === repository.defaultBranch) {
    if (!autoBranch) {
      if (!branch) throw new Error("Cannot begin on a detached HEAD");
      throw new Error(`Cannot begin on default branch ${branch}`);
    }
    branch = `codex/${sessionId.replaceAll("_", "-")}`;
    await git(["switch", "-c", branch], context.worktreePath);
    process.stdout.write(`Created task branch ${branch}\n`);
  }
  const integrationCommitAtStart = await refCommit(
    repository.path,
    `refs/heads/${repository.integrationBranch}`,
  );
  const session: Session = {
    id: sessionId,
    status: "active",
    repositoryPath: repository.path,
    repositoryId: repoId(repository.gitCommonDir),
    worktreePath: context.worktreePath,
    branch,
    startCommit: context.head,
    integrationCommitAtStart,
    startedAt: new Date().toISOString(),
    taskSummary: summary.trim(),
    dependsOn: [...new Set(dependsOn)],
  };
  await writeSession(session);
  process.stdout.write(`Started ${session.id}\n`);
  process.stdout.write(`Base commit: ${session.startCommit}\n`);
  return session;
}

export async function integrateCommand(summary: string): Promise<Session> {
  if (!summary.trim()) throw new Error('integrate requires --summary "..."');
  const source = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, source.gitCommonDir);
  const sessions = await readSessions();
  const candidates = sessions.filter(
    (item) =>
      item.worktreePath === source.worktreePath &&
      (item.status === "active" || item.status === "ready"),
  );
  const session = candidates.at(-1);
  if (!session)
    throw new Error("No active or ready session exists for this worktree");
  if (!(await isClean(source.worktreePath)))
    throw new Error("Source worktree must be clean before integration");
  if (!source.branch || source.branch !== session.branch) {
    throw new Error(
      `Source branch changed since begin (expected ${session.branch}, found ${
        source.branch ?? "detached"
      })`,
    );
  }

  if (session.status === "active") {
    session.status = "ready";
    session.readyCommit = source.head;
    session.readyAt = new Date().toISOString();
    session.completionSummary = summary.trim();
    delete session.latestError;
    await writeSession(session);
  } else {
    if (session.readyCommit !== source.head) {
      throw new Error(
        `HEAD changed after ready snapshot ${session.readyCommit}; refusing to merge a moving target`,
      );
    }
    if (session.completionSummary !== summary.trim()) {
      process.stdout.write(
        `Keeping originally persisted completion summary for retry.\n`,
      );
    }
  }
  process.stdout.write(
    `Ready snapshot ${session.readyCommit} persisted for ${session.id}\n`,
  );

  await assertDependencies(session, await readSessions());
  const integrationWorktree = join(
    runtimePaths().worktrees,
    session.repositoryId,
  );
  session.waitingForLock = true;
  await writeSession(session);
  let lock: LockHandle | undefined;
  let integrationStarted = false;
  try {
    lock = await acquireRepoLock(
      session.repositoryId,
      session.id,
      config.lockWaitSeconds,
      integrationWorktree,
    );
    session.waitingForLock = false;
    await writeSession(session);
    await assertDependencies(session, await readSessions());
    await prepareIntegrationWorktree(repository, integrationWorktree);
    integrationStarted = true;
    await mergeAndValidate(config, repository, session, integrationWorktree);
    process.stdout.write(
      `Integrated ${session.id} at ${session.integratedCommit}\n`,
    );
    return session;
  } catch (error) {
    session.waitingForLock = false;
    session.latestError = errorMessage(error);
    if (integrationStarted) session.status = "needs_review";
    await writeSession(session);
    throw error;
  } finally {
    if (lock) await releaseRepoLock(lock);
  }
}

async function prepareIntegrationWorktree(
  repository: RepositoryConfig,
  path: string,
): Promise<void> {
  if (
    repository.integrationBranch === repository.defaultBranch ||
    repository.integrationBranch === "main" ||
    repository.integrationBranch === "master"
  ) {
    throw new Error(
      `Unsafe integration branch: ${repository.integrationBranch}`,
    );
  }
  if (await pathExists(path)) {
    const context = await inspectGit(path);
    if (context.gitCommonDir !== repository.gitCommonDir) {
      throw new Error(
        `Integration worktree belongs to a different repository: ${path}`,
      );
    }
    if (context.branch !== repository.integrationBranch) {
      throw new Error(
        `Integration worktree is on ${
          context.branch ?? "detached HEAD"
        }, expected ${repository.integrationBranch}`,
      );
    }
    if ((await hasMergeInProgress(path)) || !(await isClean(path))) {
      throw new Error(
        `Integration worktree is not clean; inspect and recover it manually: ${path}`,
      );
    }
    return;
  }
  const branchRef = `refs/heads/${repository.integrationBranch}`;
  const existing = await refCommit(repository.path, branchRef);
  if (existing) {
    await git(
      ["worktree", "add", path, repository.integrationBranch],
      repository.path,
    );
  } else {
    const defaultCommit = await refCommit(
      repository.path,
      `refs/heads/${repository.defaultBranch}`,
    );
    if (!defaultCommit)
      throw new Error(`Default branch not found: ${repository.defaultBranch}`);
    await git(
      [
        "worktree",
        "add",
        "-b",
        repository.integrationBranch,
        path,
        defaultCommit,
      ],
      repository.path,
    );
  }
}

async function mergeAndValidate(
  config: Config,
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  if (!session.readyCommit || !session.readyAt || !session.completionSummary) {
    throw new Error("Session is missing persisted ready metadata");
  }
  const integrationHead = await git(["rev-parse", "HEAD"], worktree);
  const merge = await run(
    "git",
    ["merge", "--no-ff", "--no-commit", session.readyCommit],
    { cwd: worktree },
  );
  if (merge.code !== 0) {
    const conflicted = await unmergedFiles(worktree);
    if (conflicted.length === 0) {
      throw new Error(
        `Merge failed without reported conflicts: ${(
          merge.stderr || merge.stdout
        ).trim()}`,
      );
    }
    const prompt = await buildConflictPrompt(
      repository,
      session,
      integrationHead,
      conflicted,
    );
    const promptPath = await writeLog(
      `${session.id}-conflict-prompt.txt`,
      prompt,
    );
    session.conflictPromptPath = promptPath;
    await writeSession(session);
    const resolution = await run(
      config.codexCommand,
      ["exec", "--full-auto", "-"],
      {
        cwd: worktree,
        input: prompt,
        echo: true,
      },
    );
    if (resolution.code !== 0)
      throw new Error(
        `Codex conflict resolver exited with code ${resolution.code}`,
      );
    const remaining = await unmergedFiles(worktree);
    if (remaining.length > 0)
      throw new Error(`Unresolved conflicts remain: ${remaining.join(", ")}`);
  }

  await runRequiredCommands(
    repository.setupCommands,
    worktree,
    "setup command",
  );
  await runValidation(repository.integrationValidationCommands, worktree);
  await assertNoUnstagedChanges(worktree);
  const integrationBranchAdvanced = await hasMergeInProgress(worktree);
  if (integrationBranchAdvanced) {
    await git(
      ["commit", "-m", `Integrate ${session.id}: ${session.taskSummary}`],
      worktree,
    );
  } else {
    process.stdout.write(
      `Ready commit was already present on the integration branch; no merge commit needed.\n`,
    );
  }
  session.integratedCommit = await git(["rev-parse", "HEAD"], worktree);
  session.integratedAt = new Date().toISOString();
  session.waitingForLock = false;
  await writeSession(session);

  if (integrationBranchAdvanced) {
    session.postIntegrationResults = await runCommandList(
      repository.postIntegrationCommands,
      worktree,
      "post-integration command",
    );
    await writeSession(session);
    const failed = session.postIntegrationResults.find(
      (result) => result.exitCode !== 0,
    );
    if (failed) {
      throw new Error(
        `Post-integration command failed after ${repository.integrationBranch} advanced (${failed.exitCode}): ${failed.command.join(" ")}`,
      );
    }
  } else {
    session.postIntegrationResults = [];
  }

  session.status = "succeeded";
  delete session.latestError;
  await writeSession(session);
}

async function assertNoUnstagedChanges(worktree: string): Promise<void> {
  const output = await git(
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    worktree,
  );
  const unsafe = output
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) => line.startsWith("??") || (line.length > 1 && line[1] !== " "),
    );
  if (unsafe.length > 0) {
    throw new Error(
      `Validation or conflict resolution left unstaged/untracked changes: ${unsafe.join(
        ", ",
      )}`,
    );
  }
}

async function assertDependencies(
  session: Session,
  sessions: Session[],
): Promise<void> {
  for (const dependencyId of session.dependsOn) {
    const dependency = sessions.find((item) => item.id === dependencyId);
    if (!dependency)
      throw new Error(`Dependency ${dependencyId} does not exist`);
    if (dependency.status === "needs_review") {
      throw new Error(
        `Dependency ${dependencyId} needs review and blocks integration`,
      );
    }
    if (dependency.status !== "succeeded") {
      throw new Error(
        `Dependency ${dependencyId} has not integrated successfully (status: ${dependency.status})`,
      );
    }
  }
}

async function buildConflictPrompt(
  repository: RepositoryConfig,
  session: Session,
  integrationHead: string,
  conflictedFiles: string[],
): Promise<string> {
  const laterIntegrations = (await readSessions()).filter(
    (item) =>
      item.repositoryId === session.repositoryId &&
      item.status === "succeeded" &&
      Boolean(item.integratedAt) &&
      item.integratedAt! > session.startedAt,
  );
  const agentsPath = join(repository.path, "AGENTS.md");
  let repositoryInstructions = "(No repository AGENTS.md found.)";
  try {
    repositoryInstructions = await readFile(agentsPath, "utf8");
  } catch {
    // AGENTS.md is optional.
  }
  return (
    `Resolve the current Git merge conflicts in this integration worktree. Do not commit.\n\n` +
    `Incoming session:\n` +
    `- ID: ${session.id}\n` +
    `- Task summary: ${session.taskSummary}\n` +
    `- Completion summary: ${session.completionSummary}\n` +
    `- Source branch: ${session.branch}\n` +
    `- Start commit: ${session.startCommit}\n` +
    `- Ready commit: ${session.readyCommit}\n` +
    `- Started at: ${session.startedAt}\n` +
    `- Ready at: ${session.readyAt}\n` +
    `- Integration branch HEAD before merge: ${integrationHead}\n` +
    `- Conflicted files: ${conflictedFiles.join(", ")}\n` +
    `- Explicit dependencies: ${
      session.dependsOn.length ? session.dependsOn.join(", ") : "none"
    }\n\n` +
    `Successful integrations after this session began:\n${formatLaterIntegrations(
      laterIntegrations,
    )}\n\n` +
    `Repository conflict instructions:\n${
      repository.conflictInstructions || "(none)"
    }\n\n` +
    `Repository AGENTS.md:\n${repositoryInstructions}\n\n` +
    `Rules:\n` +
    `- Timing does not determine which implementation wins. Start time is context only.\n` +
    `- Explicit dependencies must be honored.\n` +
    `- Preserve compatible intent from both sides.\n` +
    `- Prefer the validated current architecture.\n` +
    `- Do not remove behavior merely to make conflicts disappear.\n` +
    `- Leave no unresolved conflict markers or unmerged paths.\n` +
    `- Stage resolved files, but do not commit.\n`
  );
}

function formatLaterIntegrations(sessions: Session[]): string {
  if (sessions.length === 0) return "- none";
  return sessions
    .map(
      (item) =>
        `- ${item.id}: started ${item.startedAt}; integrated ${
          item.integratedAt
        }; task ${item.taskSummary}; completion ${
          item.completionSummary ?? "(none)"
        }`,
    )
    .join("\n");
}

function findRepository(
  config: Config,
  gitCommonDir: string,
): RepositoryConfig {
  const repository = config.repositories.find(
    (item) => item.gitCommonDir === gitCommonDir,
  );
  if (!repository)
    throw new Error(
      "Repository is not registered. Run codex-handoff register first.",
    );
  return repository;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
