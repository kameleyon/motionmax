import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env from parent (workspace root) or current dir
try { dotenv.config({ path: join(process.cwd(), ".env") }); } catch {}
try { dotenv.config({ path: join(process.cwd(), "..", ".env") }); } catch {}

const url = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!key) { console.error("No key found"); process.exit(1); }

const supabase = createClient(url, key);

const STUCK_JOB_ID = "25be55d7-ef26-479d-b654-b3afe4e182db";

const { data, error } = await supabase
  .from("video_generation_jobs")
  .update({
    status: "failed",
    error_message: "Manually cleared — stuck in processing (export loop on restart)",
    updated_at: new Date().toISOString(),
  })
  .eq("id", STUCK_JOB_ID)
  .select("id, status, task_type, updated_at");

if (error) {
  console.error("Failed:", error.message);
} else {
  console.log("✅ Cleared:", data);
}

// Also clear ALL export_video jobs stuck in processing > 20 min
const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
const { data: stale, error: staleErr } = await supabase
  .from("video_generation_jobs")
  .update({
    status: "failed",
    error_message: "Auto-cleared — stuck in processing for >20 minutes",
    updated_at: new Date().toISOString(),
  })
  .eq("status", "processing")
  .lt("updated_at", twentyMinAgo)
  .select("id, task_type, updated_at");

if (staleErr) {
  console.error("Stale clear failed:", staleErr.message);
} else if (stale && stale.length > 0) {
  console.log(`✅ Cleared ${stale.length} additional stale job(s):`, stale.map(r => r.id));
} else {
  console.log("No other stale jobs found.");
}
