#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditLegacyCommand } from "./audit.js";
import { doctorCommand } from "./doctor.js";
import {
  beginCommand,
  commitCommand,
  initCommand,
  integrateCommand,
  registerCommand,
  resumeCommand,
  validateCommand,
} from "./handoff.js";
import { statusCommand } from "./status.js";
import { reconcileCommand } from "./reconcile.js";
import { benchmarkCommand } from "./benchmark.js";
import { finishPerformance, startPerformance } from "./performance.js";
import type { RolloutDisposition } from "./types.js";
import { incidentCommand } from "./incident.js";
import { cleanupGuidanceCommand } from "./cleanup-guidance.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  const instrument = new Set([
    "begin",
    "commit",
    "validate",
    "integrate",
    "resume",
  ]).has(command ?? "");
  if (instrument) startPerformance(command!);
  try {
    switch (command) {
      case "init":
        rejectArguments(args);
        await initCommand();
        break;
      case "register":
        {
          const options = parseRegisterOptions(args);
          await registerCommand(
            options.path,
            options.autoConfig,
            options.setupCommands,
          );
        }
        break;
      case "begin": {
        const options = parseOptions(args, true);
        await beginCommand(
          options.summary,
          options.dependsOn,
          options.autoBranch,
          options.createWorktree,
        );
        break;
      }
      case "integrate": {
        const options = parseOptions(args, false);
        await integrateCommand(
          options.summary,
          options.rolloutDisposition,
          options.rolloutFollowUps,
          options.sessionId,
        );
        break;
      }
      case "commit": {
        const options = parseCommitOptions(args);
        await commitCommand(options.message, options.sessionId);
        break;
      }
      case "validate": {
        await validateCommand(parseSessionOption(args));
        break;
      }
      case "resume": {
        await resumeCommand(parseSessionOption(args));
        break;
      }
      case "status": {
        await statusCommand(parseSessionOption(args));
        break;
      }
      case "incident": {
        if (args.length !== 1 || !args[0])
          throw new Error("Usage: parallel-integrator incident <ticket-id>");
        await incidentCommand(args[0]);
        break;
      }
      case "reconcile": {
        const options = parseReconcileOptions(args);
        await reconcileCommand(options.apply, options.path);
        break;
      }
      case "audit-legacy":
        rejectArguments(args);
        await auditLegacyCommand();
        break;
      case "cleanup-guidance":
        if (args.length > 1 || (args.length === 1 && args[0] !== "--apply"))
          throw new Error(
            "Usage: parallel-integrator cleanup-guidance [--apply]",
          );
        await cleanupGuidanceCommand(args[0] === "--apply");
        break;
      case "doctor":
        rejectArguments(args);
        await doctorCommand();
        break;
      case "benchmark":
        await benchmarkCommand(parseBenchmarkOptions(args));
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        process.stdout.write(helpText);
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${helpText}`);
    }
    if (instrument) await finishPerformance("succeeded");
  } catch (error) {
    if (instrument) await finishPerformance("failed", error);
    throw error;
  }
}

function parseBenchmarkOptions(args: string[]): {
  runs: number;
  json: boolean;
  check: boolean;
} {
  let runs = 5;
  let json = false;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--check") {
      check = true;
      runs = Math.min(runs, 3);
    } else if (argument === "--runs") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("benchmark --runs must be an integer from 1 to 100");
      }
      runs = value;
      index += 1;
    } else {
      throw new Error(`Unknown benchmark option: ${argument}`);
    }
  }
  return { runs, json, check };
}

function parseOptions(
  args: string[],
  allowDependencies: boolean,
): {
  summary: string;
  dependsOn: string[];
  autoBranch: boolean;
  createWorktree: boolean;
  sessionId?: string;
  rolloutDisposition?: RolloutDisposition;
  rolloutFollowUps: string[];
} {
  let summary = "";
  const dependsOn: string[] = [];
  let autoBranch = true;
  let createWorktree = false;
  let sessionId: string | undefined;
  let rolloutDisposition: RolloutDisposition | undefined;
  const rolloutFollowUps: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--summary" && value !== undefined) {
      summary = value;
      index += 1;
    } else if (
      allowDependencies &&
      argument === "--depends-on" &&
      value !== undefined
    ) {
      dependsOn.push(value);
      index += 1;
    } else if (allowDependencies && argument === "--auto-branch") {
      autoBranch = true;
    } else if (allowDependencies && argument === "--no-auto-branch") {
      autoBranch = false;
    } else if (allowDependencies && argument === "--create-worktree") {
      createWorktree = true;
    } else if (!allowDependencies && argument === "--session" && value) {
      if (sessionId) throw new Error("--session may be specified only once");
      sessionId = value;
      index += 1;
    } else if (!allowDependencies && argument === "--rollout" && value) {
      if (rolloutDisposition)
        throw new Error("--rollout may be specified only once");
      if (!["none", "applied", "automated", "manual"].includes(value))
        throw new Error(
          "--rollout must be none, applied, automated, or manual",
        );
      rolloutDisposition = value as RolloutDisposition;
      index += 1;
    } else if (!allowDependencies && argument === "--follow-up" && value) {
      if (!value.trim()) throw new Error("--follow-up must not be empty");
      rolloutFollowUps.push(value.trim());
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
  }
  return {
    summary,
    dependsOn,
    autoBranch,
    createWorktree,
    rolloutFollowUps,
    ...(rolloutDisposition ? { rolloutDisposition } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function rejectArguments(args: string[]): void {
  if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
}

function parseCommitOptions(args: string[]): {
  message: string;
  sessionId?: string;
} {
  let message = "";
  let sessionId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (
      (argument === "--message" || argument === "-m") &&
      value !== undefined
    ) {
      if (message) throw new Error("commit accepts exactly one message");
      message = value;
      index += 1;
    } else if (argument === "--session" && value !== undefined) {
      if (sessionId) throw new Error("--session may be specified only once");
      sessionId = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete commit option: ${argument}`);
    }
  }
  return { message, ...(sessionId ? { sessionId } : {}) };
}

