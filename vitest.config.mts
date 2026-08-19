import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // PGlite boots a Postgres WASM image on first query, and bcrypt at 12
    // rounds is deliberately slow. Both are fine; they just outrun the 5s/10s
    // defaults on a cold run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
