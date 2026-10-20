import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertCompatible,
  terminalStatuses,
  unfinished,
} from "./coordinator.js";
import {
  abandonSessionRecord,
  readSession,
  readSessions,
  restoreSessionRecord,
  runtimePaths,
} from "./runtime.js";
import {
  AUDIT_BUCKETS,
  AUDIT_BUCKET_LABELS,
  LIVENESS_NOTICE,
  auditLines,
  auditSessionRecords,
  classifySession,
  createAuditContext,
  terminalLines,
  type AuditBucket,
  type AuditContext,
  type AuditedSession,
  type SessionAudit,
} from "./session-audit.js";
import type { Session, SessionAbandonment } from "./types.js";

/**
 * Abandoning closes a session record without touching Git: its branch,
 * worktree, commits and recovery evidence stay where they are, and
 * `seshx restore` returns it to `active`.
 */

export const ABANDON_REASON_MAX_LENGTH = 500;

export class AbandonRefusal extends Error {
  constructor(
    message: string,
    /** The audit the refusal was based on, when one was made. */
    readonly audit?: SessionAudit,
  ) {
    super(message);
    this.name = "AbandonRefusal";
  }
}

export interface AbandonPreview {
  session: Session;
  audit: SessionAudit;
}

export interface AbandonOptions {
  reason: string;
  /**
   * Allow a session whose work may be unsaved: the `unsaved` bucket, or an
   * inspection too incomplete to rule unsaved work out.
   */
  includeUnsaved?: boolean;
  /** Shared audit context, for example across a batch. */
  context?: AuditContext;
  /**
   * The record and audit already shown to the user. The abandon is refused
   * when the session changed since. Computed here when omitted.
   */
  preview?: AbandonPreview;
}

export interface AbandonResult {
  session: Session;
  /** Audit made under the session record lock immediately before saving. */
  audit: SessionAudit;
}

/** Trimmed reason, or an error for empty, multi-line or overlong text. */
export function validateAbandonReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('abandon requires a non-empty --reason "..."');
  if (trimmed.length > ABANDON_REASON_MAX_LENGTH)
    throw new Error(
      `--reason must be at most ${ABANDON_REASON_MAX_LENGTH} characters`,
    );
  if (/[\x00-\x1f\x7f]/.test(trimmed))
    throw new Error("--reason must be one line without control characters");
  return trimmed;
}

/** Integration or recovery state recorded on the session itself. */
export function recordedLifecycleState(session: Session): string[] {
  const state: string[] = [];
  if (session.readyCommit) state.push(`ready commit ${session.readyCommit}`);
  if (session.integratedCommit)
    state.push(`staging commit ${session.integratedCommit}`);
  if (session.promotedCommit)
    state.push(`promoted commit ${session.promotedCommit}`);
  if (session.recoveryBundle)
    state.push(
      `${session.recoveryBundle.state} recovery bundle ${session.recoveryBundle.path}`,
    );
  if (session.recoveryPhase)
    state.push(`recovery phase ${session.recoveryPhase}`);
  if (session.localTargetRecovery) state.push("local target recovery");
  if (session.waitingForLock) state.push("waiting for the repository lock");
  if (session.awaitingConflictResolution)
    state.push("awaiting conflict resolution");
  return state;
}

function incompleteInspection(audit: SessionAudit): boolean {
  return audit.evidence.some((line) =>
    line.startsWith("inspection incomplete"),
  );
}

/** Whether abandoning needs `--include-unsaved`. */
export function needsIncludeUnsaved(audit: SessionAudit): boolean {
  return audit.bucket === "unsaved" || incompleteInspection(audit);
}

