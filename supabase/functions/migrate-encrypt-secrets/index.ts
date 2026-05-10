/**
 * One-shot migration: encrypt all plaintext secrets in
 *   - public.autopost_social_accounts (access_token, refresh_token)
 *   - public.user_api_keys           (gemini_api_key, replicate_api_token)
 *
 * ⚠️  RUN-ONCE INSTRUCTIONS  ⚠️
 *
 *  1. Deploy this function with `supabase functions deploy migrate-encrypt-secrets`.
 *  2. Set `ENCRYPTION_KEY_V1` (base64 of 32 random bytes) on the project.
 *     Example: `supabase secrets set ENCRYPTION_KEY_V1="$(openssl rand -base64 32)"`.
 *  3. Apply the matching migration `20260510130000_encrypt_oauth_and_api_keys.sql`
 *     which adds the CHECK constraints AS NOT VALID (so existing plaintext
 *     rows are not rejected during the backfill).
 *  4. Hit this endpoint exactly ONCE from an admin session:
 *
 *       curl -X POST -H "Authorization: Bearer <ADMIN_JWT>" \
 *            https://<project-ref>.supabase.co/functions/v1/migrate-encrypt-secrets
 *
 *     The response includes `{ rows_processed, errors }` per table.
 *  5. Once the response shows `errors == 0` and `rows_remaining == 0`,
 *     run the VALIDATE CONSTRAINT statements documented in the migration
 *     file's header so the table-level invariant is enforced for every
 *     existing row.
 *  6. DELETE this function (`supabase functions delete migrate-encrypt-secrets`)
 *     OR leave it in place but flip the `MIGRATION_DISABLED` env var to "true"
 *     so it returns 410 Gone.  Persistent reachable backfill endpoints are a
 *     standing-privilege risk.
 *
 * Auth model: requires a service-role JWT *or* an authenticated admin
 * (user_roles.role = 'admin').  The function itself runs with the service
 * role to bypass RLS during the bulk update.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { encryptSecret, looksEncrypted } from "../_shared/encryption.ts";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[MIGRATE-ENCRYPT-SECRETS] ${step}${detailsStr}`);
};

// Permanent kill-switch.  Set to "true" once the backfill is complete so
// the route returns 410 Gone without further code changes.
function isDisabled(): boolean {
  const v = Deno.env.get("MIGRATION_DISABLED");
  return typeof v === "string" && v.toLowerCase() === "true";
}

interface PerColumnReport {
  table: string;
  column: string;
  rows_processed: number;
  rows_remaining: number;
  errors: { id: string; message: string }[];
}

/**
 * Re-encrypt a single column on a single table for every row whose
 * column value does NOT match the encrypted regex (i.e. plaintext).
 *
 * The CHECK constraint added by 20260510130000_encrypt_oauth_and_api_keys.sql
 * accepts both `v1:` (this helper's output) and `v3:` (legacy
 * manage-api-keys output) prefixes, so anything matching `looksEncrypted`
 * OR `^v3:` is left alone.
 */
