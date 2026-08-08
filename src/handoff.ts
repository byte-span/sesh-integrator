import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { detectAutoConfig } from "./auto-config.js";
import {
  changedPaths,
  detectDefaultBranch,
  git,
  hasMergeInProgress,
  inspectGit,
  isClean,
  observeGitState,
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
  prepareCodexResolverHome,
  readConfig,
  readSessions,
  repoId,
  runtimePaths,
  writeConfig,
  writeLog,
  writeSession,
} from "./runtime.js";
import type {
  Command,
  Config,
  GitPathObservation,
  RepositoryConfig,
  Session,
} from "./types.js";
import { selectValidation, type SelectedValidation } from "./validation.js";
import {
  assessBeginBaseline,
  assessCompletionState,
  type HandoffStateDecision,
} from "./source-state.js";

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
    ...(setupCommands.length > 0
      ? { setupCommandPolicy: "required" as const }
      : {}),
    sourceValidationCommands: [],
    integrationValidationCommands: [],
    validationTiers: [],
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
  repository.setupCommandPolicy = "required";
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
      if (
        key === "setupCommands" &&
        repository.setupCommandPolicy === undefined &&
        commandsEqual(repository.setupCommands, detected.setupCommands)
      ) {
        repository.setupCommandPolicy = "advisory";
      }
      preserved.push(label);
      continue;
    }
    if (detected[key].length > 0) {
      repository[key] = detected[key];
      if (key === "setupCommands") {
        repository.setupCommandPolicy = "advisory";
      }
      configured.push(label);
    }
  }
  if ((repository.validationTiers ?? []).length > 0) {
    preserved.push("validation tiers");
  } else if (detected.validationTiers.length > 0) {
    repository.validationTiers = detected.validationTiers;
    configured.push("validation tiers");
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
  const baseline = await observeGitState(context.worktreePath);
  reportStateDecision("begin", assessBeginBaseline(baseline));
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
  try {
    await runRequiredCommands(
      repository.setupCommands,
      context.worktreePath,
      "setup command",
    );
  } catch (error) {
    if (repository.setupCommandPolicy !== "advisory") throw error;
    process.stderr.write(
      `Warning: auto-configured setup failed during begin; continuing without it. ${errorMessage(error)}\n`,
    );
  }
  const afterSetup = await observeGitState(context.worktreePath);
  const afterSetupContext = await inspectGit(context.worktreePath);
  if (afterSetup.head !== baseline.head) {
    throw new Error(
      "Setup command changed HEAD; no handoff session was created",
    );
  }
  if (afterSetupContext.branch !== context.branch) {
    throw new Error(
      "Setup command changed the current branch; no handoff session was created",
    );
  }
  reportStateDecision("setup", assessCompletionState(baseline, afterSetup, []));
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
    gitBaseline: baseline,
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
  if (!source.branch || source.branch !== session.branch) {
    throw new Error(
      `Source branch changed since begin (expected ${session.branch}, found ${
        source.branch ?? "detached"
      })`,
    );
  }

  const committedPaths = await changedPaths(
    source.worktreePath,
    session.startCommit,
    source.head,
  );
  await assertSourceHandoffState(
    session,
    source.worktreePath,
    committedPaths,
    "integration",
  );

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

  const validation = selectValidation(
    repository,
    committedPaths,
    session.sourceValidatedCommit === source.head,
  );
  session.validationTier = validation.name;
  session.changedPaths = validation.changedPaths;
  await writeSession(session);
  process.stdout.write(
    `Validation tier: ${validation.name} (${validation.changedPaths.length} changed path(s))\n`,
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
    if (
      await tryDirectIntegration(
        repository,
        session,
        validation,
        integrationWorktree,
      )
    ) {
      process.stdout.write(
        `Integrated ${session.id} directly at ${session.integratedCommit}\n`,
      );
      return session;
    }
    await prepareIntegrationWorktree(repository, session, integrationWorktree);
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

export async function validateCommand(): Promise<Session> {
  const source = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, source.gitCommonDir);
  const sessions = await readSessions();
  const session = sessions
    .filter(
      (item) =>
        item.worktreePath === source.worktreePath && item.status === "active",
    )
    .at(-1);
  if (!session) throw new Error("No active session exists for this worktree");
  if (source.branch !== session.branch) {
    throw new Error(
      `Source branch changed since begin (expected ${session.branch}, found ${source.branch ?? "detached"})`,
    );
  }
  const paths = await changedPaths(
    source.worktreePath,
    session.startCommit,
    source.head,
  );
  await assertSourceHandoffState(
    session,
    source.worktreePath,
    paths,
    "validation",
  );
  if (paths.length === 0) throw new Error("Session has no committed changes");
  const validation = selectValidation(repository, paths);
  process.stdout.write(
    `Validation tier: ${validation.name} (${paths.length} changed path(s))\n`,
  );
  await runValidation(validation.sourceCommands, source.worktreePath);
  await assertSourceHandoffState(
    session,
    source.worktreePath,
    paths,
    "source validation",
  );
  session.validationTier = validation.name;
  session.changedPaths = paths;
  session.sourceValidatedAt = new Date().toISOString();
  session.sourceValidatedCommit = source.head;
  await writeSession(session);
  process.stdout.write(`Validated ${session.id} at ${source.head}\n`);
  return session;
}

export async function resumeCommand(): Promise<Session> {
  const source = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, source.gitCommonDir);
  const sessions = await readSessions();
  const session = sessions
    .filter(
      (item) =>
        item.worktreePath === source.worktreePath &&
        item.status === "needs_review" &&
        item.awaitingConflictResolution === true,
    )
    .at(-1);
  if (!session) {
    throw new Error("No resumable conflict exists for this worktree");
  }
  if (source.branch !== session.branch || source.head !== session.readyCommit) {
    throw new Error(
      `Source snapshot changed; expected ${session.branch} at ${session.readyCommit}`,
    );
  }
  await assertSourceHandoffState(
    session,
    source.worktreePath,
    session.changedPaths ??
      (await changedPaths(
        source.worktreePath,
        session.startCommit,
        source.head,
      )),
    "resume",
  );

  const integrationWorktree = join(
    runtimePaths().worktrees,
    session.repositoryId,
  );
  session.waitingForLock = true;
  await writeSession(session);
  let lock: LockHandle | undefined;
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
    await assertResumableConflict(repository, session, integrationWorktree);
    await validateCommitAndFinish(repository, session, integrationWorktree);
    process.stdout.write(
      `Integrated ${session.id} at ${session.integratedCommit}\n`,
    );
    return session;
  } catch (error) {
    session.waitingForLock = false;
    session.status = "needs_review";
    session.latestError = errorMessage(error);
    await writeSession(session);
    throw error;
  } finally {
    if (lock) await releaseRepoLock(lock);
  }
}

