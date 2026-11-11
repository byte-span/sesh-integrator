import { runSetupWithCache } from "./cache.js";
import { requireCapabilities } from "./capabilities.js";
import { assertCompatible, unfinished } from "./coordinator.js";
import {
  CodedError,
  deliveryPolicyPath,
  repositoryFromRemoteUrl,
  resolveSessionDelivery,
  syncRemote,
  withDelivery,
} from "./delivery-policy.js";
import { assertRepositoryEnabled, repositoryCommonDir } from "./enablement.js";
import { git, inspectGit, isClean, refCommit } from "./git.js";
import {
  beginCommand,
  commitCommand,
  findRepository,
  integrateCommand,
  resolveSourceSession,
  validateCommand,
} from "./handoff.js";
import { parseHarness, type Harness } from "./harness.js";
import { sessionStatusDocument } from "./json-output.js";
import { followMovedRegistration } from "./moved-repository.js";
import { run } from "./process.js";
import { ensureGlobalTargetBranch, targetBranch } from "./promotion.js";
import { pullRequestPromotion } from "./pull-request.js";
import {
  QueueCancellation,
  QueueOwnershipUncertain,
} from "./queued-process.js";
import {
  makeSessionId,
  readConfig,
  readSession,
  readSessions,
  repoId,
  runtimePaths,
  updateSessionRecord,
} from "./runtime.js";
import { syncTargetBranch, type TargetSync } from "./sync-target.js";
import {
  adoptedValidationFiles,
  describeValidationFiles,
} from "./validation-files.js";
import type {
  RepositoryConfig,
  RolloutDisposition,
  Session,
  SessionAdoption,
} from "./types.js";

/**
 * `seshx adopt`: bring a branch written elsewhere (such as a cloud sandbox)
 * into a normal session. Its net diff becomes one local commit, which is
 * validated and integrated locally like any other session. Canonical
 * description: docs/commands.md#adopt.
 */
export const ADOPT_USAGE =
  'Usage: seshx adopt <branch | pull-request-url> --rollout <none|applied|automated|manual> [--follow-up "<TASK-ID>: ..."]... [--summary "..."] [--harness codex|claude|antigravity|grok] [--policy-file <path>] [--sync-target] [--json]';

/** Exit status when a session exists but is not promoted. */
export const ADOPT_INCOMPLETE_EXIT = 3;

export interface AdoptOptions {
  /** Branch name on the configured remote, or a GitHub pull-request URL. */
  source: string;
  summary?: string;
  harness: Harness;
  rolloutDisposition: RolloutDisposition;
  rolloutFollowUps: string[];
  policyFile?: string;
  syncTarget: boolean;
}

export type AdoptOutcome = "promoted" | "already-promoted" | "incomplete";

/** A session exists but was not promoted; `document` reports it. */
export class AdoptionIncomplete extends CodedError {
  readonly exitCode = ADOPT_INCOMPLETE_EXIT;
  constructor(
    code: string,
    message: string,
    readonly document: Record<string, unknown>,
  ) {
    super(code, message);
  }
}

function usage(message: string): CodedError {
  return Object.assign(new CodedError("usage", `${message}\n${ADOPT_USAGE}`), {
    exitCode: 2,
  });
}

