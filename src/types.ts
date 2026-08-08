export type Command = [string, ...string[]];

export interface RepositoryConfig {
  path: string;
  gitCommonDir: string;
  defaultBranch: string;
  integrationBranch: string;
  setupCommands: Command[];
  setupCommandPolicy?: "advisory" | "required";
  sourceValidationCommands: Command[];
  integrationValidationCommands: Command[];
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
  integratedCommit?: string;
  integratedAt?: string;
  latestError?: string;
  conflictPromptPath?: string;
  conflictIntegrationHead?: string;
  awaitingConflictResolution?: boolean;
  waitingForLock?: boolean;
  postIntegrationResults?: CommandExecutionResult[];
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
