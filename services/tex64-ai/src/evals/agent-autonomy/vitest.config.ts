import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const serviceRoot = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: serviceRoot,
  test: {
    environment: "node",
    include: ["src/evals/agent-autonomy/**/*.test.ts"],
  },
});
