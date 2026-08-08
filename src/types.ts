export type Command = [string, ...string[]];

export interface ValidationTier {
  name: string;
  paths: string[];
  sourceValidationCommands: Command[];
  integrationValidationCommands: Command[];
  bypassIntegrationWorktree?: boolean;
}

export interface RepositoryConfig {
  path: string;
  gitCommonDir: string;
  defaultBranch: string;
  integrationBranch: string;
  setupCommands: Command[];
  setupCommandPolicy?: "advisory" | "required";
  sourceValidationCommands: Command[];
  integrationValidationCommands: Command[];
  validationTiers?: ValidationTier[];
  postIntegrationCommands: Command[];
  conflictInstructions: string;
}

export interface Config {
  lockWaitSeconds: number;
  codexCommand: string;
  conflictResolutionMode?: "current-session" | "nested-codex";
  repositories: RepositoryConfig[];
}

export type SessionStatus = "active" | "ready" | "succeeded" | "needs_review";

export interface Session {
  id: string;
  status: SessionStatus;
  repositoryPath: string;
  repositoryId: string;
  worktreePath: string;
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
  integratedCommit?: string;
  integratedAt?: string;
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