async function migrateColumn(
  supabase: ReturnType<typeof createClient>,
  table: string,
  column: string,
): Promise<PerColumnReport> {
  const report: PerColumnReport = {
    table,
    column,
    rows_processed: 0,
    rows_remaining: 0,
    errors: [],
  };

  // Page through plaintext rows in batches.  We deliberately do NOT use
  // a server-side regex filter here because Postgres' `~ '^v1:'` is
  // available but supabase-js's PostgREST shim doesn't expose it
  // ergonomically; pulling the values and filtering in code is simpler
  // and the row count is small (one row per user max).
  const PAGE_SIZE = 500;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(`id, ${column}`)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      report.errors.push({ id: "<query>", message: `select ${table}.${column}: ${error.message}` });
      return report;
    }
    if (!data || data.length === 0) break;

    for (const row of data as Array<Record<string, unknown>>) {
      const id = row["id"] as string;
      const raw = row[column];
      if (raw === null || raw === undefined) continue;
      if (typeof raw !== "string") continue;
      if (raw.length === 0) continue;
      // Already-encrypted values: skip.
      if (looksEncrypted(raw)) continue;
      if (/^v3:/.test(raw)) continue;

      // Plaintext row — encrypt and write back.
      try {
        const encrypted = await encryptSecret(raw);
        const { error: upErr } = await supabase
          .from(table)
          .update({ [column]: encrypted })
          .eq("id", id);
        if (upErr) {
          report.errors.push({ id, message: `update: ${upErr.message}` });
        } else {
          report.rows_processed += 1;
        }
      } catch (e) {
        report.errors.push({ id, message: (e as Error).message });
      }
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // Re-scan to count any rows we couldn't migrate (e.g. encrypt errors).
  const { data: remaining, error: remErr } = await supabase
    .from(table)
    .select(`id, ${column}`);
  if (remErr) {
    report.errors.push({ id: "<rescan>", message: remErr.message });
    return report;
  }
  for (const row of (remaining as Array<Record<string, unknown>>) ?? []) {
    const v = row[column];
    if (typeof v !== "string" || v.length === 0) continue;
    if (looksEncrypted(v)) continue;
    if (/^v3:/.test(v)) continue;
    report.rows_remaining += 1;
  }

  return report;
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  if (isDisabled()) {
    return new Response(
      JSON.stringify({ error: "migration disabled (MIGRATION_DISABLED=true)" }),
      { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 405,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({ error: "service role not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Auth: caller must present an admin JWT.  The function itself uses the
  // service role for the actual table writes (so it can bypass RLS), but
  // we MUST gate the route — otherwise any anon caller could re-trigger
  // a no-op rescan that leaks row counts.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // Reject the literal service-role key — that key SHOULD never travel
  // over the wire from a human operator.  Force the operator to log in
  // as an admin user and use their session JWT.
  if (token === supabaseServiceKey) {
    return new Response(
      JSON.stringify({ error: "Do not call this endpoint with the service-role key directly" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return new Response(
      JSON.stringify({ error: "Invalid session" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const callerUserId = userData.user.id;

  const { data: adminRole, error: adminErr } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .eq("role", "admin")
    .single();
  if (adminErr || !adminRole) {
    return new Response(
      JSON.stringify({ error: "admin only" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Sanity check the encryption key by performing a round-trip on a
  // throwaway value.  If the key is missing or wrong the helper module
  // will already have thrown at import time, but this catches subtle
  // misconfiguration (e.g. key rotated between the migration apply and
  // the function deploy).
  try {
    const probe = await encryptSecret("migrate-encrypt-secrets-probe");
    if (!looksEncrypted(probe)) throw new Error("probe did not produce v1: ciphertext");
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `encryption helper unhealthy: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  logStep("starting backfill", { callerUserId });

  const reports: PerColumnReport[] = [];
  reports.push(await migrateColumn(supabase, "autopost_social_accounts", "access_token"));
  reports.push(await migrateColumn(supabase, "autopost_social_accounts", "refresh_token"));
  reports.push(await migrateColumn(supabase, "user_api_keys", "gemini_api_key"));
  reports.push(await migrateColumn(supabase, "user_api_keys", "replicate_api_token"));

  const totalProcessed = reports.reduce((a, r) => a + r.rows_processed, 0);
  const totalRemaining = reports.reduce((a, r) => a + r.rows_remaining, 0);
  const totalErrors = reports.reduce((a, r) => a + r.errors.length, 0);

  logStep("done", { totalProcessed, totalRemaining, totalErrors });

  return new Response(
    JSON.stringify(
      {
        ok: totalErrors === 0,
        total: {
          rows_processed: totalProcessed,
          rows_remaining: totalRemaining,
          errors: totalErrors,
        },
        per_column: reports,
        next_step:
          totalRemaining === 0 && totalErrors === 0
            ? "Run the VALIDATE CONSTRAINT statements from 20260510130000_encrypt_oauth_and_api_keys.sql, then disable this function (MIGRATION_DISABLED=true) or delete it."
            : "Re-run after fixing reported errors. Do NOT validate constraints until rows_remaining == 0.",
      },
      null,
      2,
    ),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

Deno.serve(handler);
