import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths, writeJsonAtomic } from "./runtime.js";

interface PhaseRecord {
  name: string;
  startedAt: string;
  durationMs: number;
  status: "succeeded" | "failed";
}

interface PerformanceRun {
  id: string;
  command: string;
  sessionId?: string;
  startedAt: string;
  durationMs?: number;
  status?: "succeeded" | "failed";
  subprocessCount: number;
  subprocessDurationMs: number;
  phases: PhaseRecord[];
  metrics: Record<string, string | number | boolean>;
  error?: string;
}

interface PerformanceRecord {
  version: 1;
  sessionId: string;
  runs: PerformanceRun[];
}

let active: { run: PerformanceRun; started: bigint } | undefined;

export function startPerformance(command: string): void {
  active = {
    run: {
      id: `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      command,
      startedAt: new Date().toISOString(),
      subprocessCount: 0,
      subprocessDurationMs: 0,
      phases: [],
      metrics: {},
    },
    started: process.hrtime.bigint(),
  };
}

export function bindPerformanceSession(sessionId: string): void {
  if (active) active.run.sessionId = sessionId;
}

export function recordPerformanceMetric(
  name: string,
  value: string | number | boolean,
): void {
  if (active) active.run.metrics[name] = value;
}

export function recordSubprocess(durationMs: number): void {
  if (!active) return;
  active.run.subprocessCount += 1;
  active.run.subprocessDurationMs += durationMs;
}

export async function measurePhase<T>(
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!active) return await action();
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  try {
    const result = await action();
    active.run.phases.push({
      name,
      startedAt,
      durationMs: elapsedMs(started),
      status: "succeeded",
    });
    return result;
  } catch (error) {
    active.run.phases.push({
      name,
      startedAt,
      durationMs: elapsedMs(started),
      status: "failed",
    });
    throw error;
  }
}

export async function finishPerformance(
  status: "succeeded" | "failed",
  error?: unknown,
): Promise<void> {
  const current = active;
  active = undefined;
  if (!current) return;
  current.run.durationMs = elapsedMs(current.started);
  current.run.status = status;
  if (error !== undefined) current.run.error = errorMessage(error);
  const recordId = current.run.sessionId ?? `command-${current.run.id}`;
  const path = join(runtimePaths().performance, `${recordId}.json`);
  let record: PerformanceRecord = {
    version: 1,
    sessionId: recordId,
    runs: [],
  };
  try {
    record = JSON.parse(await readFile(path, "utf8")) as PerformanceRecord;
  } catch {
    // The first run creates the record.
  }
  record.runs.push(current.run);
  await writeJsonAtomic(path, record);
  const slowest = [...current.run.phases]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 3)
    .map((phase) => `${phase.name} ${formatMs(phase.durationMs)}`)
    .join(", ");
  process.stdout.write(
    `Performance: total ${formatMs(current.run.durationMs)}, ${current.run.subprocessCount} subprocess(es)${slowest ? `; ${slowest}` : ""}\n`,
  );
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function formatMs(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(2)}s`
    : `${value.toFixed(1)}ms`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
