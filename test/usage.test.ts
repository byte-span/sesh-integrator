import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  normalizeUsage,
  registerUsageAdapter,
} from "../src/usage-normalization.js";
import {
  beginUsageCall,
  finishUsageCall,
  formatUsageReport,
  loadUsageLimits,
  parseUsageLimits,
  readUsageRecords,
  type UsageRecord,
} from "../src/usage.js";

const codex = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
});
it("counts Codex cached input once and preserves an unreported model", () => {
  expect(normalizeUsage("codex", codex)).toEqual([
    {
      model: null,
      input: 100,
      output: 10,
      cached: 80,
      total: 110,
      coverage: "reported",
    },
  ]);
  expect(
    normalizeUsage("codex", codex + '\n{"type":"turn.started"}')[0]?.coverage,
  ).toBe("partial");
  expect(normalizeUsage("codex", codex, true)[0]?.coverage).toBe("partial");
});
it("uses Claude per-model counts without adding the aggregate a second time", () => {
  const usage = normalizeUsage(
    "claude",
    JSON.stringify({
      usage: { input_tokens: 999 },
      modelUsage: {
        "future-model": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
        },
      },
    }),
  );
  expect(usage[0]).toMatchObject({
    model: "future-model",
    input: 80,
    output: 20,
    cached: 30,
    total: 100,
    coverage: "reported",
  });
});
it("uses Gemini's reported total and includes thought output", () => {
  expect(
    normalizeUsage(
      "gemini",
      JSON.stringify({
        stats: {
          models: {
            example: {
              tokens: {
                prompt: 100,
                input: 20,
                cached: 80,
                candidates: 10,
                thoughts: 5,
                total: 115,
              },
            },
          },
        },
      }),
    )[0],
  ).toMatchObject({ input: 100, output: 15, cached: 80, total: 115 });
});
it("marks Grok headless accounting partial and does not add reasoning twice", () => {
  expect(
    normalizeUsage(
      "grok",
      JSON.stringify({
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          reasoning_tokens: 5,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
          total_tokens: 100,
        },
      }),
    )[0],
  ).toMatchObject({ input: 80, output: 20, total: 100, coverage: "partial" });
});
it.each(["codex", "claude", "gemini", "grok", "future"])(
  "keeps missing or malformed %s usage unknown",
  (harness) => {
    for (const text of ["", "invalid", "{}"])
      expect(normalizeUsage(harness, text)[0]).toMatchObject({
        total: null,
        coverage: "unknown",
      });
  },
);
it("accepts new harness adapters without model allowlists", () => {
  registerUsageAdapter("future", () => [
    {
      model: "new-model",
      input: 2,
      output: 3,
      cached: 0,
      total: 5,
      coverage: "reported",
    },
  ]);
  expect(normalizeUsage("future", "")[0]?.total).toBe(5);
  registerUsageAdapter("future", () => []);
});

it("persists concurrent calls independently, retains pending calls and stores no raw output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-"));
  try {
    const env = {
      SESH_SMOKE_USAGE_DIR: directory,
      SESH_SMOKE_USAGE_RUN_ID: "run",
    };
    const [a, b] = await Promise.all([
      beginUsageCall("codex", env),
      beginUsageCall("codex", env),
    ]);
    await finishUsageCall(
      a,
      codex + '\n{"type":"item.completed","text":"private-prompt"}',
      false,
    );
    const { records } = await readUsageRecords(directory);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.id === b?.record.id)?.outcome).toBe("pending");
    const stored = await readFile(
      join(directory, "calls", `${a!.record.id}.json`),
      "utf8",
    );
    expect(stored).not.toContain("private-prompt");
    expect(formatUsageReport(records, "run", { 1: 200 })).toContain(
      "cannot confirm below 200",
    );
    await writeFile(join(directory, "calls", "broken.json"), "broken");
    expect((await readUsageRecords(directory)).damaged).toBe(1);
    expect(await beginUsageCall("codex", {})).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses rolling windows, excludes future calls, and warns only above each limit", () => {
  const now = 100 * 3_600_000;
  const record = (id: string, hours: number): UsageRecord => ({
    version: 1,
    id,
    runId: id,
    harness: "codex",
    startedAt: now - hours * 3_600_000,
    endedAt: now - hours * 3_600_000,
    outcome: "succeeded",
    rows: normalizeUsage("codex", codex),
  });
  const report = formatUsageReport(
    [
      record("current", 0),
      record("one", 1),
      record("four", 4),
      record("twelve", 12),
      record("old", 24),
      record("future", -1),
    ],
    "current",
    { 1: 110, 4: 200, 12: 300, 24: 400 },
    now,
  );
  expect(report).toContain("Last 1h: 110 known tokens (reported) | within 110");
  expect(report).toContain(
    "Last 4h: 220 known tokens (reported) | WARNING: exceeds 200",
  );
  expect(report).toContain(
    "Last 12h: 330 known tokens (reported) | WARNING: exceeds 300",
  );
  expect(report).toContain(
    "Last 24h: 440 known tokens (reported) | WARNING: exceeds 400",
  );
  expect(report).toContain("codex / model unreported");
  const unknown = record("current", 0);
  unknown.rows = normalizeUsage("codex", "");
  expect(formatUsageReport([unknown], "current", {}, now)).toContain(
    "This run: unknown usage",
  );
});

it("validates all threshold configuration before any calls", async () => {
  expect(
    parseUsageLimits({ "1": 100, "4": 200, "12": 300, "24": 400 }),
  ).toEqual({ 1: 100, 4: 200, 12: 300, 24: 400 });
  for (const invalid of [
    { 2: 100 },
    { 1: -1 },
    { 1: 0 },
    { 1: 1.5 },
    { 1: "100" },
    [],
  ])
    expect(() => parseUsageLimits(invalid)).toThrow();
  const directory = await mkdtemp(join(tmpdir(), "usage-limits-"));
  try {
    expect(await loadUsageLimits(directory, {})).toEqual({});
    await writeFile(join(directory, "limits.json"), '{"1":100}');
    expect(await loadUsageLimits(directory, {})).toEqual({ 1: 100 });
    expect(
      await loadUsageLimits(directory, {
        SESH_SMOKE_USAGE_LIMITS: '{"4":200}',
      }),
    ).toEqual({ 4: 200 });
    await expect(
      loadUsageLimits(directory, { SESH_SMOKE_USAGE_LIMITS: "bad" }),
    ).rejects.toThrow("Invalid SESH_SMOKE_USAGE_LIMITS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
