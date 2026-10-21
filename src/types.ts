export type Command = [string, ...string[]];

export interface ValidationCommandSpec {
  command: Command;
  resources?: {
    shared?: string[];
    exclusive?: string[];
  };
  failure?: {
    classification?: "transient";
    maxAttempts?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
  };
}

export type ValidationCommand = Command | ValidationCommandSpec;

export interface ParallelCommandGroup {
  parallel: ValidationCommand[];
}

export type ValidationStep = ValidationCommand | ParallelCommandGroup;

export interface ValidationTier {
  name: string;
  paths: string[];
  sourceValidationCommands: ValidationStep[];
  integrationValidationCommands: ValidationStep[];
  bypassIntegrationWorktree?: boolean;
  /**
   * Asserts that changes confined to this tier's paths cannot change other
   * validation commands' results. When the merged integration tree differs
   * from a session's validated source tree only in this tier's paths, the
   * tier's integration commands run on the merged tree and the session's
   * source results are reused for its other integration commands.
   */
  reuseSourceValidationOnTargetMove?: boolean;
}

export interface RepositoryConfig {
  path: string;
  gitCommonDir: string;
  defaultBranch: string;
  integrationBranch: string;
  targetBranch?: string;
  promotion?: PromotionConfig;
  /** Runtime-only inherited global policy; never persisted per repository. */
  globalDefaultTargetBranch?: string;
  /** Runtime-only inherited global PR participants; never persisted per repository. */
  globalDefaultPromotion?: DefaultPromotionConfig;
  gpgProgram?: string;
  setupCommands: Command[];
  setupCommandPolicy?: "advisory" | "required";
  sourceValidationCommands: ValidationStep[];
  integrationValidationCommands: ValidationStep[];
  validationTiers?: ValidationTier[];
  postIntegrationCommands: Command[];
  conflictInstructions: string;
  validationCache?: "off" | "session" | "repository";
  /** Overrides the global integrationBatching defaults for this repository. */
  integrationBatching?: IntegrationBatchingConfig;
}

/**
 * Batching of sessions that wait to integrate at the same time. Omitted keys
 * fall back to the global value, then to enabled with at most 8 sessions.
 */
export interface IntegrationBatchingConfig {
  enabled?: boolean;
  /** Sessions merged into one candidate, including its leader (1-64). */
  maxSessions?: number;
}

export type PromotionConfig =
  | { type: "none" }
  | {
      type: "pull-request";
      mode?: "shared-target" | "session-branch";
      productionBranch?: string;
      remote?: string;
      reviewers?: string[];
      assignees?: string[];
    };

export interface DefaultPromotionConfig {
  reviewers?: string[];
  assignees?: string[];
}

/** When a delivery policy counts a session's work as landed. */
export type DeliveryCompletion =
  "local" | "target-pushed" | "production-merged";

/**
 * The delivery rule `begin` resolved from a `sesh-integrator/delivery-policy@1`
 * file and recorded on the session. `integrate` and `resume` use it instead of
 * the repository's `targetBranch` and `promotion`; policy changes affect only
 * new sessions.
 */
export interface SessionDelivery {
  /** The policy's optional `version`, or null. */
  version: string | null;
  /** SHA-256 (lowercase hex) of the policy file bytes read by `begin`. */
  sha256: string;
  /** Lowercase GitHub `owner/name` the rule was resolved for. */
  repository: string;
  targetBranch: string;
  /** Normalized: pull-request rules always carry mode, productionBranch and remote. */
  promotion: PromotionConfig;
  completion: DeliveryCompletion;
  /** Whether a `repositories` entry matched or only `defaults` applied. */
  source: "repository" | "defaults";
}

export interface Config {
  /** Canonical Git common directories, independent of registration. */
  disabledRepositories?: string[];
  lockWaitSeconds: number;
  /** Legacy alias for harnessCommands.codex. */
  codexCommand?: string;
  harnessCommands?: Partial<Record<import("./harness.js").Harness, string>>;
  conflictResolutionMode?: "current-session" | "nested-agent" | "nested-codex";
  defaultTargetBranch?: string;
  defaultPromotion?: DefaultPromotionConfig;
  /** Delivery policy used by `begin` when `--policy-file` is not given. */
  deliveryPolicyFile?: string;
  /** Defaults for every repository; repository settings override them. */
  integrationBatching?: IntegrationBatchingConfig;
  repositories: RepositoryConfig[];
}

export type SessionStatus =
  | "active"
  | "ready"
  | "validation_pending"
  | "promotion_pending"
  | "succeeded"
  | "no_changes"
  | "abandoned"
  | "needs_review";

export type RolloutDisposition = "none" | "applied" | "automated" | "manual";

export type TaskStatus =
  "pending" | "in_progress" | "completed" | "blocked" | "skipped";

