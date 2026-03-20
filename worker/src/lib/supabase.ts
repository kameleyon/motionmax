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

/**
 * The public anon key for the canonical project.
 * This key is already embedded in the frontend (client-side code) so it is
 * not secret.  We use it as a last-resort fallback when the Render env vars
 * still reference the old project's credentials.
 */
const EXPECTED_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDE0MjMsImV4cCI6MjA4ODY3NzQyM30." +
  "KmOVtLzpzsZXjxyGEi6gxkd5U9Ir7omoCOxqnoN65YI";

// ── URL ────────────────────────────────────────────────────────────
const envUrl = process.env.SUPABASE_URL ?? "";
const urlMatchesProject = envUrl.includes(EXPECTED_PROJECT_REF);
const supabaseUrl = urlMatchesProject ? envUrl : EXPECTED_URL;

if (envUrl && !urlMatchesProject) {
  console.warn(
    `[Worker] ⚠️  SUPABASE_URL env var ("${envUrl}") does NOT match the expected project ref "${EXPECTED_PROJECT_REF}".`
  );
  console.warn(`[Worker] ⚠️  Overriding to ${EXPECTED_URL} — update your Render env vars!`);
}

// ── API Key ────────────────────────────────────────────────────────
// If the URL was overridden, the old project's keys won't work either.
// Prefer service_role → then env anon → then hardcoded anon for the
// correct project.
function keyBelongsToProject(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    return payload.ref === EXPECTED_PROJECT_REF;
  } catch {
    return false;
  }
}

function resolveKey(): { key: string; label: string } {
  const srvKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const envAnon = process.env.SUPABASE_ANON_KEY;

  // service_role key is REQUIRED — worker needs to bypass RLS
  if (srvKey && keyBelongsToProject(srvKey)) {
    return { key: srvKey, label: "service_role (env)" };
  }

  // service_role missing or wrong project — WARN loudly
  if (srvKey) {
    console.error("[Worker] 🔴 SUPABASE_SERVICE_ROLE_KEY belongs to a different project!");
    console.error(`[Worker] 🔴 Expected project ref: ${EXPECTED_PROJECT_REF}`);
  } else {
    console.error("[Worker] 🔴 SUPABASE_SERVICE_ROLE_KEY is not set!");
  }
  console.error("[Worker] 🔴 The worker REQUIRES service_role to bypass RLS.");
  console.error("[Worker] 🔴 Falling back to anon key — some operations may fail.");

  // Fallback to anon (degraded mode — will fail on RLS-protected tables)
  if (envAnon && keyBelongsToProject(envAnon)) {
    return { key: envAnon, label: "anon (env) ⚠️ DEGRADED" };
  }
  return { key: EXPECTED_ANON_KEY, label: "anon (hardcoded fallback) ⚠️ DEGRADED" };
}

const { key: supabaseKey, label: keyLabel } = resolveKey();

console.log(`[Worker] Supabase URL: ${supabaseUrl}`);
console.log(`[Worker] Supabase key: ${keyLabel}`);

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