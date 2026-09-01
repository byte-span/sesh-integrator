import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { recordSubprocess } from "./performance.js";
import {
  acquireValidationResources,
  releaseValidationResources,
} from "./resource-lock.js";
import {
  detectValidationPreparation,
  displayPreparationDirectory,
} from "./preparation.js";
import type {
  Command,
  CommandExecutionResult,
  CommandResult,
  ValidationStep,
  ValidationCommand,
  ValidationFailureRecord,
} from "./types.js";
import { validationCommandValue } from "./validation.js";

export class ValidationFailure extends Error {
  constructor(readonly record: ValidationFailureRecord) {
    super(record.message);
  }
}

export async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    echo?: boolean;
  } = {},
): Promise<CommandResult> {
  const started = process.hrtime.bigint();
  return await new Promise((resolve, reject) => {
    let recorded = false;
    const recordOnce = () => {
      if (recorded) return;
      recorded = true;
      recordSubprocess(elapsedMs(started));
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.echo) process.stdout.write(text);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.echo) process.stderr.write(text);
    });
    child.once("error", (error) => {
      recordOnce();
      reject(error);
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("close", (code) => {
      recordOnce();
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

export async function runChecked(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await run(command, args, cwd === undefined ? {} : { cwd });
  if (result.code !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `: ${details}` : ""}`,
    );
  }
  return result.stdout.trim();
}

export async function runValidation(
  commands: ValidationStep[],
  cwd: string,
  options: {
    cachedFingerprints?: Set<string>;
    onCommandSuccess?: (command: Command, fingerprint: string) => Promise<void>;
    sessionId?: string;
    resourceWaitSeconds?: number;
    phase?: "source" | "integration";
  } = {},
): Promise<{ cacheHits: number; executed: number }> {
  if (commands.length > 0) {
    await runValidationPreparation(cwd);
  }
  let cacheHits = 0;
  let executed = 0;
  for (const step of commands) {
    const group =
      Array.isArray(step) || "command" in step ? [step] : step.parallel;
    const runnable = group.filter((entry) => {
      const command = validationCommandValue(entry);
      const fingerprint = commandFingerprint(command);
      if (options.cachedFingerprints?.has(fingerprint)) {
        process.stdout.write(`Using cached validation: ${command.join(" ")}\n`);
        cacheHits += 1;
        return false;
      }
      return true;
    });
    const results = await Promise.all(
      runnable.map(async (entry) => {
        const command = validationCommandValue(entry);
        process.stdout.write(`Running validation: ${command.join(" ")}\n`);
        await runValidationCommand(entry, cwd, options);
        return { command };
      }),
    );
    executed += results.length;
    for (const { command } of results) {
      await options.onCommandSuccess?.(command, commandFingerprint(command));
    }
  }
  return { cacheHits, executed };
}

async function runValidationCommand(
  entry: ValidationCommand,
  cwd: string,
  options: {
    sessionId?: string;
    resourceWaitSeconds?: number;
    phase?: "source" | "integration";
  },
): Promise<void> {
  const command = validationCommandValue(entry);
  const spec = Array.isArray(entry) ? undefined : entry;
  const classification = spec?.failure?.classification ?? "deterministic";
  const maxAttempts =
    classification === "transient" ? (spec?.failure?.maxAttempts ?? 3) : 1;
  const initialBackoffMs = spec?.failure?.initialBackoffMs ?? 250;
  const maxBackoffMs = spec?.failure?.maxBackoffMs ?? 2_000;
  const sharedResources = [...new Set(spec?.resources?.shared ?? [])].sort();
  const exclusiveResources = [
    ...new Set(spec?.resources?.exclusive ?? []),
  ].sort();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let handle;
    try {
      handle = await acquireValidationResources(
        sharedResources,
        exclusiveResources,
        options.sessionId ?? `process-${process.pid}`,
        options.resourceWaitSeconds ?? 900,
      );
      const result = await run(command[0], command.slice(1), {
        cwd,
        echo: true,
      });
      if (result.code === 0) return;
      const message = `Validation failed (${result.code}): ${command.join(" ")}`;
      if (classification === "deterministic" || attempt === maxAttempts) {
        throw failure(message, attempt);
      }
    } catch (error) {
      if (error instanceof ValidationFailure) throw error;
      if (classification === "deterministic" || attempt === maxAttempts) {
        throw failure(
          error instanceof Error ? error.message : String(error),
          attempt,
        );
      }
    } finally {
      if (handle) await releaseValidationResources(handle);
    }
    const backoff = Math.min(
      maxBackoffMs,
      initialBackoffMs * 2 ** (attempt - 1),
    );
    process.stderr.write(
      `Transient validation failure; retrying ${command.join(" ")} in ${backoff}ms (attempt ${attempt + 1}/${maxAttempts})\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  function failure(message: string, attempts: number): ValidationFailure {
    return new ValidationFailure({
      phase: options.phase ?? "source",
      command,
      classification,
      attempts,
      maxAttempts,
      exhausted: classification === "transient" && attempts >= maxAttempts,
      sharedResources,
      exclusiveResources,
      failedAt: new Date().toISOString(),
      message,
    });
  }
}

async function runValidationPreparation(cwd: string): Promise<void> {
  const preparations = await detectValidationPreparation(cwd);
  for (const preparation of preparations) {
    process.stdout.write(
      `Running inferred validation preparation (${preparation.environment}): ${preparation.command.join(" ")} in ${displayPreparationDirectory(cwd, preparation.cwd)}\n`,
    );
    const [command, ...args] = preparation.command;
    const result = await run(command, args, {
      cwd: preparation.cwd,
      echo: true,
    });
    if (result.code !== 0) {
      throw new Error(
        `Inferred validation preparation failed (${result.code}) for ${preparation.environment}: ${preparation.command.join(" ")}`,
      );
    }
  }
}

export function commandFingerprint(command: Command): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, command, node: process.version }))
    .digest("hex");
}

export async function runRequiredCommands(
  commands: Command[],
  cwd: string,
  label: string,
): Promise<void> {
  for (const [command, ...args] of commands) {
    process.stdout.write(`Running ${label}: ${[command, ...args].join(" ")}\n`);
    const result = await run(command, args, { cwd, echo: true });
    if (result.code !== 0) {
      throw new Error(
        `${capitalize(label)} failed (${result.code}): ${[command, ...args].join(" ")}`,
      );
    }
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

export async function runCommandList(
  commands: Command[],
  cwd: string,
  label: string,
): Promise<CommandExecutionResult[]> {
  const results: CommandExecutionResult[] = [];
  for (const commandWithArgs of commands) {
    const [command, ...args] = commandWithArgs;
    process.stdout.write(`Running ${label}: ${commandWithArgs.join(" ")}\n`);
    const result = await run(command, args, { cwd, echo: true });
    results.push({
      command: commandWithArgs,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (result.code !== 0) break;
  }
  return results;
}
