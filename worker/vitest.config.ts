import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Each test file gets its own isolated module registry so vi.mock() calls
    // don't bleed across files.
    isolate: true,
    // Resolve .js extension imports (TypeScript ESM emits ".js" in import paths)
    alias: {
      // Allow test files to import "../lib/supabase.js" and have it intercepted
      // by vi.mock() without needing real Supabase credentials at test time.
    },
  },
});
