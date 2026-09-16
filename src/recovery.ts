import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { git, hasMergeInProgress, refCommit } from "./git.js";
import { run } from "./process.js";
import { runtimePaths, writeJsonAtomic } from "./runtime.js";
import type {
  RecoveryBundleManifest,
  RecoverySnapshot,
  RepositoryConfig,
  Session,
  ValidationFailureRecord,
} from "./types.js";

const ZERO = "0000000000000000000000000000000000000000";

export async function ensureRecoveryBundle(
  repository: RepositoryConfig,
  session: Session,
): Promise<void> {
  if (session.recoveryBundle) {
    await verifyManifest(session);
    return;
  }
  if (!session.readyCommit || !session.rolloutDisposition)
    throw new Error(
      "Cannot create recovery bundle before ready metadata is persisted",
    );
  const target =
    session.targetCommitBeforeIntegration ??
    (await refCommit(repository.path, `refs/heads/${session.targetBranch}`)) ??
    (session.targetBranch === repository.integrationBranch
      ? await refCommit(
          repository.path,
          `refs/heads/${repository.defaultBranch}`,
        )
      : null);
  if (!target)
    throw new Error("Cannot create recovery bundle without target commit");
  const base =
    (await refCommit(
      repository.path,
      `refs/heads/${repository.integrationBranch}`,
    )) ?? target;
  const attemptId = `attempt_${Date.now().toString(36)}`;
  const root = join(runtimePaths().recoveryBundles, session.id, attemptId);
  const prefix = `refs/codex-handoff/recovery/${session.id}/${attemptId}`;
  await mkdir(root, { recursive: true });
  for (const [name, value] of [
    ["base", base],
    ["source", session.readyCommit],
    ["target", target],
  ] as const)
    await createImmutableRef(repository.path, `${prefix}/${name}`, value);
  const rolloutRef = `${prefix}/rollout`;
  await createImmutableBlobRef(
    repository.path,
    rolloutRef,
    JSON.stringify({
      disposition: session.rolloutDisposition,
      followUps: session.rolloutFollowUps ?? [],
    }),
  );
  const manifest: RecoveryBundleManifest = {
    version: 1,
    sessionId: session.id,
    attemptId,
    repositoryId: session.repositoryId,
    createdAt: new Date().toISOString(),
    baseCommit: base,
    sourceCommit: session.readyCommit,
    targetCommit: target,
    refs: {
      base: `${prefix}/base`,
      source: `${prefix}/source`,
      target: `${prefix}/target`,
      rollout: rolloutRef,
    },
    rollout: {
      disposition: session.rolloutDisposition,
      followUps: session.rolloutFollowUps ?? [],
    },
    snapshots: [],
  };
  const hash = await writeManifest(root, manifest);
  session.recoveryBundle = {
    version: 1,
    attemptId,
    path: root,
    manifestHash: hash,
    state: "open",
    createdAt: manifest.createdAt,
  };
}

export async function snapshotRecoveryState(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
): Promise<void> {
  const manifest = await readVerifiedManifest(session);
  const sequence = manifest.snapshots.length + 1;
  if (await hasMergeInProgress(worktree)) {
    const unresolved = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: worktree },
    );
    if (unresolved.stdout.trim()) {
      const gitDir = await git(["rev-parse", "--git-dir"], worktree);
      const source = join(resolveGitDir(worktree, gitDir), "index");
      const indexFile = `index-${sequence}`;
      await copyFile(source, join(manifestPath(session), "..", indexFile));
      const indexHash = hashBytes(
        await readFile(join(manifestPath(session), "..", indexFile)),
      );
      const ref = recoveryRef(session, `index-${sequence}`);
      const object = await createImmutableBlobRef(
        repository.path,
        ref,
        JSON.stringify({
          indexHash,
          indexBase64: (
            await readFile(join(manifestPath(session), "..", indexFile))
          ).toString("base64"),
        }),
      );
      await appendSnapshot(session, manifest, {
        kind: "conflict-index",
        sequence,
        createdAt: new Date().toISOString(),
        indexFile,
        indexHash,
        ref,
        object,
      });
      return;
    }
  }
  const tree = await git(["write-tree"], worktree);
  const snapshotBase = await git(["rev-parse", "HEAD"], worktree);
  const ref = recoveryRef(session, `tree-${sequence}`);
  const commit = await git(
    [
      "commit-tree",
      tree,
      "-p",
      snapshotBase,
      "-p",
      manifest.sourceCommit,
      "-m",
      `Recovery snapshot ${session.id} ${sequence}`,
    ],
    repository.path,
  );
  await createImmutableRef(repository.path, ref, commit);
  await appendSnapshot(session, manifest, {
    kind: "merged-tree",
    sequence,
    createdAt: new Date().toISOString(),
    ref,
    object: commit,
  });
}

