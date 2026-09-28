import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["./test/setup/integration.ts"],
    fileParallelism: false,
  },
});