async function prepareIntegrationWorktree(
  repository: RepositoryConfig,
  session: Session,
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
    if (await hasMergeInProgress(path)) {
      throw new Error(
        `Integration worktree is not clean; inspect and recover it manually: ${path}`,
      );
    }
    await assertIntegrationWorktreeReady(session, path);
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
  await assertIntegrationWorktreeReady(session, path);
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
    session.conflictIntegrationHead = integrationHead;
    session.awaitingConflictResolution = true;
    await writeSession(session);
    if (config.conflictResolutionMode === "nested-codex") {
      const codexHome = await prepareCodexResolverHome();
      const resolution = await run(
        config.codexCommand,
        ["exec", "--sandbox", "workspace-write", "-"],
        {
          cwd: worktree,
          input: prompt,
          echo: true,
          env: { ...process.env, CODEX_HOME: codexHome },
        },
      );
      if (resolution.code !== 0)
        throw new Error(
          `Codex conflict resolver exited with code ${resolution.code}`,
        );
    } else {
      throw new Error(
        `Merge conflict requires resolution by the current Codex session. ` +
          `Resolve and stage files in ${worktree} using ${promptPath}, then run codex-handoff resume from ${session.worktreePath}`,
      );
    }
    const remaining = await unmergedFiles(worktree);
    if (remaining.length > 0)
      throw new Error(`Unresolved conflicts remain: ${remaining.join(", ")}`);
  }

  await validateCommitAndFinish(repository, session, worktree);
}