export function parseAdoptOptions(args: string[]): AdoptOptions {
  let source: string | undefined;
  let summary: string | undefined;
  let harness: Harness | undefined;
  let rollout: RolloutDisposition | undefined;
  let policyFile: string | undefined;
  let syncTarget = false;
  const followUps: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw usage(`${argument} needs a value`);
      index += 1;
      return next;
    };
    const once = (present: unknown) => {
      if (present !== undefined)
        throw usage(`${argument} may be given only once`);
    };
    switch (argument) {
      case "--summary":
        once(summary);
        summary = value();
        if (!summary.trim()) throw usage("--summary must not be empty");
        break;
      case "--harness":
        once(harness);
        try {
          harness = parseHarness(value());
        } catch (error) {
          throw usage(error instanceof Error ? error.message : String(error));
        }
        break;
      case "--rollout": {
        once(rollout);
        const disposition = value();
        if (!["none", "applied", "automated", "manual"].includes(disposition))
          throw usage("--rollout must be none, applied, automated, or manual");
        rollout = disposition as RolloutDisposition;
        break;
      }
      case "--follow-up": {
        const item = value().trim();
        if (!item) throw usage("--follow-up must not be empty");
        followUps.push(item);
        break;
      }
      case "--policy-file":
        once(policyFile);
        policyFile = value();
        break;
      case "--sync-target":
        syncTarget = true;
        break;
      default:
        if (argument.startsWith("-") || source !== undefined)
          throw usage(`Unknown or extra argument: ${argument}`);
        source = argument;
    }
  }
  if (!source) throw usage("adopt needs a branch name or pull-request URL");
  if (!rollout)
    throw usage(
      "adopt requires --rollout none|applied|automated|manual; source promotion does not imply external-state application",
    );
  if (rollout === "manual" && followUps.length === 0)
    throw usage('manual rollout requires at least one --follow-up "..."');
  if (rollout !== "manual" && followUps.length > 0)
    throw usage("--follow-up is valid only with --rollout manual");
  return {
    source,
    harness: harness ?? "codex",
    rolloutDisposition: rollout,
    rolloutFollowUps: followUps,
    syncTarget,
    ...(summary ? { summary: summary.trim() } : {}),
    ...(policyFile ? { policyFile } : {}),
  };
}

interface AdoptContext {
  options: AdoptOptions;
  remote: string;
  branch: string;
  sync?: TargetSync;
}

/**
 * Adopt the branch and return its session status document, or throw
 * `AdoptionIncomplete` (with that document) when the session exists but was
 * not promoted. Refusals before a session exists throw a `CodedError`.
 */