export interface SessionTask {
  /** Stable identifier, independent of the task's position in the list. */
  id: number;
  title: string;
  description?: string;
  status: TaskStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorIdentity {
  buildId: string;
  version: string;
  stateContract: number;
  recoveryContract: number;
  cliPath: string;
}

export interface LocalTargetRecovery {
  baseCommit: string;
  targetCommit: string;
  stagingBefore: string;
  worktree: string;
  resolvedCommit?: string;
  resultCommit?: string;
}

/**
 * Why and when a session was abandoned. Abandoning changes only the session
 * record; branches, worktrees, commits and recovery evidence stay in place.
 */
export interface SessionAbandonment {
  abandonedAt: string;
  /** User-supplied explanation; never a secret value. */
  reason: string;
  /** Status restored by `seshx restore`; currently always `active`. */
  previousStatus: SessionStatus;
  /** Audit bucket and evidence observed immediately before abandoning. */
  bucket: string;
  evidence: string[];
  /** Whether `--include-unsaved` was required and given. */
  includedUnsaved?: boolean;
  /** Set when the abandonment is moved to the history by a restore. */
  restoredAt?: string;
}

export interface Session {
  coordinator?: CoordinatorIdentity;
  recoveryCoordinator?: CoordinatorIdentity;
  localTargetRecovery?: LocalTargetRecovery;
  localTargetRecoveryHistory?: LocalTargetRecovery[];
  /** Missing in legacy sessions means Codex. */
  harness?: import("./harness.js").Harness;
  id: string;
  closedAt?: string;
  satisfiedBySessionId?: string;
  tasks?: SessionTask[];
  tasksUpdatedAt?: string;
  /**
   * Heartbeat set under the session record lock whenever a lifecycle or
   * `tasks` command records work. Read-only commands never set it. Missing in
   * records written only by older coordinators; never backfilled.
   */
  lastActivityAt?: string;
  /** Present only while the status is `abandoned`. */
  abandonment?: SessionAbandonment;
  /** Earlier abandonments undone by `seshx restore`, oldest first. */
  abandonmentHistory?: SessionAbandonment[];
  status: SessionStatus;
  repositoryPath: string;
  repositoryId: string;
  worktreePath: string;
  launchWorktreePath?: string;
  managedSourceWorktree?: boolean;
  branch: string;
  startCommit: string;
  integrationCommitAtStart: string | null;
  startedAt: string;
  taskSummary: string;
  dependsOn: string[];
  /** Delivery rule recorded by `begin` from a delivery policy; absent without one. */
  delivery?: SessionDelivery;
  readyCommit?: string;
  readyAt?: string;
  completionSummary?: string;
  rolloutDisposition?: RolloutDisposition;
  rolloutFollowUps?: string[];
  validationTier?: string;
  changedPaths?: string[];
  sourceValidatedAt?: string;
  sourceValidatedCommit?: string;
  sourceValidatedTree?: string;
  validationCacheEntries?: ValidationCacheEntry[];
  validationFailure?: ValidationFailureRecord;
  integratedCommit?: string;
  integratedAt?: string;
  targetBranch?: string;
  targetCommitBeforeIntegration?: string;
  promotedCommit?: string;
  promotedAt?: string;
  pullRequestUrl?: string;
  remotePromotedAt?: string;
  remoteRecoveryCommit?: string;
  remoteRecoveryBaseline?: string;
  remoteRecoveryAttempts?: number;
  recoveryPhase?:
    | "merge"
    | "post_integration"
    | "promotion"
    | "pull_request"
    | "remote_promotion"
    | "local_target";
  latestError?: string;
  conflictPromptPath?: string;
  conflictIntegrationHead?: string;
  integrationWorktreePath?: string;
  integrationWorktreeDetached?: boolean;
  awaitingConflictResolution?: boolean;
  waitingForLock?: boolean;
  /**
   * Written by a batching-aware `integrate` process while it waits for the
   * repository lock. Older coordinators never write it, so their waiting
   * sessions are never claimed into a batch.
   */
  integrationWait?: IntegrationWaiter;
  /** The latest integration batch this session led or joined. */
  integrationBatch?: IntegrationBatchMembership;
  /** Earlier batch memberships, oldest first. */
  integrationBatchHistory?: IntegrationBatchMembership[];
  postIntegrationResults?: CommandExecutionResult[];
  gitBaseline?: GitObservation;
  recoveryBundle?: RecoveryBundlePointer;
  latestIncidentId?: string;
}

export interface IntegrationWaiter {
  /** Batch protocol version the waiting process understands. */
  batching: 1;
  pid: number;
  hostname: string;
  since: string;
}

/**
 * How a session took part in an integration batch.
 * - `batched`: merged into a validated combined candidate; the session status
 *   reports its promotion result.
 * - `isolated`: integrated alone by the leader after a combined validation
 *   failed; the session status reports that result.
 * - `excluded`: its merge conflicted with the batch; it integrates alone.
 * - `released`: the batch ended without integrating it; it integrates itself.
 */
export interface IntegrationBatchMembership {
  id: string;
  leaderSessionId: string;
  role: "leader" | "member";
  joinedAt: string;
  /** Sessions merged into the latest candidate this session was part of, in merge order. */
  members: string[];
  outcome?: "batched" | "isolated" | "excluded" | "released";
  reason?: string;
  /** Validated staging commit shared by every member of the candidate. */
  stagingCommit?: string;
  validationTier?: string;
  resolvedAt?: string;
}

export interface Incident {
  version: 1;
  id: string;
  sessionId: string;
  repositoryId: string;
  createdAt: string;
  status: SessionStatus;
  phase?: Session["recoveryPhase"];
  fingerprint: string;
  category: string;
  confidence: "high" | "medium" | "low";
  diagnosis: string;
  proposedFix: string;
  fixScope: "instructions" | "project" | "environment" | "user-state";
  investigationSource: "agent" | "fallback";
  investigationError?: string;
  error: string;
  evidence: {
    readyCommit?: string;
    integratedCommit?: string;
    integrationWorktreePath?: string;
    conflictPromptPath?: string;
    validationFailure?: ValidationFailureRecord;
  };
}

export interface RecoveryBundlePointer {
  version: 1;
  attemptId: string;
  path: string;
  manifestHash: string;
  state: "open" | "archived";
  createdAt: string;
  archivedAt?: string;
}

export interface RecoverySnapshot {
  kind:
    | "conflict-index"
    | "merged-tree"
    | "staging-commit"
    | "validation"
    | "local-target";
  localTarget?: LocalTargetRecovery;
  sequence: number;
  createdAt: string;
  ref?: string;
  object?: string;
  indexFile?: string;
  indexHash?: string;
  validation?: {
    outcome: "passed" | "failed";
    tree: string;
    failure?: ValidationFailureRecord;
  };
}

export interface RecoveryBundleManifest {
  version: 1;
  sessionId: string;
  attemptId: string;
  repositoryId: string;
  createdAt: string;
  baseCommit: string;
  sourceCommit: string;
  targetCommit: string;
  refs: { base: string; source: string; target: string; rollout: string };
  rollout: { disposition: RolloutDisposition; followUps: string[] };
  snapshots: RecoverySnapshot[];
  archivedAt?: string;
  previousManifestHash?: string;
}

export interface ValidationFailureRecord {
  phase: "source" | "integration";
  command: Command;
  classification: "transient" | "unclassified";
  attempts: number;
  maxAttempts: number;
  exhausted: boolean;
  sharedResources: string[];
  exclusiveResources: string[];
  failedAt: string;
  message: string;
  /** Exit code of the failed command; absent when it could not be run. */
  exitCode?: number;
  /** Bounded, best-effort secret-redacted tail of the failed command output. */
  outputTail?: { stdout: string; stderr: string; truncated: boolean };
  /** Full redacted output under the runtime logs directory. */
  logPath?: string;
  /** Why the full log could not be written; the tail is still recorded. */
  logError?: string;
  /** Failing test names parsed from the output, when the runner reports them. */
  failingTests?: string[];
  /** First error line of the output when no failing test names were found. */
  firstErrorLine?: string;
  /** Shared build queue load when the failure was recorded. */
  queueLoad?: QueueLoadNote;
}

export interface QueueLoadNote {
  sampledAt: string;
  /** Running queue entries, counting the failed command when it ran. */
  running?: number;
  /** Waiting queue entries with live owners. */
  waiting?: number;
  capacity?: number | "unlimited";
  /** Why the queue could not be inspected. */
  unavailable?: string;
}

export interface GitCommandObservation extends CommandResult {
  args: string[];
}

export interface GitPathObservation {
  path: string;
  tracked: boolean;
  accessible: boolean;
  status: string | null;
  worktreeRaw: string | null;
  indexRaw: string | null;
  indexEntry: string | null;
  contentHash: string | null;
  errors: string[];
}

export interface GitObservation {
  version: 1;
  capturedAt: string;
  head: string;
  commands: {
    status: GitCommandObservation;
    worktreeDiff: GitCommandObservation;
    stagedDiff: GitCommandObservation;
    index: GitCommandObservation;
  };
  paths: GitPathObservation[];
  unscopedErrors: string[];
}

export interface LockMetadata {
  pid: number;
  hostname: string;
  sessionId: string;
  acquiredAt: string;
  startedAt: string;
}

export interface RuntimePaths {
  root: string;
  config: string;
  state: string;
  codexHome: string;
  sessions: string;
  locks: string;
  logs: string;
  worktrees: string;
  sourceWorktrees: string;
  indexes: string;
  performance: string;
  cache: string;
  recoveryBundles: string;
  recoveryWorktrees: string;
  incidents: string;
}

export interface ValidationCacheEntry {
  fingerprint: string;
  tree: string;
  command: Command;
  completedAt: string;
}

export interface SessionIndexEntry {
  version: 1;
  id: string;
  repositoryId: string;
  worktreePath: string;
  status: SessionStatus;
  startedAt: string;
  readyAt?: string;
  integratedAt?: string;
  promotedAt?: string;
  taskSummary: string;
  completionSummary?: string;
  updatedAt: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandExecutionResult {
  command: Command;
  exitCode: number;
  stdout: string;
  stderr: string;
}
