import { requireCapabilities } from "./capabilities.js";
import { assertRepositoryEnabled } from "./enablement.js";
import { inspectGit, refCommit } from "./git.js";
import { promoteValidatedCommit, targetBranch } from "./promotion.js";
import { run } from "./process.js";
import { readConfig, readSessions, repoId, writeSession } from "./runtime.js";
import type { RepositoryConfig, Session } from "./types.js";

export async function reconcileCommand(
  apply: boolean,
  path?: string,
): Promise<void> {
  const config = await readConfig();
  let repositories = config.repositories;
  if (path) {
    const context = await inspectGit(path);
    repositories = repositories.filter(
      (repository) => repository.gitCommonDir === context.gitCommonDir,
    );
    if (repositories.length === 0) {
      throw new Error("Repository is not registered");
    }
  }
  const sessions = await readSessions();
  let unsafe = false;
  for (const repository of repositories) {
    try {
      if (apply) {
        assertRepositoryEnabled(
          await readConfig(true),
          repository.gitCommonDir,
        );
        await requireCapabilities(repository.path);
      }
      await reconcileRepository(repository, sessions, apply);
    } catch (error) {
      unsafe = true;
      process.stderr.write(
        `UNSAFE ${repository.path}: ${errorMessage(error)}\n`,
      );
    }
  }
  if (repositories.length === 0)
    process.stdout.write("No repositories registered.\n");
  if (unsafe) process.exitCode = 1;
}

async function reconcileRepository(
  repository: RepositoryConfig,
  sessions: Session[],
  apply: boolean,
): Promise<void> {
  const target = targetBranch(repository);
  const targetRef = `refs/heads/${target}`;
  const stagingRef = `refs/heads/${repository.integrationBranch}`;
  const [targetHead, stagingHead] = await Promise.all([
    refCommit(repository.path, targetRef),
    refCommit(repository.path, stagingRef),
  ]);
  if (!targetHead && target === repository.integrationBranch) {
    process.stdout.write(
      `OK ${repository.path}: combined staging/target branch ${target} does not exist yet; nothing to reconcile.\n`,
    );
    return;
  }
  if (!targetHead) throw new Error(`target branch ${target} does not exist`);
  if (!stagingHead) {
    process.stdout.write(
      `OK ${repository.path}: staging branch ${repository.integrationBranch} does not exist; nothing to reconcile.\n`,
    );
    return;
  }

  const candidates = sessions.filter(
    (session) =>
      session.repositoryId === repoId(repository.gitCommonDir) &&
      (session.status === "succeeded" ||
        session.status === "promotion_pending") &&
      session.integratedCommit,
  );
  const missing: Session[] = [];
  for (const session of candidates) {
    const present = await isAncestor(
      repository.path,
      session.integratedCommit!,
      targetHead,
    );
    if (!present) missing.push(session);
  }
  if (missing.length === 0) {
    process.stdout.write(
      `OK ${repository.path}: all recorded validated integrations are present on target ${target} at ${targetHead}.\n`,
    );
    return;
  }

  if (!(await isAncestor(repository.path, targetHead, stagingHead))) {
    const stagingBehind = await isAncestor(
      repository.path,
      stagingHead,
      targetHead,
    );
    throw new Error(
      stagingBehind
        ? `${missing.length} validated integration(s) are absent from target ${target}, but staging ${repository.integrationBranch} is behind the target; historical state is ambiguous.`
        : `target ${target} and staging ${repository.integrationBranch} have diverged; refusing to merge or reset either branch.`,
    );
  }
  if (!missing.some((session) => session.integratedCommit === stagingHead)) {
    throw new Error(
      `staging head ${stagingHead} is not the validated commit of a recorded succeeded session; refusing to guess whether unrecorded commits are safe.`,
    );
  }
  for (const session of missing) {
    if (
      !(await isAncestor(
        repository.path,
        session.integratedCommit!,
        stagingHead,
      ))
    ) {
      throw new Error(
        `recorded integration ${session.id} at ${session.integratedCommit} is absent from both target and the current staging history.`,
      );
    }
  }

  if (!apply) {
    process.stdout.write(
      `PENDING ${repository.path}: ${missing.length} recorded validated integration(s) are absent from ${target}; safe fast-forward candidate ${targetHead} -> ${stagingHead}. Re-run with --apply after reviewing.\n`,
    );
    return;
  }
  await promoteValidatedCommit(repository, stagingHead, targetHead);
  const promotedAt = new Date().toISOString();
  for (const session of missing) {
    session.targetBranch = target;
    session.targetCommitBeforeIntegration ??= targetHead;
    session.promotedCommit = session.integratedCommit!;
    session.promotedAt = promotedAt;
    session.status = "succeeded";
    delete session.recoveryPhase;
    delete session.latestError;
    await writeSession(session);
  }
  process.stdout.write(
    `PROMOTED ${repository.path}: target ${target} advanced from ${targetHead} to ${stagingHead}; no push performed.\n`,
  );
}

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (
    (
      await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd,
      })
    ).code === 0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
