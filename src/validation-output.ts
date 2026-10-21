import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  queueCapacity,
  ownerAlive,
  queueEntries,
  queueRoot,
  queueSettings,
} from "./build-queue.js";
import { redactSecrets } from "./redaction.js";
import { runtimePaths } from "./runtime.js";
import type {
  Command,
  CommandResult,
  QueueLoadNote,
  ValidationFailureRecord,
} from "./types.js";

// Bounds keep session records and incidents small while retaining the part of
// the output that normally names the failure (test runners summarise last).
export const outputTailLines = 60;
export const outputTailBytes = 6 * 1024;
const logStreamBytes = 8 * 1024 * 1024;
const maxFailingTests = 20;
const maxSignatureLength = 200;

export type ValidationOutputEvidence = Pick<
  ValidationFailureRecord,
  | "exitCode"
  | "outputTail"
  | "logPath"
  | "logError"
  | "failingTests"
  | "firstErrorLine"
>;

/** Bounded tail of `text`, by line count and UTF-8 size, without partial characters. */
export function boundedTail(
  text: string,
  maxLines = outputTailLines,
  maxBytes = outputTailBytes,
): { text: string; truncated: boolean } {
  const trimmed = text.replace(/\s+$/, "");
  let lines = trimmed ? trimmed.split(/\r?\n/) : [];
  let truncated = lines.length > maxLines;
  lines = lines.slice(-maxLines);
  let value = lines.join("\n");
  while (Buffer.byteLength(value) > maxBytes) {
    truncated = true;
    if (lines.length > 1) {
      lines.shift();
      value = lines.join("\n");
    } else {
      const bytes = Buffer.from(value);
      value = bytes.subarray(bytes.length - maxBytes).toString("utf8");
      // Drop a leading replacement character from a split multi-byte sequence.
      value = value.replace(/^\uFFFD+/, "");
      break;
    }
  }
  return { text: value, truncated };
}

/**
 * Strip terminal controls and redact secrets. Very large output keeps only its
 * last `logStreamBytes`, starting at a whole line so no secret is cut in half
 * where the redaction patterns could no longer recognise it.
 */
function clean(
  text: string,
  env: NodeJS.ProcessEnv,
): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text);
  let kept = text;
  if (bytes > logStreamBytes) {
    kept = Buffer.from(text)
      .subarray(bytes - logStreamBytes)
      .toString("utf8");
    const newline = kept.indexOf("\n");
    kept = newline >= 0 ? kept.slice(newline + 1) : "";
  }
  return {
    text: redactSecrets(stripVTControlCharacters(kept), env),
    omittedBytes: bytes - Buffer.byteLength(kept),
  };
}

function normalizeName(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+\d+(?:\.\d+)?\s?m?s$/, "")
    .slice(0, maxSignatureLength);
}

const failingTestPatterns: RegExp[] = [
  // Vitest/Jest failure headings: " FAIL  test/a.test.ts > suite > name".
  // The first token must be a file so other tools' "FAIL <check>" lines differ.
  /^\s*FAIL\s+(\S+\.[A-Za-z0-9]+(?:\s.*)?)$/,
  // Vitest/Jest/Mocha per-test markers.
  /^\s*[×✗✕✖]\s+(\S.*)$/,
  // pytest summary: "FAILED tests/test_a.py::test_b - AssertionError".
  /^FAILED\s+(\S+)/,
  // Go: "--- FAIL: TestName (0.00s)".
  /^\s*--- FAIL:\s+(\S+)/,
  // Rust: "test module::name ... FAILED".
  /^test\s+(\S+)\s+\.\.\.\s+FAILED$/,
  // TAP/node:test: "not ok 3 - name".
  /^\s*not ok\s+\d+\s+-?\s*(\S.*?)(?:\s+#.*)?$/,
];

const errorLinePattern =
  /(?:\berror\b|\bERR!|\bfatal\b|\bexception\b|\bpanic(?:ked)?\b|^\[(?:error|warn)\])/i;

/**
 * Extract the failing test names, or else the first error line, from redacted
 * output. Vitest prints failures as both "×" markers and "FAIL" headings; the
 * headings carry the file and are preferred when present.
 */
export function failureSignature(
  stdout: string,
  stderr: string,
): { failingTests?: string[]; firstErrorLine?: string } {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/);
  const byPattern = failingTestPatterns.map(
    (pattern) =>
      new Set(
        lines.flatMap((line) => {
          const match = pattern.exec(line);
          return match?.[1] ? [normalizeName(match[1])] : [];
        }),
      ),
  );
  const names = byPattern.find((set) => set.size > 0);
  if (names)
    return { failingTests: [...names].sort().slice(0, maxFailingTests) };
  const errorLine = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)].find(
    (line) =>
      errorLinePattern.test(line) &&
      // pnpm's lifecycle trailer repeats the exit code, not the cause.
      !/ELIFECYCLE|Command failed with exit code/.test(line),
  );
  return errorLine ? { firstErrorLine: normalizeName(errorLine) } : {};
}

