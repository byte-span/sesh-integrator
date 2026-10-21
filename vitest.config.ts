import { defineConfig } from "vitest/config";
import { resolveTestWorkers } from "./src/worker-budget.js";

export default defineConfig(async () => {
  // Bound workers so concurrent queued validations share the CPUs instead of
  // each starting one worker per core. SESH_VITEST_MAX_WORKERS overrides it.
  const workers = await resolveTestWorkers();
  if (!process.env.VITEST_WORKER_ID)
    process.stderr.write(
      `Vitest workers: ${workers.maxWorkers} (${workers.source})\n`,
    );
  return {
    test: {
      // Each test exercises disposable queue state, never the operator's queue.
      setupFiles: ["./test/queue-isolation.ts"],
      maxWorkers: workers.maxWorkers,
    },
  };
});
