import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

/**
 * The canonical Supabase project reference.
 *
 * Sourced (in order) from:
 *   1. SUPABASE_PROJECT_REF (preferred — staging/prod swappable)
 *   2. The ref encoded in SUPABASE_URL (parsed as a fallback)
 *   3. The hard-coded production ref (final safety net so an
 *      operator who only set SUPABASE_SERVICE_ROLE_KEY still
 *      lands on the prod project rather than failing loudly)
 *
 * If you want to point the worker at staging, set BOTH
 * SUPABASE_PROJECT_REF and SUPABASE_URL to the staging values.
 * The boot-time check below will refuse to start if they
 * disagree.
 */
const PRODUCTION_PROJECT_REF_FALLBACK = "ayjbvcikuwknqdrpsdmj";

function refFromUrl(url: string): string | null {
  // https://<ref>.supabase.co
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

const envRef = process.env.SUPABASE_PROJECT_REF?.trim() || refFromUrl(process.env.SUPABASE_URL ?? "");
const EXPECTED_PROJECT_REF = envRef || PRODUCTION_PROJECT_REF_FALLBACK;

if (!envRef) {
  console.warn(
    `[Worker] ⚠ Neither SUPABASE_PROJECT_REF nor a parseable SUPABASE_URL was provided. ` +
      `Falling back to the hard-coded production ref "${PRODUCTION_PROJECT_REF_FALLBACK}". ` +
      `Set SUPABASE_PROJECT_REF explicitly in non-prod environments.`
  );
}

const EXPECTED_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;

// ── URL ────────────────────────────────────────────────────────────
const envUrl = process.env.SUPABASE_URL ?? "";
const urlMatchesProject = envUrl.includes(EXPECTED_PROJECT_REF);

if (envUrl && !urlMatchesProject) {
  console.error(
    `[Worker] 🔴 SUPABASE_URL env var ("${envUrl}") does NOT match the expected project ref "${EXPECTED_PROJECT_REF}".`
  );
  console.error(`[Worker] 🔴 Connecting to the wrong Supabase project will cause all job queries to fail. Exiting.`);
  process.exit(1);
}

// If SUPABASE_URL is unset/empty, fall back to the hardcoded canonical URL.
const supabaseUrl = envUrl || EXPECTED_URL;

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

/** Resolved service_role key — always belongs to the correct project. */
export const WORKER_SUPABASE_KEY = supabaseKey;