export async function recordValidationRecovery(
  repository: RepositoryConfig,
  session: Session,
  worktree: string,
  outcome: "passed" | "failed",
  failure?: ValidationFailureRecord,
): Promise<void> {
  if (!session.recoveryBundle) return;
  const manifest = await readVerifiedManifest(session);
  const sequence = manifest.snapshots.length + 1;
  const tree = await git(["write-tree"], worktree);
  const validation = {
    outcome,
    tree,
    ...(failure ? { failure } : {}),
  };
  const ref = recoveryRef(session, `validation-${sequence}`);
  const object = await createImmutableBlobRef(
    repository.path,
    ref,
    JSON.stringify(validation),
  );
  await appendSnapshot(session, manifest, {
    kind: "validation",
    sequence,
    createdAt: new Date().toISOString(),
    ref,
    object,
    validation,
  });
  if (outcome === "passed")
    await snapshotRecoveryState(repository, session, worktree);
}

export async function recordStagingCommitRecovery(
  repository: RepositoryConfig,
  session: Session,
  commit: string,
): Promise<void> {
  if (!session.recoveryBundle) return;
  const manifest = await readVerifiedManifest(session);
  const sequence = manifest.snapshots.length + 1;
  const ref = recoveryRef(session, `staging-${sequence}`);
  await createImmutableRef(repository.path, ref, commit);
  await appendSnapshot(session, manifest, {
    kind: "staging-commit",
    sequence,
    createdAt: new Date().toISOString(),
    ref,
    object: commit,
  });
}

