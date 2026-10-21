import { randomBytes } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { integrationBatchingSettings } from "./batch-settings.js";
import { runSetupWithCache } from "./cache.js";
import { withDelivery } from "./delivery-policy.js";
import {
  git,
  hasMergeInProgress,
  inspectGit,
  isClean,
  listWorktrees,
  refCommit,
} from "./git.js";
import type { LockWaitDecision } from "./lock.js";
import { isNodeError } from "./runtime.js";
import { measurePhase, recordPerformanceMetric } from "./performance.js";
import {
  run,
  runCommandList,
  runValidation,
  ValidationFailure,
} from "./process.js";
import {
  promoteValidatedCommit,
  PromotionBlockedError,
  targetBranch,
} from "./promotion.js";
import { pullRequestPromotion } from "./pull-request.js";
import {
  QueueCancellation,
  QueueOwnershipUncertain,
} from "./queued-process.js";
import {
  ensureRecoveryBundle,
  recordBatchValidationRecovery,
  recordStagingCommitRecovery,
} from "./recovery.js";
import {
  readConfig,
  readSession,
  readSessions,
  updateSessionRecord,
  writeSession,
} from "./runtime.js";
import { preflightCommitSigning } from "./signing.js";
import type {
  Config,
  IntegrationBatchMembership,
  IntegrationWaiter,
  RepositoryConfig,
  Session,
} from "./types.js";
import { selectValidation, type SelectedValidation } from "./validation.js";
import { worktreePaths } from "./worktree-location.js";

const ZERO = "0000000000000000000000000000000000000000";

/** Lifecycle steps owned by handoff.ts that a batch reuses unchanged. */
export interface BatchOperations {
  /** Integrate one session alone through the normal merge, validation and promotion path. */
  integrateAlone(repository: RepositoryConfig, session: Session): Promise<void>;
  /** Push and open or update the configured pull request, then mark the session succeeded. */
  completePullRequest(
    repository: RepositoryConfig,
    session: Session,
  ): Promise<void>;
  assertDependencies(session: Session): Promise<void>;
  assertNoUnstagedChanges(session: Session, worktree: string): Promise<void>;
}

export interface BatchRequest {
  config: Config;
  /** The registration without any session delivery rule applied. */
  registered: RepositoryConfig;
  /** The leader's effective repository configuration. */
  repository: RepositoryConfig;
  /** Holds the repository lock and has a captured target baseline. */
  leader: Session;
  canonicalWorktree: string;
  ops: BatchOperations;
  /**
   * Member failures whose incidents are recorded after the lock is released:
   * an incident may run a read-only investigation with the session's harness.
   */
  deferredIncidents: DeferredIncident[];
}

export interface DeferredIncident {
  session: Session;
  error: unknown;
  /** The member's waiting process records its own incident while alive. */
  waiterPid?: number;
}

/**
 * - `none`: no batch was formed; the leader integrates alone.
 * - `done`: the leader was promoted, in the batch or alone during isolation.
 * - `alone`: the batch ended without the leader (conflict or release); it
 *   integrates alone now.
 * - `failed`: the leader's integration failed; `started` says whether it has
 *   integration state (a preserved merge or a staged batch commit).
 */
export type BatchResult =
  | { kind: "none" }
  | { kind: "done" }
  | { kind: "alone" }
  | { kind: "failed"; error: unknown; started: boolean };

interface BatchContext extends BatchRequest {
  id: string;
  targetBranch: string;
  promotionKey: string;
  remoteBaseline?: string;
  failedTrees: Set<string>;
  leaderError?: { error: unknown };
}

interface Assembly {
  staging: string | null;
  target: string;
  commit: string;
  tree: string;
  included: Session[];
  excluded: { session: Session; reason: string }[];
}

/** Git cannot build a plumbing merge here; integrate one session at a time. */
class BatchUnavailable extends Error {}

/**
 * Called by the lock holder after its target baseline is captured. Claims
 * other sessions waiting for the same repository lock, merges every exact
 * ready commit into one candidate, validates it once and promotes it. A
 * failing candidate is split into halves until each failing session has been
 * integrated alone through the normal path, so no session is promoted on a
 * tree that was not validated.
 */
