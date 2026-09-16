import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";

export type Harness = "codex" | "claude" | "gemini" | "grok";
interface HarnessInfo {
  name: string;
  directory: string;
  instructions: string;
  skillDirectory: string;
  metadataFiles: string[];
  versionArgs: string[];
}
// This manifest is also consumed directly by the installation scripts.
export const harnessInfo = JSON.parse(
  readFileSync(new URL("../harnesses.json", import.meta.url), "utf8"),
) as Record<Harness, HarnessInfo>;
export const harnesses = Object.keys(harnessInfo) as Harness[];

export function parseHarness(value: string): Harness {
  if (!Object.hasOwn(harnessInfo, value))
    throw new Error(`--harness must be ${harnesses.join(", ")}`);
  return value as Harness;
}

export function harnessCommand(config: Config, harness: Harness): string {
  return (
    config.harnessCommands?.[harness] ??
    (harness === "codex" ? config.codexCommand : undefined) ??
    harness
  );
}

export function installedHarnesses(home: string): Harness[] {
  return harnesses.filter((harness) =>
    existsSync(
      join(
        home,
        harnessInfo[harness].skillDirectory,
        "skills",
        "sesh-integrator-workflow",
        "SKILL.md",
      ),
    ),
  );
}

export function validateHarnessConfig(config: Config): void {
  if (
    config.codexCommand !== undefined &&
    (typeof config.codexCommand !== "string" || !config.codexCommand.trim())
  )
    throw new Error("invalid codexCommand");
  if (config.harnessCommands !== undefined) {
    if (
      !config.harnessCommands ||
      typeof config.harnessCommands !== "object" ||
      Array.isArray(config.harnessCommands)
    )
      throw new Error("invalid harnessCommands");
    for (const [harness, command] of Object.entries(config.harnessCommands)) {
      parseHarness(harness);
      if (typeof command !== "string" || !command.trim())
        throw new Error(`invalid harnessCommands.${harness}`);
    }
  }
  if (
    config.conflictResolutionMode !== undefined &&
    !["current-session", "nested-agent", "nested-codex"].includes(
      config.conflictResolutionMode,
    )
  )
    throw new Error("invalid conflictResolutionMode");
}
