import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fork tests share one Surfpool instance and its clock: run them in order
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
