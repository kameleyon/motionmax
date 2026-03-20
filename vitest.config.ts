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
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
