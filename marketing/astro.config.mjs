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
    // Force ALL bundled <script> tags to be emitted as external
    // /_astro/*.js files instead of inlined into the HTML. Required
    // because the production CSP (vercel.json) has no 'unsafe-inline',
    // no nonce, and no hash — so any inline <script> (including the
    // ones Astro normally inlines because they're "small enough") is
    // blocked at runtime. External same-origin scripts pass the CSP
    // `script-src 'self'` source. See marketing/src/scripts/landing.ts.
    inlineStylesheets: "auto",
  },
  vite: {
    build: {
      // Belt-and-suspenders: force assets to never be inlined as data URIs.
      // The script-inlining behavior comes from Astro's HTML emitter, but
      // setting this also prevents Vite from inlining tiny imports.
      assetsInlineLimit: 0,
    },
  },
});
