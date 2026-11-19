import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts, whose root is web/ and would hide server tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
