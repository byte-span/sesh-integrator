import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test exercises disposable queue state, never the operator's queue.
    setupFiles: ["./test/queue-isolation.ts"],
  },
});
