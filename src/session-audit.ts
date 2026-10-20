import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  coordinatorHealth,
  unfinished,
  type CoordinatorHealth,
} from "./coordinator.js";
import { readLockMetadata } from "./lock.js";
import { run } from "./process.js";
import { targetBranch } from "./promotion.js";
import { readConfig, readSessions, repoId, runtimePaths } from "./runtime.js";
import { taskProgress } from "./tasks.js";
import type { CommandResult, Config, Session, SessionStatus } from "./types.js";

/**
 * Read-only stale-session audit. Every unfinished session receives exactly one
 * bucket with the evidence behind it. Liveness is inferred from recorded state,
 * Git and file times; nothing here proves that an agent has stopped working.
 *
 * Precedence (first match wins) keeps the riskiest interpretation:
 * lifecycle > unsaved > other (incomplete inspection) > corrupt > delivered >
 * empty > other.
 */
export type AuditBucket =
  "empty" | "delivered" | "unsaved" | "corrupt" | "lifecycle" | "other";

/** Display order, matching the documented bucket list. */
export const AUDIT_BUCKETS: readonly AuditBucket[] = [
  "empty",
  "delivered",
  "unsaved",
  "corrupt",
  "lifecycle",
  "other",
];

export const AUDIT_BUCKET_LABELS: Record<AuditBucket, string> = {
  empty: "empty",
  delivered: "delivered",
  unsaved: "unsaved work",
  corrupt: "corrupt",
  lifecycle: "in lifecycle",
  other: "other",
};

export const LIVENESS_NOTICE =
  "Liveness is inferred from session records, Git and file times, never proven. An agent may still be working in any listed session.";

export type ActivitySource =
  "lastActivityAt" | "tasksUpdatedAt" | "startedAt" | "worktreeModifiedAt";

export interface SessionActivity {
  at: string;
  source: ActivitySource;
}

/**
 * Record fields that indicate session activity, in priority order. The most
 * recent valid value wins and ties keep the earlier field, so legacy records
 * fall back from the `lastActivityAt` heartbeat to `tasksUpdatedAt`, then
 * `startedAt`. Taking the most recent value also covers records rewritten by
 * older coordinators, which keep an existing heartbeat but do not refresh it
 * when they update the checklist. The source worktree modification time is
 * used only when no record field is valid. Add newer heartbeat fields here so
 * every idle calculation stays consistent.
 */
const recordActivitySources: readonly {
  source: ActivitySource;
  read: (session: Session) => string | undefined;
}[] = [
  { source: "lastActivityAt", read: (session) => session.lastActivityAt },
  { source: "tasksUpdatedAt", read: (session) => session.tasksUpdatedAt },
  { source: "startedAt", read: (session) => session.startedAt },
];

export function lastActivity(
  session: Session,
  worktreeModifiedAt?: string | null,
): SessionActivity | undefined {
  let latest: { source: ActivitySource; time: number } | undefined;
  for (const { source, read } of recordActivitySources) {
    const time = parseTime(read(session));
    if (time !== undefined && (!latest || time > latest.time))
      latest = { source, time };
  }
  if (!latest) {
    const time = parseTime(worktreeModifiedAt);
    if (time !== undefined) latest = { source: "worktreeModifiedAt", time };
  }
  return latest
    ? { at: new Date(latest.time).toISOString(), source: latest.source }
    : undefined;
}

function parseTime(value: unknown): number | undefined {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the activity; future timestamps count as zero. */
export function idleDays(
  activity: SessionActivity | undefined,
  now = new Date(),
): number | null {
  if (!activity) return null;
  return Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(activity.at)) / DAY_MS),
  );
}

export interface SessionAuditFacts {
  repositoryExists: boolean;
  worktreeExists: boolean;
  /** Branch checked out in the worktree, `null` when detached or unknown. */
  worktreeBranch: string | null;
  worktreeHead: string | null;
  /** Whether the worktree's state is attributed to this session. */
  worktreeAttributed: boolean;
  worktreeModifiedAt: string | null;
  /** Attributed uncommitted paths; `null` when not inspected. */
  uncommittedPaths: string[] | null;
  branchExists: boolean | null;
  branchHead: string | null;
  startCommitExists: boolean | null;
  targetBranch: string | null;
  targetHead: string | null;
  sourceCommit: string | null;
  commitsSinceStart: number | null;
  unintegratedCommits: number | null;
  taskCount: number;
  coordinator: CoordinatorHealth;
  holdsRepositoryLock: boolean;
  recordLockPresent: boolean;
}

