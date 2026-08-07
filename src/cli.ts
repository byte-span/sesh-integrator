#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditLegacyCommand } from "./audit.js";
import { doctorCommand } from "./doctor.js";
import {
  beginCommand,
  initCommand,
  integrateCommand,
  registerCommand,
} from "./handoff.js";
import { statusCommand } from "./status.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "init":
      rejectArguments(args);
      await initCommand();
      break;
    case "register":
      {
        const options = parseRegisterOptions(args);
        await registerCommand(options.path, options.autoConfig);
      }
      break;
    case "begin": {
      const options = parseOptions(args, true);
      await beginCommand(
        options.summary,
        options.dependsOn,
        options.autoBranch,
      );
      break;
    }
    case "integrate": {
      const options = parseOptions(args, false);
      await integrateCommand(options.summary);
      break;
    }
    case "status":
      rejectArguments(args);
      await statusCommand();
      break;
    case "audit-legacy":
      rejectArguments(args);
      await auditLegacyCommand();
      break;
    case "doctor":
      rejectArguments(args);
      await doctorCommand();
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
}

function parseOptions(
  args: string[],
  allowDependencies: boolean,
): { summary: string; dependsOn: string[]; autoBranch: boolean } {
  let summary = "";
  const dependsOn: string[] = [];
  let autoBranch = true;
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
    } else {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
  }
  return { summary, dependsOn, autoBranch };
}

function rejectArguments(args: string[]): void {
  if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
}

function parseRegisterOptions(args: string[]): {
  path: string | undefined;
  autoConfig: boolean;
} {
  let path: string | undefined;
  let autoConfig = false;
  for (const argument of args) {
    if (argument === "--auto-config" && !autoConfig) {
      autoConfig = true;
    } else if (!argument.startsWith("--") && path === undefined) {
      path = argument;
    } else {
      throw new Error(
        "Usage: codex-handoff register [repo-path] [--auto-config]",
      );
    }
  }
  return { path, autoConfig };
}

const helpText = `codex-handoff - one-shot Git integration\n\nUsage:\n  codex-handoff init\n  codex-handoff register [repo-path] [--auto-config]\n  codex-handoff begin --summary \"...\" [--no-auto-branch] [--depends-on <session-id>]...\n  codex-handoff integrate --summary \"...\"\n  codex-handoff status\n  codex-handoff audit-legacy\n  codex-handoff doctor\n`;

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `codex-handoff: ${
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
