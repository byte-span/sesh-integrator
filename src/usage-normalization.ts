/** Normalized input includes cache reads/writes; cached tokens are a subset. */
export interface UsageRow {
  model: string | null;
  input: number | null;
  output: number | null;
  cached: number | null;
  total: number | null;
  coverage: "reported" | "partial" | "unknown";
}
export type UsageAdapter = (stdout: string) => UsageRow[];
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
export const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export const modelName = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value)
    ? value
    : null;
const add = (...values: (number | null)[]): number | null =>
  values.every((v) => v !== null)
    ? tokenCount(values.reduce<number>((sum, v) => sum + (v ?? 0), 0))
    : null;
export function unknownUsage(): UsageRow {
  return {
    model: null,
    input: null,
    output: null,
    cached: null,
    total: null,
    coverage: "unknown",
  };
}
function row(
  model: unknown,
  input: number | null,
  output: number | null,
  cached: number | null,
  total = add(input, output),
): UsageRow {
  const known = [input, output, total].some((v) => v !== null);
  return {
    model: modelName(model),
    input,
    output,
    cached,
    total,
    coverage: !known ? "unknown" : total === null ? "partial" : "reported",
  };
}
function json(stdout: string): ObjectValue {
  try {
    return object(JSON.parse(stdout));
  } catch {
    return {};
  }
}

const codex: UsageAdapter = (stdout) => {
  const rows: UsageRow[] = [];
  let model: unknown;
  let damaged = false;
  let pending = false;
  for (const line of stdout.split("\n").filter((s) => s.trim())) {
    const event = json(line);
    if (!event.type) {
      damaged = true;
      continue;
    }
    if (event.type === "turn.started" || event.type === "thread.started") {
      model = event.model ?? model;
      if (event.type === "turn.started") pending = true;
    }
    if (event.type === "turn.completed") {
      pending = false;
      const usage = object(event.usage);
      rows.push(
        row(
          event.model ?? model,
          tokenCount(usage.input_tokens),
          tokenCount(usage.output_tokens),
          tokenCount(usage.cached_input_tokens),
        ),
      );
    }
    if (event.type === "turn.failed" || event.type === "error") damaged = true;
  }
  if (!rows.length) return [unknownUsage()];
  if (damaged || pending)
    rows.forEach((r) => {
      if (r.coverage === "reported") r.coverage = "partial";
    });
  return rows;
};

function cachedInput(
  usage: ObjectValue,
  camel: boolean,
  model: unknown,
  grok: boolean,
): UsageRow {
  const input = tokenCount(usage[camel ? "inputTokens" : "input_tokens"]);
  const output = tokenCount(usage[camel ? "outputTokens" : "output_tokens"]);
  const cached = tokenCount(
    usage[camel ? "cacheReadInputTokens" : "cache_read_input_tokens"],
  );
  const creation = tokenCount(
    usage[camel ? "cacheCreationInputTokens" : "cache_creation_input_tokens"] ??
      (grok && camel ? 0 : undefined),
  );
  const fullInput = add(input, cached, creation);
  const total = tokenCount(usage.total_tokens) ?? add(fullInput, output);
  const result = row(model, fullInput ?? input, output, cached, total);
  if (fullInput === null && result.coverage === "reported")
    result.coverage = "partial";
  return result;
}
function messages(stdout: string, grok: boolean): UsageRow[] {
  const envelope = json(stdout);
  const perModel = object(envelope.modelUsage);
  const rows = Object.keys(perModel).length
    ? Object.entries(perModel).map(([model, value]) =>
        cachedInput(object(value), true, model, grok),
      )
    : [cachedInput(object(envelope.usage), false, envelope.model, grok)];
  // Grok's headless accounting excludes compaction/side-model work. Claude's
  // fallback aggregate excludes subagents; never call either complete accounting.
  if (
    grok ||
    !Object.keys(perModel).length ||
    envelope.usage_is_incomplete ||
    envelope.is_error ||
    envelope.type === "error" ||
    String(envelope.subtype).startsWith("error")
  ) {
    rows.forEach((r) => {
      if (r.coverage === "reported") r.coverage = "partial";
    });
  }
  return rows;
}
const gemini: UsageAdapter = (stdout) => {
  const envelope = json(stdout);
  const models = object(object(envelope.stats).models);
  return Object.entries(models).map(([model, value]) => {
    const tokens = object(object(value).tokens);
    const result = row(
      model,
      tokenCount(tokens.prompt),
      add(tokenCount(tokens.candidates), tokenCount(tokens.thoughts)),
      tokenCount(tokens.cached),
      tokenCount(tokens.total),
    );
    if (envelope.error && result.coverage === "reported")
      result.coverage = "partial";
    return result;
  });
};
const antigravity: UsageAdapter = (stdout) => {
  const envelope = json(stdout);
  const usage = object(envelope.usage);
  const result = row(
    envelope.model,
    tokenCount(usage.input_tokens),
    tokenCount(usage.output_tokens),
    tokenCount(usage.cache_read_tokens),
    tokenCount(usage.total_tokens),
  );
  if (envelope.status !== "SUCCESS" && result.coverage === "reported")
    result.coverage = "partial";
  return [result];
};
const adapters = new Map<string, UsageAdapter>([
  ["codex", codex],
  ["claude", (text) => messages(text, false)],
  ["gemini", gemini],
  ["antigravity", antigravity],
  ["grok", (text) => messages(text, true)],
]);
/** New harness formats plug into this boundary; storage and reporting stay shared. */
export function registerUsageAdapter(
  harness: string,
  adapter: UsageAdapter,
): void {
  adapters.set(harness, adapter);
}
export function normalizeUsage(
  harness: string,
  stdout: string,
  failed = false,
): UsageRow[] {
  let rows: UsageRow[];
  try {
    rows = adapters.get(harness)?.(stdout) ?? [];
  } catch {
    rows = [];
  }
  if (!rows.length) rows = [unknownUsage()];
  return rows.map((value) => {
    const normalized = row(
      value.model,
      tokenCount(value.input),
      tokenCount(value.output),
      tokenCount(value.cached),
      tokenCount(value.total),
    );
    if (
      (failed || value.coverage !== "reported") &&
      normalized.coverage === "reported"
    )
      normalized.coverage = "partial";
    return normalized;
  });
}