/** Why the session must not be abandoned, or undefined when it may be. */
export function abandonRefusal(
  session: Session,
  audit: SessionAudit,
  includeUnsaved = false,
): string | undefined {
  if (session.status === "abandoned")
    return `it was already abandoned at ${session.abandonment?.abandonedAt ?? "an unknown time"}`;
  if (terminalStatuses.includes(session.status))
    return `it is already finished (${session.status})`;
  if (session.status !== "active")
    return `its status is ${session.status}; finish or resume its lifecycle with its pinned coordinator instead`;
  const state = recordedLifecycleState(session);
  if (state.length)
    return `it has integration or recovery state (${state.join("; ")}); finish or resume its lifecycle instead`;
  if (audit.bucket === "lifecycle")
    return `it is in lifecycle (${audit.evidence.join("; ")})`;
  if (!includeUnsaved && audit.bucket === "unsaved")
    return `it has unsaved work (${audit.evidence.join("; ")}). Review that work; to abandon anyway, rerun with --include-unsaved. The work stays in its branch and worktree either way`;
  if (!includeUnsaved && incompleteInspection(audit))
    return `its state could not be fully inspected, so unsaved work cannot be ruled out (${audit.evidence.join("; ")}). To abandon anyway, rerun with --include-unsaved`;
  return undefined;
}

/**
 * State that must be unchanged between the audit shown to the user and the
 * recheck under the record lock. Target-branch movement by other sessions is
 * deliberately excluded.
 */
export function auditFingerprint(
  session: Session,
  audit: SessionAudit,
): string {
  const facts = audit.facts;
  return JSON.stringify({
    status: session.status,
    lastActivityAt: session.lastActivityAt ?? null,
    tasksUpdatedAt: session.tasksUpdatedAt ?? null,
    branch: session.branch,
    worktreePath: session.worktreePath,
    lifecycle: recordedLifecycleState(session),
    bucket: audit.bucket,
    worktreeHead: facts.worktreeHead,
    branchHead: facts.branchHead,
    uncommittedPaths: facts.uncommittedPaths,
    commitsSinceStart: facts.commitsSinceStart,
    unintegratedCommits: facts.unintegratedCommits,
    holdsRepositoryLock: facts.holdsRepositoryLock,
    recordLockPresent: facts.recordLockPresent,
  });
}

/**
 * Abandon one active session. The session is audited (or the supplied
 * preview is used), refused when it is in lifecycle or recovery, holds a
 * lock, or has unsaved work without `includeUnsaved`, then rechecked under
 * its record lock immediately before saving. Only the record changes.
 */
export async function abandonSession(
  sessionId: string,
  options: AbandonOptions,
): Promise<AbandonResult> {
  const reason = validateAbandonReason(options.reason);
  const includeUnsaved = options.includeUnsaved === true;
  const context = options.context ?? (await createAuditContext());
  let preview = options.preview;
  if (!preview) {
    const session = await readSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    preview = { session, audit: await classifySession(session, context) };
  }
  if (preview.session.id !== sessionId)
    throw new Error(
      `Preview belongs to ${preview.session.id}, not ${sessionId}`,
    );
  assertCompatible(preview.session);
  const refuse = (why: string, audit: SessionAudit) =>
    new AbandonRefusal(
      `Refusing to abandon ${sessionId}: ${why}. Nothing was changed.`,
      audit,
    );
  const initial = abandonRefusal(
    preview.session,
    preview.audit,
    includeUnsaved,
  );
  if (initial) throw refuse(initial, preview.audit);

  let recheck: SessionAudit | undefined;
  const session = await abandonSessionRecord(sessionId, async (latest) => {
    assertCompatible(latest);
    // Fresh lock observations; this command holds the record lock itself.
    recheck = await classifySession(latest, {
      ...context,
      now: new Date(),
      repositoryLockCache: new Map(),
      heldRecordLocks: new Set([sessionId]),
    });
    const refusal = abandonRefusal(latest, recheck, includeUnsaved);
    if (refusal) throw refuse(refusal, recheck);
    if (
      auditFingerprint(preview.session, preview.audit) !==
      auditFingerprint(latest, recheck)
    )
      throw refuse(
        "it changed after it was inspected; review the new audit and retry",
        recheck,
      );
    const abandonment: SessionAbandonment = {
      abandonedAt: new Date().toISOString(),
      reason,
      previousStatus: latest.status,
      bucket: recheck.bucket,
      evidence: [...recheck.evidence],
      ...(needsIncludeUnsaved(recheck) ? { includedUnsaved: true } : {}),
    };
    return abandonment;
  });
  return { session, audit: recheck! };
}

