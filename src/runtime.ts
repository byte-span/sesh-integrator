import {
  tryFileLock,
  releaseFileLock,
  withCleanup,
  type FileLock,
} from "./file-lock.js";
import { validateHarnessConfig } from "./harness.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  Config,
  RepositoryConfig,
  RuntimePaths,
  Session,
  SessionIndexEntry,
  SessionTask,
} from "./types.js";
import { isValidationStepList } from "./validation.js";

export const DEFAULT_INTEGRATION_BRANCH = "sesh-integrator/integration";

export function resolveRuntimeRoot(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  // Keep existing worktrees, locks, and session paths together after a rename.
  return (
    env.SESH_INTEGRATOR_HOME ??
    env.PARALLEL_INTEGRATOR_HOME ??
    env.CODEX_HANDOFF_HOME ??
    (existsSync(join(home, ".codex-handoff"))
      ? join(home, ".codex-handoff")
      : existsSync(join(home, ".parallel-integrator"))
        ? join(home, ".parallel-integrator")
        : join(home, ".sesh-integrator"))
  );
}

export function runtimePaths(): RuntimePaths {
  const root = resolveRuntimeRoot();
  return {
    root,
    config: join(root, "config.json"),
    state: join(root, "state.json"),
    codexHome: join(root, "codex-home"),
    sessions: join(root, "sessions"),
    locks: join(root, "locks"),
    logs: join(root, "logs"),
    worktrees: join(root, "worktrees"),
    sourceWorktrees: join(root, "source-worktrees"),
    indexes: join(root, "indexes"),
    performance: join(root, "performance"),
    cache: join(root, "cache"),
    recoveryBundles: join(root, "recovery-bundles"),
    recoveryWorktrees: join(root, "recovery-worktrees"),
    incidents: join(root, "incidents"),
  };
}

export const defaultConfig = (): Config => ({
  lockWaitSeconds: 900,
  codexCommand: "codex",
  conflictResolutionMode: "current-session",
  repositories: [],
});

