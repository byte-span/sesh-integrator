import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { configHistoryDirectory } from "./config-history.js";
import { unfinished } from "./coordinator.js";
import { withCleanup } from "./file-lock.js";
import {
  git,
  hasMergeInProgress,
  inspectGit,
  isClean,
  listWorktrees,
  refCommit,
} from "./git.js";
import { acquireRepoLock, releaseRepoLock } from "./lock.js";
import {
  readConfig,
  readSessions,
  repoId,
  runtimePaths,
  withConfigLock,
  writeConfig,
} from "./runtime.js";
import type { Config, RepositoryConfig, Session } from "./types.js";
import { worktreePaths } from "./worktree-location.js";

/**
 * seshx names a repository's worktrees after this hash of its Git folder path
 * (`repoId`), so moving the folder changes the name it expects.
 */
const REPOSITORY_ID = /^[0-9a-f]{8}$/;

interface Checkout {
  worktreePath: string;
  gitCommonDir: string;
}

export interface MovedRegistration {
  /** A local registration whose checkout and Git folder no longer exist. */
  registration: RepositoryConfig;
  /**
   * Linked worktrees of the current repository that seshx named after that
   * registration's Git folder: proof the folder moved here.
   */
  evidence: string[];
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** Local registrations, other than `current`'s, whose folders are gone. */
async function missingLocalRegistrations(
  config: Config,
  current: Checkout,
): Promise<RepositoryConfig[]> {
  const result: RepositoryConfig[] = [];
  for (const repository of config.repositories) {
    if (
      repository.includedFrom ||
      repository.gitCommonDir === current.gitCommonDir
    )
      continue;
    if (
      (await missing(repository.path)) &&
      (await missing(repository.gitCommonDir))
    )
      result.push(repository);
  }
  return result;
}

async function managedRoots(
  repositoryPath: string,
  kinds: ("worktrees" | "sourceWorktrees")[],
): Promise<string[]> {
  const defaults = runtimePaths();
  const configured = await worktreePaths(repositoryPath);
  const roots = kinds.flatMap((kind) => [defaults[kind], configured[kind]]);
  const physical = await Promise.all(
    roots.map((root) => realpath(root).catch(() => root)),
  );
  return [...new Set([...roots, ...physical].map((root) => resolve(root)))];
}

/** The repository ID in the name of a worktree seshx manages, if any. */
function managedRepositoryId(
  path: string,
  roots: string[],
): string | undefined {
  for (const root of roots) {
    const inside = relative(root, resolve(path));
    if (!inside || isAbsolute(inside) || inside.startsWith("..")) continue;
    const first = inside.split(sep)[0]!;
    const id = first.slice(0, 8);
    if (REPOSITORY_ID.test(id) && (first.length === 8 || first[8] === "-"))
      return id;
  }
  return undefined;
}

/**
 * Local registrations whose folders no longer exist but whose Git folder now
 * lives at `current`: the current repository still lists worktrees that seshx
 * named after the registration's Git folder. `git worktree list` keeps them
 * after a move, with or without `git worktree repair`.
 */
export async function findMovedRegistrations(
  config: Config,
  current: Checkout,
): Promise<MovedRegistration[]> {
  const candidates = await missingLocalRegistrations(config, current);
  if (candidates.length === 0) return [];
  const roots = await managedRoots(current.worktreePath, [
    "worktrees",
    "sourceWorktrees",
  ]);
  const worktrees = await listWorktrees(current.worktreePath);
  const result: MovedRegistration[] = [];
  for (const registration of candidates) {
    const id = repoId(registration.gitCommonDir);
    const evidence = worktrees
      .filter((worktree) => managedRepositoryId(worktree.path, roots) === id)
      .map((worktree) => worktree.path);
    if (evidence.length > 0) result.push({ registration, evidence });
  }
  return result;
}

function describeSource(repository: RepositoryConfig): string {
  return repository.includedFrom
    ? `by include ${repository.includedFrom.number} (${repository.includedFrom.path})`
    : "locally";
}

/** Keep an opt-out when the repository it names moved. */
function carryOptOut(config: Config, from: string, to: string): boolean {
  const disabled = config.disabledRepositories;
  if (!disabled?.includes(from)) return false;
  config.disabledRepositories = [
    ...new Set(disabled.filter((item) => item !== from).concat(to)),
  ].sort();
  return true;
}

/** `gitCommonDirs`: the Git folders as registered before the move. */
async function reportOldSessions(gitCommonDirs: string[]): Promise<void> {
  const ids = new Set(gitCommonDirs.map(repoId));
  const old = (await readSessions(true)).filter(
    (session) => unfinished(session) && ids.has(session.repositoryId),
  );
  if (old.length === 0) return;
  process.stdout.write(
    `Unfinished sessions recorded at the old path were left unchanged: ${old.map((session) => `${session.id} (${session.status})`).join(", ")}. seshx does not move sessions; inspect each with seshx status --session <id>, and close one whose work is no longer needed with seshx abandon --session <id> --reason "...".\n`,
  );
}

function movedFromCommand(moved: MovedRegistration[]): string {
  return `Several registrations whose folders no longer exist name worktrees of this repository: ${moved.map(({ registration }) => registration.path).join(", ")}. Nothing was changed. Run seshx register --moved-from <old path> here with the one this checkout came from.\n`;
}

/**
 * Let local registrations follow a moved checkout of `current`, with the
 * configuration lock held and `config` read for writing:
 *
 * - unregistered here and exactly one moved registration: adopt it, keeping
 *   every setting and any opt-out;
 * - already registered here: remove the moved entries, which can never apply
 *   again (the registration here is the one in effect);
 * - unregistered and several moved registrations: change nothing and print
 *   the command that picks one.
 *
 * Returns true when it changed the configuration.
 */
export async function followMovedRegistrationLocked(
  config: Config,
  current: Checkout,
): Promise<boolean> {
  const moved = await findMovedRegistrations(config, current);
  if (moved.length === 0) return false;
  const registered = config.repositories.find(
    (repository) => repository.gitCommonDir === current.gitCommonDir,
  );
  if (!registered && moved.length > 1) {
    process.stdout.write(movedFromCommand(moved));
    return false;
  }
  const history = configHistoryDirectory(runtimePaths().config);
  const previousGitDirs = moved.map(
    ({ registration }) => registration.gitCommonDir,
  );
  if (registered) {
    let disabled = false;
    for (const { registration } of moved) {
      config.repositories.splice(config.repositories.indexOf(registration), 1);
      disabled =
        carryOptOut(config, registration.gitCommonDir, current.gitCommonDir) ||
        disabled;
    }
    await writeConfig(config, "seshx moved repository");
    for (const { registration, evidence } of moved)
      process.stdout.write(
        `Removed stale registration ${registration.path}: this repository moved to ${current.worktreePath}, which is registered ${describeSource(registered)}; seshx worktree ${evidence[0]} belongs here now. The removed entry is kept in ${history}.\n`,
      );
    if (disabled)
      process.stdout.write(
        `Repository remains disabled at its new path: ${current.gitCommonDir}. Run seshx enable to re-enable it.\n`,
      );
  } else {
    const { registration, evidence } = moved[0]!;
    const previous = registration.path;
    const disabled = carryOptOut(
      config,
      registration.gitCommonDir,
      current.gitCommonDir,
    );
    registration.path = current.worktreePath;
    registration.gitCommonDir = current.gitCommonDir;
    await writeConfig(config, "seshx moved repository");
    process.stdout.write(
      `Registration moved: ${previous} -> ${current.worktreePath}. Its Git folder now lives here (seshx worktree ${evidence[0]} belongs to this repository); settings are unchanged and the previous entry is kept in ${history}.\n`,
    );
    if (disabled)
      process.stdout.write(
        `Repository remains disabled at its new path: ${current.gitCommonDir}. Run seshx enable to re-enable it.\n`,
      );
  }
  await reportOldSessions(previousGitDirs);
  return true;
}

/**
 * Run before resolving the registration of the repository at `cwd`. Takes the
 * configuration lock only when a moved registration was found. Detection
 * problems are warnings: commands for an ordinary registration still run.
 */
export async function followMovedRegistration(
  cwd = process.cwd(),
): Promise<void> {
  let current: Checkout;
  try {
    current = await inspectGit(cwd);
  } catch {
    return; // Not a repository (or no commit yet); the command reports it.
  }
  try {
    if (
      (await findMovedRegistrations(await readConfig(true), current)).length ===
      0
    )
      return;
    await withConfigLock(async () => {
      await followMovedRegistrationLocked(await readConfig(), current);
    });
  } catch (error) {
    process.stderr.write(
      `Warning: could not check for a moved registration: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * `seshx register --moved-from <old path>`: explicitly adopt the local
 * registration of a folder that no longer exists for the repository here.
 */
export async function adoptMovedRegistrationLocked(
  config: Config,
  current: Checkout,
  oldPath: string,
): Promise<RepositoryConfig> {
  const from = resolve(oldPath);
  const registration = config.repositories.find(
    (repository) => !repository.includedFrom && repository.path === from,
  );
  if (!registration)
    throw new Error(
      `No local registration has path ${from}; nothing changed. seshx status lists the registrations.`,
    );
  if (!(await missing(registration.path)))
    throw new Error(
      `${registration.path} still exists, so it has not moved; nothing changed.`,
    );
  if (!(await missing(registration.gitCommonDir)))
    throw new Error(
      `${registration.gitCommonDir} still exists, so that repository has not moved; nothing changed.`,
    );
  const registered = config.repositories.find(
    (repository) => repository.gitCommonDir === current.gitCommonDir,
  );
  if (registered)
    throw new Error(
      `${current.worktreePath} is already registered ${describeSource(registered)}; nothing changed. Remove the entry for ${registration.path} from ${runtimePaths().config} if it is no longer needed.`,
    );
  // Guard against adopting another repository's settings: commits its
  // sessions recorded must exist here.
  const oldId = repoId(registration.gitCommonDir);
  const recorded = [
    ...new Set(
      (await readSessions(true))
        .filter((session) => session.repositoryId === oldId)
        .flatMap((session) => [
          session.promotedCommit,
          session.readyCommit,
          session.startCommit,
        ])
        .filter((commit): commit is string => !!commit),
    ),
  ].slice(0, 50);
  if (recorded.length > 0) {
    let found = false;
    for (const commit of recorded)
      if (await refCommit(current.worktreePath, commit)) {
        found = true;
        break;
      }
    if (!found)
      throw new Error(
        `None of the ${recorded.length} commits that sessions of ${registration.path} recorded exist in ${current.worktreePath}, so it is not that repository; nothing changed.`,
      );
  }
  const disabled = carryOptOut(
    config,
    registration.gitCommonDir,
    current.gitCommonDir,
  );
  const previous = registration.path;
  const previousGitDir = registration.gitCommonDir;
  registration.path = current.worktreePath;
  registration.gitCommonDir = current.gitCommonDir;
  await writeConfig(config, "seshx register --moved-from");
  process.stdout.write(
    `Registration moved: ${previous} -> ${current.worktreePath}; settings are unchanged and the previous entry is kept in ${configHistoryDirectory(runtimePaths().config)}.\n`,
  );
  if (disabled)
    process.stdout.write(
      `Repository remains disabled at its new path: ${current.gitCommonDir}. Run seshx enable to re-enable it.\n`,
    );
  await reportOldSessions([previousGitDir]);
  return registration;
}

/** Appended to "not registered" errors when local registrations point nowhere. */
export function missingRegistrationsHint(config: Config): string {
  const gone = config.repositories.filter(
    (repository) =>
      !repository.includedFrom &&
      !existsSync(repository.path) &&
      !existsSync(repository.gitCommonDir),
  );
  if (gone.length === 0) return "";
  return ` Registrations whose folders no longer exist: ${gone.map((repository) => repository.path).join(", ")}. If this checkout was moved from one of them, run seshx register --moved-from <old path> here to keep its settings.`;
}

/** Lines `seshx status` prints about moved registrations of `current`. */
export async function movedRegistrationStatus(
  config: Config,
  current: Checkout,
): Promise<string> {
  const moved = await findMovedRegistrations(config, current);
  if (moved.length === 0) return "";
  const registered = config.repositories.some(
    (repository) => repository.gitCommonDir === current.gitCommonDir,
  );
  if (registered)
    return moved
      .map(
        ({ registration }) =>
          `Stale registration: ${registration.path} (this repository moved here; the next seshx register, begin or integrate here removes it)\n`,
      )
      .join("");
  if (moved.length === 1)
    return `Moved registration: ${moved[0]!.registration.path} -> this checkout (the next seshx register, begin or integrate here updates it)\n`;
  return `Moved registrations: ${moved.map(({ registration }) => registration.path).join(", ")}; run seshx register --moved-from <old path> here with the one this checkout came from\n`;
}

async function samePath(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  const [a, b] = await Promise.all(
    [left, right].map((path) => realpath(path).catch(() => resolve(path))),
  );
  return a === b;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Before seshx adds `canonicalPath` for the integration branch: when the
 * branch is still checked out in an integration worktree this repository left
 * under another ID (its previous Git folder path), move that worktree to
 * `canonicalPath` if it is clean and idle. Otherwise stop with the exact
 * reason. Never removes, forces, unlocks or prunes anything.
 */
export async function relocateMovedIntegrationWorktree(
  repository: RepositoryConfig,
  session: Session,
  canonicalPath: string,
): Promise<void> {
  const branch = repository.integrationBranch;
  const holder = (await listWorktrees(repository.path)).find(
    (worktree) => worktree.branch === `refs/heads/${branch}`,
  );
  if (!holder || (await samePath(holder.path, canonicalPath))) return;
  const stop = (reason: string) =>
    new Error(
      `Integration branch ${branch} is checked out in ${holder.path}; ${reason} Nothing was moved or removed.`,
    );
  const roots = await managedRoots(repository.path, ["worktrees"]);
  const previousId = roots.includes(resolve(dirname(holder.path)))
    ? basename(holder.path)
    : undefined;
  if (
    !previousId ||
    !REPOSITORY_ID.test(previousId) ||
    previousId === basename(canonicalPath)
  )
    throw stop(
      "seshx does not manage that checkout. Switch it to another branch or remove that worktree yourself, then rerun.",
    );
  if (await missing(holder.path))
    throw stop(
      `that folder no longer exists. If it is no longer needed, run git -C ${repository.path} worktree prune, then rerun.`,
    );
  let context;
  try {
    context = await inspectGit(holder.path);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .split("\n", 1)[0]
      ?.trim();
    throw stop(
      `Git cannot open it (${detail}). If this repository's folder moved, run git -C ${repository.path} worktree repair, then rerun.`,
    );
  }
  if (context.gitCommonDir !== repository.gitCommonDir)
    throw stop(
      `it belongs to ${context.gitCommonDir}, not ${repository.gitCommonDir}.`,
    );
  if (holder.locked !== undefined)
    throw stop(
      `Git marks it locked${holder.locked ? ` (${holder.locked})` : ""}. seshx leaves locked worktrees alone; inspect it and unlock it yourself if that is safe, then rerun.`,
    );
  if ((await hasMergeInProgress(holder.path)) || !(await isClean(holder.path)))
    throw stop(
      "it has changes or a merge in progress, so seshx preserves it. Inspect and recover it manually, then rerun.",
    );
  const waiting = (await readSessions(true)).filter(
    (other) =>
      other.id !== session.id &&
      unfinished(other) &&
      (other.integrationWorktreePath === holder.path ||
        (other.repositoryId === previousId && other.status !== "active")),
  );
  if (waiting.length > 0)
    throw stop(
      `unfinished ${plural(waiting.length, "session", "sessions")} ${waiting.map((other) => `${other.id} (${other.status})`).join(", ")} may still need it. Finish or abandon ${plural(waiting.length, "it", "them")} first (seshx status --session <id>), then rerun.`,
    );
  // The worktree's own lock: an integration still running under the old ID
  // keeps it. Never waits, and never removes an existing or unknown lock.
  const lock = await acquireRepoLock(
    previousId,
    session.id,
    0,
    holder.path,
    true,
    `move integration worktree ${holder.path}`,
  );
  await withCleanup(
    async () => {
      await mkdir(dirname(canonicalPath), { recursive: true });
      await git(
        ["worktree", "move", holder.path, canonicalPath],
        repository.path,
      );
    },
    () => releaseRepoLock(lock),
  );
  process.stdout.write(
    `Moved integration worktree ${holder.path} to ${canonicalPath}: this repository left it under ID ${previousId} from its previous folder path. It was clean and idle; ${branch} is unchanged.\n`,
  );
}
