import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

/**
 * The canonical Supabase project reference.
 * This MUST match the frontend's hardcoded reference in
 * src/integrations/supabase/client.ts and src/lib/supabaseUrl.ts.
 * If the env var points elsewhere the worker silently queries the
 * wrong database and never finds any jobs.
 */
const EXPECTED_PROJECT_REF = "ayjbvcikuwknqdrpsdmj";
const EXPECTED_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;

const envUrl = process.env.SUPABASE_URL ?? "";

// Validate — only honour env var if it targets the correct project
const supabaseUrl = envUrl.includes(EXPECTED_PROJECT_REF) ? envUrl : EXPECTED_URL;

if (envUrl && !envUrl.includes(EXPECTED_PROJECT_REF)) {
  console.warn(
    `[Worker] ⚠️  SUPABASE_URL env var ("${envUrl}") does NOT match the expected project ref "${EXPECTED_PROJECT_REF}".`
  );
  console.warn(`[Worker] ⚠️  Overriding to ${EXPECTED_URL} — update your Render env vars!`);
}

// Prefer service_role key; fall back to anon key for Lovable-managed projects
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY environment variable.");
  process.exit(1);
}

const isServiceRole = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log(`[Worker] Supabase URL: ${supabaseUrl}`);
console.log(`[Worker] Supabase client initialized with ${isServiceRole ? "service_role" : "anon"} key`);

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/** Validated Supabase URL — always points to the correct project. */
export const WORKER_SUPABASE_URL = supabaseUrl;

/** The active API key (service_role or anon). */
export const WORKER_SUPABASE_KEY = supabaseKey;