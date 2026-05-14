#!/usr/bin/env node
/**
 * One-off cleanup: delete all projects (and associated storage assets)
 * for specific users created BEFORE a cutoff date.
 *
 * Intended for reducing Supabase storage + DB load on accounts with
 * many old/abandoned projects. Currently scoped to:
 *   - arcanadraconi (Jo)
 *   - davidricharleblack (Prof David)
 *   - cutoff: 2026-05-01 00:00 UTC
 *
 * Usage:
 *   # Dry-run (default — prints what WOULD be deleted, no mutations):
 *   SUPABASE_URL=https://<project>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/delete-user-projects-cleanup.mjs
 *
 *   # Actually execute the deletion (irreversible):
 *   node scripts/delete-user-projects-cleanup.mjs --execute
 *
 * Safety:
 *   - Looks up users by username/email — only proceeds if BOTH targets resolve
 *   - Lists every project + every storage path before deleting
 *   - --execute required; dry-run by default
 *   - Skips projects newer than cutoff (today's work stays intact)
 *   - Storage deletion is best-effort per file; DB rows cascade via FKs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXECUTE = process.argv.includes("--execute");
const CUTOFF_ISO = "2026-05-01T00:00:00Z";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  console.error("Get the service role key from:");
  console.error("  https://supabase.com/dashboard/project/ayjbvcikuwknqdrpsdmj/settings/api-keys");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TARGET_USERS = [
  { hint: "arcanadraconi (Jo)", usernameOrEmail: "arcanadraconi" },
  { hint: "Prof David", usernameOrEmail: "davidricharleblack" },
];

/** Buckets that hold per-project assets. Anything under <projectId>/* gets
 *  deleted. If a bucket isn't listed here, we leave it alone. */
const BUCKETS = ["videos", "scene-images", "audio"];

const ANSI = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Resolve a user by username (profiles.username) or fallback to auth.email.
 *  Returns { id, username, email } or null. */
async function findUser(hint) {
  // Try profiles.username first (most likely match).
  const { data: byUsername } = await sb
    .from("profiles")
    .select("id, username")
    .eq("username", hint)
    .maybeSingle();
  if (byUsername?.id) {
    const { data: { user } } = await sb.auth.admin.getUserById(byUsername.id);
    return { id: byUsername.id, username: byUsername.username, email: user?.email ?? "(unknown)" };
  }

  // Fallback: maybe they passed an email or partial.
  const { data: { users } } = await sb.auth.admin.listUsers({ page: 1, perPage: 500 });
  const match = users.find((u) =>
    u.email?.toLowerCase().includes(hint.toLowerCase()) ||
    u.user_metadata?.username?.toLowerCase() === hint.toLowerCase(),
  );
  if (match) {
    const { data: prof } = await sb.from("profiles").select("username").eq("id", match.id).maybeSingle();
    return { id: match.id, username: prof?.username ?? "(no profile)", email: match.email };
  }

  return null;
}