export interface SessionAudit {
  sessionId: string;
  status: SessionStatus;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  taskSummary: string;
  startedAt: string;
  bucket: AuditBucket;
  /** Observations that decided the bucket. */
  evidence: string[];
  /** Other observations useful for review. */
  notes: string[];
  lastActivity: SessionActivity | null;
  idleDays: number | null;
  facts: SessionAuditFacts;
}

export interface AuditContext {
  config: Config;
  now: Date;
  locksDirectory: string;
  coordinatorCache: Map<string, Promise<CoordinatorHealth>>;
  repositoryLockCache: Map<string, Promise<string | null>>;
  /**
   * Sessions whose record lock the caller itself holds, such as `abandon`
   * rechecking a session under its lock. Their lock is not another owner.
   */
  heldRecordLocks?: ReadonlySet<string>;
}

export async function createAuditContext(
  overrides: Partial<AuditContext> = {},
): Promise<AuditContext> {
  return {
    config: overrides.config ?? (await readConfig(true)),
    now: overrides.now ?? new Date(),
    locksDirectory: overrides.locksDirectory ?? runtimePaths().locks,
    coordinatorCache: overrides.coordinatorCache ?? new Map(),
    repositoryLockCache: overrides.repositoryLockCache ?? new Map(),
    ...(overrides.heldRecordLocks
      ? { heldRecordLocks: overrides.heldRecordLocks }
      : {}),
  };
}

const lifecycleStatuses: Partial<Record<SessionStatus, string>> = {
  ready: "status ready: integration was started for a ready snapshot",
  validation_pending:
    "status validation_pending: resumable integration validation failure",
  promotion_pending:
    "status promotion_pending: validated commit awaits target promotion",
  needs_review: "status needs_review: preserved integration needs recovery",
};
// `abandoned` is terminal and excluded from `auditSessions`, but `abandon`
// and `restore` may still classify such a record directly.
const knownStatuses = new Set<string>([
  "active",
  "abandoned",
  ...Object.keys(lifecycleStatuses),
]);

export interface SessionAuditOptions {
  /** Restrict to sessions of the repository containing this path. */
  repo?: string;
  /** Keep only sessions idle for at least this many whole days. */
  idleDays?: number;
  now?: Date;
}

/** Classify every unfinished session without changing any state. */
export async function auditSessions(
  options: SessionAuditOptions = {},
): Promise<SessionAudit[]> {
  const [config, sessions] = await Promise.all([
    readConfig(true),
    readSessions(true),
  ]);
  const context = await createAuditContext({
    config,
    ...(options.now ? { now: options.now } : {}),
  });
  let selected = sessions.filter(unfinished);
  if (options.repo !== undefined) {
    const matches = await repositoryMatcher(options.repo);
    selected = selected.filter(matches);
  }
  const audits: SessionAudit[] = [];
  // Sequential to keep subprocess use modest on large runtimes.
  for (const session of selected)
    audits.push(await classifySession(session, context));
  const minimum = options.idleDays;
  const filtered =
    minimum === undefined
      ? audits
      : audits.filter(
          (audit) => audit.idleDays !== null && audit.idleDays >= minimum,
        );
  return filtered.sort(
    (a, b) =>
      AUDIT_BUCKETS.indexOf(a.bucket) - AUDIT_BUCKETS.indexOf(b.bucket) ||
      (b.idleDays ?? -1) - (a.idleDays ?? -1) ||
      a.startedAt.localeCompare(b.startedAt),
  );
}

async function repositoryMatcher(
  path: string,
): Promise<(session: Session) => boolean> {
  const absolute = resolve(path);
  const commonDir = await gitCommonDir(absolute);
  if (commonDir) {
    const id = repoId(commonDir);
    return (session) => session.repositoryId === id;
  }
  // A registered repository may have been moved or removed; match its path.
  return (session) => session.repositoryPath === absolute;
}

