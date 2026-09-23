import {
  ExecutionOperationError,
  MissingWorkingDirectoryError,
} from "./execution-error.js";
import { worktreePaths } from "./worktree-location.js";
import { coordinatorDescription } from "./coordinator.js";
import { isRepositoryDisabled, repositoryCommonDir } from "./enablement.js";
import { writeCompletionSummary } from "./completion.js";
import { currentTask, taskProgress, taskLines } from "./tasks.js";
import { stripVTControlCharacters } from "node:util";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readLockMetadata } from "./lock.js";
import { targetBranch, targetBranchSource } from "./promotion.js";
import { pullRequestPromotion } from "./pull-request.js";
import {
  readConfig,
  readSession,
  readSessions,
  runtimePaths,
} from "./runtime.js";

export async function statusCommand(sessionId?: string): Promise<void> {
  const paths = runtimePaths();
  const [allSessions, config] = await Promise.all([
    readSessions(),
    readConfig(),
  ]);
  const selected = sessionId ? await readSession(sessionId) : undefined;
  if (sessionId && !selected) throw new Error(`Unknown session: ${sessionId}`);
  const sessions = selected ? [selected] : allSessions;
  process.stdout.write(`Runtime: ${paths.root}\n`);
  let currentCommonDir: string | undefined;
  try {
    currentCommonDir = await repositoryCommonDir(process.cwd());
  } catch (error) {
    // Only the expected non-repository case is optional; execution failures
    // must still reach capability reporting.
    if (
      !(error instanceof Error) ||
      !error.message.includes("not a git repository")
    )
      throw error;
  }
  if (currentCommonDir) {
    const registered = config.repositories.some(
      (repo) => repo.gitCommonDir === currentCommonDir,
    );
    process.stdout.write(
      `Current repository: ${currentCommonDir}\nRegistration: ${registered ? "registered" : "unregistered"}\nEnablement: ${isRepositoryDisabled(config, currentCommonDir) ? "disabled (run seshx enable to re-enable)" : "enabled"}\n`,
    );
  }
  for (const commonDir of config.disabledRepositories ?? [])
    process.stdout.write(
      `Disabled repository: ${commonDir} (run seshx enable from that repository)\n`,
    );
  process.stdout.write(`Repositories: ${config.repositories.length}\n`);
  for (const repository of config.repositories) {
    const remote = pullRequestPromotion(repository);
    process.stdout.write(
      `  ${repository.path} [registered, ${isRepositoryDisabled(config, repository.gitCommonDir) ? "disabled" : "enabled"}]: staging ${repository.integrationBranch} -> target ${targetBranch(repository)} (${targetBranchSource(repository)})${remote ? ` -> PR (${remote.mode}) to ${remote.productionBranch} via ${remote.remote}` : ""}\n`,
    );
  }
  process.stdout.write(`Sessions: ${sessions.length}\n`);
  if (sessions.length === 0) process.stdout.write("  (none)\n");
  for (const session of sessions) {
    const state = session.waitingForLock
      ? `${session.status} (waiting for lock)`
      : session.status;
    process.stdout.write(`\n${session.id}  ${state}\n`);
    process.stdout.write(
      `  coordinator: ${await coordinatorDescription(session)}\n`,
    );
    if (session.recoveryCoordinator)
      process.stdout.write(
        `  recovery coordinator: ${session.recoveryCoordinator.buildId} ${session.recoveryCoordinator.cliPath}\n`,
      );
    process.stdout.write(`  harness: ${session.harness ?? "codex"}\n`);
    process.stdout.write(`  repo: ${session.repositoryPath}\n`);
    process.stdout.write(`  worktree: ${session.worktreePath}\n`);
    if (session.launchWorktreePath) {
      process.stdout.write(
        `  launch checkout: ${session.launchWorktreePath} (source worktree managed by sesh-integrator)\n`,
      );
    }
    process.stdout.write(`  branch: ${session.branch}\n`);
    for (const line of [
      `tasks: ${taskProgress(session)}`,
      `current task: ${currentTask(session)}`,
      ...(selected ? taskLines(session) : []),
    ])
      process.stdout.write(
        `  ${stripVTControlCharacters(line).replace(/[^\x20-\x7e]/g, "?")}\n`,
      );
    process.stdout.write(`  target branch: ${session.targetBranch ?? "-"}\n`);
    process.stdout.write(`  started: ${session.startedAt}\n`);
    process.stdout.write(
      `  ready: ${session.readyAt ?? "-"} ${session.readyCommit ?? ""}\n`,
    );
    process.stdout.write(
      `  validation: ${session.validationTier ?? "-"} (${session.changedPaths?.length ?? 0} changed path(s))\n`,
    );
    process.stdout.write(
      `  staged/validated: ${session.integratedAt ?? "-"} ${
        session.integratedCommit ?? ""
      }\n`,
    );
    process.stdout.write(
      `  promoted: ${session.promotedAt ?? "-"} ${session.promotedCommit ?? ""}\n`,
    );
    if (session.pullRequestUrl)
      process.stdout.write(`  pull request: ${session.pullRequestUrl}\n`);
    process.stdout.write(
      `  external rollout: ${session.rolloutDisposition ?? "unclassified"}\n`,
    );
    for (const followUp of session.rolloutFollowUps ?? [])
      process.stdout.write(`  rollout follow-up: ${followUp}\n`);
    if (session.recoveryPhase)
      process.stdout.write(`  recovery phase: ${session.recoveryPhase}\n`);
    let integrationWorktree = session.integrationWorktreePath;
    if (!integrationWorktree) {
      try {
        integrationWorktree = join(
          (await worktreePaths(session.repositoryPath)).worktrees,
          session.repositoryId,
        );
      } catch (error) {
        if (error instanceof MissingWorkingDirectoryError) {
          process.stderr.write(
            `Warning: session ${session.id}: ${error.message}; session record preserved.\n`,
          );
        } else {
          const repository = config.repositories.find(
            (repo) => repo.path === session.repositoryPath,
          );
          throw new ExecutionOperationError(
            "inspect session worktree location",
            session.repositoryPath,
            error,
            repository?.gitCommonDir,
          );
        }
      }
    }
    process.stdout.write(
      `  integration worktree: ${integrationWorktree ?? "unavailable (historical checkout missing)"}\n`,
    );
    process.stdout.write(
      `  recovery bundle: ${session.recoveryBundle ? `${session.recoveryBundle.state} ${session.recoveryBundle.path} (${session.recoveryBundle.manifestHash})` : "legacy/not yet created"}\n`,
    );
    if (session.latestError)
      process.stdout.write(`  latest error: ${session.latestError}\n`);
    if (session.latestIncidentId)
      process.stdout.write(`  incident ticket: ${session.latestIncidentId}\n`);
    if (session.validationFailure) {
      const failure = session.validationFailure;
      process.stdout.write(
        `  validation failure: ${failure.classification}, attempt ${failure.attempts}/${failure.maxAttempts}${failure.exhausted ? " (exhausted; resumable)" : ""}\n`,
      );
      process.stdout.write(
        `  validation command: ${failure.command.join(" ")}\n`,
      );
    }
    if (selected && (session.readyCommit || session.status === "no_changes"))
      writeCompletionSummary(session);
    if (session.awaitingConflictResolution) {
      process.stdout.write(
        `  resumable conflict: yes (run seshx resume after resolving and staging)\n`,
      );
      if (session.conflictPromptPath)
        process.stdout.write(
          `  conflict prompt: ${session.conflictPromptPath}\n`,
        );
    }
  }
  process.stdout.write("\nLocks:\n");
  let lockNames: string[] = [];
  try {
    lockNames = (await readdir(paths.locks)).filter((name) =>
      name.endsWith(".lock"),
    );
  } catch {
    // ensureRuntime in readSessions normally creates it.
  }
  if (lockNames.length === 0) process.stdout.write("  (none)\n");
  for (const name of lockNames) {
    const path = join(paths.locks, name);
    const owner = await readLockMetadata(path);
    process.stdout.write(
      owner
        ? `  ${name}: ${owner.sessionId}, pid ${owner.pid} on ${owner.hostname}, since ${owner.acquiredAt}\n`
        : `  ${name}: owner metadata missing or unreadable; inspect conservatively\n`,
    );
  }
}
