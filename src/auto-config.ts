import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Command, ValidationTier } from "./types.js";

const SOURCE_SCRIPTS = ["format:check", "typecheck", "lint", "test"];
const INTEGRATION_ONLY_SCRIPTS = ["build"];
const SOURCE_OVERRIDE = "handoff:source";
const INTEGRATION_OVERRIDE = "handoff:integration";
const POST_INTEGRATION_SCRIPT = "handoff:post-integration";

export interface AutoConfig {
  environments: string[];
  setupCommands: Command[];
  sourceValidationCommands: Command[];
  integrationValidationCommands: Command[];
  validationTiers: ValidationTier[];
  postIntegrationCommands: Command[];
}

export async function detectAutoConfig(
  repositoryPath: string,
): Promise<AutoConfig | null> {
  const packageJson = await readPackageJson(repositoryPath);
  const packageManager = packageJson
    ? await detectPackageManager(repositoryPath, packageJson.packageManager)
    : null;
  const setup = await detectSetup(
    repositoryPath,
    packageManager,
    packageJson?.packageManager,
  );
  const scripts = new Set(
    packageJson && isRecord(packageJson.scripts)
      ? Object.entries(packageJson.scripts)
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          )
          .map(([name]) => name)
      : [],
  );

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

  if (!packageManager && setup.commands.length === 0) return null;
  return {
    environments: setup.environments,
    setupCommands: setup.commands,
    sourceValidationCommands: packageManager
      ? sourceScripts.map((name) => packageScriptCommand(packageManager, name))
      : [],
    integrationValidationCommands: packageManager
      ? integrationScripts.map((name) =>
          packageScriptCommand(packageManager, name),
        )
      : [],
    validationTiers: [
      {
        name: "docs",
        paths: [
          "**/*.md",
          "**/*.mdx",
          "LICENSE",
          "LICENSE.*",
          "NOTICE",
          "NOTICE.*",
        ],
        sourceValidationCommands: [],
        integrationValidationCommands: [],
        bypassIntegrationWorktree: true,
      },
    ],
    postIntegrationCommands: packageManager
      ? postIntegrationScripts.map((name) =>
          packageScriptCommand(packageManager, name),
        )
      : [],
  };
}

async function readPackageJson(
  repositoryPath: string,
): Promise<Record<string, unknown> | null> {
  const path = join(repositoryPath, "package.json");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) throw new Error("root value must be an object");
    return value;
  } catch (error) {
    throw new Error(
      `Cannot auto-configure: invalid JSON in ${path}: ${errorMessage(error)}`,
    );
  }
}

async function detectSetup(
  repositoryPath: string,
  packageManager: string | null,
  declaredPackageManager: unknown,
): Promise<{ environments: string[]; commands: Command[] }> {
  for (const path of ["scripts/bootstrap", "scripts/setup", "bin/setup"]) {
    if (await isExecutable(join(repositoryPath, path))) {
      return {
        environments: [`repository bootstrap (${path})`],
        commands: [[`./${path}`]],
      };
    }
  }

  const environments: string[] = [];
  const commands: Command[] = [];
  if (packageManager) {
    environments.push(packageManager);
    const command = await packageInstallCommand(
      repositoryPath,
      packageManager,
      declaredPackageManager,
    );
    if (command) commands.push(command);
  }
  for (const candidate of [
    ["uv.lock", "uv", ["uv", "sync", "--frozen"]],
    [
      "poetry.lock",
      "Poetry",
      ["poetry", "install", "--sync", "--no-interaction"],
    ],
    ["Cargo.lock", "Cargo", ["cargo", "fetch", "--locked"]],
    ["go.sum", "Go modules", ["go", "mod", "download"]],
    ["Gemfile.lock", "Bundler", ["bundle", "install"]],
    [
      "composer.lock",
      "Composer",
      ["composer", "install", "--no-interaction", "--no-progress"],
    ],
    ["mix.lock", "Mix", ["mix", "deps.get"]],
  ] as const) {
    if (await exists(join(repositoryPath, candidate[0]))) {
      environments.push(candidate[1]);
      commands.push([...candidate[2]] as Command);
    }
  }
  return { environments, commands };
}

async function detectPackageManager(
  repositoryPath: string,
  declared: unknown,
): Promise<string> {
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
    if (await exists(join(repositoryPath, file))) return name;
  }
  return "npm";
}

async function packageInstallCommand(
  repositoryPath: string,
  packageManager: string,
  declared: unknown,
): Promise<Command | null> {
  switch (packageManager) {
    case "pnpm":
      return (await exists(join(repositoryPath, "pnpm-lock.yaml")))
        ? ["corepack", "pnpm", "install", "--frozen-lockfile"]
        : null;
    case "yarn":
      if (!(await exists(join(repositoryPath, "yarn.lock")))) return null;
      return typeof declared === "string" && /^yarn@1(?:\.|$)/.test(declared)
        ? ["corepack", "yarn", "install", "--frozen-lockfile"]
        : ["corepack", "yarn", "install", "--immutable"];
    case "bun":
      return (await exists(join(repositoryPath, "bun.lock"))) ||
        (await exists(join(repositoryPath, "bun.lockb")))
        ? ["bun", "install", "--frozen-lockfile"]
        : null;
    default:
      return (await exists(join(repositoryPath, "package-lock.json")))
        ? ["npm", "ci"]
        : null;
  }
}

function packageScriptCommand(packageManager: string, script: string): Command {
  return packageManager === "pnpm" || packageManager === "yarn"
    ? ["corepack", packageManager, "run", script]
    : [packageManager, "run", script];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