function parseSessionOption(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--session" && args[1]) return args[1];
  throw new Error("Expected at most one --session <session-id> option");
}

function parseRegisterOptions(args: string[]): {
  path: string | undefined;
  autoConfig: boolean;
  setupCommands: [string, ...string[]][];
} {
  let path: string | undefined;
  let autoConfig = false;
  const setupCommands: [string, ...string[]][] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--auto-config" && !autoConfig) {
      autoConfig = true;
    } else if (argument === "--setup-command") {
      const value = args[index + 1];
      if (value === undefined) throw registerUsageError();
      setupCommands.push(parseCommand(value));
      index += 1;
    } else if (!argument.startsWith("--") && path === undefined) {
      path = argument;
    } else {
      throw registerUsageError();
    }
  }
  return { path, autoConfig, setupCommands };
}

function parseCommand(value: string): [string, ...string[]] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid --setup-command JSON: ${value}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error(
      '--setup-command must be a JSON array of non-empty strings, for example \'["make","setup"]\'',
    );
  }
  return parsed as [string, ...string[]];
}

function registerUsageError(): Error {
  return new Error(
    "Usage: parallel-integrator register [repo-path] [--auto-config] [--setup-command '<json-array>']...",
  );
}

function parseReconcileOptions(args: string[]): {
  apply: boolean;
  path: string | undefined;
} {
  let apply = false;
  let path: string | undefined;
  for (const argument of args) {
    if (argument === "--apply" && !apply) apply = true;
    else if (!argument.startsWith("--") && path === undefined) path = argument;
    else
      throw new Error(
        "Usage: parallel-integrator reconcile [repo-path] [--apply]",
      );
  }
  return { apply, path };
}

const helpText = `parallel-integrator - one-shot Git integration

Usage:
  parallel-integrator init
  parallel-integrator register [repo-path] [--auto-config] [--setup-command '<json-array>']...
  parallel-integrator begin --summary "..." [--create-worktree] [--no-auto-branch] [--depends-on <session-id>]...
  parallel-integrator commit --message "..." [--session <session-id>]
  parallel-integrator validate [--session <session-id>]
  parallel-integrator integrate --summary "..." --rollout <none|applied|automated|manual> [--follow-up "<action, destination, exact configuration names; no secret values>"]... [--session <session-id>]
  parallel-integrator resume [--session <session-id>]
  parallel-integrator status [--session <session-id>]
  parallel-integrator incident <ticket-id>
  parallel-integrator reconcile [repo-path] [--apply]
  parallel-integrator audit-legacy
  parallel-integrator cleanup-guidance [--apply]
  parallel-integrator doctor
  parallel-integrator benchmark [--runs <n>] [--json] [--check]
`;

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `parallel-integrator: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const argument = process.argv[1];
  if (!argument) return false;
  try {
    return (
      realpathSync(argument) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
