#!/usr/bin/env node
// Wave C Signal S-M5 — replaces the previously-static public/sitemap.xml
// (lastmod was frozen at 2026-04-19, ~2 weeks stale by the time anyone
// looked). Runs as a prebuild step so `npm run build` always ships a
// sitemap with a fresh ISO date.
//
// Why a generator instead of a CI cron: the marketing pages list is in
// this repo, the build emits both React and Astro outputs together,
// and there's no other place we can guarantee the file is current.
// Adding it to build keeps the sitemap honest by construction.
//
// Add or remove URLs by editing the ROUTES table below. There is no
// dynamic page discovery — public routes are short and stable, and a
// hardcoded list is auditable on every PR.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const OUTPUT_PATH = join(REPO_ROOT, "public", "sitemap.xml");

const APEX = "https://motionmax.io";

// Route table — keep in sync with public routes that ship a real
// <Helmet>/BaseLayout meta. Priorities are deliberately conservative
// (only the homepage is 1.0). changefreq is a hint, not a contract:
// Google treats it as one signal among many. Legal pages are monthly
// because we only bump them when LEGAL_VERSIONS changes.
const ROUTES = [
  {
    loc: "/",
    changefreq: "weekly",
    priority: "1.0",
    images: [
      { loc: "/og-image.png", title: "MotionMax — AI Video Generator", caption: "Turn text into cinematic AI-generated videos with MotionMax" },
      { loc: "/herobackground.webp", title: "MotionMax Hero — AI Video from Text" },
    ],
  },
  { loc: "/pricing",        changefreq: "weekly",  priority: "0.9" },
  { loc: "/help",           changefreq: "weekly",  priority: "0.7" },
  { loc: "/terms",          changefreq: "monthly", priority: "0.4" },
  { loc: "/privacy",        changefreq: "monthly", priority: "0.4" },
  { loc: "/acceptable-use", changefreq: "monthly", priority: "0.3" },
  // /share/:token is dynamic per public-share token and intentionally
  // omitted from the sitemap (the share routes are noindex by design;
  // discoverability flows through whoever the user explicitly shared
  // the link with, not search).
];

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderImage(img) {
  const lines = [
    "    <image:image>",
    `      <image:loc>${APEX}${escapeXml(img.loc)}</image:loc>`,
  ];
  if (img.title) lines.push(`      <image:title>${escapeXml(img.title)}</image:title>`);
  if (img.caption) lines.push(`      <image:caption>${escapeXml(img.caption)}</image:caption>`);
  lines.push("    </image:image>");
  return lines.join("\n");
}

function renderUrl(route, today) {
  const lines = [
    "  <url>",
    `    <loc>${APEX}${escapeXml(route.loc)}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>${route.changefreq}</changefreq>`,
    `    <priority>${route.priority}</priority>`,
  ];
  if (route.images?.length) {
    for (const img of route.images) lines.push(renderImage(img));
  }
  lines.push("  </url>");
  return lines.join("\n");
}

function generate() {
  // ISO date (YYYY-MM-DD) per sitemaps.org spec — a full timestamp is
  // valid but adds noise and would change every build run, defeating
  // any "did the sitemap actually change" diffing on PRs.
  const today = new Date().toISOString().slice(0, 10);
  const body = ROUTES.map((r) => renderUrl(r, today)).join("\n");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    body +
    `\n</urlset>\n`;

  const outDir = dirname(OUTPUT_PATH);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUTPUT_PATH, xml, "utf8");
  console.log(`[sitemap] wrote ${ROUTES.length} urls to ${OUTPUT_PATH} (lastmod=${today})`);
}

generate();
