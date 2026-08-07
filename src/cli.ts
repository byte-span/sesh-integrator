#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditLegacyCommand } from "./audit.js";
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
      if (args.length > 1 || args[0]?.startsWith("--"))
        throw new Error("Usage: codex-handoff register [repo-path]");
      await registerCommand(args[0]);
      break;
    case "begin": {
      const options = parseOptions(args, true);
      await beginCommand(options.summary, options.dependsOn);
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
): { summary: string; dependsOn: string[] } {
  let summary = "";
  const dependsOn: string[] = [];
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
    } else {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
  }
  return { summary, dependsOn };
}

function rejectArguments(args: string[]): void {
  if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
}

const helpText = `codex-handoff - one-shot Git integration\n\nUsage:\n  codex-handoff init\n  codex-handoff register [repo-path]\n  codex-handoff begin --summary \"...\" [--depends-on <session-id>]...\n  codex-handoff integrate --summary \"...\"\n  codex-handoff status\n  codex-handoff audit-legacy\n`;

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
