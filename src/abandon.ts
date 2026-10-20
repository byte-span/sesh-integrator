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
} from "./runtime.js";
import {
  LIVENESS_NOTICE,
  auditLines,
  classifySession,
  createAuditContext,
  terminalLines,
  type AuditContext,
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

const abandonUsage =
  'Usage: seshx abandon --session <session-id> --reason "..." [--include-unsaved]';
const restoreUsage = "Usage: seshx restore --session <session-id>";

function sessionIdOption(value: string | undefined, usage: string): string {
  if (!value || value.startsWith("--")) throw new Error(usage);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid session ID");
  return value;
}

export async function abandonCommand(args: string[]): Promise<void> {
  let sessionId: string | undefined;
  let reason: string | undefined;
  let includeUnsaved = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--include-unsaved" && !includeUnsaved)
      includeUnsaved = true;
    else if (argument === "--session" && sessionId === undefined) {
      sessionId = sessionIdOption(value, abandonUsage);
      index += 1;
    } else if (
      argument === "--reason" &&
      reason === undefined &&
      value !== undefined &&
      !value.startsWith("--")
    ) {
      reason = value;
      index += 1;
    } else throw new Error(abandonUsage);
  }
  if (!sessionId || reason === undefined) throw new Error(abandonUsage);
  const validReason = validateAbandonReason(reason);
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
