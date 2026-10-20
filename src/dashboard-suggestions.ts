import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { harnessInfo, harnesses, type Harness } from "./harness.js";
import { run } from "./process.js";
import type { Config, RepositoryConfig } from "./types.js";

// Read-only hints for the dashboard Settings form. Nothing here changes Git
// or configuration state; a field still accepts any typed value.

export interface RepositorySuggestions {
  path: string;
  name: string;
  /** Local branches, without the staging branch and seshx task branches. */
  branches: string[];
  /** Remote-tracking branches by remote, for pull-request bases. */
  remoteBranches: Record<string, string[]>;
  remotes: string[];
  /** Why Git could not list this repository, when it could not. */
  error?: string;
}

export interface ProgramSuggestion {
  name: string;
  /** Every match on PATH, in PATH order; the first is what runs. */
  paths: string[];
}

export interface SettingsSuggestions {
  repositories: RepositorySuggestions[];
  /** Reviewers and assignees already named anywhere in the configuration. */
  participants: string[];
  programs: {
    signing: ProgramSuggestion[];
    harnesses: Record<Harness, ProgramSuggestion[]>;
  };
}

export const signingPrograms = ["gpg", "gpg2", "gpgsm", "ssh-keygen"];

// Matches the branch names seshx begin creates for task sessions.
const taskBranch = /^codex\/session-[a-z0-9]+-[0-9a-f]+$/;

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" }) ||
  (a < b ? -1 : a > b ? 1 : 0);

const gitTimeoutMs = 5000;

async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const result = await run("git", args, { cwd, timeoutMs: gitTimeoutMs });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim().split("\n").pop() || `git ${args[0]} failed`,
    );
  return result.stdout.split("\n").filter(Boolean);
}

export async function repositorySuggestions(
  repository: RepositoryConfig,
): Promise<RepositorySuggestions> {
  const result: RepositorySuggestions = {
    path: repository.path,
    name: basename(repository.path),
    branches: [],
    remoteBranches: {},
    remotes: [],
  };
  const listed = (name: string) =>
    name !== repository.integrationBranch && !taskBranch.test(name);
  try {
    const [remotes, refs] = await Promise.all([
      gitLines(["remote"], repository.path),
      gitLines(
        ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
        repository.path,
      ),
    ]);
    result.remotes = [...remotes].sort(byName);
    // Remote names may contain "/", so match the longest known remote first.
    const prefixes = [...remotes].sort((a, b) => b.length - a.length);
    for (const ref of refs) {
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length);
        if (listed(name)) result.branches.push(name);
        continue;
      }
      const rest = ref.slice("refs/remotes/".length);
      const remote = prefixes.find((r) => rest.startsWith(r + "/"));
      const name = remote && rest.slice(remote.length + 1);
      if (!remote || !name || name === "HEAD" || !listed(name)) continue;
      (result.remoteBranches[remote] ??= []).push(name);
    }
    result.branches.sort(byName);
    for (const names of Object.values(result.remoteBranches))
      names.sort(byName);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function configuredParticipants(config: Config): string[] {
  const names = new Set<string>([
    ...(config.defaultPromotion?.reviewers ?? []),
    ...(config.defaultPromotion?.assignees ?? []),
  ]);
  for (const repository of config.repositories)
    if (repository.promotion?.type === "pull-request")
      for (const name of [
        ...(repository.promotion.reviewers ?? []),
        ...(repository.promotion.assignees ?? []),
      ])
        names.add(name);
  return [...names].sort(byName);
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute paths for `name` on PATH, honoring PATHEXT on Windows. Entries
 * that resolve to the same file, such as /bin and /usr/bin, appear once.
 */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const pathValue =
    env.PATH ??
    Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ??
    "";
  // Relative entries would depend on the dashboard's working directory.
  const directories = [
    ...new Set(pathValue.split(delimiter).filter((d) => isAbsolute(d))),
  ];
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const found = await Promise.all(
    directories.map(async (directory) => {
      for (const extension of extensions) {
        const file = join(directory, name + extension);
        if (await isExecutable(file)) return file;
      }
      return undefined;
    }),
  );
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const file of found) {
    if (!file) continue;
    const real = await realpath(file).catch(() => file);
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push(file);
  }
  return unique;
}

async function programSuggestions(
  names: string[],
  env: NodeJS.ProcessEnv,
): Promise<ProgramSuggestion[]> {
  const found = await Promise.all(
    names.map(async (name) => ({ name, paths: await findOnPath(name, env) })),
  );
  return found.filter((program) => program.paths.length);
}

export async function settingsSuggestions(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SettingsSuggestions> {
  const [repositories, signing, agents] = await Promise.all([
    Promise.all(config.repositories.map(repositorySuggestions)),
    programSuggestions(signingPrograms, env),
    Promise.all(
      harnesses.map(async (harness) => [
        harness,
        await programSuggestions(
          [harnessInfo[harness].command ?? harness],
          env,
        ),
      ]),
    ),
  ]);
  return {
    repositories,
    participants: configuredParticipants(config),
    programs: {
      signing,
      harnesses: Object.fromEntries(agents) as Record<
        Harness,
        ProgramSuggestion[]
      >,
    },
  };
}