/**
 * Return an abandoned session to `active`. Refused when another unfinished
 * session now uses its worktree. The abandonment moves to the history.
 */
export async function restoreSession(sessionId: string): Promise<Session> {
  const session = await readSession(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  assertCompatible(session);
  return restoreSessionRecord(sessionId, async (latest) => {
    assertCompatible(latest);
    const claimant = (await readSessions(true)).find(
      (other) =>
        other.id !== latest.id &&
        unfinished(other) &&
        other.worktreePath === latest.worktreePath,
    );
    if (claimant)
      throw new Error(
        `Cannot restore ${sessionId}: its worktree ${latest.worktreePath} now belongs to unfinished session ${claimant.id}. Finish or abandon that session first. Nothing was changed.`,
      );
  });
}

/** Buckets `abandon --all` can close. `lifecycle` and `other` never are. */
export const BATCH_ABANDON_BUCKETS: readonly AuditBucket[] = [
  "empty",
  "delivered",
  "corrupt",
  "unsaved",
];

/** Selected without `--bucket`; `unsaved` is added by `includeUnsaved`. */
export const DEFAULT_BATCH_BUCKETS: readonly AuditBucket[] = [
  "empty",
  "delivered",
  "corrupt",
];

export interface BatchAbandonOptions {
  /** Restrict to sessions of the repository containing this path. */
  repo?: string;
  /** Keep only sessions idle for at least this many whole days. */
  idleDays?: number;
  /** Buckets to close; see `resolveBatchBuckets`. */
  buckets?: readonly string[];
  /** Allow the `unsaved` bucket; required to select it. */
  includeUnsaved?: boolean;
  /** Shared audit context; its `now` fixes the idle-day calculation. */
  context?: AuditContext;
}

export interface BatchExclusion extends AuditedSession {
  /** Why the session is left alone. */
  reason: string;
}

export interface BatchAbandonPlan {
  context: AuditContext;
  repo: string | null;
  idleDays: number | null;
  buckets: AuditBucket[];
  /** Whether `--bucket` was given; the default selection otherwise. */
  explicitBuckets: boolean;
  includeUnsaved: boolean;
  /** Sessions the batch would close, each with the audit shown. */
  selected: AuditedSession[];
  /** Matching sessions the batch leaves alone. */
  excluded: BatchExclusion[];
  /** Buckets of every session matching the filters. */
  counts: Record<AuditBucket, number>;
}

export interface BatchClosed extends AbandonResult {
  /** An error reported after the record was saved, such as lock cleanup. */
  warning?: string;
}

export interface BatchSkipped {
  sessionId: string;
  reason: string;
  /** The recheck the skip was based on, when one was made. */
  audit?: SessionAudit;
}

export interface BatchAbandonOutcome {
  closed: BatchClosed[];
  skipped: BatchSkipped[];
}

/**
 * The buckets a batch closes: the given IDs, or empty, delivered and corrupt
 * (plus unsaved with `includeUnsaved`). `lifecycle` is never selectable, and
 * neither is `other`, whose sessions need individual review. `unsaved` needs
 * `includeUnsaved`, which in turn must not contradict an explicit list.
 */
export function resolveBatchBuckets(
  buckets: readonly string[] | undefined,
  includeUnsaved: boolean,
): AuditBucket[] {
  if (buckets === undefined)
    return AUDIT_BUCKETS.filter(
      (bucket) =>
        DEFAULT_BATCH_BUCKETS.includes(bucket) ||
        (includeUnsaved && bucket === "unsaved"),
    );
  if (!buckets.length || buckets.some((bucket) => !bucket))
    throw new Error(
      `--bucket needs a comma-separated list of: ${BATCH_ABANDON_BUCKETS.join(", ")}`,
    );
  const selected: AuditBucket[] = [];
  for (const bucket of buckets) {
    if (!(AUDIT_BUCKETS as readonly string[]).includes(bucket))
      throw new Error(
        `Unknown bucket ${JSON.stringify(bucket)}; use: ${BATCH_ABANDON_BUCKETS.join(", ")}`,
      );
    if (bucket === "lifecycle")
      throw new Error(
        "Sessions in lifecycle are never abandoned; finish or resume each with its pinned coordinator.",
      );
    if (bucket === "other")
      throw new Error(
        "The other bucket cannot be batch-abandoned; review each session with seshx sessions audit and use seshx abandon --session <id>.",
      );
    if (!selected.includes(bucket as AuditBucket))
      selected.push(bucket as AuditBucket);
  }
  if (selected.includes("unsaved") && !includeUnsaved)
    throw new Error("--bucket unsaved requires --include-unsaved");
  if (includeUnsaved && !selected.includes("unsaved"))
    throw new Error(
      "--include-unsaved selects the unsaved bucket; add unsaved to --bucket or drop --include-unsaved",
    );
  return AUDIT_BUCKETS.filter((bucket) => selected.includes(bucket));
}

function batchExclusion(
  { session, audit }: AuditedSession,
  buckets: readonly AuditBucket[],
  includeUnsaved: boolean,
): string | undefined {
  if (!buckets.includes(audit.bucket))
    switch (audit.bucket) {
      case "lifecycle":
        return "in lifecycle; never batch-abandoned. Finish or resume it with its pinned coordinator";
      case "other":
        return `bucket other; never batch-abandoned. Review it and use seshx abandon --session ${session.id}`;
      case "unsaved":
        return "unsaved work; selected only with --include-unsaved";
      default:
        return `bucket ${audit.bucket} not selected by --bucket`;
    }
  try {
    assertCompatible(session);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return abandonRefusal(session, audit, includeUnsaved);
}

/**
 * Audit the matching unfinished sessions and decide which a batch would
 * close. Read-only: nothing is written, locked or fetched.
 */
export async function planBatchAbandon(
  options: BatchAbandonOptions = {},
): Promise<BatchAbandonPlan> {
  const includeUnsaved = options.includeUnsaved === true;
  const buckets = resolveBatchBuckets(options.buckets, includeUnsaved);
  const context = options.context ?? (await createAuditContext());
  const audited = await auditSessionRecords(
    {
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      ...(options.idleDays !== undefined ? { idleDays: options.idleDays } : {}),
    },
    context,
  );
  const selected: AuditedSession[] = [];
  const excluded: BatchExclusion[] = [];
  for (const entry of audited) {
    const reason = batchExclusion(entry, buckets, includeUnsaved);
    if (reason) excluded.push({ ...entry, reason });
    else selected.push(entry);
  }
  return {
    context,
    repo: options.repo === undefined ? null : resolve(options.repo),
    idleDays: options.idleDays ?? null,
    buckets,
    explicitBuckets: options.buckets !== undefined,
    includeUnsaved,
    selected,
    excluded,
    counts: Object.fromEntries(
      AUDIT_BUCKETS.map((bucket) => [
        bucket,
        audited.filter(({ audit }) => audit.bucket === bucket).length,
      ]),
    ) as Record<AuditBucket, number>,
  };
}

/**
 * Close the planned sessions one at a time. Each is rechecked under its
 * record lock immediately before saving and skipped when it changed since
 * the plan, entered lifecycle, recovery or a lock wait, or its record lock
 * is held. `includeUnsaved` applies only to sessions the plan itself showed
 * as needing it. Only session records change.
 */
export async function applyBatchAbandon(
  plan: BatchAbandonPlan,
  reason: string,
): Promise<BatchAbandonOutcome> {
  const validReason = validateAbandonReason(reason);
  const started = Date.now();
  const outcome: BatchAbandonOutcome = { closed: [], skipped: [] };
  for (const { session, audit } of plan.selected) {
    const recordLock = join(
      plan.context.locksDirectory,
      `session-record-${session.id}`,
    );
    // Skip promptly instead of waiting on another command's record lock.
    if (await pathExists(recordLock)) {
      outcome.skipped.push({
        sessionId: session.id,
        reason: `Refusing to abandon ${session.id}: its session record lock ${recordLock} appeared after it was inspected; another command may be using it. Nothing was changed.`,
      });
      continue;
    }
    try {
      outcome.closed.push(
        await abandonSession(session.id, {
          reason: validReason,
          includeUnsaved: plan.includeUnsaved && needsIncludeUnsaved(audit),
          context: plan.context,
          preview: { session, audit },
        }),
      );
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof AbandonRefusal)) {
        // A failure after the save, such as releasing the lock, still closed it.
        const latest = await readSession(session.id).catch(() => undefined);
        if (
          latest?.status === "abandoned" &&
          latest.abandonment?.reason === validReason &&
          Date.parse(latest.abandonment.abandonedAt) >= started
        ) {
          outcome.closed.push({ session: latest, audit, warning: message });
          continue;
        }
        // The record is saved atomically, so it was not changed.
        message = `Skipped ${session.id}: ${message.replace(/\.?$/, ".")} Nothing was changed.`;
      }
      outcome.skipped.push({
        sessionId: session.id,
        reason: message,
        ...(error instanceof AbandonRefusal && error.audit
          ? { audit: error.audit }
          : {}),
      });
    }
  }
  return outcome;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const abandonUsage = [
  'Usage: seshx abandon --session <session-id> --reason "..." [--include-unsaved]',
  '       seshx abandon --all [--repo <path>] [--idle-days <n>] [--bucket <list>] [--include-unsaved] [--apply --reason "..."]',
].join("\n");
const restoreUsage = "Usage: seshx restore --session <session-id>";

function sessionIdOption(value: string | undefined, usage: string): string {
  if (!value || value.startsWith("--")) throw new Error(usage);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid session ID");
  return value;
}

interface AbandonArguments {
  sessionId?: string;
  all: boolean;
  reason?: string;
  includeUnsaved: boolean;
  apply: boolean;
  repo?: string;
  idleDays?: number;
  buckets?: string[];
}

function parseAbandonArguments(args: string[]): AbandonArguments {
  const parsed: AbandonArguments = {
    all: false,
    includeUnsaved: false,
    apply: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    const hasValue = value !== undefined && !value.startsWith("--");
    if (argument === "--include-unsaved" && !parsed.includeUnsaved)
      parsed.includeUnsaved = true;
    else if (argument === "--all" && !parsed.all) parsed.all = true;
    else if (argument === "--apply" && !parsed.apply) parsed.apply = true;
    else if (argument === "--session" && parsed.sessionId === undefined) {
      parsed.sessionId = sessionIdOption(value, abandonUsage);
      index += 1;
    } else if (argument === "--reason" && parsed.reason === undefined) {
      if (!hasValue) throw new Error(abandonUsage);
      parsed.reason = value;
      index += 1;
    } else if (argument === "--repo" && parsed.repo === undefined) {
      if (!hasValue || !value) throw new Error(abandonUsage);
      parsed.repo = value;
      index += 1;
    } else if (argument === "--idle-days" && parsed.idleDays === undefined) {
      if (value === undefined || !/^\d+$/.test(value))
        throw new Error(
          `--idle-days needs a whole number of days\n${abandonUsage}`,
        );
      parsed.idleDays = Number(value);
      index += 1;
    } else if (argument === "--bucket" && parsed.buckets === undefined) {
      if (!hasValue) throw new Error(abandonUsage);
      parsed.buckets = value.split(",").map((bucket) => bucket.trim());
      index += 1;
    } else throw new Error(abandonUsage);
  }
  if (parsed.all && parsed.sessionId !== undefined)
    throw new Error(
      `Use either --session <session-id> or --all, not both\n${abandonUsage}`,
    );
  if (
    !parsed.all &&
    (parsed.apply ||
      parsed.repo !== undefined ||
      parsed.idleDays !== undefined ||
      parsed.buckets !== undefined)
  )
    throw new Error(
      `--apply, --repo, --idle-days and --bucket require --all\n${abandonUsage}`,
    );
  if (!parsed.all && (!parsed.sessionId || parsed.reason === undefined))
    throw new Error(abandonUsage);
  if (parsed.all && parsed.apply && parsed.reason === undefined)
    throw new Error(
      `abandon --all --apply requires --reason "..."\n${abandonUsage}`,
    );
  return parsed;
}

export async function abandonCommand(args: string[]): Promise<void> {
  const parsed = parseAbandonArguments(args);
  if (parsed.all) return batchAbandonCommand(parsed);
  const sessionId = parsed.sessionId!;
  const includeUnsaved = parsed.includeUnsaved;
  const validReason = validateAbandonReason(parsed.reason!);
  const session = await readSession(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  if (session.status === "abandoned")
    throw new Error(
      `Session ${sessionId} was already abandoned at ${session.abandonment?.abandonedAt ?? "an unknown time"}. Restore it with seshx restore --session ${sessionId}. Nothing was changed.`,
    );
  if (terminalStatuses.includes(session.status))
    throw new Error(
      `Session ${sessionId} is already finished (${session.status}); nothing to abandon.`,
    );
  const context = await createAuditContext();
  const audit = await classifySession(session, context);
  process.stdout.write(
    terminalLines([
      "Session audit before abandoning (nothing has been changed yet)",
      LIVENESS_NOTICE,
      "",
      ...auditLines(audit),
      "",
    ]),
  );
  let result: AbandonResult;
  try {
    result = await abandonSession(sessionId, {
      reason: validReason,
      includeUnsaved,
      context,
      preview: { session, audit },
    });
  } catch (error) {
    if (error instanceof AbandonRefusal && error.audit && error.audit !== audit)
      process.stdout.write(
        terminalLines([
          "Recheck under the session record lock:",
          ...auditLines(error.audit),
          "",
        ]),
      );
    throw error;
  }
  const saved = result.session;
  process.stdout.write(
    terminalLines([
      `Abandoned ${saved.id} at ${saved.abandonment!.abandonedAt} (was ${saved.abandonment!.previousStatus}, bucket ${saved.abandonment!.bucket}).`,
      `  reason: ${saved.abandonment!.reason}`,
      `  preserved: branch ${saved.branch}, worktree ${saved.worktreePath}, commits and recovery evidence. No Git, worktree or file changes were made.`,
      `  restore: seshx restore --session ${saved.id}`,
    ]),
  );
}

async function batchAbandonCommand(parsed: AbandonArguments): Promise<void> {
  const reason =
    parsed.reason === undefined
      ? undefined
      : validateAbandonReason(parsed.reason);
  const plan = await planBatchAbandon({
    ...(parsed.repo !== undefined ? { repo: parsed.repo } : {}),
    ...(parsed.idleDays !== undefined ? { idleDays: parsed.idleDays } : {}),
    ...(parsed.buckets !== undefined ? { buckets: parsed.buckets } : {}),
    includeUnsaved: parsed.includeUnsaved,
  });
  const lines = batchPlanLines(plan, parsed.apply, reason);
  if (!parsed.apply) {
    lines.push(
      "",
      ...(plan.selected.length
        ? [
            `Nothing was changed. To abandon the ${plan.selected.length} session(s) listed above, run:`,
            `  ${batchApplyCommand(plan, reason)}`,
            "--apply audits again and lists what it will close. Each session is rechecked under its record lock immediately before it is closed, and skipped if it changed.",
          ]
        : ["Nothing was changed; no sessions would be abandoned."]),
    );
    process.stdout.write(terminalLines(lines));
    return;
  }
  if (!plan.selected.length) {
    lines.push("", "Nothing to abandon; nothing was changed.");
    process.stdout.write(terminalLines(lines));
    return;
  }
  process.stdout.write(terminalLines(lines));
  const outcome = await applyBatchAbandon(plan, reason!);
  process.stdout.write(terminalLines(batchOutcomeLines(outcome)));
  if (outcome.skipped.length) process.exitCode = 1;
}

function batchPlanLines(
  plan: BatchAbandonPlan,
  apply: boolean,
  reason: string | undefined,
): string[] {
  const filters = [
    ...(plan.repo !== null ? [`repository ${plan.repo}`] : []),
    ...(plan.idleDays !== null
      ? [`idle at least ${plan.idleDays} day(s)`]
      : []),
  ];
  const lines = [
    apply
      ? "Batch abandon: closing the sessions below. Each is rechecked under its record lock first."
      : "Batch abandon preview (read-only; nothing was changed)",
    LIVENESS_NOTICE,
    "Confirm with each session's owner before closing it.",
    `Runtime: ${runtimePaths().root}`,
    `Filters: ${filters.length ? filters.join("; ") : "none"}`,
    `Selected buckets: ${plan.buckets.map((bucket) => AUDIT_BUCKET_LABELS[bucket]).join(", ")}${plan.explicitBuckets ? "" : plan.includeUnsaved ? " (default plus --include-unsaved)" : " (default)"}`,
    ...(reason !== undefined ? [`Reason: ${reason}`] : []),
    "",
    `${apply ? "Sessions to abandon" : "Would abandon"}: ${plan.selected.length}`,
  ];
  for (const { audit } of plan.selected) {
    lines.push("", ...auditLines(audit));
    if (needsIncludeUnsaved(audit))
      lines.push(
        "  unsaved work: included only because --include-unsaved was given. The work stays in its branch and worktree.",
      );
  }
  lines.push("", `Left alone: ${plan.excluded.length}`);
  for (const { audit, reason: why } of plan.excluded)
    lines.push(
      `  ${audit.sessionId}  [${AUDIT_BUCKET_LABELS[audit.bucket]}]  ${why}`,
    );
  lines.push(
    "",
    `Buckets of matching sessions: ${AUDIT_BUCKETS.map((bucket) => `${AUDIT_BUCKET_LABELS[bucket]} ${plan.counts[bucket]}`).join(", ")}`,
  );
  return lines;
}

function batchApplyCommand(
  plan: BatchAbandonPlan,
  reason: string | undefined,
): string {
  const words = ["seshx", "abandon", "--all"];
  if (plan.repo !== null) words.push("--repo", shellWord(plan.repo));
  if (plan.idleDays !== null) words.push("--idle-days", String(plan.idleDays));
  if (plan.explicitBuckets) words.push("--bucket", plan.buckets.join(","));
  if (plan.includeUnsaved) words.push("--include-unsaved");
  words.push("--apply", "--reason", reason ? shellWord(reason) : '"..."');
  return words.join(" ");
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The closed and skipped sessions, as printed by `abandon --all --apply`. */
export function batchOutcomeLines(outcome: BatchAbandonOutcome): string[] {
  const lines = ["", `Closed: ${outcome.closed.length}`];
  for (const { session, audit, warning } of outcome.closed) {
    lines.push(
      `  ${session.id}  [${AUDIT_BUCKET_LABELS[audit.bucket]}]  abandoned at ${session.abandonment!.abandonedAt}; restore: seshx restore --session ${session.id}`,
    );
    if (warning) lines.push(`    warning: ${warning}`);
  }
  lines.push("", `Skipped: ${outcome.skipped.length}`);
  for (const { sessionId, reason, audit } of outcome.skipped) {
    lines.push(`  ${sessionId}  ${reason}`);
    if (audit)
      lines.push(
        `    recheck: [${AUDIT_BUCKET_LABELS[audit.bucket]}] ${audit.evidence.join("; ")}`,
      );
  }
  lines.push(
    "",
    "Preserved: every branch, worktree, uncommitted file, commit, recovery bundle and ref, incident and lock. Only the closed sessions' records changed.",
    ...(outcome.skipped.length
      ? [
          "Skipped sessions were not changed. Review them with seshx sessions audit.",
        ]
      : []),
  );
  return lines;
}

export async function restoreCommand(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--session")
    throw new Error(restoreUsage);
  const sessionId = sessionIdOption(args[1], restoreUsage);
  const session = await restoreSession(sessionId);
  const restored = session.abandonmentHistory!.at(-1)!;
  process.stdout.write(
    terminalLines([
      `Restored ${session.id} to ${session.status}.`,
      `  abandoned: ${restored.abandonedAt} (bucket ${restored.bucket}); reason: ${restored.reason}`,
      `  branch: ${session.branch}`,
      ...(session.coordinator
        ? [
            `  coordinator: ${session.coordinator.cliPath} (use it for this session's lifecycle commands)`,
          ]
        : []),
      `Continue task in: ${session.worktreePath}`,
    ]),
  );
}