export async function adoptCommand(
  options: AdoptOptions,
): Promise<Record<string, unknown>> {
  await requireCapabilities();
  await followMovedRegistration();
  const config = await readConfig();
  assertRepositoryEnabled(config, await repositoryCommonDir(process.cwd()));
  const registered = findRepository(
    config,
    (await inspectGit(process.cwd())).gitCommonDir,
  );
  const policyPath = deliveryPolicyPath(
    options.policyFile,
    config,
    runtimePaths().config,
  );
  // Resolved here only to pick the target and remote to check against;
  // begin resolves and records the rule itself, failing the same way.
  const delivery = policyPath
    ? await resolveSessionDelivery(policyPath, registered)
    : undefined;
  const repository = withDelivery(registered, delivery);
  const remote = syncRemote(repository);
  const target = targetBranch(repository);
  const pullRequest = isPullRequestUrl(options.source)
    ? await resolvePullRequest(options.source, repository, remote)
    : undefined;
  const branch = pullRequest?.branch ?? normalizeBranch(options.source);
  await assertBranchName(repository.path, branch);
  const production = pullRequestPromotion(repository)?.productionBranch;
  const protectedBranches = new Set(
    [
      target,
      repository.integrationBranch,
      repository.defaultBranch,
      production,
    ].filter((name): name is string => !!name),
  );
  if (protectedBranches.has(branch))
    throw new CodedError(
      "branch_not_adoptable",
      `Refusing to adopt ${branch}: it is this repository's target, staging, default or production branch. Adopt only task branches such as claude/*.`,
    );

  const context: AdoptContext = { options, remote, branch };
  if (options.syncTarget)
    context.sync = await syncTargetBranch(
      repository,
      remote,
      makeSessionId(),
      config.lockWaitSeconds,
    );
  if (delivery) await ensureGlobalTargetBranch(repository, true, remote);
  else await ensureGlobalTargetBranch(repository);

  const repositoryId = repoId(repository.gitCommonDir);
  const fetched = await fetchBranch(repository.path, remote, branch, [
    target,
    ...(production && production !== target ? [production] : []),
  ]);
  if (!fetched) {
    // A rerun after the branch was removed still reports its adoption.
    const previous = findByBranch(
      await adoptedSessions(repositoryId),
      remote,
      branch,
    );
    if (previous) return advance(previous, context, true);
    throw new CodedError(
      "branch_not_found",
      `Branch ${branch} does not exist on ${remote}`,
    );
  }
  const headSha = fetched;
  const existing = findByHead(await adoptedSessions(repositoryId), headSha);
  if (existing) return advance(existing, context, true);
  if (pullRequest && pullRequest.state !== "OPEN")
    throw new CodedError(
      "pull_request_invalid",
      `Pull request ${pullRequest.url} is ${pullRequest.state.toLowerCase()}; adopt only open pull requests`,
    );

  const inspection = await inspectBranch(
    repository.path,
    remote,
    branch,
    headSha,
    target,
    [target, ...(production && production !== target ? [production] : [])],
  );
  // Flagged, never refused: local checks still decide, but they run the
  // adopted versions of these files.
  const validationFiles = await adoptedValidationFiles(
    repository.path,
    repository,
    inspection.baseCommit,
    headSha,
  );
  const record: SessionAdoption = {
    remote,
    branch,
    headSha,
    ...(pullRequest ? { pullRequestUrl: pullRequest.url } : {}),
    baseCommit: inspection.baseCommit,
    commitCount: inspection.commitCount,
    fetchedAt: new Date().toISOString(),
    validationFiles,
  };
  process.stdout.write(
    `Adopting ${remote}/${branch} at ${headSha}: ${inspection.commitCount} commit(s) since ${target} at ${inspection.baseCommit}\n` +
      `Adopted validation files: ${describeValidationFiles(validationFiles)}\n` +
      (validationFiles.length
        ? "These can change what validation runs, and local checks run the adopted versions; review them before relying on the result.\n"
        : ""),
  );
  const begun = await beginCommand(
    options.summary ?? `Adopt ${remote}/${branch} at ${headSha.slice(0, 12)}`,
    [],
    true,
    true,
    options.harness,
    {
      ...(options.policyFile ? { policyFile: options.policyFile } : {}),
      adoption: {
        record,
        startPoint: inspection.baseCommit,
        findExisting: async () => {
          const sessions = await adoptedSessions(repositoryId);
          const found = findByHead(sessions, headSha);
          if (found) return found;
          assertNotInProgress(sessions, remote, branch, headSha);
          return undefined;
        },
      },
    },
  );
  return advance(begun.session, context, !!begun.existing);
}

/** Continue a session to promotion, or report why it stopped. */
async function advance(
  found: Session,
  context: AdoptContext,
  reused: boolean,
): Promise<Record<string, unknown>> {
  let session = found;
  if (reused)
    process.stdout.write(
      `${session.adoption?.remote}/${session.adoption?.branch} at ${session.adoption?.headSha} is already adopted by ${session.id} (${session.status}); continuing it instead of starting another session.\n`,
    );
  assertCompatible(session);
  if (session.status === "succeeded")
    return report(session, context, reused, "already-promoted");
  if (session.status !== "active" && session.status !== "ready")
    throw await incomplete(
      session,
      context,
      reused,
      "needs_attention",
      `Session ${session.id} is ${session.status}`,
    );
  // Source checks fail as validation_failed; integration checks, conflicts
  // and promotion as integration_failed (see session.status).
  let phase = "adopt_failed";
  try {
    if (session.status === "active") {
      session = await ensureAdoptedCommit(session, context, reused);
      const head = (await inspectGit(session.worktreePath)).head;
      if (session.sourceValidatedCommit !== head) {
        await refreshSetup(session);
        phase = "validation_failed";
        session = await validateCommand(session.id);
      }
    }
    phase = "integration_failed";
    await integrateCommand(
      context.options.summary ??
        session.completionSummary ??
        session.taskSummary,
      context.options.rolloutDisposition,
      context.options.rolloutFollowUps,
      session.id,
    );
  } catch (error) {
    if (error instanceof AdoptionIncomplete) throw error;
    const latest = (await readSession(session.id)) ?? session;
    throw await incomplete(
      latest,
      context,
      reused,
      phase,
      error instanceof Error ? error.message : String(error),
    );
  }
  const promoted = (await readSession(session.id)) ?? session;
  if (promoted.status !== "succeeded")
    throw await incomplete(
      promoted,
      context,
      reused,
      "integration_failed",
      `Session ${promoted.id} is ${promoted.status} after integration`,
    );
  return report(promoted, context, reused, "promoted");
}