export function applyGlobalTargetPolicy(
  config: Config,
  repository: Config["repositories"][number],
): void {
  Object.defineProperty(repository, "globalDefaultTargetBranch", {
    value: config.defaultTargetBranch,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  Object.defineProperty(repository, "globalDefaultPromotion", {
    value: config.defaultPromotion,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

export async function ensureRuntime(): Promise<RuntimePaths> {
  const paths = runtimePaths();
  // Worktree roots are prepared by capability preflight in the repository
  // being operated on. Runtime records must not depend on the caller's Git
  // context or recreate a blocked default worktree directory.
  await Promise.all([
    mkdir(paths.codexHome, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.locks, { recursive: true }),
    mkdir(join(paths.locks, "validation-resources"), { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(join(paths.indexes, "worktrees"), { recursive: true }),
    mkdir(join(paths.indexes, "repositories"), { recursive: true }),
    mkdir(paths.performance, { recursive: true }),
    mkdir(join(paths.cache, "setup"), { recursive: true }),
    mkdir(join(paths.cache, "validation"), { recursive: true }),
    mkdir(paths.recoveryBundles, { recursive: true }),
    mkdir(paths.incidents, { recursive: true }),
  ]);
  await chmod(paths.codexHome, 0o700);
  await writeJsonIfMissing(paths.config, defaultConfig());
  await writeJsonIfMissing(paths.state, { version: 1 });
  return paths;
}

export async function prepareCodexResolverHome(): Promise<string> {
  const paths = await ensureRuntime();
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  for (const name of ["auth.json", "config.toml"]) {
    const source = join(sourceHome, name);
    const target = join(paths.codexHome, name);
    if (source !== target && (await isNewer(source, target))) {
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
  }
  return paths.codexHome;
}

export async function readConfig(readOnly = false): Promise<Config> {
  const paths = readOnly ? runtimePaths() : await ensureRuntime();
  let value: Config;
  try {
    value = await readJson<Config>(paths.config);
  } catch (error) {
    if (readOnly && isNodeError(error) && error.code === "ENOENT")
      return defaultConfig();
    throw error;
  }
  if (
    !Array.isArray(value.repositories) ||
    (value.disabledRepositories !== undefined &&
      (!Array.isArray(value.disabledRepositories) ||
        !value.disabledRepositories.every(
          (path) => typeof path === "string" && isAbsolute(path),
        ))) ||
    typeof value.lockWaitSeconds !== "number" ||
    (value.defaultTargetBranch !== undefined &&
      (typeof value.defaultTargetBranch !== "string" ||
        value.defaultTargetBranch.length === 0)) ||
    !isDefaultPromotionConfig(value.defaultPromotion)
  ) {
    throw new Error(`Invalid configuration: ${paths.config}`);
  }
  for (const repository of value.repositories) {
    applyGlobalTargetPolicy(value, repository);
    repository.setupCommands ??= [];
    repository.validationTiers ??= [];
    repository.postIntegrationCommands ??= [];
    repository.promotion ??= { type: "none" };
    repository.validationCache ??= "session";
    if (
      !isValidationStepList(repository.sourceValidationCommands) ||
      !isValidationStepList(repository.integrationValidationCommands) ||
      !["off", "session", "repository"].includes(repository.validationCache) ||
      !isPromotionConfig(repository)
    ) {
      throw new Error(
        `Invalid validation configuration for ${repository.path}`,
      );
    }
    for (const tier of repository.validationTiers) {
      if (
        !isValidationStepList(tier.sourceValidationCommands) ||
        !isValidationStepList(tier.integrationValidationCommands)
      ) {
        throw new Error(
          `Invalid validation tier ${tier.name} for ${repository.path}`,
        );
      }
    }
    // targetBranch intentionally remains optional for backward compatibility.
    // Its effective value inherits the optional global policy, then falls back
    // to the registered defaultBranch.
    if (
      !repository.defaultBranch ||
      !repository.integrationBranch ||
      repository.targetBranch === ""
    ) {
      throw new Error(
        `Invalid branch configuration for ${repository.path}: defaultBranch and integrationBranch must be non-empty, and targetBranch must be omitted or non-empty`,
      );
    }
    if (
      repository.targetBranch === undefined &&
      (repository.integrationBranch === repository.defaultBranch ||
        repository.integrationBranch ===
          (value.defaultTargetBranch ?? repository.defaultBranch))
    ) {
      throw new Error(
        `Ambiguous branch configuration for ${repository.path}: integrationBranch ${repository.integrationBranch} equals the default or effective target while targetBranch is omitted. Existing integrationBranch values retain staging meaning; configure a separate staging branch or explicitly set targetBranch after reviewing the history.`,
      );
    }
    if (
      repository.promotion.type === "pull-request" &&
      repository.promotion.mode !== "session-branch" &&
      (repository.promotion.productionBranch ?? repository.defaultBranch) ===
        (repository.targetBranch ??
          value.defaultTargetBranch ??
          repository.defaultBranch)
    ) {
      throw new Error(
        `Invalid pull-request promotion for ${repository.path}: target and production branches must differ`,
      );
    }
  }
  validateHarnessConfig(value);
  value.conflictResolutionMode ??= "current-session";
  return value;
}

function isPromotionConfig(repository: RepositoryConfig): boolean {
  const promotion = repository.promotion;
  if (!promotion || promotion.type === "none") return true;
  return (
    promotion.type === "pull-request" &&
    (promotion.mode === undefined ||
      promotion.mode === "shared-target" ||
      promotion.mode === "session-branch") &&
    (promotion.productionBranch === undefined ||
      (typeof promotion.productionBranch === "string" &&
        isPlausibleBranchName(promotion.productionBranch))) &&
    (promotion.remote === undefined ||
      (typeof promotion.remote === "string" && promotion.remote.length > 0)) &&
    isOptionalParticipantList(promotion.reviewers) &&
    isOptionalParticipantList(promotion.assignees)
  );
}

function isPlausibleBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(value) &&
    !value
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock"))
  );
}

function isDefaultPromotionConfig(
  promotion: Config["defaultPromotion"],
): boolean {
  return (
    promotion === undefined ||
    (typeof promotion === "object" &&
      promotion !== null &&
      isOptionalParticipantList(promotion.reviewers) &&
      isOptionalParticipantList(promotion.assignees))
  );
}

function isOptionalParticipantList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((name) => typeof name === "string" && name.length > 0))
  );
}

export async function writeConfig(config: Config): Promise<void> {
  const paths = await ensureRuntime();
  await writeJsonAtomic(paths.config, config);
}

export async function readSessions(readOnly = false): Promise<Session[]> {
  const paths = readOnly ? runtimePaths() : await ensureRuntime();
  let entries: string[];
  try {
    entries = await readdir(paths.sessions);
  } catch (error) {
    if (readOnly && isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const names = entries.filter((name) => name.endsWith(".json"));
  const sessions = await Promise.all(
    names.map((name) => readJson<Session>(join(paths.sessions, name))),
  );
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function writeSession(session: Session): Promise<void> {
  await withSessionRecordLock(session.id, async () => {
    // Lifecycle commands hold snapshots while running checks. Checklist edits
    // made meanwhile belong to the task command and must not be overwritten.
    const latest = await readSession(session.id);
    if (latest?.status === "no_changes" && session.status !== "no_changes")
      throw new Error(
        "Session is already finished without changes; start a new session.",
      );
    if (latest) {
      if (latest.tasks) session.tasks = latest.tasks;
      else delete session.tasks;
      if (latest.tasksUpdatedAt) session.tasksUpdatedAt = latest.tasksUpdatedAt;
      else delete session.tasksUpdatedAt;
    }
    await writeSessionRecord(session);
  });
}

export async function updateSessionTasks(
  sessionId: string,
  update: (tasks: SessionTask[]) => SessionTask[],
): Promise<Session> {
  return withSessionRecordLock(sessionId, async () => {
    const session = await readSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.status === "no_changes")
      throw new Error(
        "Session is already finished without changes; start a new session.",
      );
    session.tasks = update(session.tasks ?? []);
    session.tasksUpdatedAt = new Date().toISOString();
    await writeSessionRecord(session);
    return session;
  });
}

export async function finishNoChangesSession(
  sessionId: string,
  verify: (session: Session) => Promise<void>,
): Promise<Session> {
  return withSessionRecordLock(sessionId, async () => {
    const session = await readSession(sessionId);
    if (!session || session.status !== "active")
      throw new Error("Only an active session can finish without changes.");
    if (
      session.readyCommit ||
      session.recoveryBundle ||
      session.integratedCommit ||
      session.promotedCommit ||
      session.waitingForLock
    )
      throw new Error(
        "Session has integration or recovery state; complete its existing lifecycle.",
      );
    if (
      session.tasks?.some(
        (task) => !["completed", "skipped"].includes(task.status),
      )
    )
      throw new Error(
        "Finish or skip every task with a reason before finishing the session.",
      );
    await verify(session);
    session.status = "no_changes";
    session.closedAt = new Date().toISOString();
    await writeSessionRecord(session);
    return session;
  });
}

async function writeSessionRecord(session: Session): Promise<void> {
  const paths = await ensureRuntime();
  await writeJsonAtomic(join(paths.sessions, `${session.id}.json`), session);
  await Promise.all([
    writeJsonAtomic(worktreeIndexPath(paths, session.worktreePath), {
      version: 1,
      worktreePath: session.worktreePath,
      sessionId: session.id,
      status: session.status,
      updatedAt: new Date().toISOString(),
    }),
    writeJsonAtomic(repositoryIndexPath(paths, session), {
      version: 1,
      id: session.id,
      repositoryId: session.repositoryId,
      worktreePath: session.worktreePath,
      status: session.status,
      startedAt: session.startedAt,
      readyAt: session.readyAt,
      integratedAt: session.integratedAt,
      promotedAt: session.promotedAt,
      taskSummary: session.taskSummary,
      completionSummary: session.completionSummary,
      updatedAt: new Date().toISOString(),
    }),
  ]);
}

export async function readSession(
  sessionId: string,
): Promise<Session | undefined> {
  const paths = await ensureRuntime();
  try {
    return await readJson<Session>(join(paths.sessions, `${sessionId}.json`));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readRepositorySessionIndex(
  repositoryId: string,
): Promise<SessionIndexEntry[]> {
  const paths = await ensureRuntime();
  const directory = join(paths.indexes, "repositories", repositoryId);
  try {
    const names = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    if (names.length > 0) {
      return await Promise.all(
        names.map((name) => readJson<SessionIndexEntry>(join(directory, name))),
      );
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  return (await readSessions())
    .filter((session) => session.repositoryId === repositoryId)
    .map((session) => ({
      version: 1,
      id: session.id,
      repositoryId: session.repositoryId,
      worktreePath: session.worktreePath,
      status: session.status,
      startedAt: session.startedAt,
      ...(session.readyAt ? { readyAt: session.readyAt } : {}),
      ...(session.integratedAt ? { integratedAt: session.integratedAt } : {}),
      ...(session.promotedAt ? { promotedAt: session.promotedAt } : {}),
      taskSummary: session.taskSummary,
      ...(session.completionSummary
        ? { completionSummary: session.completionSummary }
        : {}),
      updatedAt:
        session.promotedAt ?? session.integratedAt ?? session.startedAt,
    }));
}

export async function findLatestSessionForWorktree(
  worktreePath: string,
  statuses: Session["status"][],
): Promise<Session | undefined> {
  const paths = await ensureRuntime();
  try {
    const pointer = await readJson<{
      worktreePath: string;
      sessionId: string;
      status: Session["status"];
    }>(worktreeIndexPath(paths, worktreePath));
    if (
      pointer.worktreePath === worktreePath &&
      statuses.includes(pointer.status)
    ) {
      return await readJson<Session>(
        join(paths.sessions, `${pointer.sessionId}.json`),
      );
    }
    if (pointer.worktreePath === worktreePath) return undefined;
  } catch {
    // Older runtimes are indexed lazily below.
  }
  const session = (await readSessions())
    .filter(
      (item) =>
        item.worktreePath === worktreePath && statuses.includes(item.status),
    )
    .at(-1);
  if (session) await writeSession(session);
  return session;
}

export async function writeLog(
  name: string,
  contents: string,
): Promise<string> {
  const paths = await ensureRuntime();
  const path = join(paths.logs, name);
  await writeFile(path, contents, "utf8");
  return path;
}

export function makeSessionId(): string {
  return `session_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

export function repoId(gitCommonDir: string): string {
  return randomStableId(gitCommonDir);
}

function randomStableId(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function worktreeIndexPath(paths: RuntimePaths, worktreePath: string): string {
  const key = createHash("sha256").update(worktreePath).digest("hex");
  return join(paths.indexes, "worktrees", `${key}.json`);
}

function repositoryIndexPath(paths: RuntimePaths, session: Session): string {
  return join(
    paths.indexes,
    "repositories",
    session.repositoryId,
    `${session.id}.json`,
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJsonIfMissing(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString(
    "hex",
  )}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function isNewer(source: string, target: string): Promise<boolean> {
  try {
    const sourceStat = await stat(source);
    try {
      return sourceStat.mtimeMs > (await stat(target)).mtimeMs;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Serialize CLI config read/modify/write operations without reclaiming unknown owners. */
export async function withConfigLock<T>(action: () => Promise<T>): Promise<T> {
  const paths = await ensureRuntime();
  return withRecordLock(
    join(paths.locks, "configuration"),
    "Configuration",
    action,
  );
}

async function withSessionRecordLock<T>(
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
  const paths = await ensureRuntime();
  return withRecordLock(
    join(paths.locks, `session-record-${id}`),
    "Session record",
    action,
  );
}

async function withRecordLock<T>(
  lock: string,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 5000;
  let handle: FileLock | undefined;
  while (!(handle = await tryFileLock(lock))) {
    if (Date.now() >= deadline)
      throw new Error(
        `${label} is locked: ${lock}. Retry after the other command finishes; inspect a leftover file or legacy directory lock manually.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const owned = handle;
  return withCleanup(action, () => releaseFileLock(owned));
}
