import { mkdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { hasMergeInProgress, inspectGit, isClean } from "./git.js";
import { isNodeError, runtimePaths, writeJsonAtomic } from "./runtime.js";
import type { LockMetadata } from "./types.js";

export interface LockHandle {
  path: string;
  metadata: LockMetadata;
}

export async function acquireRepoLock(
  repositoryId: string,
  sessionId: string,
  waitSeconds: number,
  integrationWorktree: string,
  rejectExisting = false,
): Promise<LockHandle> {
  const lockPath = join(runtimePaths().locks, `${repositoryId}.lock`);
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let announcedOwner = "";

  for (;;) {
    try {
      await mkdir(lockPath);
      const acquiredAt = new Date().toISOString();
      const metadata: LockMetadata = {
        pid: process.pid,
        hostname: hostname(),
        sessionId,
        acquiredAt,
        startedAt: acquiredAt,
      };
      await writeJsonAtomic(join(lockPath, "owner.json"), metadata);
      return { path: lockPath, metadata };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    if (rejectExisting) {
      throw new Error(
        `Cannot change repository enablement while its integration lock exists: ${lockPath}. Retry after integration finishes; inspect stale or unknown locks manually.`,
      );
    }
    const owner = await readLockMetadata(lockPath);
    const ownerDescription = owner
      ? `${owner.sessionId} (pid ${owner.pid} on ${owner.hostname}, since ${owner.acquiredAt})`
      : "unknown owner (metadata missing or invalid)";
    if (ownerDescription !== announcedOwner) {
      process.stdout.write(
        `Repository lock is owned by ${ownerDescription}; waiting...\n`,
      );
      announcedOwner = ownerDescription;
    }

    if (owner && owner.hostname === hostname() && !isProcessAlive(owner.pid)) {
      const recovery = await inspectStaleLock(integrationWorktree);
      if (!recovery.safe) {
        throw new Error(
          `Stale lock for ${owner.sessionId} has a dead PID, but it was not removed: ${recovery.reason}. ` +
            `Inspect ${integrationWorktree} and ${lockPath} manually.`,
        );
      }
      process.stdout.write(
        `Removing verified stale lock for dead pid ${owner.pid}; integration worktree is clean.\n`,
      );
      await rm(lockPath, { recursive: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for repository lock ${lockPath}; owner: ${ownerDescription}`,
      );
    }
    await delay(Math.min(500, Math.max(25, deadline - Date.now())));
  }
}

export async function releaseRepoLock(handle: LockHandle): Promise<void> {
  const current = await readLockMetadata(handle.path);
  if (
    !current ||
    current.pid !== process.pid ||
    current.sessionId !== handle.metadata.sessionId
  ) {
    throw new Error(
      `Refusing to release lock no longer owned by this process: ${handle.path}`,
    );
  }
  await rm(handle.path, { recursive: true });
}

export async function readLockMetadata(
  lockPath: string,
): Promise<LockMetadata | null> {
  try {
    return JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as LockMetadata;
  } catch {
    return null;
  }
}

async function inspectStaleLock(
  worktree: string,
): Promise<{ safe: boolean; reason: string }> {
  try {
    await inspectGit(worktree);
    if (await hasMergeInProgress(worktree))
      return { safe: false, reason: "an unfinished Git merge exists" };
    if (!(await isClean(worktree)))
      return { safe: false, reason: "the integration worktree is dirty" };
    return { safe: true, reason: "clean" };
  } catch {
    return { safe: true, reason: "integration worktree does not exist yet" };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
