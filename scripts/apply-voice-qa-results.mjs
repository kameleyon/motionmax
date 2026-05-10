#!/usr/bin/env node
/**
 * apply-voice-qa-results.mjs
 * ─────────────────────────────────────────────────────────────────────
 * Reads qa-output/voices/REPORT.md (filled in by a native-speaker
 * reviewer), counts the Pass rows, and emits a unified diff that
 * updates the public "Multilingual voiceover" claim across landing
 * content + pricing copy to the specific number "Voice generation in
 * N languages".
 *
 * Default mode is **dry-run** — prints the diff to stdout. Pass --apply
 * to actually write the changes.
 *
 * USAGE:
 *
 *   # 1) Print the diff (no file writes):
 *   node scripts/apply-voice-qa-results.mjs
 *
 *   # 2) Actually apply:
 *   node scripts/apply-voice-qa-results.mjs --apply
 *
 *   # 3) List failed locales (and emit a comment block suggesting which
 *   #    to hide from SpeakerSelector / LanguageSelector — does NOT
 *   #    auto-hide; just gives Jo something to paste):
 *   node scripts/apply-voice-qa-results.mjs --list-failed
 *
 *   # 4) Custom report path:
 *   node scripts/apply-voice-qa-results.mjs --report=qa-output/voices-2026-Q2/REPORT.md
 *
 * SAFETY:
 *
 *   • Default behaviour is non-destructive (dry-run). Apply only with
 *     explicit --apply.
 *   • If a target file no longer contains the expected source string,
 *     the script reports it and exits non-zero — never silently leaves
 *     the codebase half-updated.
 *   • Reads REPORT.md as-is — does not regenerate audio or call any
 *     APIs. Pure file rewrite.
 * ─────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── arg parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const hit = args.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.split("=")[1] : undefined;
};

const APPLY = flag("--apply");
const LIST_FAILED = flag("--list-failed");
const REPORT_PATH = path.resolve(opt("--report") ?? "qa-output/voices/REPORT.md");

// ── REPORT.md parsing ──────────────────────────────────────────────

if (!fs.existsSync(REPORT_PATH)) {
  console.error(`FATAL: report not found: ${REPORT_PATH}`);
  console.error("Run scripts/qa-voice-locales.mjs first, then fill in the Status column.");
  process.exit(1);
}

const reportText = fs.readFileSync(REPORT_PATH, "utf8");
const rows = parseReport(reportText);

if (rows.length === 0) {
  console.error("FATAL: no rows parsed from REPORT.md (is the table intact?)");
  process.exit(1);
}

const passed = rows.filter((r) => r.status === "Pass");
const failed = rows.filter((r) => r.status === "Fail");
const marginal = rows.filter((r) => r.status === "Marginal");
const unscored = rows.filter((r) => r.status === "Unscored");

const N = passed.length;

console.log(`# Voice locale QA — apply step`);
console.log(`Report: ${REPORT_PATH}`);
console.log(`Pass:     ${passed.map((r) => r.locale).join(", ") || "(none)"}`);
console.log(`Marginal: ${marginal.map((r) => r.locale).join(", ") || "(none)"}`);
console.log(`Fail:     ${failed.map((r) => r.locale).join(", ") || "(none)"}`);
console.log(`Unscored: ${unscored.map((r) => r.locale).join(", ") || "(none)"}`);
console.log("");

if (unscored.length > 0) {
  console.warn(
    `WARN: ${unscored.length} row(s) still show "Pass / Fail / Marginal" placeholder — ` +
    `they are NOT counted toward the public number. Score them and re-run.`,
  );
  console.log("");
}

if (LIST_FAILED) {
  emitFailedHideBlock(failed, marginal);
  if (!APPLY && passed.length === 0) process.exit(0);
}

if (N === 0) {
  console.error("FATAL: zero locales scored Pass. Nothing to publish — fix and re-review.");
  process.exit(1);
}

// ── Edits ──────────────────────────────────────────────────────────
// One source of truth per file: the exact string we expect to find,
// and the exact replacement. apply() walks each, reports anything
// missing, and fails the run rather than silently skipping.

const NEW_FEATURE_TITLE = `Voice generation in ${N} languages`;
const NEW_TRUST_LABEL = `Voice in ${N} languages`;

// More-explanatory descriptions that reference the QA. Reviewers can
// tweak after; these are good defaults rooted in what's been verified.
const NEW_FEATURE_DESC =
  `AI narration in ${N} natively-supported languages, each spot-checked ` +
  `by a fluent reviewer for pronunciation. The narration language is ` +
  `selectable per project.`;
const NEW_TRUST_DETAIL =
  `Generate voiceovers in ${N} reviewer-verified languages — ` +
  `narration language is set per project.`;

const EDITS = [
  // src/config/landingContent.ts — feature card
  {
    file: "src/config/landingContent.ts",
    find: `    title: "Multilingual Voiceover",\n    description:\n      "AI narration in multiple languages — including English, French, Spanish, and Haitian Creole. The narration language is selectable per project.",`,
    replace:
      `    title: "${NEW_FEATURE_TITLE}",\n    description:\n      "${NEW_FEATURE_DESC}",`,
  },
  // src/config/landingContent.ts — trust badge
  {
    file: "src/config/landingContent.ts",
    find: `    label: "Multilingual Narration",\n    detail: "Generate voiceovers in multiple languages — narration language is set per project.",`,
    replace:
      `    label: "${NEW_TRUST_LABEL}",\n    detail: "${NEW_TRUST_DETAIL}",`,
  },
  // src/components/landing/LandingPricing.tsx — Creator extras list
  {
    file: "src/components/landing/LandingPricing.tsx",
    find: `extras={["1080p quality", "All formats (16:9, 9:16)", "Multilingual voiceover"]}`,
    replace: `extras={["1080p quality", "All formats (16:9, 9:16)", "${NEW_FEATURE_TITLE}"]}`,
  },
  // src/config/pricingPlans.ts — Creator features bullet
  {
    file: "src/config/pricingPlans.ts",
    find: `      "1 voice clone",\n      "Multilingual voiceover narration",`,
    replace: `      "1 voice clone",\n      "${NEW_FEATURE_TITLE}",`,
  },
  // src/config/pricingPlans.ts — Studio features bullet
  {
    file: "src/config/pricingPlans.ts",
    find: `      "5 voice clones",\n      "Multilingual voiceover narration",`,
    replace: `      "5 voice clones",\n      "${NEW_FEATURE_TITLE}",`,
  },
  // marketing/src/pages/index.astro — feature card
  {
    file: "marketing/src/pages/index.astro",
    find: `    title: "Multilingual Voiceover",\n    description: "AI narration in multiple languages — including English, French, Spanish, and Haitian Creole. Set the narration language per project.",`,
    replace:
      `    title: "${NEW_FEATURE_TITLE}",\n    description: "${NEW_FEATURE_DESC}",`,
  },
  // marketing/src/pages/index.astro — trust badge
  {
    file: "marketing/src/pages/index.astro",
    find: `<h3 class="font-semibold text-foreground">Multilingual Narration</h3>\n            <p class="mt-1 text-sm text-muted-foreground">Generate voiceovers in multiple languages — narration language is set per project.</p>`,
    replace:
      `<h3 class="font-semibold text-foreground">${NEW_TRUST_LABEL}</h3>\n            <p class="mt-1 text-sm text-muted-foreground">${NEW_TRUST_DETAIL}</p>`,
  },
  // marketing/src/pages/index.astro — JSON-LD featureList
  {
    file: "marketing/src/pages/index.astro",
    find: `    "Multilingual Voiceover Narration",`,
    replace: `    "${NEW_FEATURE_TITLE}",`,
  },
];

let missing = 0;
let willChange = 0;

console.log(`# Proposed edits (${EDITS.length} hunks across ${new Set(EDITS.map((e) => e.file)).size} files)`);
console.log(`# Public claim: "${NEW_FEATURE_TITLE}"\n`);

for (const edit of EDITS) {
  const abs = path.resolve(edit.file);
  if (!fs.existsSync(abs)) {
    console.error(`MISSING FILE: ${edit.file}`);
    missing++;
    continue;
  }
  const beforeRaw = fs.readFileSync(abs, "utf8");
  // Be tolerant of CRLF line endings on Windows checkouts. Match against
  // a normalised \n form and apply the edit while preserving whatever
  // line ending the file is using.
  const usesCRLF = beforeRaw.includes("\r\n");
  const before = usesCRLF ? beforeRaw.replace(/\r\n/g, "\n") : beforeRaw;
  if (!before.includes(edit.find)) {
    console.error(`NO MATCH in ${edit.file} — expected source string was not found.`);
    console.error(`         Source may have been edited since the apply script was generated.`);
    console.error(`         Re-read the file and update EDITS in scripts/apply-voice-qa-results.mjs.`);
    missing++;
    continue;
  }
  const afterLF = before.replace(edit.find, edit.replace);
  const after = usesCRLF ? afterLF.replace(/\n/g, "\r\n") : afterLF;
  printDiff(edit.file, edit.find, edit.replace);
  if (APPLY) {
    fs.writeFileSync(abs, after);
    console.log(`  applied → ${edit.file}\n`);
  }
  willChange++;
}

if (missing > 0) {
  console.error(`\nFATAL: ${missing} edit(s) could not be applied. Aborting without changes.`);
  process.exit(2);
}

console.log("");
console.log(`Summary: ${N} of ${rows.length} locales passed.`);
console.log(`Public claim ${APPLY ? "updated to" : "would be updated to"}: "${NEW_FEATURE_TITLE}".`);
if (!APPLY) {
  console.log(`\n(Dry-run. Re-run with --apply to write the changes.)`);
}

// ── helpers ────────────────────────────────────────────────────────

function parseReport(text) {
  // Find the "Review checklist" table. Header row is recognised by
  // | Locale | Language | File | Provider | Voice ID | Status | ...
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) =>
    /^\|\s*Locale\s*\|.*Status/i.test(l),
  );
  if (headerIdx < 0) return [];
  const out = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] is "" before first pipe.
    if (cells.length < 7) continue;
    const locale = cells[1];
    const language = cells[2];
    const statusRaw = cells[6];
    if (!locale || locale === "---") continue;
    let status = "Unscored";
    if (/^Pass$/i.test(statusRaw)) status = "Pass";
    else if (/^Fail$/i.test(statusRaw)) status = "Fail";
    else if (/^Marginal$/i.test(statusRaw)) status = "Marginal";
    out.push({ locale, language, status, raw: statusRaw });
  }
  return out;
}

function emitFailedHideBlock(failed, marginal) {
  if (failed.length === 0 && marginal.length === 0) {
    console.log("# --list-failed: no Fail or Marginal rows. Nothing to hide.");
    return;
  }
  console.log(`# --list-failed: paste the following comment block above the languages array`);
  console.log(`# in src/components/workspace/LanguageSelector.tsx, then comment out the`);
  console.log(`# matching { id: '<locale>', ... } entries. (This script does NOT auto-edit.)\n`);
  console.log(`/*`);
  console.log(` * Voice QA — ${new Date().toISOString().slice(0, 10)}`);
  console.log(` * The following locales did NOT pass native-speaker review and should be`);
  console.log(` * hidden from the language picker until the underlying TTS issue is fixed`);
  console.log(` * (or moved to a different provider). The 'pt' code already stays in the`);
  console.log(` * Language union for legacy projects — do the same here.`);
  if (failed.length > 0) {
    console.log(` *`);
    console.log(` * Fail (do not offer):`);
    for (const r of failed) console.log(` *   - ${r.locale}  // ${r.language}`);
  }
  if (marginal.length > 0) {
    console.log(` *`);
    console.log(` * Marginal (consider hiding, or label as "beta"):`);
    for (const r of marginal) console.log(` *   - ${r.locale}  // ${r.language}`);
  }
  console.log(` */\n`);
}

function printDiff(file, find, replace) {
  console.log(`--- a/${file}`);
  console.log(`+++ b/${file}`);
  for (const line of find.split("\n")) console.log(`- ${line}`);
  for (const line of replace.split("\n")) console.log(`+ ${line}`);
  console.log("");
}
