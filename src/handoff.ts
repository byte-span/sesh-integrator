import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { detectAutoConfig } from "./auto-config.js";
import {
  recordValidationCache,
  runSetupWithCache,
  validationCacheFor,
} from "./cache.js";
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
import { run, runCommandList, runValidation } from "./process.js";
import {
  DEFAULT_INTEGRATION_BRANCH,
  applyGlobalTargetPolicy,
  ensureRuntime,
  findLatestSessionForWorktree,
  makeSessionId,
  prepareCodexResolverHome,
  readConfig,
  readRepositorySessionIndex,
  readSession,
  readSessions,
  repoId,
  runtimePaths,
  writeConfig,
  writeLog,
  writeSession,
} from "./runtime.js";
import {
  bindPerformanceSession,
  measurePhase,
  recordPerformanceMetric,
} from "./performance.js";
import type {
  Command,
  Config,
  GitPathObservation,
  RepositoryConfig,
  Session,
  SessionIndexEntry,
} from "./types.js";
import { selectValidation, type SelectedValidation } from "./validation.js";
import {
  assessBeginBaseline,
  assessCompletionState,
  type HandoffStateDecision,
} from "./source-state.js";
import { preflightCommitSigning } from "./signing.js";
import {
  ensureGlobalTargetBranch,
  promoteValidatedCommit,
  PromotionBlockedError,
  targetBranch,
} from "./promotion.js";
import { promoteByPullRequest } from "./pull-request.js";

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
  const registrationPath = pathArgument ?? process.cwd();
  let context;
  try {
    context = await inspectGit(registrationPath);
  } catch (error) {
    const [inside, head] = await Promise.all([
      run("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: registrationPath,
      }),
      run("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: registrationPath,
      }),
    ]);
    if (
      inside.code === 0 &&
      inside.stdout.trim() === "true" &&
      head.code !== 0
    ) {
      throw new Error(
        "Cannot register a repository with an unborn default branch; create its initial commit first",
      );
    }
    throw error;
  }
  const config = await readConfig();
  const existing = config.repositories.find(
    (repo) => repo.gitCommonDir === context.gitCommonDir,
  );
  if (existing) {
    await ensureGlobalTargetBranch(existing);
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
    promotion: { type: "none" },
    conflictInstructions: "",
  };
  applyGlobalTargetPolicy(config, repository);
  await ensureGlobalTargetBranch(repository);
  if (autoConfig) await autoConfigureRepository(repository);
  config.repositories.push(repository);
  await writeConfig(config);
  process.stdout.write(`Registered ${repository.path}\n`);
  process.stdout.write(`Integration branch: ${repository.integrationBranch}\n`);
  process.stdout.write(`Target branch: ${targetBranch(repository)}\n`);
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
      if (key === "setupCommands") {
        repository.setupCommands = detected.setupCommands;
      } else if (key === "sourceValidationCommands") {
        repository.sourceValidationCommands = detected.sourceValidationCommands;
      } else if (key === "integrationValidationCommands") {
        repository.integrationValidationCommands =
          detected.integrationValidationCommands;
      } else {
        repository.postIntegrationCommands = detected.postIntegrationCommands;
      }
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
  createWorktree = false,
): Promise<Session> {
  if (!summary.trim()) throw new Error('begin requires --summary "..."');
  if (createWorktree && !autoBranch) {
    throw new Error(
      "--create-worktree cannot be combined with --no-auto-branch",
    );
  }
  const launchContext = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, launchContext.gitCommonDir);
  await ensureGlobalTargetBranch(repository);
  if (launchContext.branch === repository.integrationBranch) {
    throw new Error(
      `Cannot begin on integration branch ${launchContext.branch}`,
    );
  }
  const activeStatuses: Session["status"][] = [
    "active",
    "ready",
    "promotion_pending",
    "needs_review",
  ];
  const duplicate = await findLatestSessionForWorktree(
    launchContext.worktreePath,
    activeStatuses,
  );
  if (duplicate)
    throw new Error(
      `Checkout already has handoff session ${duplicate.id}; continue from ${duplicate.worktreePath}`,
    );
  for (const dependency of dependsOn) {
    if (!(await readSession(dependency))) {
      throw new Error(`Unknown dependency session: ${dependency}`);
    }
  }
  const sessionId = makeSessionId();
  let context = launchContext;
  let managedSourceWorktree = false;
  let branch = context.branch;
  if (createWorktree && !launchContext.linkedWorktree) {
    const paths = await ensureRuntime();
    const worktree = join(
      paths.sourceWorktrees,
      repoId(repository.gitCommonDir),
      sessionId,
    );
    branch = `codex/${sessionId.replaceAll("_", "-")}`;
    const effectiveTarget = targetBranch(repository);
    const sourceBase = await refCommit(
      repository.path,
      `refs/heads/${effectiveTarget}`,
    );
    if (!sourceBase) {
      throw new Error(`Target branch not found: ${effectiveTarget}`);
    }
    await mkdir(dirname(worktree), { recursive: true });
    await git(
      ["worktree", "add", "-b", branch, worktree, sourceBase],
      launchContext.worktreePath,
    );
    context = await inspectGit(worktree);
    managedSourceWorktree = true;
    process.stdout.write(`Created source worktree ${context.worktreePath}\n`);
  } else if (createWorktree) {
    process.stdout.write(
      `Using existing linked source worktree ${context.worktreePath}\n`,
    );
  }
  try {
    const baseline = await measurePhase("source_baseline", async () =>
      observeGitState(context.worktreePath),
    );
    reportStateDecision("begin", assessBeginBaseline(baseline));
    try {
      const setup = await measurePhase("setup", async () =>
        runSetupWithCache(repository, context.worktreePath),
      );
      recordPerformanceMetric("setupCacheHit", setup.cacheHit);
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
    reportStateDecision(
      "setup",
      assessCompletionState(baseline, afterSetup, []),
    );
    const effectiveTarget = targetBranch(repository);
    if (
      !branch ||
      branch === repository.defaultBranch ||
      branch === effectiveTarget
    ) {
      if (!autoBranch) {
        if (!branch) throw new Error("Cannot begin on a detached HEAD");
        throw new Error(
          `Cannot begin on ${branch === effectiveTarget ? "target" : "default"} branch ${branch}`,
        );
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
      ...(context.worktreePath !== launchContext.worktreePath
        ? {
            launchWorktreePath: launchContext.worktreePath,
            managedSourceWorktree: true,
          }
        : {}),
      branch,
      startCommit: context.head,
      integrationCommitAtStart,
      startedAt: new Date().toISOString(),
      taskSummary: summary.trim(),
      dependsOn: [...new Set(dependsOn)],
      gitBaseline: baseline,
    };
    await writeSession(session);
    bindPerformanceSession(session.id);
    process.stdout.write(`Started ${session.id}\n`);
    process.stdout.write(`Base commit: ${session.startCommit}\n`);
    process.stdout.write(`Continue task in: ${session.worktreePath}\n`);
    return session;
  } catch (error) {
    if (managedSourceWorktree) {
      process.stderr.write(
        `Source worktree preserved after begin failed: ${context.worktreePath}\n`,
      );
    }
    throw error;
  }
}

async function findSessionsLaunchedFrom(
  launchWorktreePath: string,
  statuses: Session["status"][],
): Promise<Session[]> {
  return (await readSessions()).filter(
    (session) =>
      session.launchWorktreePath === launchWorktreePath &&
      statuses.includes(session.status),
  );
}

async function resolveSourceSession(
  statuses: Session["status"][],
  sessionId?: string,
): Promise<{
  source: Awaited<ReturnType<typeof inspectGit>>;
  repository: RepositoryConfig;
  session: Session;
}> {
  const current = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, current.gitCommonDir);
  if (sessionId) {
    const session = await readSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.repositoryId !== repoId(repository.gitCommonDir)) {
      throw new Error(`Session ${sessionId} belongs to a different repository`);
    }
    if (!statuses.includes(session.status)) {
      throw new Error(
        `Session ${sessionId} is ${session.status}; expected ${statuses.join(" or ")}`,
      );
    }
    return {
      source: await inspectGit(session.worktreePath),
      repository,
      session,
    };
  }
  const attached = await findLatestSessionForWorktree(
    current.worktreePath,
    statuses,
  );
  if (attached) return { source: current, repository, session: attached };
  const launched = await findSessionsLaunchedFrom(
    current.worktreePath,
    statuses,
  );
  if (launched.length === 1) {
    return {
      source: await inspectGit(launched[0]!.worktreePath),
      repository,
      session: launched[0]!,
    };
  }
  if (launched.length > 1) {
    throw new Error(
      `Multiple matching sessions were launched from this checkout: ${launched.map((item) => item.id).join(", ")}. Select one with --session <session-id>`,
    );
  }
  throw new Error(
    `No ${statuses.join(" or ")} session exists for this worktree`,
  );
}

