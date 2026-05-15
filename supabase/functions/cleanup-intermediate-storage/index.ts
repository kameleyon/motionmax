// Monthly intermediate-asset storage cleanup edge function.
//
// Scheduled by migration 20260515160000_monthly_intermediate_storage_cleanup.sql
// to run on the 1st of every month at 02:00 UTC.
//
// What it deletes:
//   For every project where `projects.updated_at < NOW() - INTERVAL '30 days'`,
//   removes all files under `<bucket>/<project_id>/...` from the three
//   intermediate buckets: scene-images, audio, scene-videos.
//
// What it preserves:
//   The `videos/` bucket (final exported videos) is never touched.
//   Projects newer than 30 days are skipped entirely.
//
// Budget:
//   Edge functions cap at ~150s wall time on Supabase. We cap the
//   per-invocation project count at 500. If more projects qualify
//   they roll into next month's run; with growth that warrants
//   higher cadence, switch the cron to weekly or daily-with-batch.
//
// Auth:
//   pg_cron posts with the service-role key. The function verifies
//   the bearer header matches process.env.SUPABASE_SERVICE_ROLE_KEY
//   before doing any work, so an attacker who learns the URL still
//   can't trigger destruction.

// @deno-types removed: this file is invoked by the Supabase Edge
// runtime which uses Deno. The deno.json at supabase/functions/
// resolves these imports.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface CleanupResult {
  scanned_projects: number;
  cleaned_projects: number;
  files_deleted: number;
  errors: Array<{ project_id: string; bucket: string; error: string }>;
}

const INTERMEDIATE_BUCKETS = ["scene-images", "audio", "scene-videos"] as const;
const MAX_PROJECTS_PER_RUN = 500;

Deno.serve(async (req: Request) => {
  // Auth gate — service-role token from pg_cron.
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`;
  if (auth !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result: CleanupResult = {
    scanned_projects: 0,
    cleaned_projects: 0,
    files_deleted: 0,
    errors: [],
  };

  // Page through old projects. The CHECK on the WHERE clause +
  // `id`-as-tiebreaker keyset pagination avoids OFFSET (which gets
  // slow + can skip rows if new projects insert during the scan).
  const { data: projects, error: pErr } = await supabase
    .from("projects")
    .select("id, updated_at")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(MAX_PROJECTS_PER_RUN);

  if (pErr) {
    await logToSystem(supabase, "system_error", "cleanup_intermediate_storage_failed", {
      stage: "list_projects",
      error: pErr.message,
    });
    return new Response(JSON.stringify({ error: pErr.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  result.scanned_projects = projects?.length ?? 0;

  for (const project of projects ?? []) {
    let cleanedAny = false;
    for (const bucket of INTERMEDIATE_BUCKETS) {
      try {
        const deleted = await deleteAllUnderPrefix(supabase, bucket, project.id);
        result.files_deleted += deleted;
        if (deleted > 0) cleanedAny = true;
      } catch (e) {
        result.errors.push({
          project_id: project.id,
          bucket,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (cleanedAny) result.cleaned_projects++;
  }

  await logToSystem(supabase, "system_info", "cleanup_intermediate_storage_run", {
    cutoff,
    ...result,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// Recursively list + delete every object under `<bucket>/<prefix>/`.
// Supabase storage.list returns at most 100 names per call so we page
// until the list returns empty. Returns the total number of objects
// deleted (across all pages).
async function deleteAllUnderPrefix(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<number> {
  let totalDeleted = 0;
  const PAGE = 1000; // storage.list max

  for (;;) {
    const { data: entries, error: lErr } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, sortBy: { column: "name", order: "asc" } });
    if (lErr) throw new Error(`list failed: ${lErr.message}`);
    if (!entries || entries.length === 0) break;

    const paths = entries.map((e) => `${prefix}/${e.name}`);
    const { error: rmErr } = await supabase.storage.from(bucket).remove(paths);
    if (rmErr) throw new Error(`remove failed: ${rmErr.message}`);

    totalDeleted += paths.length;
    if (entries.length < PAGE) break; // last page
  }

  return totalDeleted;
}

async function logToSystem(
  supabase: ReturnType<typeof createClient>,
  category: "system_info" | "system_warning" | "system_error",
  eventType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await supabase.from("system_logs").insert({
    category,
    event_type: eventType,
    message: `cleanup-intermediate-storage: ${eventType}`,
    details,
  });
}
