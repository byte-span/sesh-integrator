import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { commandFingerprint, runRequiredCommands } from "./process.js";
import { runtimePaths, writeJsonAtomic } from "./runtime.js";
import type {
  Command,
  RepositoryConfig,
  Session,
  ValidationCacheEntry,
  ValidationStep,
} from "./types.js";
import { validationCommandValue } from "./validation.js";

export async function runSetupWithCache(
  repository: RepositoryConfig,
  cwd: string,
): Promise<{ cacheHit: boolean }> {
  const fingerprint = await setupFingerprint(repository, cwd);
  const cachePath = fingerprint
    ? join(runtimePaths().cache, "setup", `${fingerprint}.json`)
    : undefined;
  if (
    cachePath &&
    (await exists(cachePath)) &&
    (await setupMarkerExists(cwd))
  ) {
    process.stdout.write("Using cached advisory setup.\n");
    return { cacheHit: true };
  }
  await runRequiredCommands(repository.setupCommands, cwd, "setup command");
  if (cachePath && (await setupMarkerExists(cwd))) {
    await writeJsonAtomic(cachePath, {
      version: 1,
      fingerprint,
      cwd,
      completedAt: new Date().toISOString(),
    });
  }
  return { cacheHit: false };
}

export async function validationCacheFor(
  repository: RepositoryConfig,
  session: Session,
  tree: string,
  steps: ValidationStep[],
): Promise<Set<string>> {
  if (repository.validationCache === "off") return new Set();
  const available = new Set<string>();
  const entries = session.validationCacheEntries ?? [];
  for (const command of flattenSteps(steps)) {
    const fingerprint = validationFingerprint(repository, tree, command);
    if (entries.some((entry) => entry.fingerprint === fingerprint)) {
      available.add(commandFingerprint(command));
      continue;
    }
    if (
      repository.validationCache === "repository" &&
      (await exists(repositoryValidationPath(fingerprint)))
    ) {
      available.add(commandFingerprint(command));
    }
  }
  return available;
}

export async function recordValidationCache(
  repository: RepositoryConfig,
  session: Session,
  tree: string,
  command: Command,
): Promise<void> {
  if (repository.validationCache === "off") return;
  const entry: ValidationCacheEntry = {
    fingerprint: validationFingerprint(repository, tree, command),
    tree,
    command,
    completedAt: new Date().toISOString(),
  };
  session.validationCacheEntries ??= [];
  if (
    !session.validationCacheEntries.some(
      (candidate) => candidate.fingerprint === entry.fingerprint,
    )
  ) {
    session.validationCacheEntries.push(entry);
  }
  if (repository.validationCache === "repository") {
    await writeJsonAtomic(repositoryValidationPath(entry.fingerprint), {
      version: 1,
      repositoryId: session.repositoryId,
      ...entry,
    });
  }
}

function validationFingerprint(
  repository: RepositoryConfig,
  tree: string,
  command: Command,
): string {
  return digest({
    version: 1,
    repository: repository.gitCommonDir,
    tree,
    command: commandFingerprint(command),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  });
}

async function setupFingerprint(
  repository: RepositoryConfig,
  cwd: string,
): Promise<string | undefined> {
  if (
    repository.setupCommandPolicy !== "advisory" ||
    repository.setupCommands.length === 0 ||
    !repository.setupCommands.every(isCacheableSetupCommand)
  ) {
    return undefined;
  }
  const inputs: Record<string, string> = {};
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
  ]) {
    try {
      inputs[name] = createHash("sha256")
        .update(await readFile(join(cwd, name)))
        .digest("hex");
    } catch {
      // Missing inputs do not contribute to the fingerprint.
    }
  }
  if (Object.keys(inputs).length === 0) return undefined;
  return digest({
    version: 1,
    cwd,
    commands: repository.setupCommands,
    inputs,
    node: process.version,
  });
}

function isCacheableSetupCommand(command: Command): boolean {
  return command.some((part) => ["pnpm", "yarn", "npm", "bun"].includes(part));
}

async function setupMarkerExists(cwd: string): Promise<boolean> {
  return await exists(join(cwd, "node_modules"));
}

function flattenSteps(steps: ValidationStep[]): Command[] {
  return steps.flatMap((step) => {
    const entries =
      Array.isArray(step) || "command" in step ? [step] : step.parallel;
    return entries.map(validationCommandValue);
  });
}

function repositoryValidationPath(fingerprint: string): string {
  return join(runtimePaths().cache, "validation", `${fingerprint}.json`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
