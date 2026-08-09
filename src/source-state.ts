import type { GitObservation, GitPathObservation } from "./types.js";

export interface HandoffStateDecision {
  warnings: string[];
  blockers: string[];
}

export function assessBeginBaseline(
  observation: GitObservation,
): HandoffStateDecision {
  const warnings: string[] = [];
  const blockers = observationErrors(observation);
  for (const path of observation.paths) {
    if (isStaged(path)) {
      blockers.push(
        `${path.path}: blocked because it is staged before begin; a later task commit could absorb it`,
      );
    } else if (!path.accessible && path.tracked) {
      warnings.push(
        `${path.path}: tracked path is inaccessible and unstaged; its observable handoff state will be preserved and compared`,
      );
    } else if (!path.accessible) {
      blockers.push(
        `${path.path}: inaccessible path could not be confirmed as tracked`,
      );
    } else {
      warnings.push(
        `${path.path}: pre-existing unstaged change recorded; it must remain observably unchanged and outside the task commit`,
      );
    }
  }
  return { warnings, blockers };
}

export function assessCompletionState(
  baseline: GitObservation,
  current: GitObservation,
  taskPaths: Iterable<string>,
): HandoffStateDecision {
  const warnings: string[] = [];
  const blockers = observationErrors(current);
  if (baseline.version !== 1) {
    blockers.push(
      "unsupported Git baseline version; begin a new handoff session",
    );
    return { warnings, blockers };
  }
  const targets = new Set(taskPaths);
  const before = new Map(baseline.paths.map((path) => [path.path, path]));
  const after = new Map(current.paths.map((path) => [path.path, path]));
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const initial = before.get(path);
    const observed = after.get(path);
    if (targets.has(path)) {
      if (initial && !initial.accessible) {
        blockers.push(
          `${path}: blocked because the task commit targets a path that was inaccessible at begin`,
        );
      } else if (initial) {
        blockers.push(
          `${path}: blocked because the task commit includes a pre-existing dirty path; excluding it could make the commit incomplete`,
        );
      }
      if (observed) {
        blockers.push(
          `${path}: blocked because a task path still has uncommitted or indeterminate working-tree state`,
        );
      }
      continue;
    }
    if (!initial && observed) {
      blockers.push(
        `${path}: blocked because a new unrelated ${describe(observed)} appeared after begin`,
      );
      continue;
    }
    if (initial && !observed) {
      if (
        !initial.accessible &&
        initial.tracked &&
        initial.indexEntry !== null &&
        currentIndexEntry(current, path) === initial.indexEntry
      ) {
        warnings.push(
          `${path}: inaccessible at begin and omitted by current worktree observation, but remains tracked at the same unstaged index entry and outside the task diff; preserving and excluding it (disk contents were not verified)`,
        );
        continue;
      }
      blockers.push(
        `${path}: blocked because its pre-existing observable handoff state changed after begin`,
      );
      continue;
    }
    if (!initial || !observed) continue;
    if (isStaged(observed)) {
      blockers.push(`${path}: blocked because the non-task path is staged`);
      continue;
    }
    if (!sameObservableState(initial, observed)) {
      blockers.push(
        `${path}: blocked because its observable handoff state changed after begin`,
      );
      continue;
    }
    if (!initial.accessible) {
      warnings.push(
        `${path}: inaccessible at begin and completion, tracked, unstaged, outside the task diff, and observably unchanged; preserving and excluding it (disk contents were not verified)`,
      );
    } else {
      warnings.push(
        `${path}: pre-existing unstaged change is observably unchanged and outside the task diff; preserving and excluding it`,
      );
    }
  }
  return { warnings, blockers };
}

function currentIndexEntry(
  observation: GitObservation,
  path: string,
): string | null {
  for (const record of observation.commands.index.stdout.split("\0")) {
    const separator = record.indexOf("\t");
    if (separator > 0 && record.slice(separator + 1) === path) {
      return record.slice(0, separator);
    }
  }
  return null;
}

function observationErrors(observation: GitObservation): string[] {
  return observation.unscopedErrors.map(
    (error) => `Git observation was indeterminate: ${error}`,
  );
}

function isStaged(path: GitPathObservation): boolean {
  return (
    path.indexRaw !== null ||
    (!!path.status && ![" ", "?"].includes(path.status[0] ?? ""))
  );
}

function sameObservableState(
  left: GitPathObservation,
  right: GitPathObservation,
): boolean {
  return (
    left.tracked === right.tracked &&
    left.accessible === right.accessible &&
    left.status === right.status &&
    left.worktreeRaw === right.worktreeRaw &&
    left.indexRaw === right.indexRaw &&
    left.indexEntry === right.indexEntry &&
    left.contentHash === right.contentHash &&
    JSON.stringify(left.errors) === JSON.stringify(right.errors)
  );
}

function describe(path: GitPathObservation): string {
  if (!path.accessible) return "inaccessible or permission-error path";
  if (path.status?.includes("D")) return "tracked-file deletion";
  return "modification";
}
