#!/usr/bin/env node
/**
 * Merge script for Path B deployment.
 *
 * After `vite build` produces dist/ and `astro build` produces marketing-dist/:
 *   1. Rename dist/index.html → dist/app-shell.html  (React SPA entry)
 *   2. Copy marketing-dist/** into dist/              (Astro static pages become the real routes)
 *
 * Result: Astro's index.html is the public landing page;
 *         the SPA loads via /app-shell.html for authenticated app routes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const marketingDist = path.join(root, "marketing", "dist");

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. Rename React SPA shell
const spaShell = path.join(dist, "index.html");
const spaShellDest = path.join(dist, "app-shell.html");
if (!fs.existsSync(spaShell)) {
  console.error("ERROR: dist/index.html not found — run `npm run build:react` first.");
  process.exit(1);
}
fs.renameSync(spaShell, spaShellDest);
console.log("✓ dist/index.html → dist/app-shell.html");

// 2. Copy Astro output into dist/
if (!fs.existsSync(marketingDist)) {
  console.error("ERROR: marketing-dist/ not found — run `npm run build:marketing` first.");
  process.exit(1);
}
copyDirSync(marketingDist, dist);
console.log("✓ marketing-dist/ copied into dist/");

console.log("✓ Merge complete.");
