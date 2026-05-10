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

// ── pgbouncer / pooler URL assertion (C-8-3 / Crash CRASH-004) ─────
//
// At launch load with 8 worker replicas, each opening direct Postgres
// connections to db.<ref>.supabase.co:5432, the hosted Supabase
// connection ceiling (~60 on the standard plan) is exhausted within a
// minute — UPDATEs queue, claim_pending_job RPCs time out, and the
// queue stalls. The transaction pooler at port 6543 multiplexes our
// many short-lived queries onto a small pool of upstream connections,
// which is what we actually want here.
//
// However the supabase-js HTTP client uses the REST URL
// (https://<ref>.supabase.co — the PostgREST gateway), NOT a raw
// libpq connection string. PostgREST itself is connection-pooled
// upstream by Supabase. So the connection-exhaustion risk applies to
// any direct libpq code path (PG_URL / DATABASE_URL / direct
// connection string) that the worker uses ALONGSIDE supabase-js — eg
// `pg`-based migrations, custom RPC clients, or future Postgres-LISTEN
// channels. We assert on those env vars here so an operator deploying
// with the direct (non-pooler) connection string in production sees a
// loud refusal at boot instead of a silent quota burn.
//
// What we DO NOT block:
//   * SUPABASE_URL — that's the REST URL, not a libpq DSN. Always
//     of the form https://<ref>.supabase.co/...
//   * Local dev (NODE_ENV !== 'production' AND no Railway/Render env
//     markers) — directly-connected dev is fine, you only have one
//     worker.
function assertPoolerUrl(envName: string, raw: string): void {
  // We only care about libpq-style URLs (postgres:// or postgresql://).
  // Anything else falls through.
  if (!/^postgres(ql)?:\/\//i.test(raw)) return;
  // The pooler host is `pooler.supabase.com` (regional, e.g.
  // aws-0-us-east-1.pooler.supabase.com:6543) — accept any subdomain.
  // Direct host pattern is `db.<ref>.supabase.co:5432`.
  const isPooler = /pooler\.supabase\.com/i.test(raw);
  if (isPooler) return; // good
  // Detect direct connection. Sanitize for logging — strip the
  // password and any obvious secrets.
  const sanitized = raw.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
  const isProd = process.env.NODE_ENV === "production"
    || !!process.env.RAILWAY_ENVIRONMENT
    || !!process.env.RENDER
    || !!process.env.RENDER_SERVICE_ID;
  if (isProd) {
    console.error(
      `[Worker] 🔴 ${envName} appears to be a DIRECT Supabase connection (port 5432) ` +
      `instead of the transaction pooler (pooler.supabase.com:6543). ` +
      `At launch load with multiple worker replicas this WILL exhaust the connection ` +
      `quota and stall the queue (C-8-3 / CRASH-004). ` +
      `Switch to the transaction-pool URL from Supabase Dashboard → Project Settings → ` +
      `Database → Connection Pooling → Transaction. ` +
      `Sanitized value: ${sanitized}`,
    );
    // Refuse to start. The fail-loud behaviour matches the project-ref
    // / service-role checks above — wrong DB plumbing is a launch
    // blocker, not a warning.
    process.exit(1);
  } else {
    console.warn(
      `[Worker] ⚠ ${envName} appears to be a direct Supabase connection (not pooler). ` +
      `Tolerated outside production; in production this is a fail-closed startup ` +
      `error (C-8-3 / CRASH-004). Sanitized: ${sanitized}`,
    );
  }
}

// Run the assertion against every libpq-style env var the worker might
// pick up. Adding a new one? Drop it into this list.
for (const envName of ["DATABASE_URL", "POSTGRES_URL", "PG_URL", "SUPABASE_DB_URL"]) {
  const raw = process.env[envName];
  if (raw) assertPoolerUrl(envName, raw);
}

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