/**
 * Preserve a failed validation command's output as bounded, redacted evidence.
 * A full redacted log is written under the runtime logs directory when the
 * command belongs to a session; ad-hoc callers keep only the in-record tail.
 */
export async function captureValidationOutput(
  result: CommandResult,
  context: {
    command: Command;
    cwd: string;
    phase: "source" | "integration";
    attempt: number;
    sessionId?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ValidationOutputEvidence> {
  const env = context.env ?? process.env;
  const cleanedStdout = clean(result.stdout, env);
  const cleanedStderr = clean(result.stderr, env);
  const stdout = cleanedStdout.text;
  const stderr = cleanedStderr.text;
  const stdoutTail = boundedTail(stdout);
  const stderrTail = boundedTail(stderr);
  const evidence: ValidationOutputEvidence = {
    exitCode: result.code,
    outputTail: {
      stdout: stdoutTail.text,
      stderr: stderrTail.text,
      truncated: stdoutTail.truncated || stderrTail.truncated,
    },
    ...failureSignature(stdout, stderr),
  };
  if (!context.sessionId) return evidence;
  try {
    const directory = join(runtimePaths().logs, "validation");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeSession = context.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    const path = join(
      directory,
      `${safeSession}-${context.phase}-${stamp}-${randomBytes(3).toString("hex")}.log`,
    );
    const stream = (
      label: string,
      cleaned: { text: string; omittedBytes: number },
    ) =>
      `--- ${label}${cleaned.omittedBytes ? ` (earliest ${cleaned.omittedBytes} bytes omitted)` : ""} ---\n${cleaned.text}\n`;
    await writeFile(
      path,
      [
        `command: ${redactSecrets(context.command.join(" "), env)}`,
        `cwd: ${context.cwd}`,
        `phase: ${context.phase}`,
        `attempt: ${context.attempt}`,
        `exit code: ${result.code}`,
        `recorded: ${new Date().toISOString()}`,
        "Output is redacted on a best-effort basis; review before sharing.",
        "",
        stream("stdout", cleanedStdout),
        stream("stderr", cleanedStderr),
      ].join("\n"),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    evidence.logPath = path;
  } catch (error) {
    evidence.logError = error instanceof Error ? error.message : String(error);
  }
  return evidence;
}

/**
 * Sample the shared build queue after a command fails. A command that ran has
 * already released its slot when its result returns, so it is counted back in:
 * `running` then describes the load the command finished under. Failures before
 * or without a completed run (such as a queue wait timeout) are not added.
 */
export async function sampleQueueLoad(
  countFailedCommand: boolean,
): Promise<QueueLoadNote> {
  const sampledAt = new Date().toISOString();
  try {
    const root = queueRoot();
    const [settings, entries] = await Promise.all([
      queueSettings(root),
      queueEntries(root),
    ]);
    const limit = queueCapacity(settings);
    return {
      sampledAt,
      running:
        entries.filter((entry) => entry.state === "running").length +
        (countFailedCommand ? 1 : 0),
      waiting: entries.filter(
        (entry) => entry.state === "waiting" && ownerAlive(entry),
      ).length,
      capacity: Number.isFinite(limit) ? limit : "unlimited",
    };
  } catch (error) {
    return {
      sampledAt,
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeQueueLoad(load: QueueLoadNote): string {
  if (load.unavailable !== undefined)
    return `unavailable (${load.unavailable})`;
  return `${load.running ?? 0} running, ${load.waiting ?? 0} waiting (capacity ${load.capacity ?? "unknown"})`;
}

/** Preserved evidence of a validation failure as label/value pairs. */
export function validationFailureEvidence(
  failure: ValidationFailureRecord,
): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (failure.failingTests?.length)
    lines.push([
      "failing tests",
      `${failure.failingTests.slice(0, 5).join("; ")}${failure.failingTests.length > 5 ? ` (+${failure.failingTests.length - 5} more)` : ""}`,
    ]);
  else if (failure.firstErrorLine)
    lines.push(["first error line", failure.firstErrorLine]);
  if (failure.queueLoad)
    lines.push([
      "build queue at failure",
      describeQueueLoad(failure.queueLoad),
    ]);
  if (failure.logPath) lines.push(["full output log", failure.logPath]);
  else if (failure.logError)
    lines.push(["full output log unavailable", failure.logError]);
  if (failure.outputTail)
    lines.push([
      "output tail",
      `kept in the failure record (${failure.outputTail.truncated ? "bounded" : "complete"}, redacted)`,
    ]);
  return lines.map(([label, value]) => [
    label,
    stripVTControlCharacters(value),
  ]);
}
