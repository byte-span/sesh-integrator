import { writeCompletionSummary } from "./completion.js";
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
  process.stdout.write(`Repositories: ${config.repositories.length}\n`);
  for (const repository of config.repositories) {
    const remote = pullRequestPromotion(repository);
    process.stdout.write(
      `  ${repository.path}: staging ${repository.integrationBranch} -> target ${targetBranch(repository)} (${targetBranchSource(repository)})${remote ? ` -> PR (${remote.mode}) to ${remote.productionBranch} via ${remote.remote}` : ""}\n`,
    );
  }
  process.stdout.write(`Sessions: ${sessions.length}\n`);
  if (sessions.length === 0) process.stdout.write("  (none)\n");
  for (const session of sessions) {
    const state = session.waitingForLock
      ? `${session.status} (waiting for lock)`
      : session.status;
    process.stdout.write(`\n${session.id}  ${state}\n`);
    process.stdout.write(`  repo: ${session.repositoryPath}\n`);
    process.stdout.write(`  worktree: ${session.worktreePath}\n`);
    if (session.launchWorktreePath) {
      process.stdout.write(
        `  launch checkout: ${session.launchWorktreePath} (source worktree managed by parallel-integrator)\n`,
      );
    }
    process.stdout.write(`  branch: ${session.branch}\n`);
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
    process.stdout.write(
      `  integration worktree: ${session.integrationWorktreePath ?? join(paths.worktrees, session.repositoryId)}\n`,
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
    if (selected && session.readyCommit) writeCompletionSummary(session);
    if (session.awaitingConflictResolution) {
      process.stdout.write(
        `  resumable conflict: yes (run parallel-integrator resume after resolving and staging)\n`,
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