/** Create the single adopted commit through the normal commit path. */
async function ensureAdoptedCommit(
  session: Session,
  context: AdoptContext,
  reused: boolean,
): Promise<Session> {
  const adoption = session.adoption;
  if (!adoption)
    throw await incomplete(
      session,
      context,
      reused,
      "adopt_failed",
      `Session ${session.id} has no adoption record`,
    );
  if (adoption.adoptedCommit) return session;
  const worktree = session.worktreePath;
  const source = await inspectGit(worktree);
  if (source.branch !== session.branch)
    throw await incomplete(
      session,
      context,
      reused,
      "adoption_interrupted",
      `Source branch changed since begin (expected ${session.branch}, found ${source.branch ?? "detached"})`,
    );
  let adoptedCommit: string;
  if (source.head !== session.startCommit) {
    // An earlier run committed but stopped before recording the commit.
    const first = (
      await git(
        ["rev-list", "--reverse", `${session.startCommit}..${source.head}`],
        worktree,
      )
    ).split("\n")[0]!;
    const message = await git(["log", "-1", "--format=%B", first], worktree);
    if (!message.includes(`Adopted-Head: ${adoption.headSha}`))
      throw await incomplete(
        session,
        context,
        reused,
        "adoption_interrupted",
        `Source worktree ${worktree} has commits that are not the adopted commit for ${adoption.headSha}; inspect it, then abandon the session and rerun adopt`,
      );
    adoptedCommit = first;
  } else {
    if (!(await isClean(worktree)))
      throw await incomplete(
        session,
        context,
        reused,
        "adoption_interrupted",
        `Source worktree ${worktree} has uncommitted changes from an interrupted adoption; inspect it, then abandon the session (seshx abandon --session ${session.id} --reason "...") and rerun adopt`,
      );
    // Index and worktree become the adopted tree; HEAD stays at the base.
    await git(["read-tree", "-m", "-u", "HEAD", adoption.headSha], worktree);
    await commitCommand(
      adoptionMessage(session.taskSummary, adoption),
      session.id,
    );
    adoptedCommit = (await inspectGit(worktree)).head;
  }
  const saved = await updateSessionRecord(session.id, (record) => {
    if (!record.adoption) return false;
    record.adoption.adoptedCommit = adoptedCommit;
    return true;
  });
  return saved ?? session;
}

