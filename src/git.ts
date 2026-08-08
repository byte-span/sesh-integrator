import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { run, runChecked } from "./process.js";
import type {
  GitCommandObservation,
  GitObservation,
  GitPathObservation,
} from "./types.js";

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

export async function observeGitState(cwd: string): Promise<GitObservation> {
  const head = await git(["rev-parse", "HEAD"], cwd);
  const [status, worktreeDiff, stagedDiff, index] = await Promise.all([
    observeGitCommand(
      [
        "-c",
        "status.renames=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      cwd,
    ),
    observeGitCommand(
      ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", "HEAD", "--"],
      cwd,
    ),
    observeGitCommand(
      [
        "diff",
        "--cached",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-z",
        "HEAD",
        "--",
      ],
      cwd,
    ),
    observeGitCommand(["ls-files", "--stage", "-z"], cwd),
  ]);

  const statuses = parseStatus(status.stdout);
  const worktreeRaw = parseRawDiff(worktreeDiff.stdout);
  const indexRaw = parseRawDiff(stagedDiff.stdout);
  const indexEntries = parseIndex(index.stdout);
  const scopedErrors = [status, worktreeDiff, stagedDiff, index].flatMap(
    (command) => parsePathErrors(command.stderr),
  );
  const paths = new Set([
    ...statuses.keys(),
    ...worktreeRaw.keys(),
    ...indexRaw.keys(),
  ]);
  const observations: GitPathObservation[] = [];
  for (const path of [...paths].sort()) {
    const errors = scopedErrors
      .filter(
        (error) =>
          error.path === path ||
          path.startsWith(`${error.path.replace(/\/$/, "")}/`),
      )
      .map((error) => error.message);
    let accessible = errors.length === 0;
    let contentHash: string | null = null;
    const statusCode = statuses.get(path) ?? null;
    const deleted =
      statusCode?.includes("D") || worktreeRaw.get(path)?.endsWith(" D");
    if (accessible && (statusCode || worktreeRaw.has(path)) && !deleted) {
      const hash = await run("git", ["hash-object", "--", path], { cwd });
      if (hash.code === 0) contentHash = hash.stdout.trim() || null;
      else {
        accessible = false;
        errors.push(
          (hash.stderr || hash.stdout).trim() || "git hash-object failed",
        );
      }
    }
    observations.push({
      path,
      tracked: indexEntries.has(path),
      accessible,
      status: statusCode,
      worktreeRaw: worktreeRaw.get(path) ?? null,
      indexRaw: indexRaw.get(path) ?? null,
      indexEntry: indexEntries.get(path) ?? null,
      contentHash,
      errors,
    });
  }
  const scopedLines = new Set(
    scopedErrors
      .filter((error) =>
        observations.some(
          (path) =>
            path.path === error.path ||
            path.path.startsWith(`${error.path.replace(/\/$/, "")}/`),
        ),
      )
      .map((error) => error.message),
  );
  const unscopedErrors = [status, worktreeDiff, stagedDiff, index]
    .flatMap((command) => command.stderr.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !scopedLines.has(line));
  for (const command of [status, worktreeDiff, stagedDiff, index]) {
    if (command.code !== 0 && parsePathErrors(command.stderr).length === 0) {
      unscopedErrors.push(
        `git ${command.args.join(" ")} exited with status ${command.code}`,
      );
    }
  }
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    head,
    commands: { status, worktreeDiff, stagedDiff, index },
    paths: observations,
    unscopedErrors: [...new Set(unscopedErrors)],
  };
}

async function observeGitCommand(
  args: string[],
  cwd: string,
): Promise<GitCommandObservation> {
  return { args, ...(await run("git", args, { cwd })) };
}

function parseStatus(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of output.split("\0").filter(Boolean)) {
    if (record.length < 4) continue;
    result.set(record.slice(3), record.slice(0, 2));
  }
  return result;
}

function parseRawDiff(output: string): Map<string, string> {
  const result = new Map<string, string>();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const tab = record.indexOf("\t");
    if (tab >= 0) {
      result.set(record.slice(tab + 1), record.slice(0, tab));
      continue;
    }
    if (!record.startsWith(":")) continue;
    const path = records[index + 1];
    if (!path) continue;
    result.set(path, record);
    index += 1;
  }
  return result;
}

function parseIndex(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of output.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    result.set(record.slice(tab + 1), record.slice(0, tab));
  }
  return result;
}

function parsePathErrors(stderr: string): { path: string; message: string }[] {
  const result: { path: string; message: string }[] = [];
  for (const rawLine of stderr.split("\n")) {
    const line = rawLine.trim();
    if (
      !/(Operation not permitted|Permission denied|could not open|unable to access)/i.test(
        line,
      )
    ) {
      continue;
    }
    const quoted = line.match(/["']([^"']+)["']/)?.[1];
    const plain = line.match(
      /^(?:error:\s*)?(.+?):\s*(?:Operation not permitted|Permission denied)$/i,
    )?.[1];
    const path = (quoted ?? plain)?.replace(/^\.\//, "");
    if (path) result.push({ path, message: line });
  }
  return result;
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

export async function changedPaths(
  cwd: string,
  from: string,
  to?: string,
): Promise<string[]> {
  const args = [
    "diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    from,
  ];
  if (to) args.push(to);
  const tracked = await git(args, cwd);
  const paths = tracked ? tracked.split("\n").filter(Boolean) : [];
  if (!to) {
    const untracked = await git(
      ["ls-files", "--others", "--exclude-standard"],
      cwd,
    );
    if (untracked) paths.push(...untracked.split("\n").filter(Boolean));
  }
  return [...new Set(paths)].sort();
}
