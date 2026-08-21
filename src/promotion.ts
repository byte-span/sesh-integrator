import {
  hasMergeInProgress,
  inspectGit,
  isClean,
  listWorktrees,
  refCommit,
} from "./git.js";
import { run } from "./process.js";
import type { RepositoryConfig } from "./types.js";

export class PromotionBlockedError extends Error {}

export function targetBranch(repository: RepositoryConfig): string {
  return (
    repository.targetBranch ??
    repository.globalDefaultTargetBranch ??
    repository.defaultBranch
  );
}

export function targetBranchSource(
  repository: RepositoryConfig,
): "override" | "global default" | "defaultBranch" {
  if (repository.targetBranch !== undefined) return "override";
  if (repository.globalDefaultTargetBranch !== undefined)
    return "global default";
  return "defaultBranch";
}

export async function ensureGlobalTargetBranch(
  repository: RepositoryConfig,
): Promise<void> {
  if (
    repository.targetBranch !== undefined ||
    repository.globalDefaultTargetBranch === undefined
  ) {
    return;
  }
  const branch = targetBranch(repository);
  const localRef = `refs/heads/${branch}`;
  if (await refCommit(repository.path, localRef)) return;

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (await refCommit(repository.path, remoteRef)) {
    const tracked = await run(
      "git",
      ["branch", "--track", branch, `origin/${branch}`],
      { cwd: repository.path },
    );
    if (tracked.code !== 0) {
      throw new PromotionBlockedError(
        `Could not create local target branch ${branch} tracking origin/${branch}: ${(tracked.stderr || tracked.stdout).trim()}`,
      );
    }
    return;
  }

  const defaultCommit = await refCommit(
    repository.path,
    `refs/heads/${repository.defaultBranch}`,
  );
  if (!defaultCommit) {
    throw new PromotionBlockedError(
      `Cannot create target branch ${branch}: default branch ${repository.defaultBranch} has no local commit`,
    );
  }
  const created = await run(
    "git",
    [
      "update-ref",
      localRef,
      defaultCommit,
      "0000000000000000000000000000000000000000",
    ],
    { cwd: repository.path },
  );
  if (created.code !== 0) {
    throw new PromotionBlockedError(
      `Could not create local target branch ${branch} from ${repository.defaultBranch}: ${(created.stderr || created.stdout).trim()}`,
    );
  }
}

