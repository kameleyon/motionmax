import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
// Prefer service_role key; fall back to anon key for Lovable-managed projects
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY environment variables.");
  process.exit(1);
}

const isServiceRole = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log(`[Worker] Supabase client initialized with ${isServiceRole ? "service_role" : "anon"} key`);

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});