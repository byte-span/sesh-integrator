import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { run, runChecked } from "./process.js";

export interface GitContext {
  worktreePath: string;
  gitCommonDir: string;
  branch: string | null;
  head: string;
}

export async function git(args: string[], cwd: string): Promise<string> {
  return await runChecked("git", args, cwd);
}

export async function inspectGit(cwd: string): Promise<GitContext> {
  const worktreePath = await realpath(
    await git(["rev-parse", "--show-toplevel"], cwd),
  );
  const rawCommonDir = await git(
    ["rev-parse", "--git-common-dir"],
    worktreePath,
  );
  const gitCommonDir = await realpath(
    isAbsolute(rawCommonDir)
      ? rawCommonDir
      : resolve(worktreePath, rawCommonDir),
  );
  const branchResult = await run(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: worktreePath },
  );
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const head = await git(["rev-parse", "HEAD"], worktreePath);
  return { worktreePath, gitCommonDir, branch, head };
}

export async function isClean(cwd: string): Promise<boolean> {
  return (
    (await git(
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      cwd,
    )) === ""
  );
}

export async function refCommit(
  cwd: string,
  ref: string,
): Promise<string | null> {
  const result = await run(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd },
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function detectDefaultBranch(cwd: string): Promise<string> {
  const remote = await run(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  if (remote.code === 0) return remote.stdout.trim().replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (await refCommit(cwd, `refs/heads/${name}`)) return name;
  }
  const current = await inspectGit(cwd);
  if (current.branch) return current.branch;
  throw new Error("Could not determine the repository default branch");
}

export async function unmergedFiles(cwd: string): Promise<string[]> {
  const output = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  return output ? output.split("\n").filter(Boolean) : [];
}

export async function hasMergeInProgress(cwd: string): Promise<boolean> {
  const result = await run("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
    cwd,
  });
  return result.code === 0;
}
