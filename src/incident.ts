import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureRuntime, runtimePaths, writeSession } from "./runtime.js";
import type { Incident, Session } from "./types.js";

type Diagnosis = Pick<
  Incident,
  "category" | "confidence" | "diagnosis" | "proposedFix" | "fixScope"
>;

export function diagnoseFailure(session: Session, error: string): Diagnosis {
  const text = error.toLowerCase();
  if (session.awaitingConflictResolution || text.includes("conflict"))
    return {
      category: "conflict",
      confidence: "high",
      diagnosis: "The exact integration merge has unresolved conflicts.",
      proposedFix:
        "Resolve and stage the preserved conflict using its prompt, then resume.",
      fixScope: "project",
    };
  if (session.validationFailure || text.includes("validation failed"))
    return {
      category: "validation",
      confidence: "high",
      diagnosis: `${session.validationFailure?.classification ?? "A"} validation failure blocked integration.`,
      proposedFix:
        session.validationFailure?.classification === "transient"
          ? "Resume the unchanged preserved validation; if it recurs, correct its retry classification or resource policy."
          : "Fix the recorded command failure in a new source session, then integrate that fix.",
      fixScope:
        session.validationFailure?.classification === "transient"
          ? "instructions"
          : "project",
    };
  if (text.includes("dependenc"))
    return {
      category: "dependency",
      confidence: "high",
      diagnosis:
        "A declared handoff dependency has not completed successfully.",
      proposedFix:
        "Complete its incident first, then resume this preserved session.",
      fixScope: "project",
    };
  if (text.includes("manifest hash") || text.includes("recovery manifest"))
    return {
      category: "recovery-integrity",
      confidence: "high",
      diagnosis: "Immutable recovery evidence failed integrity verification.",
      proposedFix:
        "Audit the recovery bundle and runtime-writing path without rewriting preserved evidence.",
      fixScope: "project",
    };
  if (
    session.status === "promotion_pending" ||
    text.includes("target worktree") ||
    text.includes("must be checked out")
  )
    return {
      category: "promotion",
      confidence: "high",
      diagnosis: "Target promotion is blocked by the target worktree state.",
      proposedFix:
        "Preserve user changes, make the target worktree clean and accessible, then resume.",
      fixScope: "user-state",
    };
  if (
    text.includes("sign") ||
    text.includes("timeout") ||
    text.includes("temporar") ||
    text.includes("connection") ||
    text.includes("lock")
  )
    return {
      category: "environment",
      confidence: "medium",
      diagnosis: "An environmental dependency prevented completion.",
      proposedFix:
        "Correct the recorded environment failure, then resume the preserved session.",
      fixScope: "environment",
    };
  return {
    category: "unknown",
    confidence: "low",
    diagnosis: "The recorded evidence does not match a known failure class.",
    proposedFix:
      "Investigate this ticket in a new session and add a bounded workflow rule for the confirmed cause.",
    fixScope: "instructions",
  };
}

export async function recordIncident(
  session: Session,
  error: string,
): Promise<Incident> {
  const paths = await ensureRuntime();
  const now = new Date();
  const id = `CH-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const diagnosis = diagnoseFailure(session, error);
  const fingerprint = createHash("sha256")
    .update(
      `${diagnosis.category}\0${error.replace(/[0-9a-f]{7,40}/gi, "<sha>").replace(/\d+/g, "<n>")}`,
    )
    .digest("hex")
    .slice(0, 12);
  const incident: Incident = {
    version: 1,
    id,
    sessionId: session.id,
    repositoryId: session.repositoryId,
    createdAt: now.toISOString(),
    status: session.status,
    ...(session.recoveryPhase ? { phase: session.recoveryPhase } : {}),
    fingerprint,
    ...diagnosis,
    error,
    evidence: {
      ...(session.readyCommit ? { readyCommit: session.readyCommit } : {}),
      ...(session.integratedCommit
        ? { integratedCommit: session.integratedCommit }
        : {}),
      ...(session.integrationWorktreePath
        ? { integrationWorktreePath: session.integrationWorktreePath }
        : {}),
      ...(session.conflictPromptPath
        ? { conflictPromptPath: session.conflictPromptPath }
        : {}),
      ...(session.validationFailure
        ? { validationFailure: session.validationFailure }
        : {}),
    },
  };
  const path = join(paths.incidents, `${id}.json`);
  await writeFile(path, `${JSON.stringify(incident, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  session.latestIncidentId = id;
  await writeSession(session);
  return incident;
}

export function writeIncidentSummary(incident: Incident): void {
  process.stderr.write(`\nHandoff incomplete — ${incident.id}\n`);
  process.stderr.write(`Cause: ${incident.diagnosis}\n`);
  process.stderr.write(`Fix: ${incident.proposedFix}\n`);
  process.stderr.write(
    `Would you like me to implement the fix from ${incident.id} in a new session?\n`,
  );
}

export async function incidentCommand(id: string): Promise<void> {
  if (!/^CH-\d{8}-[0-9A-F]{6}$/.test(id))
    throw new Error(`Invalid incident ticket: ${id}`);
  let incident: Incident;
  try {
    incident = JSON.parse(
      await readFile(join(runtimePaths().incidents, `${id}.json`), "utf8"),
    ) as Incident;
  } catch {
    throw new Error(`Unknown incident ticket: ${id}`);
  }
  process.stdout.write(
    `${incident.id} — ${incident.category} (${incident.confidence} confidence)\n`,
  );
  process.stdout.write(`Session: ${incident.sessionId}\n`);
  process.stdout.write(`Diagnosis: ${incident.diagnosis}\n`);
  process.stdout.write(`Proposed fix: ${incident.proposedFix}\n`);
  process.stdout.write(`Fix scope: ${incident.fixScope}\n`);
  process.stdout.write(`Fingerprint: ${incident.fingerprint}\n`);
  process.stdout.write(`Recorded error: ${incident.error}\n`);
}
