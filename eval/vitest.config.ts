import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["eval/live.ts"],
    fileParallelism: false,
    testTimeout: 420_000,
    hookTimeout: 30_000,
  },
});
