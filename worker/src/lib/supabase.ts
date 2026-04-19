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
// service_role is REQUIRED — worker must bypass RLS. Missing or wrong-project key → exit(1).
function keyBelongsToProject(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    return payload.ref === EXPECTED_PROJECT_REF;
  } catch {
    return false;
  }
}

function resolveKey(): string {
  const srvKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (srvKey && keyBelongsToProject(srvKey)) {
    return srvKey;
  }

  if (srvKey) {
    console.error("[Worker] 🔴 SUPABASE_SERVICE_ROLE_KEY belongs to a different project!");
    console.error(`[Worker] 🔴 Expected project ref: ${EXPECTED_PROJECT_REF}`);
  } else {
    console.error("[Worker] 🔴 SUPABASE_SERVICE_ROLE_KEY is not set!");
  }
  console.error("[Worker] 🔴 The worker REQUIRES service_role to bypass RLS. Exiting.");
  process.exit(1);
  throw new Error("unreachable"); // satisfies TypeScript's return-type check
}

const supabaseKey = resolveKey();

console.log(`[Worker] Supabase URL: ${supabaseUrl}`);
console.log(`[Worker] Supabase key: service_role (env)`);

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/** Validated Supabase URL — always points to the correct project. */
export const WORKER_SUPABASE_URL = supabaseUrl;