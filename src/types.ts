export type Command = [string, ...string[]];

export interface ParallelCommandGroup {
  parallel: Command[];
}

export type ValidationStep = Command | ParallelCommandGroup;

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
  lockWaitSeconds: number;
  codexCommand: string;
  conflictResolutionMode?: "current-session" | "nested-codex";
  defaultTargetBranch?: string;
  defaultPromotion?: DefaultPromotionConfig;
  repositories: RepositoryConfig[];
}

export type SessionStatus =
  "active" | "ready" | "promotion_pending" | "succeeded" | "needs_review";

export interface Session {
  id: string;
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
  validationTier?: string;
  changedPaths?: string[];
  sourceValidatedAt?: string;
  sourceValidatedCommit?: string;
  sourceValidatedTree?: string;
  validationCacheEntries?: ValidationCacheEntry[];
  integratedCommit?: string;
  integratedAt?: string;
  targetBranch?: string;
  targetCommitBeforeIntegration?: string;
  promotedCommit?: string;
  promotedAt?: string;
  pullRequestUrl?: string;
  remotePromotedAt?: string;
  recoveryPhase?: "merge" | "post_integration" | "promotion" | "pull_request";
  latestError?: string;
  conflictPromptPath?: string;
  conflictIntegrationHead?: string;
  awaitingConflictResolution?: boolean;
  waitingForLock?: boolean;
  postIntegrationResults?: CommandExecutionResult[];
  gitBaseline?: GitObservation;
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