export async function promoteValidatedCommit(
  repository: RepositoryConfig,
  validatedCommit: string,
  expectedTargetCommit: string,
  requireCheckedOutTarget = false,
): Promise<string | undefined> {
  const branch = targetBranch(repository);
  const ref = `refs/heads/${branch}`;
  const current = await refCommit(repository.path, ref);
  if (!current) {
    throw new PromotionBlockedError(`Target branch not found: ${branch}`);
  }
  if (current === validatedCommit) {
    const holders = (await listWorktrees(repository.path)).filter(
      (worktree) => worktree.branch === ref,
    );
    if (holders.length === 0) {
      if (requireCheckedOutTarget) {
        throw new PromotionBlockedError(
          `Target branch ${branch} must be checked out in one clean worktree to run post-integration commands. Check it out, then run codex-handoff resume from the source worktree.`,
        );
      }
      return undefined;
    }
    if (holders.length > 1) {
      throw new PromotionBlockedError(
        `Target ${branch} already points to ${validatedCommit}, but multiple checked-out worktrees require inspection: ${holders.map((item) => item.path).join(", ")}.`,
      );
    }
    const holder = holders[0]!;
    try {
      const context = await inspectGit(holder.path);
      if (
        context.branch === branch &&
        context.head === validatedCommit &&
        !(await hasMergeInProgress(holder.path)) &&
        (await isClean(holder.path))
      ) {
        return holder.path;
      }
    } catch {
      // The actionable error below covers inaccessible and inconsistent state.
    }
    throw new PromotionBlockedError(
      `Target ref ${branch} already points to ${validatedCommit}, but checked-out worktree ${holder.path} is not verifiably synchronized and clean. Repair it without discarding user changes before retrying.`,
    );
  }
  if (current !== expectedTargetCommit) {
    throw new PromotionBlockedError(
      `Target branch ${branch} moved unexpectedly; expected ${expectedTargetCommit}, found ${current}. The validated commit ${validatedCommit} remains on ${repository.integrationBranch}. Reconcile the target movement before retrying.`,
    );
  }
  const fastForward = await run(
    "git",
    ["merge-base", "--is-ancestor", expectedTargetCommit, validatedCommit],
    { cwd: repository.path },
  );
  if (fastForward.code !== 0) {
    throw new PromotionBlockedError(
      `Validated integration ${validatedCommit} is not a fast-forward of target ${branch} at ${expectedTargetCommit}; refusing promotion.`,
    );
  }
  const holders = (await listWorktrees(repository.path)).filter(
    (worktree) => worktree.branch === ref,
  );
  if (holders.length > 1) {
    throw new PromotionBlockedError(
      `Target branch ${branch} is checked out in multiple worktrees; inspect ${holders.map((item) => item.path).join(", ")}.`,
    );
  }
  const holder = holders[0];
  if (!holder) {
    if (requireCheckedOutTarget) {
      throw new PromotionBlockedError(
        `Target branch ${branch} must be checked out in one clean worktree to run post-integration commands. Check it out, then run codex-handoff resume from the source worktree.`,
      );
    }
    const update = await run(
      "git",
      ["update-ref", ref, validatedCommit, expectedTargetCommit],
      { cwd: repository.path },
    );
    if (update.code !== 0) {
      throw new PromotionBlockedError(
        `Atomic promotion of ${branch} failed: ${(update.stderr || update.stdout).trim()}`,
      );
    }
    return undefined;
  }

  let context;
  try {
    context = await inspectGit(holder.path);
  } catch (error) {
    throw new PromotionBlockedError(
      `Target branch ${branch} is checked out at inaccessible worktree ${holder.path}: ${errorMessage(error)}. The validated commit remains on ${repository.integrationBranch}.`,
    );
  }
  if (
    context.branch !== branch ||
    context.head !== expectedTargetCommit ||
    holder.head !== expectedTargetCommit
  ) {
    throw new PromotionBlockedError(
      `Target worktree ${holder.path} moved unexpectedly; expected ${branch} at ${expectedTargetCommit}.`,
    );
  }
  if (
    (await hasMergeInProgress(holder.path)) ||
    !(await isClean(holder.path))
  ) {
    throw new PromotionBlockedError(
      `Target worktree ${holder.path} is dirty or has an unfinished merge. Clean it without discarding user changes, then run codex-handoff resume from the source worktree. Validated commit: ${validatedCommit}.`,
    );
  }

  // A checked-out branch must be advanced through its own clean worktree so
  // its ref, index, and working tree stay synchronized. Git's fast-forward
  // merge updates the ref transactionally against the worktree's current HEAD.
  const merge = await run(
    "git",
    ["merge", "--ff-only", "--no-edit", validatedCommit],
    { cwd: holder.path },
  );
  if (merge.code !== 0) {
    throw new PromotionBlockedError(
      `Could not synchronize clean target worktree ${holder.path}: ${(merge.stderr || merge.stdout).trim()}`,
    );
  }
  const afterRef = await refCommit(repository.path, ref);
  const after = await inspectGit(holder.path);
  if (
    afterRef !== validatedCommit ||
    after.head !== validatedCommit ||
    after.branch !== branch ||
    !(await isClean(holder.path))
  ) {
    throw new PromotionBlockedError(
      `Target worktree ${holder.path} did not finish synchronized at ${validatedCommit}; inspect it before retrying.`,
    );
  }
  return holder.path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
