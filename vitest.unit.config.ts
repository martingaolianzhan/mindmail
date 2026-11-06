import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Match Next.js's JSX runtime when exercising application components.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["./test/setup/unit.ts"],
  },
});
