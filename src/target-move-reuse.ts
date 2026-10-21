import { validationCacheFor } from "./cache.js";
import { git } from "./git.js";
import { recordPerformanceMetric } from "./performance.js";
import { commandFingerprint, run } from "./process.js";
import type {
  Command,
  RepositoryConfig,
  Session,
  ValidationStep,
} from "./types.js";
import { findValidationTier, validationCommandValue } from "./validation.js";

/**
 * How integration validation may reuse a session's source validation results
 * when the merged integration tree is not the tree `seshx validate` checked.
 *
 * - `exact-tree`: the trees are identical; ordinary exact-tree reuse applies.
 * - `applied`: every differing path matches one opt-in tier; that tier's
 *   integration commands run on the merged tree and the session's source
 *   results are reused for its other commands.
 * - `skipped`: every selected integration command runs on the merged tree
 *   (exact-tree cache hits for the merged tree still apply).
 */
export interface SourceReusePlan {
  outcome: "exact-tree" | "applied" | "skipped";
  reason: string;
  tier?: string;
  /** Paths that differ between the validated source and merged trees. */
  differingPaths: string[];
  /** Steps to run on the merged tree. */
  steps: ValidationStep[];
  /** Fingerprints of commands whose source-tree results are reused. */
  reused: Set<string>;
}

const PATH_PREVIEW = 5;

/**
 * Decide whether integration may reuse source results across target movement.
 * Reuse requires the exact ready commit to have passed `seshx validate` and
 * every path that differs between that validated tree and the merged tree to
 * match the first tier (in configuration order) matching all of them, with
 * that tier explicitly opting in. Anything else keeps the full rerun.
 */
export async function planSourceReuse(input: {
  repository: RepositoryConfig;
  session: Session;
  worktree: string;
  mergedTree: string;
  steps: ValidationStep[];
}): Promise<SourceReusePlan> {
  const { repository, session, worktree, mergedTree, steps } = input;
  const keep = (
    outcome: "exact-tree" | "skipped",
    reason: string,
    differingPaths: string[] = [],
    tier?: string,
  ): SourceReusePlan => ({
    outcome,
    reason,
    ...(tier ? { tier } : {}),
    differingPaths,
    steps,
    reused: new Set(),
  });
  if (session.recoveryPhase === "local_target")
    return keep(
      "skipped",
      "local target recovery reruns every integration command",
    );
  if (repository.validationCache === "off")
    return keep("skipped", "validationCache is off");
  const sourceTree = session.sourceValidatedTree;
  if (
    !session.readyCommit ||
    session.sourceValidatedCommit !== session.readyCommit ||
    !sourceTree
  )
    return keep(
      "skipped",
      "the ready commit was not validated by seshx validate",
    );
  const readyTree = await git(
    ["rev-parse", `${session.readyCommit}^{tree}`],
    worktree,
  );
  if (readyTree !== sourceTree)
    return keep(
      "skipped",
      "the validated source tree does not match the ready commit",
    );
  if (mergedTree === sourceTree)
    return keep("exact-tree", "the merged tree is the validated source tree");
  const differingPaths = await treeDifference(worktree, sourceTree, mergedTree);
  if (differingPaths.length === 0)
    return keep(
      "skipped",
      "the differences between the validated and merged trees could not be listed",
    );
  const tier = findValidationTier(repository, differingPaths);
  if (!tier)
    return keep(
      "skipped",
      `the merged tree differs from the validated source tree outside any single validation tier (${preview(differingPaths)})`,
      differingPaths,
    );
  if (tier.reuseSourceValidationOnTargetMove !== true)
    return keep(
      "skipped",
      `the merged tree differs only in ${tier.name} paths (${preview(differingPaths)}), but tier ${tier.name} does not set reuseSourceValidationOnTargetMove`,
      differingPaths,
      tier.name,
    );
  // The tier's own commands check the differing paths on the merged tree.
  // The session's other commands keep their source results; commands without
  // one (integration-only commands such as build) still run on the merged tree.
  const tierCommands = new Set(
    flatten(tier.integrationValidationCommands).map(commandFingerprint),
  );
  const sessionSteps = withoutCommands(steps, tierCommands);
  const sourceResults = await validationCacheFor(
    repository,
    session,
    sourceTree,
    sessionSteps,
  );
  return {
    outcome: "applied",
    reason: `the merged tree differs from the validated source tree only in ${tier.name} paths (${preview(differingPaths)})`,
    tier: tier.name,
    differingPaths,
    steps: [...tier.integrationValidationCommands, ...sessionSteps],
    reused: sourceResults,
  };
}

/** Print and record the reuse decision before integration validation. */
export function reportSourceReuse(plan: SourceReusePlan): void {
  recordPerformanceMetric("integrationSourceReuse", plan.outcome);
  recordPerformanceMetric("integrationSourceReuseReason", plan.reason);
  recordPerformanceMetric(
    "integrationSourceReuseDifferingPaths",
    plan.differingPaths.length,
  );
  if (plan.tier)
    recordPerformanceMetric("integrationSourceReuseTier", plan.tier);
  if (plan.outcome === "applied") {
    process.stdout.write(
      `Source validation reuse: ${plan.reason}. Running the ${plan.tier} integration commands on the merged tree; reusing ${plan.reused.size} source result(s) for the other commands.\n`,
    );
  } else if (plan.outcome === "skipped") {
    process.stdout.write(`Source validation reuse skipped: ${plan.reason}.\n`);
  }
}

/** Record which commands actually reused a source result. */
export function recordSourceReuseResult(
  plan: SourceReusePlan,
  reused: Command[],
): void {
  if (plan.outcome !== "applied") return;
  recordPerformanceMetric("integrationSourceReusedCommands", reused.length);
  recordPerformanceMetric(
    "integrationSourceReusedCommandList",
    reused.map((command) => command.join(" ")).join("; "),
  );
}

/** Every path whose entry differs between two trees, without rename pairing. */
export async function treeDifference(
  cwd: string,
  from: string,
  to: string,
): Promise<string[]> {
  // Plumbing ignores porcelain diff configuration (relative paths, rename
  // detection, ignored submodules); -z keeps unusual path names exact.
  const result = await run(
    "git",
    [
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-renames",
      "--ignore-submodules=none",
      from,
      to,
    ],
    { cwd },
  );
  if (result.code !== 0)
    throw new Error(
      `Could not compare validated tree ${from} with merged tree ${to}: ${(result.stderr || result.stdout).trim()}`,
    );
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}

function withoutCommands(
  steps: ValidationStep[],
  fingerprints: Set<string>,
): ValidationStep[] {
  if (fingerprints.size === 0) return steps;
  const keep = (entry: Parameters<typeof validationCommandValue>[0]) =>
    !fingerprints.has(commandFingerprint(validationCommandValue(entry)));
  return steps.flatMap((step): ValidationStep[] => {
    if (Array.isArray(step) || "command" in step)
      return keep(step) ? [step] : [];
    const parallel = step.parallel.filter(keep);
    return parallel.length > 0 ? [{ ...step, parallel }] : [];
  });
}

function flatten(steps: ValidationStep[]): Command[] {
  return steps.flatMap((step) =>
    (Array.isArray(step) || "command" in step ? [step] : step.parallel).map(
      validationCommandValue,
    ),
  );
}

function preview(paths: string[]): string {
  const shown = paths.slice(0, PATH_PREVIEW).join(", ");
  const more = paths.length - PATH_PREVIEW;
  return `${paths.length} path(s): ${shown}${more > 0 ? `, and ${more} more` : ""}`;
}
