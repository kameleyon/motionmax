import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  output: "static",
  outDir: "./dist",
  // Share root public/ assets (favicon, logo, etc.)
  publicDir: "../public",
  integrations: [
    tailwind({
      configFile: "./tailwind.config.cjs",
      applyBaseStyles: false,
    }),
  ],
  build: {
    // Generates /terms/index.html, /privacy/index.html etc.
    format: "directory",
    assets: "_astro",
  },
});
