// Weekly storage cleanup edge function.
//
// Scheduled by migration 20260515160000_monthly_intermediate_storage_cleanup.sql
// + 20260515170000_storage_cleanup_weekly.sql to fire every Sunday
// at 02:00 UTC.
//
// Two passes:
//
//   Pass A — INTERMEDIATE BUCKETS (scene-images, audio, scene-videos):
//     For every top-level folder under each bucket:
//       - If the folder name is a UUID and (it isn't a live project OR
//         the project's updated_at is older than 30 days) → recursively
//         delete every file under that folder.
//     This catches both age-based cleanup ("shipped + idle" projects)
//     AND orphans from earlier bulk-deletes whose storage half didn't
//     clean up. The buckets `scene-videos` and `videos` have a nested
//     layout (<projectId>/<generationId>/...) so recursion is mandatory
//     — the previous version of this function listed only one level
//     and silently dropped 37 GB of scene-videos files in May 2026.
//
//   Pass B — VIDEOS BUCKET (final exports):
//     For every file recursively under videos/:
//       - Extract any UUID from the path.
//       - Look up the parent project: by direct project_id match, or
//         by generation_id → project_id.
//       - If no parent project exists → DELETE (orphan).
//       - If parent project AND the file is older than 30 days AND
//         the project is older than 30 days → DELETE (composite
//         policy — abandoned project's old export).
//       - Otherwise → KEEP.
//     The final-export policy is stricter than the intermediate
//     policy because losing a final video means the user loses their
//     deliverable; both age gates must pass before we touch it.
//
// Auth:
//   pg_cron posts with the service-role key. Supabase's Edge gateway
//   verifies the JWT signature before invoking the function. We
//   additionally decode the payload and check `role === "service_role"`
//   so a leaked anon-key JWT can't trigger destruction.
//
// Time budget:
//   Edge functions cap at ~150s wall time on Supabase. We cap walks
//   at 20,000 files; beyond that we stop and rely on next week's run.
//   Empirically ~14k files takes ~60s.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const INTERMEDIATE_BUCKETS = ["scene-images", "audio", "scene-videos"] as const;
const VIDEOS_BUCKET = "videos" as const;
const PAGE = 1000;
const CUTOFF_DAYS = 30;
const MAX_FILES_PER_RUN = 20_000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface RunResult {
  pass_a_files_deleted: number;
  pass_a_folders_swept: number;
  pass_b_files_deleted: number;
  pass_b_files_kept: number;
  files_scanned: number;
  errors: string[];
  truncated: boolean;
}

