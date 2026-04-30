#!/usr/bin/env node
/**
 * Delete storage objects whose path references a project_id that no
 * longer exists in public.projects.
 *
 * Buckets covered: audio, scene-videos, scene-images, videos.
 *
 * Strategy:
 *   1. Load every active project id into a Set.
 *   2. Page through `storage.objects` (via the storage schema exposed
 *      by PostgREST under service-role) for each bucket. Each row
 *      gives us the object's path and we extract any UUID-shaped
 *      tokens.
 *   3. An object is an orphan iff its path contains at least one UUID
 *      AND none of the UUIDs match a live project id.
 *   4. In --execute mode, batch-delete orphans 100-at-a-time via the
 *      Storage API (`storage.from(bucket).remove([paths])`). Direct
 *      DELETE on storage.objects is blocked by Supabase's
 *      protect_delete trigger.
 *
 * Required env (loaded from worker/.env or shell):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/prune-orphan-storage.mjs           # default = dry run
 *   node scripts/prune-orphan-storage.mjs --execute # actually delete
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf-8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}
loadEnvFile(resolve(__dirname, "..", "worker", ".env"));
loadEnvFile(resolve(__dirname, "..", ".env"));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const DRY_RUN = !process.argv.includes("--execute");
const BUCKETS = ["audio", "scene-videos", "scene-images", "videos"];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const REMOVE_BATCH = 100;
const PAGE_SIZE = 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: "public" }, // default; we override per-query for storage
});

async function loadProjectIds() {
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`projects fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) ids.add(r.id);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return ids;
}

/**
 * Fetch orphan storage objects for one bucket via the SECURITY DEFINER
 * RPC `public.list_orphan_storage_objects`. The RPC computes orphans
 * server-side by comparing UUID tokens in the path against
 * public.projects, so we don't need to download the whole index.
 */
async function fetchOrphans(bucket) {
  const out = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.rpc("list_orphan_storage_objects", {
      p_bucket: bucket,
      p_offset: offset,
      p_limit: PAGE,
    });
    if (error) throw new Error(`rpc list_orphan_storage_objects ${bucket}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) out.push({ name: r.name, size: Number(r.size_bytes ?? 0) });
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  console.log(`[prune] mode: ${DRY_RUN ? "DRY RUN" : "EXECUTE"}`);

  let grandOrphans = 0;
  let grandBytes = 0;

  for (const bucket of BUCKETS) {
    process.stdout.write(`[prune] querying orphans in ${bucket}…`);
    const orphans = await fetchOrphans(bucket);
    process.stdout.write(` ${orphans.length} orphans\n`);

    const bytes = orphans.reduce((s, o) => s + o.size, 0);
    grandOrphans += orphans.length;
    grandBytes += bytes;
    console.log(
      `[prune] ${bucket}: ${orphans.length} orphans, ${(bytes / 1024 / 1024).toFixed(1)} MB`
    );
    for (const o of orphans.slice(0, 3)) console.log(`         · ${o.name}`);

    if (DRY_RUN) continue;

    const paths = orphans.map((o) => o.name);
    let deleted = 0;
    for (const batch of chunk(paths, REMOVE_BATCH)) {
      const { error } = await supabase.storage.from(bucket).remove(batch);
      if (error) {
        console.error(`\n[prune] ${bucket}: batch remove failed: ${error.message}`);
        continue;
      }
      deleted += batch.length;
      process.stdout.write(`\r[prune] ${bucket}: deleted ${deleted}/${paths.length}`);
    }
    process.stdout.write("\n");
  }

  console.log(
    `[prune] TOTAL: ${grandOrphans} orphans, ${(grandBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  );
  if (DRY_RUN) console.log("[prune] re-run with --execute to actually delete.");
}

main().catch((e) => {
  console.error("[prune] failed:", e);
  process.exit(1);
});
