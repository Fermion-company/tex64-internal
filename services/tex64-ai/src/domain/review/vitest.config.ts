import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const serviceRoot = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: serviceRoot,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../../src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/domain/review/**/*.test.ts"],
  },
});
