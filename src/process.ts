import { spawn } from "node:child_process";
import type {
  Command,
  CommandExecutionResult,
  CommandResult,
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
  return await new Promise((resolve, reject) => {
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
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
  commands: Command[],
  cwd: string,
): Promise<void> {
  await runRequiredCommands(commands, cwd, "validation");
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