/** Classify one session. Safe to call for any session record; read-only. */
export async function classifySession(
  session: Session,
  supplied?: AuditContext,
): Promise<SessionAudit> {
  const context = supplied ?? (await createAuditContext());
  const facts = await inspectSession(session, context);
  const inspectionErrors = facts.errors.map(
    (error) => `inspection incomplete: ${error}`,
  );
  const lifecycle = lifecycleEvidence(session, facts, context);
  const corrupt: string[] = [];
  const unsaved: string[] = [];
  const notes: string[] = [];
  const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "?");

  if (!facts.repositoryExists)
    corrupt.push(`repository path missing: ${session.repositoryPath}`);
  if (!facts.worktreeExists)
    corrupt.push(`worktree missing: ${session.worktreePath}`);
  else if (facts.worktreeNotGit)
    corrupt.push(`worktree is not a Git worktree: ${session.worktreePath}`);
  else if (facts.worktreeForeign)
    corrupt.push(
      `worktree belongs to a different repository: ${session.worktreePath}`,
    );
  else if (!facts.worktreeAttributed && facts.worktreeHead)
    corrupt.push(
      `worktree has ${facts.worktreeBranch ?? `detached HEAD ${short(facts.worktreeHead)}`} checked out, not session branch ${session.branch}; its working-tree state is not attributed to this session`,
    );
  if (facts.branchExists === false)
    corrupt.push(`session branch missing: ${session.branch}`);
  if (facts.startCommitExists === false)
    corrupt.push(`start commit missing: ${session.startCommit}`);
  if (facts.coordinator === "missing" || facts.coordinator === "modified")
    corrupt.push(
      `pinned coordinator ${facts.coordinator}: ${session.coordinator?.cliPath ?? "-"}`,
    );
  if (facts.coordinator === "legacy")
    notes.push("legacy session without a pinned coordinator");

  if (facts.uncommittedPaths?.length) {
    const sample = facts.uncommittedPaths.slice(0, 5).join(", ");
    unsaved.push(
      `${facts.uncommittedPaths.length} uncommitted path(s) in worktree: ${sample}${facts.uncommittedPaths.length > 5 ? ", ..." : ""}`,
    );
    const baseline = session.gitBaseline?.paths.length ?? 0;
    if (baseline)
      notes.push(
        `${baseline} pre-existing path(s) were recorded at begin; some uncommitted files may predate the session`,
      );
  }
  if (facts.unintegratedCommits)
    unsaved.push(
      facts.targetHead
        ? `${facts.unintegratedCommits} commit(s) at ${short(facts.sourceCommit)} not reachable from target ${facts.targetBranch} (${short(facts.targetHead)})`
        : `${facts.unintegratedCommits} commit(s) since start at ${short(facts.sourceCommit)}; target ${facts.targetBranch ?? "branch unknown"} unavailable, so treated as unintegrated`,
    );

  const checklist =
    facts.taskCount > 0
      ? `checklist present (${taskProgress(session)})`
      : "no checklist";
  const clean =
    facts.worktreeAttributed && facts.uncommittedPaths?.length === 0;

  let bucket: AuditBucket;
  let evidence: string[];
  if (!knownStatuses.has(session.status)) {
    bucket = "other";
    evidence = [`unrecognized unfinished status ${session.status}`];
  } else if (lifecycle.length) {
    bucket = "lifecycle";
    evidence = lifecycle;
  } else if (unsaved.length) {
    bucket = "unsaved";
    evidence = unsaved;
  } else if (inspectionErrors.length) {
    bucket = "other";
    evidence = inspectionErrors;
  } else if (corrupt.length) {
    bucket = "corrupt";
    evidence = corrupt;
  } else if (
    facts.commitsSinceStart !== null &&
    facts.commitsSinceStart > 0 &&
    facts.unintegratedCommits === 0 &&
    facts.targetHead
  ) {
    bucket = "delivered";
    evidence = [
      `source commit ${short(facts.sourceCommit)} (${facts.commitsSinceStart} commit(s) since start) is reachable from target ${facts.targetBranch} (${short(facts.targetHead)})`,
      ...(clean ? ["worktree clean"] : []),
    ];
  } else if (facts.commitsSinceStart === 0 && clean && facts.taskCount === 0) {
    bucket = "empty";
    evidence = [
      `no commits since start ${short(session.startCommit)}`,
      "worktree clean",
      "no checklist",
    ];
  } else {
    bucket = "other";
    evidence =
      facts.commitsSinceStart === 0
        ? [
            `no commits since start ${short(session.startCommit)}, but ${facts.taskCount > 0 ? checklist : "worktree state could not be confirmed clean"}`,
          ]
        : [
            `could not establish delivery: ${facts.commitsSinceStart ?? "unknown"} commit(s) since start, target ${facts.targetBranch ?? "unknown"}`,
          ];
  }
  // Keep every other finding visible without changing the bucket.
  for (const line of [
    ...lifecycle,
    ...unsaved,
    ...inspectionErrors,
    ...corrupt,
  ])
    if (!evidence.includes(line)) notes.push(line);
  if (facts.taskCount > 0 && !evidence.some((line) => line.includes(checklist)))
    notes.push(checklist);

  const activity = lastActivity(session, facts.worktreeModifiedAt);
  const {
    errors: _errors,
    worktreeNotGit: _a,
    worktreeForeign: _b,
    ...publicFacts
  } = facts;
  return {
    sessionId: session.id,
    status: session.status,
    repositoryPath: session.repositoryPath,
    worktreePath: session.worktreePath,
    branch: session.branch,
    taskSummary: session.taskSummary,
    startedAt: session.startedAt,
    bucket,
    evidence,
    notes,
    lastActivity: activity ?? null,
    idleDays: idleDays(activity, context.now),
    facts: publicFacts,
  };
}