export async function commitCommand(
  message: string,
  sessionId?: string,
): Promise<Session> {
  if (!message.trim()) throw new Error('commit requires --message "..."');
  const { source, repository, session } = await resolveSourceSession(
    ["active"],
    sessionId,
  );
  bindPerformanceSession(session.id);
  if (source.branch !== session.branch) {
    throw new Error(
      `Source branch changed since begin (expected ${session.branch}, found ${source.branch ?? "detached"})`,
    );
  }
  if (!session.gitBaseline) {
    throw new Error(
      "Session predates observable Git baselines; begin a new handoff session before committing",
    );
  }

  const stagedOutput = await git(
    ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB"],
    source.worktreePath,
  );
  const stagedPaths = stagedOutput.split("\n").filter(Boolean);
  if (stagedPaths.length === 0) {
    throw new Error(
      "No staged task changes. Stage only the intended task paths before running codex-handoff commit",
    );
  }
  for (const path of stagedPaths) {
    const unstaged = await run("git", ["diff", "--quiet", "--", path], {
      cwd: source.worktreePath,
    });
    if (unstaged.code === 1) {
      throw new Error(
        `${path}: staged task path also has unstaged changes; make the source commit snapshot explicit first`,
      );
    }
    if (unstaged.code !== 0) {
      throw new Error(`${path}: could not determine unstaged state`);
    }
  }
  const current = await observeGitState(source.worktreePath);
  const staged = new Set(stagedPaths);
  reportStateDecision(
    "source commit",
    assessCompletionState(
      session.gitBaseline,
      {
        ...current,
        paths: current.paths.filter((path) => !staged.has(path.path)),
      },
      stagedPaths,
    ),
  );

  await preflightCommitSigning(
    repository,
    source.worktreePath,
    "source commit",
  );
  await git(
    withGpgProgram(repository.gpgProgram, ["commit", "-m", message.trim()]),
    source.worktreePath,
  );
  const committed = await inspectGit(source.worktreePath);
  process.stdout.write(`Committed ${session.id} source at ${committed.head}\n`);
  return session;
}

