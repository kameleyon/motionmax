#!/usr/bin/env node
// One-shot manual fire of the intermediate-asset cleanup. Same logic
// as supabase/functions/cleanup-intermediate-storage/index.ts but
// run from this machine using worker/.env credentials — avoids the
// edge-function auth gate while we figure out the key mismatch.
//
// Usage:  node scripts/run-intermediate-cleanup-once.mjs
//         node scripts/run-intermediate-cleanup-once.mjs --days 14   # tighter window
//         node scripts/run-intermediate-cleanup-once.mjs --dry-run   # list, don't delete
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from worker/.env.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const envPath = path.resolve("worker/.env");
if (fs.existsSync(envPath)) {
  // Manual dotenv load from the worker .env since our cwd is repo root.
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const daysArg = process.argv.find((a) => a.startsWith("--days"));
const days = daysArg ? Number(daysArg.split(/=|\s/)[1] ?? process.argv[process.argv.indexOf(daysArg) + 1]) : 30;
if (!Number.isFinite(days) || days < 1) {
  console.error("Invalid --days value:", daysArg);
  process.exit(1);
}

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in worker/.env");
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
console.log(`▶ cutoff = ${cutoff} (${days} days)  dryRun = ${dryRun}\n`);

const { data: projects, error: pErr } = await sb
  .from("projects")
  .select("id, updated_at, user_id")
  .lt("updated_at", cutoff)
  .order("updated_at", { ascending: true });
if (pErr) {
  console.error("Failed to list projects:", pErr.message);
  process.exit(1);
}
console.log(`Found ${projects.length} project(s) older than ${days} days.\n`);
if (projects.length === 0) process.exit(0);

const BUCKETS = ["scene-images", "audio", "scene-videos"];
let totalFiles = 0;
let totalBytes = 0;
const errors = [];

for (let i = 0; i < projects.length; i++) {
  const p = projects[i];
  let perProjectFiles = 0;
  let perProjectBytes = 0;
  for (const bucket of BUCKETS) {
    try {
      let page = 0;
      const PAGE_SIZE = 1000;
      for (;;) {
        const { data: entries, error: lErr } = await sb.storage
          .from(bucket)
          .list(p.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE, sortBy: { column: "name", order: "asc" } });
        if (lErr) throw new Error(`list ${bucket}: ${lErr.message}`);
        if (!entries || entries.length === 0) break;

        const paths = entries.map((e) => `${p.id}/${e.name}`);
        const bytes = entries.reduce((s, e) => s + (e.metadata?.size ?? 0), 0);
        perProjectFiles += entries.length;
        perProjectBytes += bytes;

        if (!dryRun) {
          const { error: rmErr } = await sb.storage.from(bucket).remove(paths);
          if (rmErr) throw new Error(`remove ${bucket}: ${rmErr.message}`);
        }

        if (entries.length < PAGE_SIZE) break;
        page++;
      }
    } catch (e) {
      errors.push({ project: p.id, bucket, error: e.message });
    }
  }
  totalFiles += perProjectFiles;
  totalBytes += perProjectBytes;
  if (perProjectFiles > 0 || (i + 1) % 25 === 0) {
    process.stdout.write(
      `  [${i + 1}/${projects.length}] ${p.id} → ${perProjectFiles} files, ${(perProjectBytes / 1024 / 1024).toFixed(1)} MB\n`,
    );
  }
}

console.log("");
console.log(`━━━ SUMMARY ━━━`);
console.log(`  Projects scanned:  ${projects.length}`);
console.log(`  Files ${dryRun ? "would-delete" : "deleted"}: ${totalFiles}`);
console.log(`  Bytes ${dryRun ? "would-free" : "freed"}:    ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB  (${(totalBytes / 1024 / 1024).toFixed(0)} MB)`);
if (errors.length) {
  console.log(`  Errors:            ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log(`    - ${e.project} / ${e.bucket}: ${e.error}`);
}