function lifecycleEvidence(
  session: Session,
  facts: SessionAuditFacts,
  context: AuditContext,
): string[] {
  const evidence: string[] = [];
  const status = lifecycleStatuses[session.status];
  if (status) evidence.push(status);
  if (session.waitingForLock)
    evidence.push("recorded as waiting for the repository lock");
  if (session.awaitingConflictResolution)
    evidence.push("awaiting conflict resolution");
  if (session.recoveryPhase)
    evidence.push(`recovery phase ${session.recoveryPhase}`);
  if (session.recoveryBundle?.state === "open")
    evidence.push(`open recovery bundle ${session.recoveryBundle.path}`);
  if (session.localTargetRecovery)
    evidence.push("local target recovery recorded");
  if (facts.holdsRepositoryLock)
    evidence.push(
      `holds repository lock ${join(context.locksDirectory, `${session.repositoryId}.lock`)}`,
    );
  if (facts.recordLockPresent)
    evidence.push(
      `session record lock present ${join(context.locksDirectory, `session-record-${session.id}`)}`,
    );
  return evidence;
}

interface InspectedFacts extends SessionAuditFacts {
  errors: string[];
  worktreeNotGit: boolean;
  worktreeForeign: boolean;
}

async function inspectSession(
  session: Session,
  context: AuditContext,
): Promise<InspectedFacts> {
  const errors: string[] = [];
  const facts: InspectedFacts = {
    repositoryExists: await isDirectory(session.repositoryPath),
    worktreeExists: false,
    worktreeBranch: null,
    worktreeHead: null,
    worktreeAttributed: false,
    worktreeModifiedAt: null,
    uncommittedPaths: null,
    branchExists: null,
    branchHead: null,
    startCommitExists: null,
    targetBranch: null,
    targetHead: null,
    sourceCommit: null,
    commitsSinceStart: null,
    unintegratedCommits: null,
    taskCount: session.tasks?.length ?? 0,
    coordinator: await cachedCoordinatorHealth(session, context),
    holdsRepositoryLock:
      (await repositoryLockOwner(session.repositoryId, context)) === session.id,
    recordLockPresent:
      !context.heldRecordLocks?.has(session.id) &&
      (await exists(
        join(context.locksDirectory, `session-record-${session.id}`),
      )),
    errors,
    worktreeNotGit: false,
    worktreeForeign: false,
  };
  const repository = context.config.repositories.find(
    (item) => repoId(item.gitCommonDir) === session.repositoryId,
  );
  facts.targetBranch =
    session.targetBranch ?? (repository ? targetBranch(repository) : null);
  const expectedCommonDir =
    repository?.gitCommonDir ??
    (facts.repositoryExists
      ? await gitCommonDir(session.repositoryPath)
      : null);

  const worktreeStat = await statOrNull(session.worktreePath);
  facts.worktreeExists = worktreeStat?.isDirectory() ?? false;
  if (worktreeStat) facts.worktreeModifiedAt = worktreeStat.mtime.toISOString();
  let worktreeUsable = false;
  if (facts.worktreeExists) {
    const top = await gitRead(
      ["rev-parse", "--show-toplevel"],
      session.worktreePath,
    );
    if (top.code !== 0) {
      if (/not a git repository/i.test(top.stderr)) facts.worktreeNotGit = true;
      else errors.push(gitError("inspect worktree", top));
    } else if (
      (await realpathOrNull(top.stdout.trim())) !==
      (await realpathOrNull(session.worktreePath))
    ) {
      facts.worktreeNotGit = true;
    } else {
      const commonDir = await gitCommonDir(session.worktreePath);
      if (
        expectedCommonDir &&
        commonDir &&
        (await realpathOrNull(expectedCommonDir)) !== commonDir
      )
        facts.worktreeForeign = true;
      else worktreeUsable = true;
    }
  }
  if (worktreeUsable) {
    const [branch, head] = await Promise.all([
      gitRead(
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        session.worktreePath,
      ),
      gitRead(
        ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        session.worktreePath,
      ),
    ]);
    facts.worktreeBranch = branch.code === 0 ? branch.stdout.trim() : null;
    facts.worktreeHead = head.code === 0 ? head.stdout.trim() : null;
    facts.worktreeAttributed =
      facts.worktreeBranch === session.branch ||
      (facts.worktreeBranch === null && session.managedSourceWorktree === true);
    if (facts.worktreeAttributed) {
      const status = await gitRead(
        ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        session.worktreePath,
      );
      if (status.code === 0)
        facts.uncommittedPaths = porcelainPaths(status.stdout);
      else errors.push(gitError("read worktree status", status));
    }
  }

  const gitCwd = facts.repositoryExists
    ? session.repositoryPath
    : worktreeUsable
      ? session.worktreePath
      : null;
  if (!gitCwd) return facts;
  const [branchHead, startExists, targetHead] = await Promise.all([
    commitOf(gitCwd, `refs/heads/${session.branch}`),
    commitOf(gitCwd, session.startCommit),
    facts.targetBranch
      ? commitOf(gitCwd, `refs/heads/${facts.targetBranch}`)
      : Promise.resolve(null),
  ]);
  facts.branchHead = branchHead;
  facts.branchExists = branchHead !== null;
  facts.startCommitExists = startExists !== null;
  facts.targetHead = targetHead;
  const heads = [
    ...new Set(
      [facts.worktreeAttributed ? facts.worktreeHead : null, branchHead].filter(
        (head): head is string => head !== null,
      ),
    ),
  ];
  facts.sourceCommit = heads[0] ?? null;
  if (!heads.length) return facts;
  const start = facts.startCommitExists ? [session.startCommit] : [];
  let since: number | null = start.length ? 0 : null;
  let unintegrated: number | null = 0;
  for (const head of heads) {
    // Only the session's own commits count: commits already present at start
    // (for example on a reused in-place branch) are not its unsaved work.
    const ahead = start.length
      ? await revCount(gitCwd, [head, "--not", ...start], errors)
      : null;
    const outside = targetHead
      ? await revCount(gitCwd, [head, "--not", ...start, targetHead], errors)
      : ahead;
    since = since === null || ahead === null ? null : Math.max(since, ahead);
    unintegrated =
      unintegrated === null || outside === null
        ? null
        : Math.max(unintegrated, outside);
  }
  facts.commitsSinceStart = since;
  facts.unintegratedCommits = unintegrated;
  return facts;
}

