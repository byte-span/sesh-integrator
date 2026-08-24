import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { recordSubprocess } from "./performance.js";
import type {
  Command,
  CommandExecutionResult,
  CommandResult,
  ValidationStep,
} from "./types.js";

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
  } = {},
): Promise<{ cacheHits: number; executed: number }> {
  let cacheHits = 0;
  let executed = 0;
  for (const step of commands) {
    const group = Array.isArray(step) ? [step] : step.parallel;
    const runnable = group.filter((command) => {
      const fingerprint = commandFingerprint(command);
      if (options.cachedFingerprints?.has(fingerprint)) {
        process.stdout.write(`Using cached validation: ${command.join(" ")}\n`);
        cacheHits += 1;
        return false;
      }
      return true;
    });
    const results = await Promise.all(
      runnable.map(async (command) => {
        process.stdout.write(`Running validation: ${command.join(" ")}\n`);
        const result = await run(command[0], command.slice(1), {
          cwd,
          echo: true,
        });
        return { command, result };
      }),
    );
    executed += results.length;
    const failed = results.find(({ result }) => result.code !== 0);
    if (failed) {
      throw new Error(
        `Validation failed (${failed.result.code}): ${failed.command.join(" ")}`,
      );
    }
    for (const { command } of results) {
      await options.onCommandSuccess?.(command, commandFingerprint(command));
    }
  }
  return { cacheHits, executed };
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
