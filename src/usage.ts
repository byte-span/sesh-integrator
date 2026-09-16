import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  modelName,
  normalizeUsage,
  tokenCount,
  unknownUsage,
  type UsageRow,
} from "./usage-normalization.js";

export const usageWindows = [1, 4, 12, 24] as const;
export type UsageLimits = Partial<
  Record<(typeof usageWindows)[number], number>
>;
export interface UsageRecord {
  version: 1;
  id: string;
  runId: string;
  harness: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "pending" | "succeeded" | "failed";
  rows: UsageRow[];
}
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export function usageDirectory(env = process.env): string {
  const directory =
    env.SESH_SMOKE_USAGE_DIR ||
    join(
      env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "sesh-integrator",
      "smoke-usage",
    );
  if (!isAbsolute(directory))
    throw new Error("Smoke usage directory must be absolute.");
  return directory;
}
export function parseUsageLimits(value: unknown): UsageLimits {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Usage thresholds must be a JSON object with 1, 4, 12, and/or 24 hour keys.",
    );
  const limits: UsageLimits = {};
  for (const [key, amount] of Object.entries(value)) {
    if (
      !usageWindows.some((hour) => String(hour) === key) ||
      tokenCount(amount) === null ||
      amount === 0
    )
      throw new Error(
        "Usage thresholds must be positive integer token limits for 1, 4, 12, or 24 hours.",
      );
    limits[Number(key) as keyof UsageLimits] = amount as number;
  }
  return limits;
}
export async function loadUsageLimits(
  directory: string,
  env = process.env,
): Promise<UsageLimits> {
  if (env.SESH_SMOKE_USAGE_LIMITS !== undefined) {
    try {
      return parseUsageLimits(JSON.parse(env.SESH_SMOKE_USAGE_LIMITS));
    } catch {
      throw new Error(
        "Invalid SESH_SMOKE_USAGE_LIMITS; use a JSON object of positive token limits keyed by hours.",
      );
    }
  }
  let raw: string;
  try {
    raw = await readFile(join(directory, "limits.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read smoke usage limits.json.");
  }
  try {
    return parseUsageLimits(JSON.parse(raw));
  } catch {
    throw new Error("Invalid smoke usage limits.json.");
  }
}
async function saveRecord(
  directory: string,
  record: UsageRecord,
): Promise<void> {
  const folder = join(directory, "calls");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `${record.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, join(folder, `${record.id}.json`));
}
/** A pending record is durable before a provider is launched. A killed call stays unknown. */
export async function beginUsageCall(
  harness: string,
  env = process.env,
): Promise<{ directory: string; record: UsageRecord } | undefined> {
  if (!env.SESH_SMOKE_USAGE_RUN_ID || !env.SESH_SMOKE_USAGE_DIR)
    return undefined;
  const runId = env.SESH_SMOKE_USAGE_RUN_ID;
  if (!identifier.test(runId) || !identifier.test(harness))
    throw new Error("Invalid smoke usage identifier.");
  const directory = usageDirectory(env);
  const record: UsageRecord = {
    version: 1,
    id: randomUUID(),
    runId,
    harness,
    startedAt: Date.now(),
    endedAt: null,
    outcome: "pending",
    rows: [unknownUsage()],
  };
  await saveRecord(directory, record);
  return { directory, record };
}
export async function finishUsageCall(
  call: Awaited<ReturnType<typeof beginUsageCall>>,
  stdout: string,
  failed: boolean,
): Promise<void> {
  if (!call) return;
  await saveRecord(call.directory, {
    ...call.record,
    endedAt: Date.now(),
    outcome: failed ? "failed" : "succeeded",
    rows: normalizeUsage(call.record.harness, stdout, failed),
  });
}
function validRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as UsageRecord;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    identifier.test(record.id) &&
    typeof record.runId === "string" &&
    identifier.test(record.runId) &&
    typeof record.harness === "string" &&
    identifier.test(record.harness) &&
    tokenCount(record.startedAt) !== null &&
    (record.endedAt === null ||
      (tokenCount(record.endedAt) !== null &&
        record.endedAt >= record.startedAt)) &&
    ["pending", "succeeded", "failed"].includes(record.outcome) &&
    Array.isArray(record.rows) &&
    record.rows.length > 0 &&
    record.rows.every(
      (row) =>
        row &&
        (row.model === null || modelName(row.model) === row.model) &&
        ["reported", "partial", "unknown"].includes(row.coverage) &&
        [row.input, row.output, row.cached, row.total].every(
          (v) => v === null || tokenCount(v) !== null,
        ),
    )
  );
}
export async function readUsageRecords(
  directory: string,
): Promise<{ records: UsageRecord[]; damaged: number }> {
  let names: string[];
  try {
    names = await readdir(join(directory, "calls"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { records: [], damaged: 0 };
    throw new Error("Cannot read smoke usage history.");
  }
  const records: UsageRecord[] = [];
  let damaged = 0;
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(directory, "calls", name), "utf8"),
      );
      if (!validRecord(value) || name !== `${value.id}.json`) {
        damaged++;
        continue;
      }
      records.push(value);
    } catch {
      damaged++;
    }
  }
  return { records, damaged };
}
export function summarizeUsage(records: UsageRecord[]) {
  const rows = records.flatMap((record) => record.rows);
  const sum = (key: "input" | "output" | "cached" | "total") =>
    rows.reduce((n, row) => n + (row[key] ?? 0), 0);
  const knownTotal = rows.reduce(
    (n, row) => n + (row.total ?? (row.input ?? 0) + (row.output ?? 0)),
    0,
  );
  return {
    calls: records.length,
    total: knownTotal,
    input: sum("input"),
    output: sum("output"),
    cached: sum("cached"),
    incomplete: records.filter(
      (r) =>
        r.outcome === "pending" ||
        r.rows.some((row) => row.coverage !== "reported" || row.total === null),
    ).length,
    unknown: rows.filter((row) => row.coverage === "unknown").length,
  };
}
export function formatUsageReport(
  records: UsageRecord[],
  runId: string,
  limits: UsageLimits,
  now = Date.now(),
  damaged = 0,
): string {
  const describe = (items: UsageRecord[]) => {
    const summary = summarizeUsage(items);
    if (!summary.calls) return "no recorded calls";
    if (items.every((r) => r.rows.every((row) => row.coverage === "unknown")))
      return "unknown usage (INCOMPLETE)";
    return `${summary.total.toLocaleString("en-US")} known tokens${summary.incomplete ? ` (INCOMPLETE: ${summary.incomplete} call(s), ${summary.unknown} unknown row(s))` : " (reported)"}`;
  };
  const current = records.filter((r) => r.runId === runId);
  const lines = [
    "\nSmoke-test token usage (local history; not account quota or cost)",
    `This run: ${describe(current)}`,
  ];
  for (const hours of usageWindows) {
    const items = records.filter((r) => {
      const time = r.endedAt ?? r.startedAt;
      return time > now - hours * 3_600_000 && time <= now;
    });
    const summary = summarizeUsage(items);
    const limit = limits[hours];
    const status =
      limit === undefined
        ? "limit unset"
        : summary.total > limit
          ? `WARNING: exceeds ${limit.toLocaleString("en-US")}`
          : summary.incomplete || damaged
            ? `cannot confirm below ${limit.toLocaleString("en-US")}`
            : `within ${limit.toLocaleString("en-US")}`;
    lines.push(`Last ${hours}h: ${describe(items)} | ${status}`);
  }
  const groups = new Map<string, UsageRecord[]>();
  for (const record of current)
    for (const row of record.rows) {
      const key = `${record.harness} / ${row.model ?? "model unreported"}`;
      const items = groups.get(key) ?? [];
      items.push({ ...record, rows: [row] });
      groups.set(key, items);
    }
  for (const [key, items] of groups) {
    const summary = summarizeUsage(items);
    const display = (field: "input" | "output" | "cached") =>
      items.every((r) => r.rows.every((row) => row[field] === null))
        ? "unknown"
        : `${summary[field].toLocaleString("en-US")}${items.some((r) => r.rows.some((row) => row[field] === null)) ? "+unknown" : ""}`;
    lines.push(
      `  ${key}: ${describe(items)}; input ${display("input")}, output ${display("output")}, cached ${display("cached")} (included in input)`,
    );
  }
  if (damaged)
    lines.push(
      `WARNING: ${damaged} unreadable/invalid history file(s); rolling totals are incomplete.`,
    );
  lines.push(
    "Only instrumented live smoke calls are counted. Missing usage is unknown, never free.",
  );
  return lines.join("\n") + "\n";
}
export async function prepareUsageRun(env = process.env) {
  const directory = usageDirectory(env);
  const limits = await loadUsageLimits(directory, env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  return {
    env: { SESH_SMOKE_USAGE_DIR: directory, SESH_SMOKE_USAGE_RUN_ID: runId },
    async report() {
      const { records, damaged } = await readUsageRecords(directory);
      process.stdout.write(
        formatUsageReport(records, runId, limits, Date.now(), damaged),
      );
    },
  };
}
