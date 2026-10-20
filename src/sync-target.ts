import { join } from "node:path";
import { CodedError } from "./delivery-policy.js";
import { withCleanup } from "./file-lock.js";
import {
  hasMergeInProgress,
  inspectGit,
  isClean,
  listWorktrees,
  refCommit,
} from "./git.js";
import { acquireRepoLock, releaseRepoLock } from "./lock.js";
import { run } from "./process.js";
import { targetBranch } from "./promotion.js";
import { repoId } from "./runtime.js";
import type { RepositoryConfig } from "./types.js";
import { worktreePaths } from "./worktree-location.js";

export type TargetSyncResult =
  "fast-forwarded" | "up-to-date" | "local-ahead" | "no-remote-branch";

/** Reported as `sync` by `begin --json`. */
export interface TargetSync {
  /** Remote fetched from; null when it is not configured in the repository. */
  remote: string | null;
  result: TargetSyncResult;
  branch: string;
  /** Local target commit before and after; null when the branch was absent. */
  before: string | null;
  after: string | null;
}

/**
 * `begin --sync-target`: under the repository integration lock, fetch
 * `<remote>/<target>` and move the local target only by fast-forward.
 * Failures (`fetch_failed`, `target_diverged`, `target_dirty`) change nothing.
 */
export async function syncTargetBranch(
  repository: RepositoryConfig,
  remote: string,
  sessionId: string,
  lockWaitSeconds: number,
): Promise<TargetSync> {
  const repositoryId = repoId(repository.gitCommonDir);
  const lock = await acquireRepoLock(
    repositoryId,
    sessionId,
    lockWaitSeconds,
    join((await worktreePaths(repository.path)).worktrees, repositoryId),
  );
  return withCleanup(
    () => syncLocked(repository, remote),
    () => releaseRepoLock(lock),
  );
}

async function syncLocked(
  repository: RepositoryConfig,
  remote: string,
): Promise<TargetSync> {
  const branch = targetBranch(repository);
  const ref = `refs/heads/${branch}`;
  const before = await refCommit(repository.path, ref);
  const unchanged = (result: TargetSyncResult, from: string | null) => ({
    remote: from,
    result,
    branch,
    before,
    after: before,
  });
  const configured = await run(
    "git",
    ["config", "--get-all", `remote.${remote}.url`],
    { cwd: repository.path },
  );
  if (configured.code !== 0 || !configured.stdout.trim())
    return unchanged("no-remote-branch", null);
  const advertised = await run(
    "git",
    ["ls-remote", "--exit-code", "--heads", remote, ref],
    { cwd: repository.path },
  );
  if (advertised.code === 2) return unchanged("no-remote-branch", remote);
  if (advertised.code !== 0)
    throw new CodedError(
      "fetch_failed",
      `Could not inspect ${remote}/${branch}: ${(advertised.stderr || advertised.stdout).trim()}`,
    );
  const fetched = await run("git", ["fetch", "--no-tags", remote, ref], {
    cwd: repository.path,
  });
  if (fetched.code !== 0)
    throw new CodedError(
      "fetch_failed",
      `Could not fetch ${remote}/${branch}: ${(fetched.stderr || fetched.stdout).trim()}`,
    );
  const remoteCommit = await refCommit(repository.path, "FETCH_HEAD");
  if (!remoteCommit)
    throw new CodedError(
      "fetch_failed",
      `Fetched ${remote}/${branch} but could not resolve FETCH_HEAD`,
    );
  if (before === remoteCommit) return unchanged("up-to-date", remote);
  if (before && (await isAncestor(repository.path, remoteCommit, before)))
    return unchanged("local-ahead", remote);
  if (before && !(await isAncestor(repository.path, before, remoteCommit)))
    throw new CodedError(
      "target_diverged",
      `Local ${branch} at ${before} and ${remote}/${branch} at ${remoteCommit} have diverged; nothing was changed. Reconcile ${branch} manually (never reset or force) and retry`,
    );

  const holders = (await listWorktrees(repository.path)).filter(
    (worktree) => worktree.branch === ref,
  );
  if (holders.length > 1)
    throw new CodedError(
      "target_dirty",
      `Target ${branch} is checked out in several worktrees (${holders.map((item) => item.path).join(", ")}); nothing was changed`,
    );
  const holder = holders[0];
  if (!holder) {
    // Create or advance the unchecked-out ref atomically against its old value.
    const update = await run(
      "git",
      ["update-ref", ref, remoteCommit, before ?? ""],
      { cwd: repository.path },
    );
    if (update.code !== 0)
      throw new CodedError(
        "target_diverged",
        `Could not fast-forward ${branch} to ${remoteCommit}; it moved during sync: ${(update.stderr || update.stdout).trim()}`,
      );
    return {
      remote,
      result: "fast-forwarded",
      branch,
      before,
      after: remoteCommit,
    };
  }
  const context = await inspectGit(holder.path);
  if (
    context.branch !== branch ||
    context.head !== before ||
    (await hasMergeInProgress(holder.path)) ||
    !(await isClean(holder.path))
  )
    throw new CodedError(
      "target_dirty",
      `Target worktree ${holder.path} has uncommitted changes or an unfinished operation, so ${branch} cannot be fast-forwarded to ${remote}/${branch}; nothing was changed. Commit or clean it without discarding work, then retry`,
    );
  const merge = await run(
    "git",
    ["merge", "--ff-only", "--no-edit", remoteCommit],
    { cwd: holder.path },
  );
  if (merge.code !== 0)
    throw new CodedError(
      "target_dirty",
      `Could not fast-forward target worktree ${holder.path}: ${(merge.stderr || merge.stdout).trim()}`,
    );
  return {
    remote,
    result: "fast-forwarded",
    branch,
    before,
    after: remoteCommit,
  };
}

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd },
  );
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(
    `Could not compare ${ancestor} with ${descendant}: ${(result.stderr || result.stdout).trim()}`,
  );
}
