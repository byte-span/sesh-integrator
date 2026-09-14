import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureRuntime,
  prepareCodexResolverHome,
  readConfig,
  runtimePaths,
  writeSession,
} from "./runtime.js";
import { run } from "./process.js";
import type { Incident, Session } from "./types.js";

type Diagnosis = Pick<
  Incident,
  "category" | "confidence" | "diagnosis" | "proposedFix" | "fixScope"
>;

export async function recordIncident(
  session: Session,
  error: string,
): Promise<Incident> {
  const paths = await ensureRuntime();
  const now = new Date();
  const id = `CH-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const fingerprint = createHash("sha256")
    .update(
      `${session.status}\0${session.recoveryPhase ?? "none"}\0${error.replace(/[0-9a-f]{7,40}/gi, "<sha>").replace(/\d+/g, "<n>")}`,
    )
    .digest("hex")
    .slice(0, 12);
  const investigation = await investigateFailure(session, error, fingerprint);
  const incident: Incident = {
    version: 1,
    id,
    sessionId: session.id,
    repositoryId: session.repositoryId,
    createdAt: now.toISOString(),
    status: session.status,
    ...(session.recoveryPhase ? { phase: session.recoveryPhase } : {}),
    fingerprint,
    ...investigation,
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

async function investigateFailure(
  session: Session,
  error: string,
  fingerprint: string,
): Promise<
  Diagnosis & Pick<Incident, "investigationSource" | "investigationError">
> {
  const fallback: Diagnosis & Pick<Incident, "investigationSource"> = {
    category: "unclassified",
    confidence: "low",
    diagnosis: "Automated investigation did not produce a validated diagnosis.",
    proposedFix: `Inspect fingerprint ${fingerprint} from its preserved evidence and resume the same session when retrying is safe.`,
    fixScope: "project",
    investigationSource: "fallback",
  };
  if (process.env.PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK === "1")
    return {
      ...fallback,
      investigationError: "Agent investigation disabled by test harness",
    };
  const paths = await ensureRuntime();
  const temporary = await mkdtemp(join(paths.root, "incident-analysis-"));
  try {
    const schemaPath = join(temporary, "schema.json");
    const outputPath = join(temporary, "result.json");
    await writeFile(schemaPath, `${JSON.stringify(investigationSchema)}\n`);
    const priorCount = (await readPriorIncidents(fingerprint)).length;
    const prompt = buildInvestigationPrompt(
      session,
      error,
      fingerprint,
      priorCount,
    );
    const config = await readConfig();
    const codexHome = await prepareCodexResolverHome();
    const result = await run(
      config.codexCommand,
      [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      {
        cwd: session.repositoryPath,
        input: prompt,
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: 120_000,
      },
    );
    if (result.code !== 0)
      return { ...fallback, investigationError: `Codex exited ${result.code}` };
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    const diagnosis = validateDiagnosis(parsed);
    return { ...diagnosis, investigationSource: "agent" };
  } catch (errorValue) {
    return {
      ...fallback,
      investigationError:
        errorValue instanceof Error ? errorValue.message : String(errorValue),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const investigationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "confidence", "diagnosis", "proposedFix", "fixScope"],
  properties: {
    category: { type: "string", minLength: 1, maxLength: 60 },
    confidence: { enum: ["high", "medium", "low"] },
    diagnosis: { type: "string", minLength: 1, maxLength: 300 },
    proposedFix: { type: "string", minLength: 1, maxLength: 500 },
    fixScope: {
      enum: ["instructions", "project", "environment", "user-state"],
    },
  },
} as const;

function buildInvestigationPrompt(
  session: Session,
  error: string,
  fingerprint: string,
  priorCount: number,
): string {
  return `Investigate why this sesh-integrator session did not complete. This is read-only analysis: do not modify files, Git state, runtime state, instructions, or external systems. Base conclusions on the supplied evidence and repository structure; avoid inventing facts. Prefer a systemic instruction fix when workflow behavior caused the failure, and a code fix only when evidence identifies a tool defect. Return only the requested JSON object.\n\nFingerprint: ${fingerprint}\nPrior incidents with fingerprint: ${priorCount}\nSession evidence:\n${JSON.stringify({ sessionId: session.id, status: session.status, phase: session.recoveryPhase, taskSummary: session.taskSummary, completionSummary: session.completionSummary, readyCommit: session.readyCommit, integratedCommit: session.integratedCommit, awaitingConflictResolution: session.awaitingConflictResolution, validationFailure: session.validationFailure, error }, null, 2)}`;
}

function validateDiagnosis(value: unknown): Diagnosis {
  if (!value || typeof value !== "object")
    throw new Error("Investigation response is not an object");
  const item = value as Record<string, unknown>;
  if (
    typeof item.category !== "string" ||
    !item.category.trim() ||
    item.category.length > 60 ||
    !["high", "medium", "low"].includes(String(item.confidence)) ||
    typeof item.diagnosis !== "string" ||
    !item.diagnosis.trim() ||
    item.diagnosis.length > 300 ||
    typeof item.proposedFix !== "string" ||
    !item.proposedFix.trim() ||
    item.proposedFix.length > 500 ||
    !["instructions", "project", "environment", "user-state"].includes(
      String(item.fixScope),
    )
  )
    throw new Error("Investigation response failed validation");
  return item as unknown as Diagnosis;
}

async function readPriorIncidents(fingerprint: string): Promise<Incident[]> {
  const directory = runtimePaths().incidents;
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  const incidents = await Promise.all(
    names.map(async (name) => {
      try {
        return JSON.parse(
          await readFile(join(directory, name), "utf8"),
        ) as Incident;
      } catch {
        return undefined;
      }
    }),
  );
  return incidents.filter(
    (item): item is Incident => item?.fingerprint === fingerprint,
  );
}

export function writeIncidentSummary(incident: Incident): void {
  process.stderr.write(`\nHandoff incomplete — ${incident.id}\n`);
  process.stderr.write(`Cause: ${incident.diagnosis}\n`);
  process.stderr.write(`Fix: ${incident.proposedFix}\n`);
  process.stderr.write(
    incident.status === "validation_pending"
      ? "Next: inspect the preserved evidence and resume this session when retrying is safe.\n"
      : "Next: follow the preserved recovery guidance for this session.\n",
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
  process.stdout.write(`Investigation: ${incident.investigationSource}\n`);
  if (incident.investigationError)
    process.stdout.write(
      `Investigation fallback: ${incident.investigationError}\n`,
    );
  process.stdout.write(`Fingerprint: ${incident.fingerprint}\n`);
  process.stdout.write(`Recorded error: ${incident.error}\n`);
}
