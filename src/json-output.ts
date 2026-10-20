import { CodedError } from "./delivery-policy.js";
import { readSession } from "./runtime.js";
import type { TargetSync } from "./sync-target.js";
import type { Session } from "./types.js";

/**
 * Machine-readable documents printed by `begin --json`, `status --json` and
 * `policy check`. Canonical description: docs/commands.md#machine-readable-output.
 * Fields may be added within a schema version, never removed or retyped.
 */
export const SESSION_STATUS_SCHEMA = "sesh-integrator/session-status@1";
export const ERROR_SCHEMA = "sesh-integrator/error@1";

const RESUMABLE: readonly Session["status"][] = [
  "needs_review",
  "validation_pending",
  "promotion_pending",
];

export function sessionStatusDocument(
  session: Session,
  sync?: TargetSync,
): Record<string, unknown> {
  const delivery = session.delivery;
  return {
    schema: SESSION_STATUS_SCHEMA,
    session: {
      id: session.id,
      status: session.status,
      harness: session.harness ?? null,
      repositoryPath: session.repositoryPath,
      worktreePath: session.worktreePath,
      branch: session.branch,
      startCommit: session.startCommit,
      dependsOn: [...(session.dependsOn ?? [])],
      readyCommit: session.readyCommit ?? null,
      integratedCommit: session.integratedCommit ?? null,
      promotedCommit: session.promotedCommit ?? null,
      targetBranch: session.targetBranch ?? null,
      pullRequestUrl: session.pullRequestUrl ?? null,
      remotePromotedAt: session.remotePromotedAt ?? null,
      recoveryPhase: session.recoveryPhase ?? null,
      latestError: session.latestError ?? null,
      awaitingConflictResolution: session.awaitingConflictResolution ?? false,
      integrationWorktreePath: session.integrationWorktreePath ?? null,
      conflictPromptPath: session.conflictPromptPath ?? null,
      rolloutDisposition: session.rolloutDisposition ?? null,
      rolloutFollowUps: [...(session.rolloutFollowUps ?? [])],
      delivery: delivery
        ? {
            version: delivery.version,
            sha256: delivery.sha256,
            repository: delivery.repository,
            targetBranch: delivery.targetBranch,
            promotion: delivery.promotion,
            completion: delivery.completion,
            source: delivery.source,
          }
        : null,
    },
    resumeCommand: RESUMABLE.includes(session.status)
      ? ["seshx", "resume", "--session", session.id]
      : null,
    ...(sync ? { sync } : {}),
  };
}

export async function sessionStatusJson(
  sessionId: string | undefined,
): Promise<Record<string, unknown>> {
  if (!sessionId)
    throw new CodedError(
      "usage",
      "Usage: seshx status --session <session-id> --json",
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
    throw new CodedError("usage", "Invalid session ID");
  const session = await readSession(sessionId);
  if (!session)
    throw new CodedError("unknown_session", `Unknown session: ${sessionId}`);
  return sessionStatusDocument(session);
}

export function errorDocument(
  error: unknown,
  fallbackCode: string,
): Record<string, unknown> {
  return {
    schema: ERROR_SCHEMA,
    error: {
      code: error instanceof CodedError ? error.code : fallbackCode,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Send everything written to stdout, including relayed child output, to
 * stderr so stdout carries exactly one JSON document.
 */
export function divertStdout(): {
  write(text: string): void;
  restore(): void;
} {
  const stdout = process.stdout;
  const original = stdout.write;
  stdout.write = ((...args: unknown[]) =>
    (process.stderr.write as (...values: unknown[]) => boolean).apply(
      process.stderr,
      args,
    )) as typeof stdout.write;
  return {
    write: (text) => {
      original.call(stdout, text);
    },
    restore: () => {
      stdout.write = original;
    },
  };
}
