import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readLockMetadata } from "./lock.js";
import { readSessions, runtimePaths } from "./runtime.js";

export async function statusCommand(): Promise<void> {
  const paths = runtimePaths();
  const sessions = await readSessions();
  process.stdout.write(`Runtime: ${paths.root}\n`);
  process.stdout.write(`Sessions: ${sessions.length}\n`);
  if (sessions.length === 0) process.stdout.write("  (none)\n");
  for (const session of sessions) {
    const state = session.waitingForLock
      ? `${session.status} (waiting for lock)`
      : session.status;
    process.stdout.write(`\n${session.id}  ${state}\n`);
    process.stdout.write(`  repo: ${session.repositoryPath}\n`);
    process.stdout.write(`  worktree: ${session.worktreePath}\n`);
    process.stdout.write(`  branch: ${session.branch}\n`);
    process.stdout.write(`  started: ${session.startedAt}\n`);
    process.stdout.write(
      `  ready: ${session.readyAt ?? "-"} ${session.readyCommit ?? ""}\n`,
    );
    process.stdout.write(
      `  validation: ${session.validationTier ?? "-"} (${session.changedPaths?.length ?? 0} changed path(s))\n`,
    );
    process.stdout.write(
      `  integrated: ${session.integratedAt ?? "-"} ${
        session.integratedCommit ?? ""
      }\n`,
    );
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