export async function integrateWaitingBatch(
  request: BatchRequest,
): Promise<BatchResult> {
  const { config, registered, repository, leader } = request;
  const settings = integrationBatchingSettings(config, registered);
  if (!settings.enabled || settings.maxSessions < 2) return { kind: "none" };
  if (!canLead(leader)) return { kind: "none" };
  const promotion = JSON.stringify(pullRequestPromotion(repository) ?? null);
  const context: BatchContext = {
    ...request,
    id: `batch_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    targetBranch: targetBranch(repository),
    promotionKey: promotion,
    ...(leader.remoteRecoveryBaseline
      ? { remoteBaseline: leader.remoteRecoveryBaseline }
      : {}),
    failedTrees: new Set(),
  };
  if (!(await stagingCanAdvance(context))) return { kind: "none" };

  const joinedAt = new Date().toISOString();
  const claimed: Session[] = [];
  for (const candidate of await waitingCandidates(context)) {
    if (claimed.length >= settings.maxSessions - 1) break;
    try {
      await request.ops.assertDependencies(candidate);
    } catch {
      continue;
    }
    const member = await claim(context, candidate.id, joinedAt);
    if (member) claimed.push(member);
  }
  if (claimed.length === 0) return { kind: "none" };
  if (leader.integrationBatch)
    (leader.integrationBatchHistory ??= []).push(leader.integrationBatch);
  leader.integrationBatch = {
    id: context.id,
    leaderSessionId: leader.id,
    role: "leader",
    joinedAt,
    members: [],
  };
  await writeSession(leader);
  const ordered = [leader, ...claimed].sort(byReadyOrder);
  process.stdout.write(
    `Integration batch ${context.id}: ${leader.id} claimed ${claimed.length} waiting session(s) (cap ${settings.maxSessions}); merge order ${ordered.map((session) => session.id).join(", ")}\n`,
  );
  recordPerformanceMetric("integrationBatchId", context.id);
  recordPerformanceMetric("integrationBatchSessions", ordered.length);

  let aborted: { error: unknown } | undefined;
  try {
    await processGroup(context, ordered);
  } catch (error) {
    aborted = { error };
    process.stdout.write(
      `Integration batch ${context.id} stopped: ${errorMessage(error)}\n`,
    );
  }
  for (const member of claimed) {
    if (member.integrationBatch?.outcome) continue;
    if (member.integratedCommit) {
      await recordFailure(
        context,
        member,
        aborted?.error ??
          new Error(
            "Integration batch stopped before finishing this session's promotion",
          ),
      );
      await resolve(context, member, "batched");
    } else {
      await resolve(
        context,
        member,
        "released",
        aborted
          ? `the batch stopped: ${errorMessage(aborted.error)}`
          : "the batch stopped before integrating it",
      );
    }
  }
  const outcome = leader.integrationBatch.outcome;
  if (context.leaderError)
    return { kind: "failed", error: context.leaderError.error, started: true };
  if (aborted && !(aborted.error instanceof BatchUnavailable)) {
    if (!outcome && leader.integratedCommit) {
      await recordFailure(context, leader, aborted.error);
      await resolve(context, leader, "batched");
      return { kind: "failed", error: aborted.error, started: true };
    }
    if (!outcome)
      await resolve(context, leader, "released", errorMessage(aborted.error));
    return { kind: "failed", error: aborted.error, started: false };
  }
  if (outcome === "batched" || outcome === "isolated") return { kind: "done" };
  if (!outcome)
    await resolve(
      context,
      leader,
      "released",
      aborted
        ? errorMessage(aborted.error)
        : "the batch stopped before integrating it",
    );
  return { kind: "alone" };
}

function canLead(leader: Session): boolean {
  return (
    !leader.integratedCommit &&
    !leader.recoveryPhase &&
    !leader.awaitingConflictResolution &&
    leader.integrationBatch?.outcome !== "excluded"
  );
}

/** A member must be waiting in a live, batching-aware process. */
function claimable(context: BatchContext, session: Session): boolean {
  const waiter = session.integrationWait;
  const repository = withDelivery(context.registered, session.delivery);
  return (
    session.id !== context.leader.id &&
    session.repositoryId === context.leader.repositoryId &&
    session.status === "ready" &&
    session.waitingForLock === true &&
    waiter?.batching === 1 &&
    waiter.hostname === hostname() &&
    isProcessAlive(waiter.pid) &&
    !!session.readyCommit &&
    !!session.readyAt &&
    !!session.completionSummary &&
    !!session.rolloutDisposition &&
    !session.integratedCommit &&
    !session.recoveryPhase &&
    !session.awaitingConflictResolution &&
    !session.recoveryBundle &&
    !session.integrationWorktreePath &&
    (!session.integrationBatch ||
      session.integrationBatch.outcome === "released") &&
    targetBranch(repository) === context.targetBranch &&
    JSON.stringify(pullRequestPromotion(repository) ?? null) ===
      context.promotionKey
  );
}

async function waitingCandidates(context: BatchContext): Promise<Session[]> {
  return (await readSessions())
    .filter((session) => claimable(context, session))
    .sort(byReadyOrder);
}

async function claim(
  context: BatchContext,
  sessionId: string,
  joinedAt: string,
): Promise<Session | undefined> {
  let claimed = false;
  const latest = await updateSessionRecord(sessionId, (session) => {
    if (!claimable(context, session)) return false;
    if (session.integrationBatch)
      (session.integrationBatchHistory ??= []).push(session.integrationBatch);
    session.integrationBatch = {
      id: context.id,
      leaderSessionId: context.leader.id,
      role: "member",
      joinedAt,
      members: [],
    };
    claimed = true;
    return true;
  });
  return claimed ? latest : undefined;
}

async function processGroup(
  context: BatchContext,
  group: Session[],
): Promise<"continue" | "stop"> {
  if (group.length === 0) return "continue";
  if (group.length === 1) return integrateAlone(context, group[0]!);
  const assembly = await measurePhase("batch_assembly", async () =>
    assemble(context, group),
  );
  for (const { session, reason } of assembly.excluded) {
    process.stdout.write(
      `Integration batch ${context.id}: ${session.id} left the batch (${reason}); it integrates alone through the normal conflict flow.\n`,
    );
    await resolve(context, session, "excluded", reason);
  }
  const sessions = assembly.included;
  if (sessions.length === 0) return "continue";
  if (sessions.length === 1) return integrateAlone(context, sessions[0]!);
  await recordCandidate(context, assembly);
  let passed = false;
  if (context.failedTrees.has(assembly.tree)) {
    process.stdout.write(
      `Integration batch ${context.id}: combined tree ${assembly.tree} already failed validation in this batch; isolating without rerunning it.\n`,
    );
  } else {
    passed = await validateCandidate(context, assembly);
  }
  if (passed) return promoteCandidate(context, assembly);
  context.failedTrees.add(assembly.tree);
  const half = Math.max(1, Math.floor(sessions.length / 2));
  process.stdout.write(
    `Integration batch ${context.id}: isolating the failure by validating ${sessions
      .slice(0, half)
      .map((session) => session.id)
      .join(", ")} before ${sessions
      .slice(half)
      .map((session) => session.id)
      .join(", ")}\n`,
  );
  if ((await processGroup(context, sessions.slice(0, half))) === "stop")
    return "stop";
  return processGroup(context, sessions.slice(half));
}

async function integrateAlone(
  context: BatchContext,
  session: Session,
): Promise<"continue" | "stop"> {
  process.stdout.write(
    `Integration batch ${context.id}: integrating ${session.id} alone\n`,
  );
  if (session.id !== context.leader.id && context.remoteBaseline) {
    session.remoteRecoveryBaseline = context.remoteBaseline;
    session.remoteRecoveryAttempts = 0;
  }
  try {
    await context.ops.integrateAlone(repositoryFor(context, session), session);
  } catch (error) {
    await recordFailure(context, session, error);
    await resolve(context, session, "isolated");
    if (isQueueInterruption(error)) throw error;
    return session.status === "promotion_pending" ? "stop" : "continue";
  }
  await resolve(context, session, "isolated");
  return "continue";
}

async function assemble(
  context: BatchContext,
  group: Session[],
): Promise<Assembly> {
  const repository = context.repository;
  const target = await refCommit(
    repository.path,
    `refs/heads/${context.targetBranch}`,
  );
  if (!target)
    throw new Error(`Target branch not found: ${context.targetBranch}`);
  const staging = await refCommit(
    repository.path,
    `refs/heads/${repository.integrationBranch}`,
  );
  if (
    staging &&
    staging !== target &&
    !(await isAncestor(repository.path, staging, target))
  )
    throw new Error(
      `Staging branch ${repository.integrationBranch} at ${staging} is ahead of or divergent from target ${context.targetBranch} at ${target}`,
    );
  let current = target;
  let signing: boolean | undefined;
  const included: Session[] = [];
  const excluded: Assembly["excluded"] = [];
  for (const session of group) {
    const ready = session.readyCommit!;
    if (await isAncestor(repository.path, ready, current)) {
      included.push(session);
      continue;
    }
    const merged = await run(
      "git",
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        current,
        ready,
      ],
      { cwd: repository.path },
    );
    const lines = merged.stdout.split("\n").filter(Boolean);
    if (merged.code === 1 && lines.length > 0) {
      const files = lines.slice(1);
      excluded.push({
        session,
        reason: `merge conflict with the batch${files.length ? ` in ${files.join(", ")}` : ""}`,
      });
      continue;
    }
    if (merged.code !== 0 || !lines[0])
      throw new BatchUnavailable(
        `Git could not build a batch merge (${(merged.stderr || merged.stdout).trim() || `exit ${merged.code}`}); integrating one session at a time`,
      );
    signing ??= await preflightCommitSigning(
      repository,
      repository.path,
      "batch integration commit",
    );
    current = await git(
      gpg(repository.gpgProgram, [
        "commit-tree",
        lines[0],
        "-p",
        current,
        "-p",
        ready,
        ...(signing ? ["-S"] : []),
        "-m",
        `Integrate ${session.id}: ${session.taskSummary}`,
      ]),
      repository.path,
    );
    included.push(session);
  }
  return {
    staging,
    target,
    commit: current,
    tree: await git(["rev-parse", `${current}^{tree}`], repository.path),
    included,
    excluded,
  };
}

async function recordCandidate(
  context: BatchContext,
  assembly: Assembly,
): Promise<void> {
  const members = assembly.included.map((session) => session.id);
  for (const session of assembly.included) {
    session.targetBranch = context.targetBranch;
    session.targetCommitBeforeIntegration = assembly.target;
    if (session.id !== context.leader.id && context.remoteBaseline) {
      session.remoteRecoveryBaseline = context.remoteBaseline;
      session.remoteRecoveryAttempts = 0;
    }
    await ensureRecoveryBundle(repositoryFor(context, session), session);
    session.integrationBatch!.members = members;
    await writeSession(session);
  }
}

/** The strictest selection any member needs: a shared tier, else full. */
function batchValidation(
  repository: RepositoryConfig,
  sessions: Session[],
): SelectedValidation {
  const paths = [
    ...new Set(sessions.flatMap((session) => session.changedPaths ?? [])),
  ].sort();
  const selected = sessions.map((session) =>
    selectValidation(
      repository,
      session.changedPaths ?? [],
      session.validationTier !== "full" &&
        session.sourceValidatedCommit === session.readyCommit,
    ),
  );
  const name = selected[0]?.name;
  if (
    name &&
    name !== "full" &&
    selected.every((selection) => selection.name === name)
  ) {
    const combined = selectValidation(repository, paths, true);
    if (combined.name === name) return combined;
  }
  return selectValidation(repository, paths, false);
}

async function validateCandidate(
  context: BatchContext,
  assembly: Assembly,
): Promise<boolean> {
  const repository = context.repository;
  const validation = batchValidation(repository, assembly.included);
  for (const session of assembly.included)
    session.integrationBatch!.validationTier = validation.name;
  process.stdout.write(
    `Integration batch ${context.id}: validating ${assembly.included.length} sessions together on ${assembly.commit} (tier ${validation.name})\n`,
  );
  const worktree = await prepareBatchWorktree(context, assembly.commit);
  const record = async (
    outcome: "passed" | "failed",
    failure?: ValidationFailure,
  ) => {
    for (const session of assembly.included) {
      await recordBatchValidationRecovery(
        repositoryFor(context, session),
        session,
        assembly.tree,
        outcome,
        failure?.record,
      );
      await writeSession(session);
    }
  };
  try {
    await measurePhase("batch_setup", async () =>
      runSetupWithCache(repository, worktree),
    );
  } catch (error) {
    if (isQueueInterruption(error)) throw error;
    process.stdout.write(
      `Integration batch ${context.id}: setup failed for the combined tree: ${errorMessage(error)}\n`,
    );
    await record("failed");
    return false;
  }
  if ((await git(["write-tree"], worktree)) !== assembly.tree)
    throw new Error("Batch candidate tree changed before validation");
  await context.ops.assertNoUnstagedChanges(context.leader, worktree);
  try {
    const resourceWaitSeconds = (await readConfig()).lockWaitSeconds;
    await measurePhase("batch_validation", async () =>
      runValidation(validation.integrationCommands, worktree, {
        // A combined tree never matches a member's source tree: run every
        // command rather than reusing source or earlier results.
        cachedFingerprints: new Set(),
        sessionId: context.leader.id,
        resourceWaitSeconds,
        phase: "integration",
      }),
    );
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    process.stdout.write(
      `Integration batch ${context.id}: combined validation failed: ${error.message}\n`,
    );
    await record("failed", error);
    return false;
  }
  await context.ops.assertNoUnstagedChanges(context.leader, worktree);
  if ((await git(["write-tree"], worktree)) !== assembly.tree)
    throw new Error("Batch candidate tree changed during validation");
  await record("passed");
  return true;
}

async function promoteCandidate(
  context: BatchContext,
  assembly: Assembly,
): Promise<"continue" | "stop"> {
  const repository = context.repository;
  const sessions = assembly.included;
  await advanceStaging(context, assembly.staging, assembly.commit);
  const integratedAt = new Date().toISOString();
  for (const session of sessions) {
    session.integratedCommit = assembly.commit;
    session.integratedAt = integratedAt;
    session.awaitingConflictResolution = false;
    delete session.validationFailure;
    session.integrationBatch!.stagingCommit = assembly.commit;
    session.recoveryPhase = "promotion";
    await recordStagingCommitRecovery(
      repositoryFor(context, session),
      session,
      assembly.commit,
    );
    await writeSession(session);
  }
  process.stdout.write(
    `Integration batch ${context.id}: validated ${assembly.commit}; promoting ${sessions.length} sessions to ${context.targetBranch}\n`,
  );
  let targetWorktree: string | undefined;
  try {
    targetWorktree = await measurePhase("promotion", async () =>
      promoteValidatedCommit(
        repository,
        assembly.commit,
        assembly.target,
        repository.postIntegrationCommands.length > 0,
      ),
    );
  } catch (error) {
    for (const session of sessions) {
      if (error instanceof PromotionBlockedError)
        session.status = "promotion_pending";
      await recordFailure(context, session, error);
      await resolve(context, session, "batched");
    }
    if (error instanceof PromotionBlockedError) return "stop";
    throw error;
  }
  const promotedAt = new Date().toISOString();
  for (const session of sessions) {
    session.promotedCommit = assembly.commit;
    session.promotedAt ??= promotedAt;
    delete session.latestError;
    if (repository.postIntegrationCommands.length > 0)
      session.recoveryPhase = "post_integration";
    await writeSession(session);
  }
  let results: Session["postIntegrationResults"] = [];
  if (repository.postIntegrationCommands.length > 0) {
    results = await measurePhase("post_integration", async () =>
      runCommandList(
        repository.postIntegrationCommands,
        targetWorktree!,
        "post-integration command",
      ),
    );
  }
  const failed = results.find((result) => result.exitCode !== 0);
  for (const session of sessions) {
    session.postIntegrationResults = results;
    await writeSession(session);
  }
  if (failed) {
    const error = new Error(
      `Post-integration check failed after target promotion (${failed.exitCode}): ${failed.command.join(" ")}`,
    );
    for (const session of sessions) {
      await recordFailure(context, session, error);
      await resolve(context, session, "batched");
    }
    return "continue";
  }
  for (const session of sessions) {
    try {
      await context.ops.completePullRequest(
        repositoryFor(context, session),
        session,
      );
    } catch (error) {
      await recordFailure(context, session, error);
    }
    await resolve(context, session, "batched");
  }
  process.stdout.write(
    `Promoted integration batch ${context.id} (${sessions.map((session) => session.id).join(", ")}) to ${context.targetBranch} at ${assembly.commit}\n`,
  );
  return "continue";
}

/** Fails a session as `integrate` would; the leader's own catch reports it. */
async function recordFailure(
  context: BatchContext,
  session: Session,
  error: unknown,
): Promise<void> {
  session.latestError = errorMessage(error);
  if (error instanceof ValidationFailure) {
    session.validationFailure = error.record;
    session.status = error.record.exhausted
      ? "validation_pending"
      : "needs_review";
  } else if (session.status !== "promotion_pending") {
    session.status = "needs_review";
  }
  if (session.id === context.leader.id) {
    context.leaderError ??= { error };
    await writeSession(session);
    return;
  }
  context.deferredIncidents.push({
    session,
    error,
    ...(session.integrationWait
      ? { waiterPid: session.integrationWait.pid }
      : {}),
  });
  session.waitingForLock = false;
  delete session.integrationWait;
  await writeSession(session);
}

/**
 * Record incidents for failed members whose waiting process has exited; a
 * live waiter reports and records its own, as a single integration would.
 * Call only after releasing the repository lock.
 */
export async function recordDeferredIncidents(
  deferred: DeferredIncident[],
  record: (session: Session, error: unknown) => Promise<void>,
): Promise<void> {
  for (const { session, error, waiterPid } of deferred.splice(0)) {
    if (waiterPid !== undefined && isProcessAlive(waiterPid)) continue;
    await record(session, error);
  }
}

async function resolve(
  context: BatchContext,
  session: Session,
  outcome: NonNullable<IntegrationBatchMembership["outcome"]>,
  reason?: string,
): Promise<void> {
  const batch = session.integrationBatch!;
  batch.outcome = outcome;
  if (reason) batch.reason = reason;
  batch.resolvedAt = new Date().toISOString();
  // Excluded and released members are still waiting to integrate alone.
  if (
    session.id !== context.leader.id &&
    (outcome === "batched" || outcome === "isolated")
  ) {
    session.waitingForLock = false;
    delete session.integrationWait;
  }
  await writeSession(session);
}

/** Batching requires a staging ref that can fast-forward to a batch commit. */
async function stagingCanAdvance(context: BatchContext): Promise<boolean> {
  const repository = context.repository;
  if (context.targetBranch === repository.integrationBranch) return false;
  const target = await refCommit(
    repository.path,
    `refs/heads/${context.targetBranch}`,
  );
  if (!target) return false;
  const ref = `refs/heads/${repository.integrationBranch}`;
  const staging = await refCommit(repository.path, ref);
  if (
    staging &&
    staging !== target &&
    !(await isAncestor(repository.path, staging, target))
  )
    return false;
  const holders = (await listWorktrees(repository.path)).filter(
    (worktree) => worktree.branch === ref,
  );
  return (
    holders.length === 0 ||
    (holders.length === 1 &&
      (await samePath(holders[0]!.path, context.canonicalWorktree)))
  );
}

/**
 * Advance staging with an expected-old check. A clean canonical integration
 * worktree is fast-forwarded in place so its index and files stay aligned;
 * preserved review state there is left untouched, as isolated integrations do.
 */
async function advanceStaging(
  context: BatchContext,
  expected: string | null,
  commit: string,
): Promise<void> {
  const repository = context.repository;
  const ref = `refs/heads/${repository.integrationBranch}`;
  const current = await refCommit(repository.path, ref);
  if (current !== expected)
    throw new Error(
      `Staging branch ${repository.integrationBranch} moved during batch integration (expected ${expected ?? "none"}, found ${current ?? "none"}); validated batch commit ${commit} was not staged`,
    );
  const holders = (await listWorktrees(repository.path)).filter(
    (worktree) => worktree.branch === ref,
  );
  const holder = holders[0];
  if (
    holders.length > 1 ||
    (holder && !(await samePath(holder.path, context.canonicalWorktree)))
  )
    throw new Error(
      `Staging branch ${repository.integrationBranch} is checked out outside the integration worktree: ${holders.map((item) => item.path).join(", ")}`,
    );
  if (
    holder &&
    expected &&
    holder.head === expected &&
    !(await hasMergeInProgress(holder.path)) &&
    (await isClean(holder.path))
  ) {
    await git(["merge", "--ff-only", "--no-edit", commit], holder.path);
    if (
      (await refCommit(repository.path, ref)) !== commit ||
      (await git(["rev-parse", "HEAD"], holder.path)) !== commit
    )
      throw new Error(
        `Integration worktree ${holder.path} did not finish at batch commit ${commit}`,
      );
    return;
  }
  const update = await run(
    "git",
    ["update-ref", ref, commit, expected ?? ZERO],
    { cwd: repository.path },
  );
  if (update.code !== 0)
    throw new Error(
      `Could not advance staging to batch commit ${commit}: ${(update.stderr || update.stdout).trim()}`,
    );
  // Like a single integration, leave the canonical integration worktree
  // checked out at the latest staging commit. Best effort: staging already
  // holds the validated commit, and later integrations create it if missing.
  if (!holder && !(await pathExists(context.canonicalWorktree))) {
    const added = await run(
      "git",
      [
        "worktree",
        "add",
        context.canonicalWorktree,
        repository.integrationBranch,
      ],
      { cwd: repository.path },
    );
    if (added.code !== 0)
      process.stderr.write(
        `Warning: could not create integration worktree ${context.canonicalWorktree}: ${(added.stderr || added.stdout).trim()}\n`,
      );
  }
}

/** A detached, tool-owned worktree reused across batches when clean. */
async function prepareBatchWorktree(
  context: BatchContext,
  commit: string,
): Promise<string> {
  const repository = context.repository;
  const root = (await worktreePaths(repository.path)).worktrees;
  const base = `${context.leader.repositoryId}-batch`;
  for (const path of [join(root, base), join(root, `${base}-${context.id}`)]) {
    if (!(await pathExists(path))) {
      await mkdir(dirname(path), { recursive: true });
      await git(["worktree", "add", "--detach", path, commit], repository.path);
      return path;
    }
    if (await reusableBatchWorktree(repository, path)) {
      await git(["checkout", "--detach", "--quiet", commit], path);
      if (
        (await git(["rev-parse", "HEAD"], path)) === commit &&
        (await isClean(path))
      )
        return path;
    }
    process.stdout.write(
      `Batch worktree ${path} is not a clean detached checkout; preserving it.\n`,
    );
  }
  throw new Error(
    "No clean batch worktree is available; preserved existing ones",
  );
}

async function reusableBatchWorktree(
  repository: RepositoryConfig,
  path: string,
): Promise<boolean> {
  try {
    const context = await inspectGit(path);
    return (
      context.gitCommonDir === repository.gitCommonDir &&
      context.branch === null &&
      !(await hasMergeInProgress(path)) &&
      (await isClean(path))
    );
  } catch {
    return false;
  }
}

function repositoryFor(
  context: BatchContext,
  session: Session,
): RepositoryConfig {
  return session.id === context.leader.id
    ? context.repository
    : withDelivery(context.registered, session.delivery);
}

function byReadyOrder(left: Session, right: Session): number {
  return (
    (left.readyAt ?? "").localeCompare(right.readyAt ?? "") ||
    left.id.localeCompare(right.id)
  );
}

// --- Waiting side -----------------------------------------------------------

/** Advertised while waiting so a batch leader may claim this session. */
export function integrationWaiter(): IntegrationWaiter {
  return {
    batching: 1,
    pid: process.pid,
    hostname: hostname(),
    since: new Date().toISOString(),
  };
}

/** The membership a leader recorded during the wait that started at `since`. */
function joinedBatch(
  session: Session,
  since: string,
): IntegrationBatchMembership | undefined {
  const batch = session.integrationBatch;
  return batch?.role === "member" && batch.joinedAt >= since
    ? batch
    : undefined;
}

/** True when a batch leader finished integrating this session. */
export function resolvedByBatch(session: Session, since: string): boolean {
  const outcome = joinedBatch(session, since)?.outcome;
  return outcome === "batched" || outcome === "isolated";
}

/**
 * Lock-wait callback for `integrate`: keeps waiting while a leader integrates
 * this session, names the batch, and stops once the leader resolved it. At
 * the deadline it withdraws from batching atomically unless already claimed.
 */
export function batchLockWatcher(
  sessionId: string,
  since: string,
): (expired: boolean) => Promise<LockWaitDecision> {
  let joined = "";
  let announced = "";
  return async (expired) => {
    let latest = await readSession(sessionId);
    if (!latest) return "wait";
    if (expired && !joinedBatch(latest, since)) {
      latest =
        (await updateSessionRecord(sessionId, (session) => {
          if (joinedBatch(session, since) || !session.integrationWait)
            return false;
          session.waitingForLock = false;
          delete session.integrationWait;
          return true;
        })) ?? latest;
    }
    const batch = joinedBatch(latest, since);
    if (!batch) return "wait";
    if (joined !== batch.id) {
      joined = batch.id;
      process.stdout.write(
        `Joined integration batch ${batch.id} led by ${batch.leaderSessionId}.\n`,
      );
    }
    const key = `${batch.id}/${batch.outcome ?? "claimed"}/${batch.members.length}`;
    if (key !== announced) {
      announced = key;
      process.stdout.write(describeWait(batch));
    }
    if (batch.outcome === "batched" || batch.outcome === "isolated")
      return "stop";
    return batch.outcome ? "wait" : "hold";
  };
}

function describeWait(batch: IntegrationBatchMembership): string {
  switch (batch.outcome) {
    case undefined:
      return batch.members.length
        ? `Integration batch ${batch.id} is validating ${batch.members.length} sessions together: ${batch.members.join(", ")}\n`
        : "";
    case "excluded":
      return `Left integration batch ${batch.id}: ${batch.reason ?? "merge conflict"}. This session integrates alone after the batch.\n`;
    case "released":
      return `Integration batch ${batch.id} released this session (${batch.reason ?? "batch stopped"}); waiting to integrate.\n`;
    default:
      return "";
  }
}

/**
 * Release a claim left by a leader that stopped: the caller holds the
 * repository lock, so that leader is no longer integrating. Returns whether
 * the session changed.
 */
export function releaseStaleBatchClaim(session: Session): boolean {
  const batch = session.integrationBatch;
  if (batch?.role !== "member" || batch.outcome) return false;
  batch.outcome = "released";
  batch.reason = `batch leader ${batch.leaderSessionId} stopped before resolving this session`;
  batch.resolvedAt = new Date().toISOString();
  process.stdout.write(
    `Released stale claim from integration batch ${batch.id}: ${batch.reason}.\n`,
  );
  return true;
}

/** Describe the result a batch leader recorded; true when promoted. */
export function reportBatchResolution(session: Session): boolean {
  const batch = session.integrationBatch!;
  process.stdout.write(
    batch.outcome === "batched"
      ? `Integration batch ${batch.id} (led by ${batch.leaderSessionId}) merged ${batch.members.length} sessions into validated commit ${batch.stagingCommit ?? "(not staged)"}: ${batch.members.join(", ")}\n`
      : `Integration batch ${batch.id} (led by ${batch.leaderSessionId}) integrated ${session.id} alone after its combined validation failed.\n`,
  );
  if (session.status === "succeeded")
    process.stdout.write(
      `Promoted ${session.id} to ${session.targetBranch} at ${session.promotedCommit}\n`,
    );
  return session.status === "succeeded";
}

// --- Helpers ----------------------------------------------------------------

function isQueueInterruption(error: unknown): boolean {
  return (
    error instanceof QueueCancellation ||
    error instanceof QueueOwnershipUncertain
  );
}

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (
    (
      await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd,
      })
    ).code === 0
  );
}

function gpg(program: string | undefined, args: string[]): string[] {
  return program ? ["-c", `gpg.program=${program}`, ...args] : args;
}

async function samePath(left: string, right: string): Promise<boolean> {
  const resolve = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  };
  return (await resolve(left)) === (await resolve(right));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
