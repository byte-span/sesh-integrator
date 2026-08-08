import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config, RuntimePaths, Session } from "./types.js";

export const DEFAULT_INTEGRATION_BRANCH = "codex-handoff/integration";

export function runtimePaths(): RuntimePaths {
  const root =
    process.env.CODEX_HANDOFF_HOME ?? join(homedir(), ".codex-handoff");
  return {
    root,
    config: join(root, "config.json"),
    state: join(root, "state.json"),
    codexHome: join(root, "codex-home"),
    sessions: join(root, "sessions"),
    locks: join(root, "locks"),
    logs: join(root, "logs"),
    worktrees: join(root, "worktrees"),
  };
}

export const defaultConfig = (): Config => ({
  lockWaitSeconds: 900,
  codexCommand: "codex",
  conflictResolutionMode: "current-session",
  repositories: [],
});

export async function ensureRuntime(): Promise<RuntimePaths> {
  const paths = runtimePaths();
  await Promise.all([
    mkdir(paths.codexHome, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.locks, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.worktrees, { recursive: true }),
  ]);
  await chmod(paths.codexHome, 0o700);
  await writeJsonIfMissing(paths.config, defaultConfig());
  await writeJsonIfMissing(paths.state, { version: 1 });
  return paths;
}

export async function prepareCodexResolverHome(): Promise<string> {
  const paths = await ensureRuntime();
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  for (const name of ["auth.json", "config.toml"]) {
    const source = join(sourceHome, name);
    const target = join(paths.codexHome, name);
    if (source !== target && (await isNewer(source, target))) {
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
  }
  return paths.codexHome;
}

export async function readConfig(): Promise<Config> {
  const paths = await ensureRuntime();
  const value = await readJson<Config>(paths.config);
  if (
    !Array.isArray(value.repositories) ||
    typeof value.lockWaitSeconds !== "number"
  ) {
    throw new Error(`Invalid configuration: ${paths.config}`);
  }
  for (const repository of value.repositories) {
    repository.setupCommands ??= [];
    repository.validationTiers ??= [];
    repository.postIntegrationCommands ??= [];
  }
  value.conflictResolutionMode ??= "current-session";
  return value;
}

export async function writeConfig(config: Config): Promise<void> {
  const paths = await ensureRuntime();
  await writeJsonAtomic(paths.config, config);
}

export async function readSessions(): Promise<Session[]> {
  const paths = await ensureRuntime();
  const names = (await readdir(paths.sessions)).filter((name) =>
    name.endsWith(".json"),
  );
  const sessions = await Promise.all(
    names.map((name) => readJson<Session>(join(paths.sessions, name))),
  );
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function writeSession(session: Session): Promise<void> {
  const paths = await ensureRuntime();
  await writeJsonAtomic(join(paths.sessions, `${session.id}.json`), session);
}

export async function writeLog(
  name: string,
  contents: string,
): Promise<string> {
  const paths = await ensureRuntime();
  const path = join(paths.logs, name);
  await writeFile(path, contents, "utf8");
  return path;
}

export function makeSessionId(): string {
  return `session_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

export function repoId(gitCommonDir: string): string {
  return randomStableId(gitCommonDir);
}

function randomStableId(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJsonIfMissing(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString(
    "hex",
  )}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function isNewer(source: string, target: string): Promise<boolean> {
  try {
    const sourceStat = await stat(source);
    try {
      return sourceStat.mtimeMs > (await stat(target)).mtimeMs;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
