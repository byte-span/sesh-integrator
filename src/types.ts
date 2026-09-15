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

export interface Config {
  /** Canonical Git common directories, independent of registration. */
  disabledRepositories?: string[];
  lockWaitSeconds: number;
  codexCommand: string;
  conflictResolutionMode?: "current-session" | "nested-codex";
  defaultTargetBranch?: string;
  defaultPromotion?: DefaultPromotionConfig;
  repositories: RepositoryConfig[];
}

export type SessionStatus =
  | "active"
  | "ready"
  | "validation_pending"
  | "promotion_pending"
  | "succeeded"
  | "no_changes"
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

export interface Session {
  id: string;
  closedAt?: string;
  satisfiedBySessionId?: string;
  tasks?: SessionTask[];
  tasksUpdatedAt?: string;
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
    | "remote_promotion";
  latestError?: string;
  conflictPromptPath?: string;
  conflictIntegrationHead?: string;
  integrationWorktreePath?: string;
  integrationWorktreeDetached?: boolean;
  awaitingConflictResolution?: boolean;
  waitingForLock?: boolean;
  postIntegrationResults?: CommandExecutionResult[];
  gitBaseline?: GitObservation;
  recoveryBundle?: RecoveryBundlePointer;
  latestIncidentId?: string;
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
  kind: "conflict-index" | "merged-tree" | "staging-commit" | "validation";
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
