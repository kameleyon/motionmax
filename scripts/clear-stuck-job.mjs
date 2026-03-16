import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { join } from "path";

try { dotenv.config({ path: join(process.cwd(), ".env") }); } catch {}
try { dotenv.config({ path: join(process.cwd(), "..", ".env") }); } catch {}

const sb = createClient(
  "https://ayjbvcikuwknqdrpsdmj.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Clear all stuck/failing export jobs
const { data: exportJobs } = await sb
  .from("video_generation_jobs")
  .update({
    status: "failed",
    error_message: "Manually cleared — export job crashing worker on FFmpeg step",
    updated_at: new Date().toISOString(),
  })
  .eq("task_type", "export_video")
  .in("status", ["pending", "processing"])
  .select("id, task_type, status");

console.log(`✅ Cleared ${exportJobs?.length ?? 0} export job(s):`);
exportJobs?.forEach(j => console.log(`  ${j.id} → failed`));

// Also clear any other stale processing jobs (>20 min)
const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
const { data: stale } = await sb
  .from("video_generation_jobs")
  .update({
    status: "failed",
    error_message: "Auto-cleared — stuck in processing for >20 minutes",
    updated_at: new Date().toISOString(),
  })
  .eq("status", "processing")
  .lt("updated_at", twentyMinAgo)
  .select("id, task_type");

if (stale && stale.length > 0) {
  console.log(`✅ Also cleared ${stale.length} stale processing job(s):`, stale.map(r => r.id));
}