/** List projects belonging to userId created before cutoff. */
async function listProjects(userId) {
  const { data, error } = await sb
    .from("projects")
    .select("id, title, project_type, created_at")
    .eq("user_id", userId)
    .lt("created_at", CUTOFF_ISO)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listProjects(${userId}) failed: ${error.message}`);
  return data ?? [];
}

/** List storage paths under <projectId>/* for one bucket. Returns array of
 *  full object paths (incl. project id prefix). */
async function listStoragePaths(bucket, projectId) {
  // Supabase storage.list is paginated, max 1000 per page. Walk until empty.
  const paths = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.storage.from(bucket).list(projectId, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      // Bucket might not exist for this project (no assets). Treat as empty.
      if (/not found|does not exist/i.test(error.message)) return [];
      throw new Error(`listStoragePaths(${bucket}, ${projectId}) failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    for (const item of data) {
      // Skip directory placeholders (.emptyFolderPlaceholder, etc.)
      if (item.name === ".emptyFolderPlaceholder") continue;
      paths.push(`${projectId}/${item.name}`);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return paths;
}

/** Delete a batch of storage paths from a bucket. */
async function deleteStorageBatch(bucket, paths) {
  if (paths.length === 0) return { deleted: 0, error: null };
  // remove() accepts up to ~100 paths per call. Chunk to be safe.
  let deleted = 0;
  for (let i = 0; i < paths.length; i += 50) {
    const chunk = paths.slice(i, i + 50);
    const { data, error } = await sb.storage.from(bucket).remove(chunk);
    if (error) return { deleted, error: error.message };
    deleted += data?.length ?? 0;
  }
  return { deleted, error: null };
}

/** Delete one project's DB rows. Relies on FK cascades for generations,
 *  video_generation_jobs, autopost_schedules, etc. If the schema doesn't
 *  cascade, this will fail loudly and we surface the error. */
async function deleteProjectRow(projectId) {
  const { error } = await sb.from("projects").delete().eq("id", projectId);
  if (error) throw new Error(`deleteProjectRow(${projectId}) failed: ${error.message}`);
}

// ── Main ────────────────────────────────────────────────────────────
console.log(ANSI.bold("\n=== motionmax: bulk user-project cleanup ===\n"));
console.log(`Mode:     ${EXECUTE ? ANSI.red("EXECUTE (irreversible)") : ANSI.yellow("DRY-RUN (no mutations)")}`);
console.log(`Cutoff:   delete projects created BEFORE ${CUTOFF_ISO}`);
console.log(`Buckets:  ${BUCKETS.join(", ")}\n`);

const users = [];
for (const target of TARGET_USERS) {
  process.stdout.write(`Resolving ${target.hint}... `);
  const u = await findUser(target.usernameOrEmail);
  if (!u) {
    console.log(ANSI.red("NOT FOUND"));
    console.log(`  Searched for: "${target.usernameOrEmail}" in profiles.username + auth.users.email`);
    console.log(ANSI.red("Aborting — won't proceed if any target is unresolved.\n"));
    process.exit(2);
  }
  console.log(ANSI.green(`OK`) + ` ${u.id} <${u.email}> (@${u.username})`);
  users.push({ ...u, hint: target.hint });
}

let totalProjects = 0;
let totalStorageFiles = 0;
const allDeletions = []; // [{ user, project, storage: { bucket, paths }[] }]

for (const u of users) {
  console.log(ANSI.bold(`\n── ${u.hint} (${u.id}) ──`));
  const projects = await listProjects(u.id);
  if (projects.length === 0) {
    console.log(ANSI.dim(`  No projects before cutoff.`));
    continue;
  }
  console.log(`  ${projects.length} project(s) to delete:\n`);

  for (const p of projects) {
    const storageByBucket = [];
    let pStorageCount = 0;
    for (const bucket of BUCKETS) {
      const paths = await listStoragePaths(bucket, p.id);
      if (paths.length > 0) {
        storageByBucket.push({ bucket, paths });
        pStorageCount += paths.length;
      }
    }
    console.log(
      `    ${ANSI.dim(p.id)}  ${p.created_at.slice(0, 10)}  ` +
      `[${p.project_type}]  ${(p.title ?? "(untitled)").slice(0, 60)}  ` +
      ANSI.yellow(`${pStorageCount} files`),
    );
    for (const sb of storageByBucket) {
      console.log(ANSI.dim(`        ${sb.bucket}: ${sb.paths.length} file(s)`));
    }
    allDeletions.push({ user: u, project: p, storage: storageByBucket });
    totalProjects++;
    totalStorageFiles += pStorageCount;
  }
}

console.log(ANSI.bold(`\n── Summary ──`));
console.log(`  Total projects:     ${totalProjects}`);
console.log(`  Total storage files: ${totalStorageFiles}`);

if (!EXECUTE) {
  console.log(ANSI.yellow(`\nDRY-RUN complete. No changes made.`));
  console.log(`To actually delete, re-run with: ${ANSI.bold("--execute")}\n`);
  process.exit(0);
}

console.log(ANSI.red(`\nProceeding with deletion in 3 seconds... (Ctrl-C to abort)\n`));
await new Promise((r) => setTimeout(r, 3000));

let okStorage = 0, errStorage = 0, okProjects = 0, errProjects = 0;
for (const { user, project, storage } of allDeletions) {
  // 1. Delete storage objects across all buckets that have files
  for (const { bucket, paths } of storage) {
    const { deleted, error } = await deleteStorageBatch(bucket, paths);
    if (error) {
      console.log(ANSI.red(`  storage:${bucket}/${project.id} failed (${deleted}/${paths.length} done): ${error}`));
      errStorage += paths.length - deleted;
      okStorage += deleted;
    } else {
      console.log(ANSI.green(`  storage:${bucket}/${project.id} deleted ${deleted} file(s)`));
      okStorage += deleted;
    }
  }
  // 2. Delete project row (cascades to generations + jobs + schedules)
  try {
    await deleteProjectRow(project.id);
    console.log(ANSI.green(`  db:projects/${project.id} deleted`));
    okProjects++;
  } catch (err) {
    console.log(ANSI.red(`  db:projects/${project.id} FAILED: ${err.message}`));
    errProjects++;
  }
}

console.log(ANSI.bold(`\n── Done ──`));
console.log(`  Storage files deleted: ${okStorage}` + (errStorage ? ANSI.red(` (${errStorage} failed)`) : ""));
console.log(`  Project rows deleted:  ${okProjects}` + (errProjects ? ANSI.red(` (${errProjects} failed)`) : ""));
console.log("");