async function assertResumableConflict(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  const context = await inspectGit(worktree);
  if (context.gitCommonDir !== repository.gitCommonDir) {
    throw new Error(
      `Integration worktree belongs to a different repository: ${worktree}`,
    );
  }
  if (context.branch !== repository.integrationBranch) {
    throw new Error(
      `Integration worktree is on ${context.branch ?? "detached HEAD"}, expected ${repository.integrationBranch}`,
    );
  }
  if (
    !session.conflictIntegrationHead ||
    context.head !== session.conflictIntegrationHead
  ) {
    throw new Error(
      `Integration HEAD changed since the conflict was preserved; expected ${session.conflictIntegrationHead ?? "recorded conflict HEAD"}`,
    );
  }
  if (!(await hasMergeInProgress(worktree))) {
    throw new Error(
      "The preserved integration worktree has no merge in progress",
    );
  }
  const mergeHead = await git(["rev-parse", "MERGE_HEAD"], worktree);
  if (mergeHead !== session.readyCommit) {
    throw new Error(
      `Preserved merge targets ${mergeHead}, expected ready commit ${session.readyCommit}`,
    );
  }
  const remaining = await unmergedFiles(worktree);
  if (remaining.length > 0) {
    throw new Error(
      `Resolve and stage all conflicts before resume: ${remaining.join(", ")}`,
    );
  }
}