/** The adopted tree may change dependencies installed when begin ran. */
async function refreshSetup(session: Session): Promise<void> {
  const { repository } = await resolveSourceSession(["active"], session.id);
  try {
    await runSetupWithCache(repository, session.worktreePath);
  } catch (error) {
    if (
      error instanceof QueueCancellation ||
      error instanceof QueueOwnershipUncertain ||
      repository.setupCommandPolicy !== "advisory"
    )
      throw error;
    process.stderr.write(
      `Warning: auto-configured setup failed after adopting; continuing without it. ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Trailers list validation files only when there are this few. */
const TRAILER_FILE_LIMIT = 10;

function adoptionMessage(summary: string, adoption: SessionAdoption): string {
  const files = adoption.validationFiles ?? [];
  const listed =
    files.length <= TRAILER_FILE_LIMIT &&
    files.every(
      (path) => /^\S(?:.*\S)?$/.test(path) && !/[\x00-\x1f\x7f]/.test(path),
    );
  return [
    summary.trim(),
    "",
    `Net diff of ${adoption.remote}/${adoption.branch} (${adoption.commitCount} commit(s) since ${adoption.baseCommit}), adopted with seshx adopt.`,
    "",
    `Adopted-Remote: ${adoption.remote}`,
    `Adopted-Branch: ${adoption.branch}`,
    `Adopted-Head: ${adoption.headSha}`,
    ...(adoption.pullRequestUrl
      ? [`Adopted-Pull-Request: ${adoption.pullRequestUrl}`]
      : []),
    `Adopted-Validation-Files: ${files.length}`,
    ...(listed ? files.map((path) => `Adopted-Validation-File: ${path}`) : []),
  ].join("\n");
}

function report(
  session: Session,
  context: AdoptContext,
  reused: boolean,
  outcome: AdoptOutcome,
  error?: { code: string; message: string },
): Record<string, unknown> {
  const validationFiles = [...(session.adoption?.validationFiles ?? [])];
  if (outcome !== "incomplete")
    process.stdout.write(
      `Adopted ${context.remote}/${context.branch} at ${session.adoption?.headSha} as ${session.id}: ${outcome}, ${session.targetBranch ?? "target"} at ${session.promotedCommit}; adopted validation files: ${describeValidationFiles(validationFiles)}\n`,
    );
  return {
    ...sessionStatusDocument(session, context.sync),
    adopt: {
      outcome,
      reusedSession: reused,
      error: error ?? null,
      validationFiles,
    },
  };
}

async function incomplete(
  session: Session,
  context: AdoptContext,
  reused: boolean,
  code: string,
  detail: string,
): Promise<AdoptionIncomplete> {
  const latest = (await readSession(session.id)) ?? session;
  const resumable = [
    "needs_review",
    "validation_pending",
    "promotion_pending",
  ].includes(latest.status);
  const next = resumable
    ? `after resolving it, run seshx resume --session ${latest.id}`
    : `after fixing it in ${latest.worktreePath}, rerun this seshx adopt command`;
  const message = `Adoption of ${context.remote}/${context.branch} is incomplete: session ${latest.id} is ${latest.status} (${code}): ${detail}\nInspect seshx status --session ${latest.id}; ${next}.`;
  return new AdoptionIncomplete(
    code,
    message,
    report(latest, context, reused, "incomplete", { code, message: detail }),
  );
}

async function adoptedSessions(repositoryId: string): Promise<Session[]> {
  return (await readSessions()).filter(
    (session) =>
      session.repositoryId === repositoryId &&
      !!session.adoption &&
      session.status !== "abandoned",
  );
}

function findByHead(sessions: Session[], headSha: string): Session | undefined {
  return sessions.filter((s) => s.adoption!.headSha === headSha).at(-1);
}

function findByBranch(
  sessions: Session[],
  remote: string,
  branch: string,
): Session | undefined {
  return sessions
    .filter(
      (s) => s.adoption!.remote === remote && s.adoption!.branch === branch,
    )
    .at(-1);
}

function assertNotInProgress(
  sessions: Session[],
  remote: string,
  branch: string,
  headSha: string,
): void {
  const other = sessions.find(
    (s) =>
      unfinished(s) &&
      s.adoption!.remote === remote &&
      s.adoption!.branch === branch &&
      s.adoption!.headSha !== headSha,
  );
  if (other)
    throw new CodedError(
      "adoption_in_progress",
      `Session ${other.id} (${other.status}) is still adopting ${remote}/${branch} at ${other.adoption!.headSha}; finish or abandon it before adopting the newer head ${headSha}`,
    );
}

/**
 * Fetch the branch (and the remote base branches used for the ancestry
 * check) into remote-tracking refs. Returns the branch head, or undefined
 * when the remote has no such branch. Never deletes or prunes anything.
 */
async function fetchBranch(
  cwd: string,
  remote: string,
  branch: string,
  bases: string[],
): Promise<string | undefined> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const configured = await run("git", ["remote", "get-url", remote], { cwd });
  if (configured.code !== 0)
    throw new CodedError(
      "fetch_failed",
      `Remote ${remote} is not configured in ${cwd}`,
    );
  const names = [...new Set([branch, ...bases])];
  const listed = await run(
    "git",
    [
      "ls-remote",
      "--heads",
      remote,
      ...names.map((name) => `refs/heads/${name}`),
    ],
    { cwd, env },
  );
  if (listed.code !== 0)
    throw new CodedError(
      "fetch_failed",
      `Could not inspect ${remote}: ${(listed.stderr || listed.stdout).trim()}`,
    );
  const advertised = new Set(
    listed.stdout
      .split("\n")
      .map((line) => line.split("\t")[1]?.trim())
      .filter((ref): ref is string => !!ref),
  );
  if (!advertised.has(`refs/heads/${branch}`)) return undefined;
  const refspecs = names
    .filter((name) => advertised.has(`refs/heads/${name}`))
    .map((name) => `+refs/heads/${name}:refs/remotes/${remote}/${name}`);
  const fetched = await run(
    "git",
    ["fetch", "--no-tags", "--no-write-fetch-head", remote, ...refspecs],
    { cwd, env },
  );
  if (fetched.code !== 0)
    throw new CodedError(
      "fetch_failed",
      `Could not fetch ${remote}/${branch}: ${(fetched.stderr || fetched.stdout).trim()}`,
    );
  const head = await refCommit(cwd, `refs/remotes/${remote}/${branch}`);
  if (!head)
    throw new CodedError(
      "fetch_failed",
      `Fetched ${remote}/${branch} but could not resolve its head commit`,
    );
  return head;
}

/**
 * Refuse branches whose net diff would carry more than their own work: no
 * shared history, merges of history the target lacks, or a base the local
 * target does not contain yet.
 */
async function inspectBranch(
  cwd: string,
  remote: string,
  branch: string,
  headSha: string,
  target: string,
  remoteBases: string[],
): Promise<{ baseCommit: string; commitCount: number }> {
  const name = `${remote}/${branch}`;
  const localTarget = await refCommit(cwd, `refs/heads/${target}`);
  if (!localTarget)
    throw new CodedError("adopt_failed", `Target branch not found: ${target}`);
  if (await isAncestor(cwd, headSha, localTarget))
    throw new CodedError(
      "no_changes",
      `${name} at ${headSha} is already contained in ${target}; nothing to adopt`,
    );
  const base = await run("git", ["merge-base", localTarget, headSha], { cwd });
  const baseCommit = base.stdout.trim();
  if (base.code !== 0 || !baseCommit)
    throw new CodedError(
      "unrelated_history",
      `${name} shares no history with ${target}; refusing to adopt it`,
    );
  const commits = (
    await git(["rev-list", "--parents", headSha, "--not", localTarget], cwd)
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  for (const [commit, ...parents] of commits) {
    if (parents.length === 0)
      throw new CodedError(
        "unrelated_history",
        `${name} contains root commit ${commit}, which shares no history with ${target}`,
      );
    for (const parent of parents.slice(1))
      if (!(await isAncestor(cwd, parent, localTarget)))
        throw new CodedError(
          "unrelated_history",
          `${name} merge commit ${commit} brings in ${parent}, which is not in ${target}; push a branch that merges nothing but ${target}`,
        );
  }
  for (const baseBranch of remoteBases) {
    const remoteCommit = await refCommit(
      cwd,
      `refs/remotes/${remote}/${baseBranch}`,
    );
    if (!remoteCommit) continue;
    const shared = await run("git", ["merge-base", headSha, remoteCommit], {
      cwd,
    });
    const mergeBase = shared.stdout.trim();
    if (shared.code !== 0 || !mergeBase) continue;
    if (!(await isAncestor(cwd, mergeBase, localTarget)))
      throw new CodedError(
        "base_not_in_target",
        `${name} builds on ${remote}/${baseBranch} commit ${mergeBase}, which local ${target} does not contain; bring ${target} up to date (for example with --sync-target) and rerun`,
      );
  }
  if (
    (await run("git", ["diff", "--quiet", baseCommit, headSha], { cwd }))
      .code === 0
  )
    throw new CodedError(
      "no_changes",
      `${name} at ${headSha} changes nothing relative to ${target}`,
    );
  return { baseCommit, commitCount: commits.length };
}

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd },
  );
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new CodedError(
    "adopt_failed",
    `Could not compare ${ancestor} with ${descendant}: ${(result.stderr || result.stdout).trim()}`,
  );
}

function normalizeBranch(value: string): string {
  return value.startsWith("refs/heads/")
    ? value.slice("refs/heads/".length)
    : value;
}

async function assertBranchName(cwd: string, branch: string): Promise<void> {
  const checked = branch.startsWith("-")
    ? { code: 1 }
    : await run("git", ["check-ref-format", `refs/heads/${branch}`], { cwd });
  if (checked.code !== 0) throw usage(`Invalid branch name: ${branch}`);
}

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/;

function isPullRequestUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** Resolve a same-repository pull request to its head branch with gh. */
async function resolvePullRequest(
  value: string,
  repository: RepositoryConfig,
  remote: string,
): Promise<{ branch: string; url: string; state: string }> {
  const match = PULL_REQUEST_URL.exec(value.trim());
  if (!match)
    throw new CodedError(
      "pull_request_invalid",
      `Not a GitHub pull-request URL: ${value}`,
    );
  const url = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
  const slug = `${match[1]}/${match[2]}`.toLowerCase();
  const configured = await run(
    "git",
    ["config", "--get", `remote.${remote}.url`],
    { cwd: repository.path },
  );
  const remoteSlug = repositoryFromRemoteUrl(configured.stdout.trim());
  if (remoteSlug !== slug)
    throw new CodedError(
      "pull_request_invalid",
      `Pull request ${url} belongs to ${slug}, but remote ${remote} is ${remoteSlug ?? "not a GitHub repository"}`,
    );
  let viewed;
  try {
    viewed = await run(
      "gh",
      [
        "pr",
        "view",
        url,
        "--json",
        "headRefName,headRefOid,isCrossRepository,state",
      ],
      {
        cwd: repository.path,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
  } catch (error) {
    throw new CodedError(
      "pull_request_unavailable",
      `Could not run gh to read ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (viewed.code !== 0)
    throw new CodedError(
      "pull_request_unavailable",
      `Could not read ${url} with gh: ${(viewed.stderr || viewed.stdout).trim()}`,
    );
  let details: {
    headRefName?: unknown;
    isCrossRepository?: unknown;
    state?: unknown;
  };
  try {
    details = JSON.parse(viewed.stdout) as typeof details;
  } catch {
    throw new CodedError(
      "pull_request_unavailable",
      `gh returned unreadable details for ${url}`,
    );
  }
  if (typeof details.headRefName !== "string" || !details.headRefName)
    throw new CodedError(
      "pull_request_unavailable",
      `gh did not report a head branch for ${url}`,
    );
  // A fork's branch name could match an unrelated branch on this remote.
  if (details.isCrossRepository !== false)
    throw new CodedError(
      "pull_request_invalid",
      `Pull request ${url} comes from a fork; adopt only branches pushed to ${remote}`,
    );
  return {
    branch: details.headRefName,
    url,
    state: typeof details.state === "string" ? details.state : "UNKNOWN",
  };
}
