import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "./types.js";

const SOURCE_SCRIPTS = ["format:check", "typecheck", "lint", "test"];
const INTEGRATION_ONLY_SCRIPTS = ["build"];
const SOURCE_OVERRIDE = "handoff:source";
const INTEGRATION_OVERRIDE = "handoff:integration";
const POST_INTEGRATION_SCRIPT = "handoff:post-integration";

export interface AutoConfig {
  packageManager: string;
  sourceValidationCommands: Command[];
  integrationValidationCommands: Command[];
  postIntegrationCommands: Command[];
}

export async function detectAutoConfig(
  repositoryPath: string,
): Promise<AutoConfig | null> {
  const packageJsonPath = join(repositoryPath, "package.json");
  let contents: string;
  try {
    contents = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(
      `Cannot auto-configure: invalid JSON in ${packageJsonPath}`,
    );
  }
  if (!isRecord(value) || !isRecord(value.scripts)) {
    return null;
  }

  const scripts = new Set(
    Object.entries(value.scripts)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .map(([name]) => name),
  );
  const packageManager = await detectPackageManager(
    repositoryPath,
    value.packageManager,
  );
  if (!packageManager) return null;

  const sourceScripts = scripts.has(SOURCE_OVERRIDE)
    ? [SOURCE_OVERRIDE]
    : SOURCE_SCRIPTS.filter((name) => scripts.has(name));
  const integrationScripts = scripts.has(INTEGRATION_OVERRIDE)
    ? [INTEGRATION_OVERRIDE]
    : [
        ...sourceScripts,
        ...INTEGRATION_ONLY_SCRIPTS.filter((name) => scripts.has(name)),
      ];
  const postIntegrationScripts = scripts.has(POST_INTEGRATION_SCRIPT)
    ? [POST_INTEGRATION_SCRIPT]
    : [];

  return {
    packageManager,
    sourceValidationCommands: sourceScripts.map((name) =>
      packageScriptCommand(packageManager, name),
    ),
    integrationValidationCommands: integrationScripts.map((name) =>
      packageScriptCommand(packageManager, name),
    ),
    postIntegrationCommands: postIntegrationScripts.map((name) =>
      packageScriptCommand(packageManager, name),
    ),
  };
}

async function detectPackageManager(
  repositoryPath: string,
  declared: unknown,
): Promise<string | null> {
  if (typeof declared === "string") {
    const name = declared.split("@", 1)[0];
    if (name && ["pnpm", "yarn", "npm", "bun"].includes(name)) return name;
  }
  for (const [file, name] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const) {
    try {
      await readFile(join(repositoryPath, file));
      return name;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return "npm";
}

function packageScriptCommand(packageManager: string, script: string): Command {
  return packageManager === "pnpm" || packageManager === "yarn"
    ? ["corepack", packageManager, "run", script]
    : [packageManager, "run", script];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
