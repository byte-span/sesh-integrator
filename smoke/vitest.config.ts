import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["smoke/live.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 30_000,
  },
});
