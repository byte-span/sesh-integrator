import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { git } from "./git.js";
import { acquireRepoLock, releaseRepoLock } from "./lock.js";
import {
  readConfig,
  repoId,
  runtimePaths,
  withConfigLock,
  writeConfig,
} from "./runtime.js";
import type { Config } from "./types.js";

// Does not require HEAD: an unborn repository can be opted out too.
export async function repositoryCommonDir(cwd: string): Promise<string> {
  const raw = await git(["rev-parse", "--git-common-dir"], cwd);
  return realpath(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

export function isRepositoryDisabled(
  config: Config,
  commonDir: string,
): boolean {
  return config.disabledRepositories?.includes(commonDir) ?? false;
}

export function assertRepositoryEnabled(
  config: Config,
  commonDir: string,
): void {
  if (isRepositoryDisabled(config, commonDir)) {
    throw new Error(
      `Repository is disabled: ${commonDir}. Run pintx enable from this repository to re-enable it.`,
    );
  }
}

export async function enablementCommand(
  enabled: boolean,
  path = process.cwd(),
): Promise<void> {
  const commonDir = await repositoryCommonDir(path);
  await withConfigLock(async () => {
    const id = repoId(commonDir);
    const lock = await acquireRepoLock(
      id,
      "repository-enablement",
      0,
      join(runtimePaths().worktrees, id),
      true,
    );
    try {
      const config = await readConfig();
      const disabled = new Set(config.disabledRepositories ?? []);
      if (enabled) disabled.delete(commonDir);
      else disabled.add(commonDir);
      config.disabledRepositories = [...disabled].sort();
      const stored = JSON.parse(
        await readFile(runtimePaths().config, "utf8"),
      ) as Config;
      stored.disabledRepositories = config.disabledRepositories;
      await writeConfig(stored);
      const registered = config.repositories.some(
        (repo) => repo.gitCommonDir === commonDir,
      );
      process.stdout.write(
        `Repository ${enabled ? "enabled" : "disabled"}: ${commonDir}\nRegistration: ${registered ? "registered" : "unregistered"}\n`,
      );
      if (!enabled)
        process.stdout.write(
          "Configuration, sessions, and Git state preserved. Run pintx enable from this repository to re-enable it.\n",
        );
    } finally {
      await releaseRepoLock(lock);
    }
  });
}
