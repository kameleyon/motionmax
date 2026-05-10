/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import path from "path";

// Standalone test config — no vite plugins (lovable-tagger, PWA etc.)
export default defineConfig({
  plugins: [],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["src/test-utils/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/integrations/**",
      ],
      // C-10-2: bumped from 20%/15% to 50%/40%. Realistic for a TS/React
      // codebase that is roughly half UI shell + half business logic
      // (lib/, services/, hooks/), and meaningful — a PR can't ship if
      // the new code is wholly untested. `perFile = false` keeps the
      // gate global so a single low-coverage file doesn't fail every
      // unrelated PR; we'd rather fail on the project total drifting
      // backwards. Bump again once it's comfortably green.
      thresholds: {
        perFile: false,
        lines: 50,
        functions: 40,
        branches: 40,
        statements: 50,
      },
      reporter: ["text", "lcov", "json"],
    },
  },
});