export async function integrateCommand(
  summary: string,
  sessionId?: string,
): Promise<Session> {
  if (!summary.trim()) throw new Error('integrate requires --summary "..."');
  const config = await readConfig();
  const { source, repository, session } = await resolveSourceSession(
    ["active", "ready"],
    sessionId,
  );
  bindPerformanceSession(session.id);
  if (!source.branch || source.branch !== session.branch) {
    throw new Error(
      `Source branch changed since begin (expected ${session.branch}, found ${
        source.branch ?? "detached"
      })`,
    );
  }

  const committedPaths = await measurePhase("source_state", async () =>
    changedPaths(source.worktreePath, session.startCommit, source.head),
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
  recordPerformanceMetric("validationTier", validation.name);
  recordPerformanceMetric("changedPathCount", validation.changedPaths.length);
  session.validationTier = validation.name;
  session.changedPaths = validation.changedPaths;
  await writeSession(session);
  process.stdout.write(
    `Validation tier: ${validation.name} (${validation.changedPaths.length} changed path(s))\n`,
  );

  await assertDependencies(session);
  let integrationWorktree = join(
    runtimePaths().worktrees,
    session.repositoryId,
  );
  session.waitingForLock = true;
  await writeSession(session);
  let lock: LockHandle | undefined;
  let integrationStarted = false;
  try {
    lock = await measurePhase("lock_wait", async () =>
      acquireRepoLock(
        session.repositoryId,
        session.id,
        config.lockWaitSeconds,
        integrationWorktree,
      ),
    );
    session.waitingForLock = false;
    await writeSession(session);
    await assertDependencies(session);
    await measurePhase("target_baseline", async () =>
      captureTargetExpectation(repository, session),
    );
    integrationWorktree = await selectIntegrationWorktree(
      repository,
      session,
      integrationWorktree,
    );
    if (
      await measurePhase("direct_integration", async () =>
        tryDirectIntegration(
          repository,
          session,
          validation,
          integrationWorktree,
        ),
      )
    ) {
      process.stdout.write(
        `Promoted ${session.id} directly to ${session.targetBranch} at ${session.promotedCommit}\n`,
      );
      writeCompletionSummary(session);
      return session;
    }
    await measurePhase("worktree_preparation", async () =>
      prepareIntegrationWorktree(repository, session, integrationWorktree),
    );
    integrationStarted = true;
    await mergeAndValidate(config, repository, session, integrationWorktree);
    process.stdout.write(
      `Promoted ${session.id} to ${session.targetBranch} at ${session.promotedCommit}\n`,
    );
    writeCompletionSummary(session);
    return session;
  } catch (error) {
    session.waitingForLock = false;
    session.latestError = errorMessage(error);
    if (
      (integrationStarted || session.recoveryPhase === "pull_request") &&
      session.status !== "promotion_pending"
    ) {
      session.status = "needs_review";
    }
    await writeSession(session);
    throw error;
  } finally {
    if (lock) await releaseRepoLock(lock);
  }
}

export async function validateCommand(sessionId?: string): Promise<Session> {
  const { source, repository, session } = await resolveSourceSession(
    ["active"],
    sessionId,
  );
  bindPerformanceSession(session.id);
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
  recordPerformanceMetric("validationTier", validation.name);
  recordPerformanceMetric("changedPathCount", paths.length);
  const tree = await git(
    ["rev-parse", `${source.head}^{tree}`],
    source.worktreePath,
  );
  const cachedFingerprints = await validationCacheFor(
    repository,
    session,
    tree,
    validation.sourceCommands,
  );
  const successfulCommands: Command[] = [];
  const validationResult = await measurePhase("source_validation", async () =>
    runValidation(validation.sourceCommands, source.worktreePath, {
      cachedFingerprints,
      onCommandSuccess: async (command) => {
        successfulCommands.push(command);
      },
    }),
  );
  await assertSourceHandoffState(
    session,
    source.worktreePath,
    paths,
    "source validation",
  );
  for (const command of successfulCommands) {
    await recordValidationCache(repository, session, tree, command);
  }
  recordPerformanceMetric("validationCacheHits", validationResult.cacheHits);
  recordPerformanceMetric("validationCommandsRun", validationResult.executed);
  session.validationTier = validation.name;
  session.changedPaths = paths;
  session.sourceValidatedAt = new Date().toISOString();
  session.sourceValidatedCommit = source.head;
  session.sourceValidatedTree = tree;
  await writeSession(session);
  process.stdout.write(`Validated ${session.id} at ${source.head}\n`);
  return session;
}

export async function resumeCommand(sessionId?: string): Promise<Session> {
  const current = await inspectGit(process.cwd());
  const config = await readConfig();
  const repository = findRepository(config, current.gitCommonDir);
  let session = sessionId
    ? await readSession(sessionId)
    : await findLatestSessionForWorktree(current.worktreePath, [
        "needs_review",
        "promotion_pending",
      ]);
  if (sessionId && !session) throw new Error(`Unknown session: ${sessionId}`);
  if (session && session.repositoryId !== repoId(repository.gitCommonDir))
    throw new Error(`Session ${session.id} belongs to a different repository`);
  if (
    sessionId &&
    session &&
    !["needs_review", "promotion_pending", "active", "ready"].includes(
      session.status,
    )
  ) {
    throw new Error(
      `Session ${session.id} is not resumable (${session.status})`,
    );
  }
  if (!session && !sessionId) {
    const launched = await findSessionsLaunchedFrom(current.worktreePath, [
      "needs_review",
      "promotion_pending",
    ]);
    if (launched.length > 1)
      throw new Error(
        `Multiple resumable sessions were launched from this checkout: ${launched.map((item) => item.id).join(", ")}. Select one with --session <session-id>`,
      );
    session = launched[0];
  }
  const source = session ? await inspectGit(session.worktreePath) : current;
  if (
    !session ||
    !["needs_review", "promotion_pending"].includes(session.status)
  ) {
    const orphaned =
      session ??
      (await findLatestSessionForWorktree(source.worktreePath, [
        "active",
        "ready",
      ]));
    if (orphaned) {
      const integrationWorktree = join(
        runtimePaths().worktrees,
        orphaned.repositoryId,
      );
      if (await pathExists(integrationWorktree)) {
        const context = await inspectGit(integrationWorktree);
        const mergeHead = await run("git", ["rev-parse", "MERGE_HEAD"], {
          cwd: integrationWorktree,
        });
        if (
          context.gitCommonDir === repository.gitCommonDir &&
          context.branch === repository.integrationBranch &&
          mergeHead.code === 0 &&
          mergeHead.stdout.trim() === source.head
        ) {
          orphaned.status = "needs_review";
          orphaned.readyCommit = source.head;
          orphaned.readyAt ??= new Date().toISOString();
          orphaned.completionSummary ??= orphaned.taskSummary;
          orphaned.targetBranch ??= targetBranch(repository);
          orphaned.conflictIntegrationHead = context.head;
          orphaned.awaitingConflictResolution = true;
          orphaned.latestError =
            "Recovered a preserved integration merge after interrupted session-state persistence";
          await writeSession(orphaned);
          session = orphaned;
          process.stderr.write(
            `Recovered resumable merge state for ${orphaned.id} from ${integrationWorktree}.\n`,
          );
        }
      }
    }
  }
  if (!session) {
    throw new Error("No resumable integration exists for this worktree");
  }
  if (!["needs_review", "promotion_pending"].includes(session.status)) {
    throw new Error(`Session ${session.id} has no resumable integration state`);
  }
  bindPerformanceSession(session.id);
  if (!session.readyCommit) {
    throw new Error("Resumable session is missing its ready commit");
  }
  if (source.branch !== session.branch) {
    throw new Error(
      `Source snapshot changed; expected ${session.branch} at ${session.readyCommit}`,
    );
  }
  const readyIsAncestor =
    source.head === session.readyCommit ||
    (
      await run(
        "git",
        ["merge-base", "--is-ancestor", session.readyCommit!, source.head],
        { cwd: source.worktreePath },
      )
    ).code === 0;
  if (!readyIsAncestor) {
    throw new Error(
      `Source snapshot diverged; expected ${session.branch} to contain ${session.readyCommit}`,
    );
  }
  if (source.head !== session.readyCommit) {
    process.stderr.write(
      `Warning (resume): source branch advanced after ${session.readyCommit}; retrying only the preserved ready commit\n`,
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

  const integrationWorktree =
    session.integrationWorktreePath ??
    join(runtimePaths().worktrees, session.repositoryId);
  session.waitingForLock = true;
  await writeSession(session);
  let lock: LockHandle | undefined;
  try {
    lock = await measurePhase("lock_wait", async () =>
      acquireRepoLock(
        session.repositoryId,
        session.id,
        config.lockWaitSeconds,
        integrationWorktree,
      ),
    );
    session.waitingForLock = false;
    await writeSession(session);
    await assertDependencies(session);
    if (session.recoveryPhase === "pull_request") {
      await completePullRequestPromotion(repository, session);
    } else if (session.recoveryPhase === "remote_promotion") {
      await resumeRemotePromotion(repository, session, integrationWorktree);
    } else if (
      session.recoveryPhase === "promotion" ||
      session.recoveryPhase === "post_integration"
    ) {
      await runPostIntegrationAndPromote(
        repository,
        session,
        integrationWorktree,
      );
    } else if (session.awaitingConflictResolution) {
      await assertResumableConflict(repository, session, integrationWorktree);
      await validateCommitAndFinish(repository, session, integrationWorktree);
    } else {
      await assertResumableCommitFailure(
        repository,
        session,
        integrationWorktree,
      );
      await validateCommitAndFinish(repository, session, integrationWorktree);
    }
    process.stdout.write(
      `Promoted ${session.id} to ${session.targetBranch} at ${session.promotedCommit}\n`,
    );
    writeCompletionSummary(session);
    return session;
  } catch (error) {
    session.waitingForLock = false;
    if (session.status !== "promotion_pending") session.status = "needs_review";
    session.latestError = errorMessage(error);
    await writeSession(session);
    throw error;
  } finally {
    if (lock) await releaseRepoLock(lock);
  }
}

async function selectIntegrationWorktree(
  repository: RepositoryConfig,
  session: Session,
  canonicalPath: string,
): Promise<string> {
  if (session.integrationWorktreePath) return session.integrationWorktreePath;
  if (await pathExists(canonicalPath)) {
    const context = await inspectGit(canonicalPath);
    if (
      context.gitCommonDir === repository.gitCommonDir &&
      context.branch === repository.integrationBranch &&
      ((await hasMergeInProgress(canonicalPath)) ||
        !(await isClean(canonicalPath)))
    ) {
      const isolatedPath = join(
        runtimePaths().worktrees,
        `${session.repositoryId}-${session.id}`,
      );
      session.integrationWorktreePath = isolatedPath;
      session.integrationWorktreeDetached = true;
      await writeSession(session);
      process.stdout.write(
        `Shared integration worktree contains preserved review state; using isolated worktree ${isolatedPath}\n`,
      );
      return isolatedPath;
    }
  }
  session.integrationWorktreePath = canonicalPath;
  session.integrationWorktreeDetached = false;
  await writeSession(session);
  return canonicalPath;
}

async function prepareIntegrationWorktree(
  repository: RepositoryConfig,
  session: Session,
  path: string,
): Promise<void> {
  if (await pathExists(path)) {
    const context = await inspectGit(path);
    if (context.gitCommonDir !== repository.gitCommonDir) {
      throw new Error(
        `Integration worktree belongs to a different repository: ${path}`,
      );
    }
    if (
      context.branch !== repository.integrationBranch &&
      !(session.integrationWorktreeDetached && context.branch === null)
    ) {
      throw new Error(
        `Integration worktree is on ${
          context.branch ?? "detached HEAD"
        }, expected ${session.integrationWorktreeDetached ? "a detached integration checkout" : repository.integrationBranch}`,
      );
    }
    if (await hasMergeInProgress(path)) {
      throw new Error(
        `Integration worktree is not clean; inspect and recover it manually: ${path}`,
      );
    }
    await assertIntegrationWorktreeReady(session, path);
    await alignIntegrationBranchWithTarget(repository, session, path);
    return;
  }
  const branchRef = `refs/heads/${repository.integrationBranch}`;
  const existing = await refCommit(repository.path, branchRef);
  if (session.integrationWorktreeDetached) {
    const base = existing ?? session.targetCommitBeforeIntegration;
    if (!base) throw new Error("Session is missing an integration baseline");
    await git(["worktree", "add", "--detach", path, base], repository.path);
    session.conflictIntegrationHead = base;
    await writeSession(session);
    await assertIntegrationWorktreeReady(session, path);
    return;
  }
  if (existing) {
    await git(
      ["worktree", "add", path, repository.integrationBranch],
      repository.path,
    );
  } else {
    const targetCommit = session.targetCommitBeforeIntegration;
    if (!targetCommit)
      throw new Error("Session is missing target baseline metadata");
    await git(
      [
        "worktree",
        "add",
        "-b",
        repository.integrationBranch,
        path,
        targetCommit,
      ],
      repository.path,
    );
  }
  await assertIntegrationWorktreeReady(session, path);
  await alignIntegrationBranchWithTarget(repository, session, path);
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
  const merge = await measurePhase("merge", async () =>
    run("git", ["merge", "--no-ff", "--no-commit", session.readyCommit!], {
      cwd: worktree,
    }),
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
  if (
    context.branch !== repository.integrationBranch &&
    !(session.integrationWorktreeDetached && context.branch === null)
  ) {
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

async function assertResumableCommitFailure(
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
  if (
    context.branch !== repository.integrationBranch &&
    !(session.integrationWorktreeDetached && context.branch === null)
  ) {
    throw new Error(
      `Integration worktree is on ${context.branch ?? "detached HEAD"}, expected ${repository.integrationBranch}`,
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
      `Preserved non-conflict retry unexpectedly has unresolved files: ${remaining.join(", ")}`,
    );
  }
  const expected = await run(
    "git",
    ["merge-tree", "--write-tree", context.head, session.readyCommit],
    { cwd: worktree },
  );
  const expectedTree = expected.stdout.split("\n", 1)[0]?.trim();
  if (expected.code !== 0 || !expectedTree) {
    throw new Error("Could not reconstruct the preserved clean merge tree");
  }
  const stagedTree = await git(["write-tree"], worktree);
  if (stagedTree !== expectedTree) {
    throw new Error(
      "Preserved integration index changed after the non-conflict failure; refusing automatic retry",
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
  const setup = await measurePhase("integration_setup", async () =>
    runSetupWithCache(repository, worktree),
  );
  recordPerformanceMetric("integrationSetupCacheHit", setup.cacheHit);
  const tree = await git(["write-tree"], worktree);
  const cachedFingerprints = await validationCacheFor(
    repository,
    session,
    tree,
    validation.integrationCommands,
  );
  const successfulCommands: Command[] = [];
  const result = await measurePhase("integration_validation", async () =>
    runValidation(validation.integrationCommands, worktree, {
      cachedFingerprints,
      onCommandSuccess: async (command) => {
        successfulCommands.push(command);
      },
    }),
  );
  await assertNoUnstagedChanges(session, worktree);
  for (const command of successfulCommands) {
    await recordValidationCache(repository, session, tree, command);
  }
  recordPerformanceMetric("integrationValidationCacheHits", result.cacheHits);
  recordPerformanceMetric("integrationValidationCommandsRun", result.executed);
  const integrationBranchAdvanced = await hasMergeInProgress(worktree);
  if (integrationBranchAdvanced) {
    await measurePhase("integration_commit", async () => {
      await preflightCommitSigning(repository, worktree, "integration commit");
      await git(
        withGpgProgram(repository.gpgProgram, [
          "commit",
          "-m",
          `Integrate ${session.id}: ${session.taskSummary}`,
        ]),
        worktree,
      );
    });
  } else {
    process.stdout.write(
      `Ready commit was already present on the integration branch; no merge commit needed.\n`,
    );
  }
  session.integratedCommit = await git(["rev-parse", "HEAD"], worktree);
  if (session.integrationWorktreeDetached) {
    const expected = session.conflictIntegrationHead;
    if (!expected)
      throw new Error("Detached integration is missing its staging baseline");
    const update = await run(
      "git",
      [
        "update-ref",
        `refs/heads/${repository.integrationBranch}`,
        session.integratedCommit,
        expected,
      ],
      { cwd: repository.path },
    );
    if (update.code !== 0) {
      throw new Error(
        `Integration branch advanced while ${session.id} was pending; its validated commit is preserved at ${session.integratedCommit}. Resume after reconciling the newer staging history.`,
      );
    }
  }
  session.integratedAt = new Date().toISOString();
  session.waitingForLock = false;
  session.awaitingConflictResolution = false;
  await writeSession(session);

  await runPostIntegrationAndPromote(
    repository,
    session,
    worktree,
    integrationBranchAdvanced,
  );
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
  const targetCommit = session.targetCommitBeforeIntegration;
  if (!targetCommit) return false;
  let integrationHead = existingIntegrationHead ?? targetCommit;
  if (existingIntegrationHead && existingIntegrationHead !== targetCommit) {
    const stagingBehindTarget = await run(
      "git",
      ["merge-base", "--is-ancestor", existingIntegrationHead, targetCommit],
      { cwd: repository.path },
    );
    if (stagingBehindTarget.code !== 0) return false;
    integrationHead = targetCommit;
  }
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
    const signCommit = await commitSigningEnabled(repository.path);
    if (signCommit) {
      await preflightCommitSigning(
        repository,
        repository.path,
        "direct integration commit",
      );
    }
    integratedCommit = await git(
      withGpgProgram(repository.gpgProgram, [
        "commit-tree",
        tree,
        "-p",
        integrationHead,
        "-p",
        session.readyCommit,
        ...(signCommit ? ["-S"] : []),
        "-m",
        `Integrate ${session.id}: ${session.taskSummary}`,
      ]),
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
  await runPostIntegrationAndPromote(repository, session, integrationWorktree);
  return true;
}

async function captureTargetExpectation(
  repository: RepositoryConfig,
  session: Session,
): Promise<void> {
  const branch = targetBranch(repository);
  const commit =
    (await refCommit(repository.path, `refs/heads/${branch}`)) ??
    (branch === repository.integrationBranch
      ? await refCommit(
          repository.path,
          `refs/heads/${repository.defaultBranch}`,
        )
      : null);
  if (!commit) throw new Error(`Target branch not found: ${branch}`);
  session.targetBranch = branch;
  session.targetCommitBeforeIntegration = commit;
  await writeSession(session);
}

async function alignIntegrationBranchWithTarget(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  const target = session.targetCommitBeforeIntegration;
  if (!target) throw new Error("Session is missing target baseline metadata");
  const staging = await git(["rev-parse", "HEAD"], worktree);
  if (staging === target) return;
  const stagingBehind = await run(
    "git",
    ["merge-base", "--is-ancestor", staging, target],
    { cwd: worktree },
  );
  if (stagingBehind.code === 0) {
    await git(["merge", "--ff-only", "--no-edit", target], worktree);
    return;
  }
  const targetBehind = await run(
    "git",
    ["merge-base", "--is-ancestor", target, staging],
    { cwd: worktree },
  );
  const relation = targetBehind.code === 0 ? "ahead of" : "divergent from";
  throw new Error(
    `Staging branch ${repository.integrationBranch} at ${staging} is ${relation} target ${session.targetBranch} at ${target}. Run codex-handoff reconcile to audit historical integrations before starting new work.`,
  );
}

async function runPostIntegrationAndPromote(
  repository: RepositoryConfig,
  session: Session,
  integrationWorktree: string,
  integrationBranchAdvanced = true,
  includePullRequest = true,
): Promise<void> {
  session.recoveryPhase = "promotion";
  await writeSession(session);
  const targetWorktree = await measurePhase("promotion", async () =>
    completePromotion(
      repository,
      session,
      integrationBranchAdvanced &&
        repository.postIntegrationCommands.length > 0,
    ),
  );
  if (integrationBranchAdvanced) {
    session.recoveryPhase = "post_integration";
    await writeSession(session);
    const commandWorktree =
      targetBranch(repository) === repository.integrationBranch
        ? integrationWorktree
        : targetWorktree;
    if (repository.postIntegrationCommands.length > 0 && !commandWorktree) {
      throw new Error(
        `Target branch ${targetBranch(repository)} has no checked-out worktree for post-integration commands`,
      );
    }
    session.postIntegrationResults = await measurePhase(
      "post_integration",
      async () =>
        runCommandList(
          repository.postIntegrationCommands,
          commandWorktree ?? integrationWorktree,
          "post-integration command",
        ),
    );
    await writeSession(session);
    const failed = session.postIntegrationResults.find(
      (result) => result.exitCode !== 0,
    );
    if (failed) {
      throw new Error(
        `Post-integration check failed after target promotion (${failed.exitCode}): ${failed.command.join(" ")}`,
      );
    }
  } else {
    session.postIntegrationResults = [];
  }
  if (includePullRequest)
    await completePullRequestPromotion(repository, session);
}

async function completePullRequestPromotion(
  repository: RepositoryConfig,
  session: Session,
): Promise<void> {
  session.recoveryPhase = "pull_request";
  await writeSession(session);
  const pullRequestUrl = await measurePhase("pull_request", async () =>
    promoteByPullRequest(repository, session, async (remoteCommit) =>
      recoverMovedRemoteTarget(repository, session, remoteCommit),
    ),
  );
  if (pullRequestUrl) {
    session.pullRequestUrl = pullRequestUrl;
    session.remotePromotedAt = new Date().toISOString();
  }
  session.status = "succeeded";
  delete session.recoveryPhase;
  delete session.latestError;
  await writeSession(session);
}

async function recoverMovedRemoteTarget(
  repository: RepositoryConfig,
  session: Session,
  remoteCommit: string,
): Promise<void> {
  const worktree = join(runtimePaths().worktrees, session.repositoryId);
  if (!(await pathExists(worktree))) {
    await git(
      ["worktree", "add", worktree, repository.integrationBranch],
      repository.path,
    );
  }
  const context = await inspectGit(worktree);
  if (
    context.gitCommonDir !== repository.gitCommonDir ||
    context.branch !== repository.integrationBranch ||
    context.head !== session.integratedCommit ||
    (await hasMergeInProgress(worktree)) ||
    !(await isClean(worktree))
  ) {
    throw new Error(
      `Integration worktree is not in the exact clean validated state ${session.integratedCommit}; refusing remote recovery`,
    );
  }
  session.remoteRecoveryCommit = remoteCommit;
  if (!session.remoteRecoveryBaseline) {
    if (!session.targetCommitBeforeIntegration) {
      throw new Error("Session is missing target baseline metadata");
    }
    session.remoteRecoveryBaseline = session.targetCommitBeforeIntegration;
  }
  session.remoteRecoveryAttempts = (session.remoteRecoveryAttempts ?? 0) + 1;
  session.recoveryPhase = "remote_promotion";
  session.conflictIntegrationHead = context.head;
  session.awaitingConflictResolution = true;
  await writeSession(session);
  const merge = await run(
    "git",
    ["merge", "--no-ff", "--no-commit", remoteCommit],
    { cwd: worktree },
  );
  if (merge.code !== 0) {
    const conflicted = await unmergedFiles(worktree);
    if (conflicted.length === 0) {
      throw new Error(
        `Could not replay validated integration on remote target ${remoteCommit}: ${(merge.stderr || merge.stdout).trim()}`,
      );
    }
    session.status = "needs_review";
    session.latestError =
      `Remote target recovery conflicts with ${remoteCommit}: ${conflicted.join(", ")}. ` +
      `Resolve and stage files in ${worktree}, then run codex-handoff resume from ${session.worktreePath}`;
    await writeSession(session);
    throw new Error(session.latestError);
  }
  await validateRemoteRecoveryAndContinue(repository, session, worktree);
}

async function resumeRemotePromotion(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  const context = await inspectGit(worktree);
  if (
    context.gitCommonDir !== repository.gitCommonDir ||
    context.branch !== repository.integrationBranch ||
    context.head !== session.conflictIntegrationHead ||
    !(await hasMergeInProgress(worktree)) ||
    (await git(["rev-parse", "MERGE_HEAD"], worktree)) !==
      session.remoteRecoveryCommit
  ) {
    throw new Error("Preserved remote target recovery state is ambiguous");
  }
  const remaining = await unmergedFiles(worktree);
  if (remaining.length > 0) {
    throw new Error(
      `Resolve and stage all conflicts before resume: ${remaining.join(", ")}`,
    );
  }
  await validateRemoteRecoveryAndContinue(repository, session, worktree);
  await completePullRequestPromotion(repository, session);
}

async function validateRemoteRecoveryAndContinue(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  // A remote replay can change any part of the combined tree, so always run
  // the repository's full integration validation without session-tier caches.
  await runSetupWithCache(repository, worktree);
  await runValidation(repository.integrationValidationCommands, worktree);
  await assertNoUnstagedChanges(session, worktree);
  await preflightCommitSigning(
    repository,
    worktree,
    "remote recovery integration commit",
  );
  await git(
    withGpgProgram(repository.gpgProgram, [
      "commit",
      "-m",
      `Replay ${session.id} on remote ${session.targetBranch}`,
    ]),
    worktree,
  );
  session.integratedCommit = await git(["rev-parse", "HEAD"], worktree);
  session.integratedAt = new Date().toISOString();
  if (!session.promotedCommit) {
    throw new Error(
      "Remote recovery is missing the previously promoted commit",
    );
  }
  session.targetCommitBeforeIntegration = session.promotedCommit;
  session.awaitingConflictResolution = false;
  delete session.conflictIntegrationHead;
  await writeSession(session);
  await runPostIntegrationAndPromote(
    repository,
    session,
    worktree,
    true,
    false,
  );
}

function writeCompletionSummary(session: Session): void {
  const pullRequest = session.pullRequestUrl ?? "None";
  const manualFollowUp = session.pullRequestUrl
    ? `Review and merge ${session.pullRequestUrl}.`
    : "No manual follow-up required.";
  process.stdout.write(
    `Completion summary:\n` +
      `  Session: ${session.id}\n` +
      `  Source commit: ${session.readyCommit}\n` +
      `  Staging integration commit: ${session.integratedCommit}\n` +
      `  Target promotion: ${session.targetBranch} at ${session.promotedCommit}\n` +
      `  Pull request: ${pullRequest}\n` +
      `  Manual follow-up: ${manualFollowUp}\n`,
  );
}

async function completePromotion(
  repository: RepositoryConfig,
  session: Session,
  requireCheckedOutTarget = false,
): Promise<string | undefined> {
  if (!session.integratedCommit || !session.targetCommitBeforeIntegration) {
    throw new Error(
      "Session is missing validated integration promotion metadata",
    );
  }
  let targetWorktree: string | undefined;
  try {
    targetWorktree = await promoteValidatedCommit(
      repository,
      session.integratedCommit,
      session.targetCommitBeforeIntegration,
      requireCheckedOutTarget,
    );
  } catch (error) {
    if (error instanceof PromotionBlockedError) {
      session.status = "promotion_pending";
      session.recoveryPhase = "promotion";
      session.latestError = error.message;
      await writeSession(session);
    }
    throw error;
  }
  session.promotedCommit = session.integratedCommit;
  session.promotedAt ??= new Date().toISOString();
  delete session.latestError;
  await writeSession(session);
  return targetWorktree;
}

export function withGpgProgram(
  gpgProgram: string | undefined,
  args: string[],
): string[] {
  return gpgProgram ? ["-c", `gpg.program=${gpgProgram}`, ...args] : args;
}

async function commitSigningEnabled(cwd: string): Promise<boolean> {
  const result = await run(
    "git",
    ["config", "--bool", "--get", "commit.gpgSign"],
    { cwd },
  );
  return result.code === 0 && result.stdout.trim() === "true";
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
  const observablyUnstaged =
    path.status?.[0] === " " ||
    path.status?.[0] === "?" ||
    (path.status === null && path.worktreeRaw?.endsWith(" D") === true);
  return (
    !!baseline &&
    path.tracked &&
    !path.accessible &&
    path.indexRaw === null &&
    !session.changedPaths?.includes(path.path) &&
    observablyUnstaged
  );
}

async function assertDependencies(session: Session): Promise<void> {
  for (const dependencyId of session.dependsOn) {
    const dependency = await readSession(dependencyId);
    if (!dependency)
      throw new Error(`Dependency ${dependencyId} does not exist`);
    if (dependency.status === "needs_review") {
      throw new Error(
        `Dependency ${dependencyId} needs review and blocks integration`,
      );
    }
    if (dependency.status !== "succeeded") {
      throw new Error(
        `Dependency ${dependencyId} has not been promoted successfully (status: ${dependency.status})`,
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
  const laterIntegrations = (
    await readRepositorySessionIndex(session.repositoryId)
  ).filter(
    (item) =>
      item.repositoryId === session.repositoryId &&
      item.status === "succeeded" &&
      Boolean(item.promotedAt ?? item.integratedAt) &&
      (item.promotedAt ?? item.integratedAt)! > session.startedAt,
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
    `Successful target promotions after this session began:\n${formatLaterIntegrations(
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

function formatLaterIntegrations(sessions: SessionIndexEntry[]): string {
  if (sessions.length === 0) return "- none";
  return sessions
    .map(
      (item) =>
        `- ${item.id}: started ${item.startedAt}; promoted ${
          item.promotedAt ?? item.integratedAt
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
