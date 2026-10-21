import { availableParallelism } from "node:os";
import { queueCapacity, queueRoot, queueSettings } from "./build-queue.js";

/** Environment variable that overrides the derived test worker count. */
export const testWorkersVariable = "SESH_VITEST_MAX_WORKERS";

export interface WorkerBudget {
  maxWorkers: number;
  /** Human-readable origin of the value, for diagnostics. */
  source: string;
}

/**
 * Workers one command may use when `concurrency` such commands can share
 * `cpus` threads at once. It keeps the runner's usual spare thread, so a single
 * command matches Vitest's own default of one fewer worker than CPUs.
 */
export function boundedWorkers(cpus: number, concurrency: number): number {
  return Math.max(
    1,
    Math.floor(Math.max(1, cpus - 1) / Math.max(1, concurrency)),
  );
}

/**
 * Resolve the test worker bound from the environment override or the shared
 * build queue's effective concurrency. An unlimited (or unreadable) queue uses
 * the queue's resource-aware `auto` estimate, because any number of commands
 * may then run together. This only reads queue settings; it never joins the queue.
 */
export async function resolveTestWorkers(
  env: NodeJS.ProcessEnv = process.env,
  cpus = availableParallelism(),
): Promise<WorkerBudget> {
  const override = env[testWorkersVariable]?.trim();
  if (override) {
    const value = Number(override);
    if (!/^\d+$/.test(override) || value < 1 || value > 1024)
      throw new Error(
        `${testWorkersVariable} must be a whole number from 1 to 1024; got "${override}". Unset it to derive the bound from the build queue.`,
      );
    return { maxWorkers: value, source: testWorkersVariable };
  }
  const estimate = queueCapacity({ concurrency: "auto", waitSeconds: 1 });
  let concurrency: number;
  let source: string;
  try {
    const limit = queueCapacity(await queueSettings(queueRoot()));
    if (Number.isFinite(limit)) {
      concurrency = limit;
      source = `build queue concurrency ${limit}`;
    } else {
      concurrency = estimate;
      source = `unlimited build queue; resource-aware estimate ${estimate}`;
    }
  } catch {
    concurrency = estimate;
    source = `unreadable build queue settings; resource-aware estimate ${estimate}`;
  }
  return {
    maxWorkers: boundedWorkers(cpus, concurrency),
    source: `${cpus} CPUs / ${source}`,
  };
}