/** Git invocation that never takes optional locks (e.g. index refresh). */
async function gitRead(args: string[], cwd: string): Promise<CommandResult> {
  return run("git", ["--no-optional-locks", ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function commitOf(cwd: string, ref: string): Promise<string | null> {
  const result = await gitRead(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    cwd,
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

async function revCount(
  cwd: string,
  revisions: string[],
  errors: string[],
): Promise<number | null> {
  const result = await gitRead(["rev-list", "--count", ...revisions], cwd);
  const count = Number(result.stdout.trim());
  if (result.code === 0 && Number.isSafeInteger(count)) return count;
  errors.push(gitError(`count commits ${revisions.join(" ")}`, result));
  return null;
}

async function gitCommonDir(cwd: string): Promise<string | null> {
  if (!(await isDirectory(cwd))) return null;
  const result = await gitRead(["rev-parse", "--git-common-dir"], cwd);
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  return realpathOrNull(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

function porcelainPaths(output: string): string[] {
  const records = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    // Renames and copies carry their original path as the next record.
    if (/^[RC]/.test(record) || /^.[RC]/.test(record)) index += 1;
  }
  return paths;
}

function gitError(action: string, result: CommandResult): string {
  const detail = (result.stderr || result.stdout).trim().split("\n")[0];
  return `${action} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`;
}

async function cachedCoordinatorHealth(
  session: Session,
  context: AuditContext,
): Promise<CoordinatorHealth> {
  if (!session.coordinator) return "legacy";
  const key = `${session.coordinator.buildId}\0${session.coordinator.cliPath}`;
  let health = context.coordinatorCache.get(key);
  if (!health) {
    health = coordinatorHealth(session);
    context.coordinatorCache.set(key, health);
  }
  return health;
}

async function repositoryLockOwner(
  repositoryId: string,
  context: AuditContext,
): Promise<string | null> {
  let owner = context.repositoryLockCache.get(repositoryId);
  if (!owner) {
    owner = readLockMetadata(
      join(context.locksDirectory, `${repositoryId}.lock`),
    ).then((metadata) => metadata?.sessionId ?? null);
    context.repositoryLockCache.set(repositoryId, owner);
  }
  return owner;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isDirectory() ?? false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

const usage =
  "Usage: seshx sessions audit [--repo <path>] [--idle-days <n>] [--json]";

export async function sessionsCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "audit") throw new Error(usage);
  const options: SessionAuditOptions = {};
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const value = rest[index + 1];
    if (argument === "--json" && !json) json = true;
    else if (
      argument === "--repo" &&
      options.repo === undefined &&
      value &&
      !value.startsWith("--")
    ) {
      options.repo = value;
      index += 1;
    } else if (
      argument === "--idle-days" &&
      options.idleDays === undefined &&
      value !== undefined &&
      /^\d+$/.test(value)
    ) {
      options.idleDays = Number(value);
      index += 1;
    } else throw new Error(usage);
  }
  const now = new Date();
  const audits = await auditSessions({ ...options, now });
  const counts = Object.fromEntries(
    AUDIT_BUCKETS.map((bucket) => [
      bucket,
      audits.filter((audit) => audit.bucket === bucket).length,
    ]),
  ) as Record<AuditBucket, number>;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          readOnly: true,
          liveness: "inferred, never proven",
          notice: LIVENESS_NOTICE,
          generatedAt: now.toISOString(),
          runtime: runtimePaths().root,
          filters: {
            repo: options.repo ? resolve(options.repo) : null,
            idleDays: options.idleDays ?? null,
          },
          counts,
          sessions: audits,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [
    "Session audit (read-only; nothing was changed)",
    LIVENESS_NOTICE,
    "Confirm with the session's owner before closing it.",
    `Runtime: ${runtimePaths().root}`,
  ];
  const filters = [
    ...(options.repo ? [`repository ${resolve(options.repo)}`] : []),
    ...(options.idleDays !== undefined
      ? [`idle at least ${options.idleDays} day(s)`]
      : []),
  ];
  if (filters.length) lines.push(`Filters: ${filters.join("; ")}`);
  lines.push(`Unfinished sessions shown: ${audits.length}`);
  if (!audits.length) lines.push("No unfinished sessions match.");
  for (const audit of audits) lines.push("", ...auditLines(audit));
  lines.push(
    "",
    `Buckets: ${AUDIT_BUCKETS.map((bucket) => `${AUDIT_BUCKET_LABELS[bucket]} ${counts[bucket]}`).join(", ")}`,
  );
  process.stdout.write(terminalLines(lines));
}

/** One session's audit as plain text, as printed by `sessions audit`. */
export function auditLines(audit: SessionAudit): string[] {
  const idle =
    audit.idleDays === null || !audit.lastActivity
      ? "idle unknown"
      : `idle ${audit.idleDays} day(s) since ${audit.lastActivity.at} (${audit.lastActivity.source})`;
  return [
    `${audit.sessionId}  [${AUDIT_BUCKET_LABELS[audit.bucket]}]  ${idle}`,
    `  status: ${audit.status}`,
    `  repo: ${audit.repositoryPath}`,
    `  worktree: ${audit.worktreePath}`,
    `  branch: ${audit.branch}`,
    `  summary: ${audit.taskSummary}`,
    "  evidence:",
    ...audit.evidence.map((line) => `    - ${line}`),
    ...(audit.notes.length
      ? ["  notes:", ...audit.notes.map((line) => `    - ${line}`)]
      : []),
  ];
}

/** Join lines as terminal-safe ASCII for output. */
export function terminalLines(lines: string[]): string {
  return (
    lines
      .map((line) =>
        stripVTControlCharacters(line).replace(/[^\x20-\x7e]/g, "?"),
      )
      .join("\n") + "\n"
  );
}