Deno.serve(async (req: Request) => {
  // ── Auth gate ───────────────────────────────────────────────────
  // Decode the JWT payload (gateway already verified the signature).
  // Reject anything that isn't service_role so a leaked anon token
  // can't trigger destruction.
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const payload = decodeJwtPayload(auth.slice(7));
    if (payload?.role !== "service_role") {
      return new Response("forbidden", { status: 403 });
    }
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const cutoffMs = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  const result: RunResult = {
    pass_a_files_deleted: 0,
    pass_a_folders_swept: 0,
    pass_b_files_deleted: 0,
    pass_b_files_kept: 0,
    files_scanned: 0,
    errors: [],
    truncated: false,
  };

  // ── Load live project + generation maps ─────────────────────────
  const projectsMap = new Map<string, number>(); // id → updated_at ms
  const genToProject = new Map<string, string>();
  try {
    for await (const row of pageAll(supabase, "projects", "id, updated_at")) {
      projectsMap.set(row.id, new Date(row.updated_at).getTime());
    }
    for await (const row of pageAll(supabase, "generations", "id, project_id")) {
      if (row.project_id) genToProject.set(row.id, row.project_id);
    }
  } catch (e) {
    result.errors.push(`load_maps: ${e instanceof Error ? e.message : String(e)}`);
    await logRun(supabase, "system_error", result);
    return jsonResponse(result, 500);
  }

  // ── Pass A: intermediate buckets ────────────────────────────────
  for (const bucket of INTERMEDIATE_BUCKETS) {
    try {
      const folders = await listTopLevelFolders(supabase, bucket);
      for (const folderName of folders) {
        if (result.files_scanned >= MAX_FILES_PER_RUN) { result.truncated = true; break; }
        if (!UUID_FULL_RE.test(folderName)) continue; // skip non-UUID

        const projUpdated = projectsMap.get(folderName);
        const isOrphan = projUpdated === undefined;
        const isOldProject = projUpdated !== undefined && projUpdated < cutoffMs;
        if (!isOrphan && !isOldProject) continue; // active project — keep

        try {
          const { deleted, scanned } = await deleteAllUnderPrefix(supabase, bucket, folderName);
          result.pass_a_files_deleted += deleted;
          result.files_scanned += scanned;
          if (deleted > 0) result.pass_a_folders_swept++;
        } catch (e) {
          result.errors.push(`passA/${bucket}/${folderName}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      result.errors.push(`passA/${bucket}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (result.truncated) break;
  }

  // ── Pass B: videos bucket (composite policy) ────────────────────
  if (!result.truncated) {
    try {
      const toDelete: string[] = [];
      await walkAndClassify(supabase, VIDEOS_BUCKET, "", (path, entry) => {
        result.files_scanned++;
        if (result.files_scanned >= MAX_FILES_PER_RUN) { result.truncated = true; return false; }

        const fileTime = new Date(entry.updated_at ?? entry.created_at ?? Date.now()).getTime();
        const fileOldEnough = fileTime < cutoffMs;

        // Find parent project via any UUID in the path.
        const uuids = path.match(UUID_GLOBAL_RE) ?? [];
        let projectId: string | null = null;
        for (const u of uuids) {
          if (genToProject.has(u)) { projectId = genToProject.get(u)!; break; }
          if (projectsMap.has(u))  { projectId = u; break; }
        }
        if (!projectId) {
          // No live parent found — orphan or unattributable.
          if (uuids.length > 0) toDelete.push(path); // orphan with UUID → safe to delete
          else result.pass_b_files_kept++;            // flat legacy file → preserve
          return true;
        }
        const projUpdated = projectsMap.get(projectId);
        if (projUpdated === undefined) {
          toDelete.push(path); // gen's parent project was deleted → orphan
          return true;
        }
        const projIdleEnough = projUpdated < cutoffMs;
        if (fileOldEnough && projIdleEnough) toDelete.push(path);
        else result.pass_b_files_kept++;
        return true;
      });

      // Delete in 1000-path batches.
      for (let i = 0; i < toDelete.length; i += 1000) {
        const batch = toDelete.slice(i, i + 1000);
        const { error } = await supabase.storage.from(VIDEOS_BUCKET).remove(batch);
        if (error) result.errors.push(`passB/remove[${i}]: ${error.message}`);
        else result.pass_b_files_deleted += batch.length;
      }
    } catch (e) {
      result.errors.push(`passB: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await logRun(supabase, result.errors.length > 0 ? "system_warning" : "system_info", result);
  return jsonResponse(result, 200);
});

// ── helpers ──────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function* pageAll(
  supabase: ReturnType<typeof createClient>,
  table: string,
  cols: string,
): AsyncGenerator<Record<string, string>> {
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) yield r as Record<string, string>;
    if (data.length < PAGE) break;
    from += PAGE;
  }
}

async function listTopLevelFolders(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
): Promise<string[]> {
  const out: string[] = [];
  let off = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list("", {
      limit: PAGE, offset: off, sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`list root: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const e of data) out.push(e.name);
    if (data.length < PAGE) break;
    off += PAGE;
  }
  return out;
}

// Recursively walk + delete every file under `<bucket>/<prefix>/`.
// Returns { deleted, scanned } so the caller can attribute counts.
async function deleteAllUnderPrefix(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<{ deleted: number; scanned: number }> {
  let deleted = 0, scanned = 0;
  const paths: string[] = [];

  async function gather(p: string): Promise<void> {
    let off = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(bucket).list(p, {
        limit: PAGE, offset: off, sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`list ${p}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const e of data) {
        const child = `${p}/${e.name}`;
        // Sub-folders surface as entries with id=null + metadata=null.
        if (e.id === null && (e.metadata === null || e.metadata === undefined)) {
          await gather(child);
        } else {
          paths.push(child);
          scanned++;
        }
      }
      if (data.length < PAGE) break;
      off += PAGE;
    }
  }

  await gather(prefix);

  for (let i = 0; i < paths.length; i += 1000) {
    const batch = paths.slice(i, i + 1000);
    const { error } = await supabase.storage.from(bucket).remove(batch);
    if (error) throw new Error(`remove batch: ${error.message}`);
    deleted += batch.length;
  }
  return { deleted, scanned };
}

// Walk every file under bucket/prefix, calling visit(path, entry) for
// each leaf. Stops early if visit returns false.
async function walkAndClassify(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
  visit: (path: string, entry: {
    updated_at?: string | null;
    created_at?: string | null;
    metadata?: { size?: number } | null;
  }) => boolean,
): Promise<void> {
  let off = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: PAGE, offset: off, sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const e of data) {
      const child = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null && (e.metadata === null || e.metadata === undefined)) {
        await walkAndClassify(supabase, bucket, child, visit);
      } else {
        if (!visit(child, e)) return;
      }
    }
    if (data.length < PAGE) break;
    off += PAGE;
  }
}

async function logRun(
  supabase: ReturnType<typeof createClient>,
  category: "system_info" | "system_warning" | "system_error",
  details: RunResult,
): Promise<void> {
  await supabase.from("system_logs").insert({
    category,
    event_type: "cleanup_storage_run",
    message: `cleanup-intermediate-storage: pass_a_deleted=${details.pass_a_files_deleted} pass_b_deleted=${details.pass_b_files_deleted}${details.errors.length ? ` errors=${details.errors.length}` : ""}`,
    details,
  });
}
