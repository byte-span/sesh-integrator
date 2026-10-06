import { defineConfig } from "vitest/config";
import { availableParallelism, totalmem } from "node:os";
import { defaultConcurrency } from "./src/build-queue.js";

export default defineConfig({
  test: {
    // Each test exercises disposable queue state, never the operator's queue.
    setupFiles: ["./test/queue-isolation.ts"],
    maxWorkers: defaultConcurrency(
      availableParallelism(),
      Math.min(totalmem(), process.constrainedMemory?.() || Infinity),
    ),
  },
});