async function validateCommitAndFinish(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  const validation = selectValidation(
    repository,
    session.changedPaths ??
      (await changedPaths(worktree, session.startCommit, session.readyCommit)),
    session.validationTier !== "full" &&
      session.sourceValidatedCommit === session.readyCommit,
  );
  await runRequiredCommands(
    repository.setupCommands,
    worktree,
    "setup command",
  );
  await runValidation(validation.integrationCommands, worktree);
  await assertNoUnstagedChanges(session, worktree);
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
  session.awaitingConflictResolution = false;
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

async function tryDirectIntegration(
  repository: RepositoryConfig,
  session: Session,
  validation: SelectedValidation,
  integrationWorktree: string,
): Promise<boolean> {
  if (!validation.bypassIntegrationWorktree) return false;
  if (session.sourceValidatedCommit !== session.readyCommit) {
    process.stdout.write(
      "Direct integration bypass skipped: ready commit was not validated by codex-handoff validate.\n",
    );
    return false;
  }
  if (
    validation.integrationCommands.length > 0 ||
    repository.postIntegrationCommands.length > 0
  ) {
    process.stdout.write(
      "Direct integration bypass skipped: integration or post-integration commands require a worktree.\n",
    );
    return false;
  }
  if (!session.readyCommit) return false;
  const branchRef = `refs/heads/${repository.integrationBranch}`;
  const existingIntegrationHead = await refCommit(repository.path, branchRef);
  const integrationHead =
    existingIntegrationHead ??
    (await refCommit(
      repository.path,
      `refs/heads/${repository.defaultBranch}`,
    ));
  if (!integrationHead) return false;

  let integratedCommit: string;
  const ancestor = await run(
    "git",
    ["merge-base", "--is-ancestor", integrationHead, session.readyCommit],
    { cwd: repository.path },
  );
  if (ancestor.code === 0) {
    integratedCommit = session.readyCommit;
  } else {
    const mergeTree = await run(
      "git",
      ["merge-tree", "--write-tree", integrationHead, session.readyCommit],
      { cwd: repository.path },
    );
    if (mergeTree.code !== 0) {
      process.stdout.write(
        "Direct integration bypass found a conflict or unsupported Git; using the integration worktree.\n",
      );
      return false;
    }
    const tree = mergeTree.stdout.split("\n", 1)[0]?.trim();
    if (!tree) return false;
    integratedCommit = await git(
      [
        "commit-tree",
        tree,
        "-p",
        integrationHead,
        "-p",
        session.readyCommit,
        "-m",
        `Integrate ${session.id}: ${session.taskSummary}`,
      ],
      repository.path,
    );
  }

  if (
    !(await removeOwnedIntegrationWorktree(repository, integrationWorktree))
  ) {
    process.stdout.write(
      "Direct integration bypass skipped: integration worktree is not safely removable.\n",
    );
    return false;
  }
  if (await isBranchCheckedOut(repository, branchRef)) {
    process.stdout.write(
      "Direct integration bypass skipped: integration branch is checked out in another worktree.\n",
    );
    return false;
  }
  await git(
    [
      "update-ref",
      branchRef,
      integratedCommit,
      existingIntegrationHead ?? "0000000000000000000000000000000000000000",
    ],
    repository.path,
  );
  session.integratedCommit = integratedCommit;
  session.integratedAt = new Date().toISOString();
  session.waitingForLock = false;
  session.awaitingConflictResolution = false;
  session.postIntegrationResults = [];
  session.status = "succeeded";
  delete session.latestError;
  await writeSession(session);
  return true;
}

async function isBranchCheckedOut(
  repository: RepositoryConfig,
  branchRef: string,
): Promise<boolean> {
  const output = await git(
    ["worktree", "list", "--porcelain"],
    repository.path,
  );
  return output.split("\n").some((line) => line === `branch ${branchRef}`);
}

async function removeOwnedIntegrationWorktree(
  repository: RepositoryConfig,
  path: string,
): Promise<boolean> {
  if (!(await pathExists(path))) return true;
  const context = await inspectGit(path);
  if (
    context.gitCommonDir !== repository.gitCommonDir ||
    context.branch !== repository.integrationBranch ||
    (await hasMergeInProgress(path)) ||
    !(await isClean(path))
  ) {
    return false;
  }
  const result = await run("git", ["worktree", "remove", path], {
    cwd: repository.path,
  });
  return result.code === 0;
}

async function assertNoUnstagedChanges(
  session: Session,
  worktree: string,
): Promise<void> {
  const observation = await observeGitState(worktree);
  const unsafe = observation.paths.filter(
    (path) =>
      (path.status === "??" || (!!path.status && path.status[1] !== " ")) &&
      !isAllowedIntegrationInaccessible(session, path),
  );
  if (observation.unscopedErrors.length > 0) {
    throw new Error(
      `Integration Git observation was indeterminate: ${observation.unscopedErrors.join("; ")}`,
    );
  }
  if (unsafe.length > 0) {
    throw new Error(
      `Validation or conflict resolution left unstaged/untracked changes: ${unsafe
        .map((path) => path.path)
        .join(", ")}`,
    );
  }
}

async function assertIntegrationWorktreeReady(
  session: Session,
  worktree: string,
): Promise<void> {
  const observation = await observeGitState(worktree);
  const unsafe = observation.paths.filter(
    (path) => !isAllowedIntegrationInaccessible(session, path),
  );
  if (observation.unscopedErrors.length > 0 || unsafe.length > 0) {
    throw new Error(
      `Integration worktree is not clean; unsafe observable paths: ${unsafe.map((path) => path.path).join(", ") || observation.unscopedErrors.join("; ")}`,
    );
  }
  for (const path of observation.paths) {
    process.stderr.write(
      `Warning (integration worktree): ${path.path} remains inaccessible, tracked, unstaged, and outside the task diff; preserving the integration branch version (disk contents were not verified)\n`,
    );
  }
}

function isAllowedIntegrationInaccessible(
  session: Session,
  path: GitPathObservation,
): boolean {
  const baseline = session.gitBaseline?.paths.find(
    (item) => item.path === path.path && !item.accessible,
  );
  return (
    !!baseline &&
    path.tracked &&
    !path.accessible &&
    path.indexRaw === null &&
    !session.changedPaths?.includes(path.path) &&
    (path.status?.[0] === " " || path.status?.[0] === "?")
  );
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

function commandsEqual(left: Command[], right: Command[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertSourceHandoffState(
  session: Session,
  worktree: string,
  taskPaths: string[],
  phase: string,
): Promise<void> {
  if (!session.gitBaseline) {
    throw new Error(
      `Session ${session.id} predates observable Git baselines and cannot be safely ${phase === "integration" ? "integrated" : "validated"}. Start a new codex-handoff session.`,
    );
  }
  const current = await observeGitState(worktree);
  reportStateDecision(
    phase,
    assessCompletionState(session.gitBaseline, current, taskPaths),
  );
}

function reportStateDecision(
  phase: string,
  decision: HandoffStateDecision,
): void {
  for (const warning of decision.warnings) {
    process.stderr.write(`Warning (${phase}): ${warning}\n`);
  }
  if (decision.blockers.length > 0) {
    throw new Error(
      `Observable Git state blocked ${phase}:\n- ${decision.blockers.join("\n- ")}`,
    );
  }
}
