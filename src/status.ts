import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readLockMetadata } from "./lock.js";
import { targetBranch } from "./promotion.js";
import { readConfig, readSessions, runtimePaths } from "./runtime.js";

export async function statusCommand(): Promise<void> {
  const paths = runtimePaths();
  const [sessions, config] = await Promise.all([readSessions(), readConfig()]);
  process.stdout.write(`Runtime: ${paths.root}\n`);
  process.stdout.write(`Repositories: ${config.repositories.length}\n`);
  for (const repository of config.repositories) {
    process.stdout.write(
      `  ${repository.path}: staging ${repository.integrationBranch} -> target ${targetBranch(repository)}${repository.targetBranch ? " (override)" : " (defaultBranch)"}\n`,
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
        `  launch checkout: ${session.launchWorktreePath} (source worktree managed by codex-handoff)\n`,
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
    if (session.recoveryPhase)
      process.stdout.write(`  recovery phase: ${session.recoveryPhase}\n`);
    process.stdout.write(
      `  integration worktree: ${join(paths.worktrees, session.repositoryId)}\n`,
    );
    if (session.latestError)
      process.stdout.write(`  latest error: ${session.latestError}\n`);
    if (session.awaitingConflictResolution) {
      process.stdout.write(
        `  resumable conflict: yes (run codex-handoff resume after resolving and staging)\n`,
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