export async function reconstructRecoveryWorktree(
  repository: RepositoryConfig,
  session: Session,
  importResolvedFrom?: string,
): Promise<string> {
  let manifest = await readVerifiedManifest(session);
  if (importResolvedFrom && (await hasMergeInProgress(importResolvedFrom))) {
    const unresolved = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: importResolvedFrom },
    );
    if (!unresolved.stdout.trim()) {
      await snapshotRecoveryState(repository, session, importResolvedFrom);
      manifest = await readVerifiedManifest(session);
    }
  }
  const snapshot = [...manifest.snapshots]
    .reverse()
    .find((item) => item.kind === "merged-tree" && item.object);
  const reconstructingSnapshotlessBundle = manifest.snapshots.length === 0;
  const snapshotBase = snapshot?.object
    ? await git(["rev-parse", `${snapshot.object}^1`], repository.path)
    : manifest.baseCommit;
  if (snapshot?.object) {
    // Verify the durable object before considering live staging reconciliation.
    await git(["rev-parse", `${snapshot.object}^{tree}`], repository.path);
  }
  let currentStaging =
    (await refCommit(
      repository.path,
      `refs/heads/${repository.integrationBranch}`,
    )) ?? manifest.baseCommit;
  if (reconstructingSnapshotlessBundle) {
    const currentTarget = session.targetBranch
      ? await refCommit(repository.path, `refs/heads/${session.targetBranch}`)
      : null;
    if (!currentTarget)
      throw new Error(
        "Cannot reconstruct snapshotless recovery without the current target ref",
      );
    if (currentStaging !== currentTarget) {
      const stagingBehindTarget = await run(
        "git",
        ["merge-base", "--is-ancestor", currentStaging, currentTarget],
        { cwd: repository.path },
      );
      if (stagingBehindTarget.code !== 0)
        throw new Error(
          "Current staging is not an ancestor of the current target while reconstructing snapshotless recovery",
        );
      await git(
        [
          "update-ref",
          `refs/heads/${repository.integrationBranch}`,
          currentTarget,
          currentStaging,
        ],
        repository.path,
      );
      currentStaging = currentTarget;
    }
    session.targetCommitBeforeIntegration = currentTarget;
  }
  const path = join(
    runtimePaths().recoveryWorktrees,
    session.id,
    session.recoveryBundle!.attemptId,
  );
  await removeOwnedWorktree(repository.path, path);
  await mkdir(dirname(path), { recursive: true });
  await git(
    ["worktree", "add", "--detach", path, currentStaging],
    repository.path,
  );
  if (snapshot?.object && currentStaging !== snapshotBase) {
    const currentTarget = session.targetBranch
      ? await refCommit(repository.path, `refs/heads/${session.targetBranch}`)
      : null;
    if (!currentTarget)
      throw new Error(
        "Cannot reconcile recovery with newer staging without the current target ref",
      );
    const targetIsAncestor = await run(
      "git",
      ["merge-base", "--is-ancestor", currentTarget, currentStaging],
      { cwd: repository.path },
    );
    if (targetIsAncestor.code !== 0)
      throw new Error(
        "Current staging and target histories diverged while reconstructing recovery",
      );
    session.targetCommitBeforeIntegration = currentTarget;
    const merge = await run(
      "git",
      ["merge", "--no-ff", "--no-commit", manifest.sourceCommit],
      { cwd: path },
    );
    if (merge.code !== 0)
      throw new Error(
        "The preserved session conflicts with newer staging history; resolve and stage the fresh recovery worktree, then resume",
      );
  } else if (snapshot?.object) {
    const expected = await git(
      ["rev-parse", `${snapshot.object}^{tree}`],
      repository.path,
    );
    await git(["read-tree", expected], path);
    await git(["checkout-index", "-a", "-f"], path);
    const actual = await git(["write-tree"], path);
    if (actual !== expected)
      throw new Error(
        `Recovery tree hash mismatch: expected ${expected}, found ${actual}`,
      );
    const gitDir = await git(["rev-parse", "--git-dir"], path);
    const absoluteGitDir = resolveGitDir(path, gitDir);
    await writeFile(
      join(absoluteGitDir, "MERGE_HEAD"),
      `${manifest.sourceCommit}\n`,
    );
    await writeFile(
      join(absoluteGitDir, "MERGE_MSG"),
      `Integrate ${session.id}: ${session.taskSummary}\n`,
    );
  } else {
    const merge = await run(
      "git",
      ["merge", "--no-ff", "--no-commit", manifest.sourceCommit],
      { cwd: path },
    );
    if (merge.code !== 0) {
      const unresolved = await run(
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: path },
      );
      if (!unresolved.stdout.trim())
        throw new Error(
          `Recovery merge failed without reported conflicts: ${(merge.stderr || merge.stdout).trim()}`,
        );
      session.awaitingConflictResolution = true;
    }
  }
  session.integrationWorktreePath = path;
  session.integrationWorktreeDetached = true;
  session.conflictIntegrationHead = currentStaging;
  if (reconstructingSnapshotlessBundle) {
    await snapshotRecoveryState(repository, session, path);
  }
  return path;
}

export async function archiveRecoveryBundle(session: Session): Promise<void> {
  if (!session.recoveryBundle || session.recoveryBundle.state === "archived")
    return;
  const manifest = await readVerifiedManifest(session);
  manifest.previousManifestHash = session.recoveryBundle.manifestHash;
  manifest.archivedAt = new Date().toISOString();
  session.recoveryBundle.manifestHash = await writeManifest(
    session.recoveryBundle.path,
    manifest,
  );
  session.recoveryBundle.state = "archived";
  session.recoveryBundle.archivedAt = manifest.archivedAt;
}

