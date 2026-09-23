import * as fs from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  basename,
} from "node:path";
import { run } from "./process.js";
import { runtimePaths, readSessions, readConfig, repoId } from "./runtime.js";
import { listWorktrees } from "./git.js";
import { repositoryCommonDir } from "./enablement.js";

const key = "sesh.worktreeRoot";

async function physicalPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await physicalPath(dirname(path)), basename(path));
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

export async function worktreePaths(cwd = process.cwd()) {
  const defaults = runtimePaths();
  const discovery = await run("git", ["rev-parse", "--git-common-dir"], {
    cwd,
  });
  if (discovery.code !== 0) {
    if (discovery.stderr.includes("not a git repository")) return defaults;
    throw new Error(discovery.stderr.trim());
  }
  const result = await run("git", ["config", "--local", "--get", key], { cwd });
  if (result.code === 1) return defaults;
  if (result.code !== 0) throw new Error(result.stderr.trim());
  const root = result.stdout.trim();
  if (!isAbsolute(root)) throw new Error(`${key} must be an absolute path`);
  return {
    ...defaults,
    sourceWorktrees: join(root, "source-worktrees"),
    worktrees: join(root, "worktrees"),
    recoveryWorktrees: join(root, "recovery-worktrees"),
  };
}

export async function worktreeLocationCommand(
  args: string[],
  cwd = process.cwd(),
) {
  if (!args.length) {
    const paths = await worktreePaths(cwd);
    console.log(
      `Source worktrees: ${paths.sourceWorktrees}\nIntegration worktrees: ${paths.worktrees}\nRecovery worktrees: ${paths.recoveryWorktrees}`,
    );
    return;
  }
  if (
    !(args.length === 1 && args[0] === "--repo-local") &&
    !(args.length === 2 && args[0] === "--directory" && isAbsolute(args[1]!))
  )
    throw new Error(
      "Usage: seshx worktree-location [--repo-local | --directory <absolute-path>]",
    );
  const common = await repositoryCommonDir(cwd);
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (top.code) throw new Error(top.stderr.trim());
  const repo = await fs.realpath(top.stdout.trim());
  // Select from the ordinary checkout, never accidentally nest under a task worktree.
  const gitDir = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  if (gitDir.code || (await fs.realpath(gitDir.stdout.trim())) !== common)
    throw new Error(
      "Select the worktree location from the main checkout, not a linked worktree",
    );
  const root = await physicalPath(
    resolve(args[0] === "--repo-local" ? join(repo, ".worktrees") : args[1]!),
  );
  if (within(root, repo) || within(common, root))
    throw new Error(
      "Choose a dedicated worktree directory outside Git metadata",
    );
  const existing = await worktreePaths(cwd);
  if (existing.sourceWorktrees !== join(root, "source-worktrees")) {
    for (const session of await readSessions(true)) {
      if (
        !["succeeded", "no_changes"].includes(session.status) &&
        session.repositoryId === repoId(common)
      )
        throw new Error(
          `Preserve unfinished session ${session.id}; finish it before changing worktree locations`,
        );
    }
    const repository = (await readConfig(true)).repositories.find(
      (entry) => entry.gitCommonDir === common,
    );
    if (repository) {
      const retained = (await listWorktrees(repo)).find(
        (entry) =>
          entry.branch === `refs/heads/${repository.integrationBranch}`,
      );
      if (retained)
        throw new Error(
          `Existing integration worktree retained at ${retained.path}. Review its relocation manually before changing roots; no worktree or branch was moved or removed.`,
        );
    }
  }
  const local = relative(repo, root);
  if (local && within(repo, root)) {
    const patternPath = local.split(sep).join("/");
    if (/[\r\n*?\[\]\\!#]/.test(patternPath))
      throw new Error(
        "Repository-local directory contains unsupported ignore-pattern characters",
      );
    const tracked = await run("git", ["ls-files", "--", local], { cwd: repo });
    if (tracked.code || tracked.stdout.trim())
      throw new Error("Choose a dedicated directory without tracked files");
    const exclude = join(common, "info", "exclude");
    let text = "";
    try {
      text = await fs.readFile(exclude, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pattern = `/${patternPath}/`;
    if (!text.split(/\r?\n/).includes(pattern)) {
      await fs.mkdir(dirname(exclude), { recursive: true });
      await fs.appendFile(
        exclude,
        `${text && !text.endsWith("\n") ? "\n" : ""}${pattern}\n`,
      );
    }
  }
  const saved = await run("git", ["config", "--local", key, root], { cwd });
  if (saved.code) throw new Error(saved.stderr.trim());
  console.log(
    `Worktree root selected: ${root}\nExisting worktrees, runtime state, manual mode and failure evidence are preserved. Run seshx capabilities --recheck in the intended agent environment before beginning work. This setting does not grant filesystem access.`,
  );
}