async function appendSnapshot(
  session: Session,
  manifest: RecoveryBundleManifest,
  snapshot: RecoverySnapshot,
): Promise<void> {
  manifest.previousManifestHash = session.recoveryBundle!.manifestHash;
  manifest.snapshots.push(snapshot);
  session.recoveryBundle!.manifestHash = await writeManifest(
    session.recoveryBundle!.path,
    manifest,
  );
}
async function readVerifiedManifest(
  session: Session,
): Promise<RecoveryBundleManifest> {
  if (!session.recoveryBundle)
    throw new Error("Session has no recovery bundle");
  const raw = await readFile(manifestPath(session), "utf8");
  const hash = hashBytes(Buffer.from(raw));
  const manifest = JSON.parse(raw) as RecoveryBundleManifest;
  if (
    manifest.version !== 1 ||
    manifest.sessionId !== session.id ||
    manifest.repositoryId !== session.repositoryId ||
    manifest.sourceCommit !== session.readyCommit
  )
    throw new Error(
      `Incompatible or mismatched recovery manifest for ${session.id}`,
    );
  if (hash !== session.recoveryBundle.manifestHash) {
    // A process can stop between publishing bundle evidence and the session pointer.
    // Accept only independently retained, hash-linked local recovery evidence.
    const history = join(session.recoveryBundle.path, "manifests");
    let cursor = hash;
    let found = false;
    for (let depth = 0; depth < 100; depth++) {
      if (cursor === session.recoveryBundle.manifestHash) {
        found = true;
        break;
      }
      let saved: Buffer;
      try {
        saved = await readFile(join(history, `${cursor}.json`));
      } catch {
        break;
      }
      if (hashBytes(saved) !== cursor) break;
      const prior = JSON.parse(saved.toString()) as RecoveryBundleManifest;
      if (!prior.previousManifestHash) break;
      cursor = prior.previousManifestHash;
    }
    const local = [...manifest.snapshots]
      .reverse()
      .find((s) => s.kind === "local-target");
    if (!found || !local?.localTarget)
      throw new Error(`Recovery manifest hash mismatch for ${session.id}`);
    session.localTargetRecovery = { ...local.localTarget };
    session.recoveryPhase = "local_target";
    session.recoveryBundle.manifestHash = hash;
  }
  return manifest;
}
async function verifyManifest(session: Session): Promise<void> {
  await readVerifiedManifest(session);
}
function manifestPath(session: Session): string {
  return join(session.recoveryBundle!.path, "manifest.json");
}
async function writeManifest(
  root: string,
  manifest: RecoveryBundleManifest,
): Promise<string> {
  const path = join(root, "manifest.json");
  const history = join(root, "manifests");
  await mkdir(history, { recursive: true });
  try {
    const previous = await readFile(path);
    await writeFile(join(history, `${hashBytes(previous)}.json`), previous, {
      flag: "wx",
    });
  } catch (e) {
    if (!["ENOENT", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? ""))
      throw e;
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  try {
    await writeFile(join(history, `${hashBytes(bytes)}.json`), bytes, {
      flag: "wx",
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  await writeJsonAtomic(path, manifest);
  return hashBytes(await readFile(path));
}
function recoveryRef(session: Session, suffix: string): string {
  return `refs/codex-handoff/recovery/${session.id}/${session.recoveryBundle!.attemptId}/${suffix}`;
}
async function createImmutableRef(
  cwd: string,
  ref: string,
  value: string,
): Promise<void> {
  const result = await run("git", ["update-ref", ref, value, ZERO], { cwd });
  if (result.code !== 0)
    throw new Error(
      `Recovery ref already exists or could not be created: ${ref}`,
    );
}

async function createImmutableBlobRef(
  cwd: string,
  ref: string,
  contents: string,
): Promise<string> {
  const result = await run("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    input: contents,
  });
  if (result.code !== 0 || !result.stdout.trim())
    throw new Error(`Could not persist recovery object for ${ref}`);
  const object = result.stdout.trim();
  await createImmutableRef(cwd, ref, object);
  return object;
}
async function removeOwnedWorktree(repo: string, path: string): Promise<void> {
  const probe = await run(
    "git",
    ["-C", path, "rev-parse", "--git-common-dir"],
    { cwd: repo },
  );
  if (probe.code === 0)
    await git(["worktree", "remove", "--force", path], repo);
  else await rm(path, { recursive: true, force: true });
}
function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveGitDir(worktree: string, gitDir: string): string {
  return isAbsolute(gitDir) ? gitDir : resolve(worktree, gitDir);
}

// Append immutable inputs and phase evidence without replacing original snapshots.
export async function recordLocalTargetRecovery(
  repository: RepositoryConfig,
  session: Session,
): Promise<void> {
  const state = session.localTargetRecovery!;
  const manifest = await readVerifiedManifest(session);
  const sequence = manifest.snapshots.length + 1;
  for (const [name, commit] of Object.entries({
    base: state.baseCommit,
    target: state.targetCommit,
    staging: state.stagingBefore,
    resolved: state.resolvedCommit,
    result: state.resultCommit,
  })) {
    if (commit)
      await createImmutableRef(
        repository.path,
        recoveryRef(session, `local-${sequence}-${name}`),
        commit,
      );
  }
  const ref = recoveryRef(session, `local-${sequence}`);
  const object = await createImmutableBlobRef(
    repository.path,
    ref,
    JSON.stringify(state),
  );
  await appendSnapshot(session, manifest, {
    kind: "local-target",
    sequence,
    createdAt: new Date().toISOString(),
    ref,
    object,
    localTarget: { ...state },
  });
}

export async function verifyRecoveryBundle(session: Session): Promise<void> {
  await readVerifiedManifest(session);
}
