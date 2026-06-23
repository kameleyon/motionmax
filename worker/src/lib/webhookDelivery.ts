/**
 * Customer webhook delivery (Phase 2).
 *
 * MotionMax delivers per-job customer webhooks on terminal transitions:
 *   - video.succeeded  (job reached status='completed')
 *   - video.failed     (job reached status='failed')
 *
 * The customer target is video_generation_jobs.callback_url, validated at
 * SUBMIT by checkWebhookUrl() (api/v1/_shared/moderation.ts): https-only, no
 * credentials, no literal IPs, no localhost/.local/metadata. That is the
 * first-hop check. This module is the SECOND line of defense at SEND time:
 * it re-resolves the URL host via DNS and rejects if ANY resolved A/AAAA
 * record is private/loopback/link-local/metadata, and uses redirect:'manual'
 * so a 3xx hop to an internal IP cannot bypass the first-hop check.
 *
 * Flow:
 *   1. enqueueWebhook() inserts a 'pending' webhook_deliveries row at the
 *      terminal write site in index.ts. Payload + signature are computed at
 *      ENQUEUE time so the signed bytes are immutable across retries (the
 *      customer's HMAC verification must match exactly what was signed, and
 *      re-signing per attempt would drift if the payload builder ever changes).
 *   2. deliverPendingWebhooks() (a sweep, wired on the worker's reaper cadence)
 *      claims due rows, dispatches each via deliverWebhook(), and records the
 *      outcome with exponential-backoff retry until max_attempts.
 *
 * Signature header: X-MotionMax-Signature: sha256=<hex hmac of the raw body>.
 * The HMAC key is the per-account accounts.webhook_secret.
 */

import { createHmac } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { SupabaseClient } from "@supabase/supabase-js";

import { retryDelayMs } from "./retryClassifier.js";
import { wlog } from "./workerLogger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** Abort a single webhook POST after this long. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Rows claimed + delivered per deliverPendingWebhooks() pass. */
const DEFAULT_SWEEP_LIMIT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WebhookEvent = "video.succeeded" | "video.failed";

/**
 * The terminal result shape the worker already has on hand. Fields MIRROR
 * api/v1 VideoResult so the webhook `data` block matches GET /videos/{id}.
 * Everything is optional/nullable so the caller can pass whatever it has.
 */
export interface WebhookResult {
  status?: string | null;
  video_url?: string | null;
  duration_s?: number | null;
  thumbnail_url?: string | null;
  format?: string | null;
  error?: { code: string; message: string } | null;
}

/** Minimal job shape needed to build a webhook event. */
export interface WebhookJob {
  id: string;
  account_id?: string | null;
  callback_url?: string | null;
}

/** Public webhook payload — `data` mirrors api/v1 VideoResult. */
export interface WebhookEventPayload {
  id: string;
  type: WebhookEvent;
  created: number; // unix seconds
  data: {
    status: string | null;
    video_url: string | null;
    duration_s: number | null;
    thumbnail_url: string | null;
    format: string | null;
    error: { code: string; message: string } | null;
  };
}

/** One claimable webhook_deliveries row. */
export interface WebhookDeliveryRow {
  id: string;
  account_id: string | null;
  job_id: string | null;
  url: string;
  event: WebhookEvent;
  payload: WebhookEventPayload | null;
  signature: string | null;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  max_attempts: number;
}

export interface DeliveryOutcome {
  ok: boolean;
  code: number | null;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload + signature
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the public webhook payload. `data` mirrors the api/v1 VideoResult
 * fields so a customer receives the same shape they'd GET /videos/{id}.
 */
export function buildWebhookEvent(
  job: WebhookJob,
  event: WebhookEvent,
  result: WebhookResult | null | undefined,
): WebhookEventPayload {
  const r = result ?? {};
  return {
    id: job.id,
    type: event,
    created: Math.floor(Date.now() / 1000),
    data: {
      // Public enum derived from the event type — NEVER the raw internal status
      // token in the payload (which can be 'complete'/'generating'/etc.). Matches
      // the GET handler's mapInternalToPublicState output ('succeeded'/'failed').
      status: event === "video.succeeded" ? "succeeded" : "failed",
      video_url: r.video_url ?? null,
      duration_s: r.duration_s ?? null,
      thumbnail_url: r.thumbnail_url ?? null,
      format: r.format ?? null,
      error: r.error ?? null,
    },
  };
}

/** HMAC-SHA256 of `rawBody` keyed by `secret`, hex-encoded. */
export function signWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Stable JSON serialization used for BOTH signing and sending. */
function serializePayload(payload: WebhookEventPayload): string {
  return JSON.stringify(payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSRF — re-resolve at send time (the api/ isPrivateIp is Deno/Node-split and
// not importable here, so a small local copy lives here).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True if `ip` (a literal IPv4 or IPv6 string) is private/loopback/link-local/
 * metadata/reserved — i.e. must NOT be the target of a customer webhook.
 */
export function isPrivateIp(ip: string): boolean {
  let h = ip.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

  // IPv4-mapped IPv6 (::ffff:169.254.169.254) — unwrap and test as v4.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  if (h.includes(":")) {
    // IPv6
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    if (h.startsWith("fe80")) return true; // link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
    return false;
  }

  return isPrivateIpv4(h);
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true; // not a clean IPv4 literal → treat as unsafe
  const oct = m.slice(1).map((n) => Number(n));
  if (oct.some((n) => Number.isNaN(n) || n > 255)) return true;
  const [a, b] = oct;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Re-resolve the URL host and confirm EVERY resolved A/AAAA record is public.
 * Rejects on: non-https, embedded creds, literal-private host, DNS failure,
 * or ANY private resolved IP. Returns the resolved public IPs on success.
 */
async function assertPublicHost(
  rawUrl: string,
): Promise<{ ok: boolean; reason?: string; ip?: string; family?: 4 | 6 }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed webhook URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "webhook URL must use https" };
  if (u.username || u.password) return { ok: false, reason: "credentials in webhook URL" };

  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return { ok: false, reason: "missing host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { ok: false, reason: "loopback host" };
  }
  if (host === "metadata.google.internal") return { ok: false, reason: "metadata host" };

  // Literal-IP host: classify directly, never DNS-resolve.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    if (isPrivateIp(host)) return { ok: false, reason: "private/loopback/metadata IP" };
    return { ok: false, reason: "literal IP not allowed (use a hostname)" };
  }

  // Hostname: resolve A + AAAA, reject if ANY record is private.
  let v4: string[] = [];
  let v6: string[] = [];
  try {
    v4 = await resolve4(host);
  } catch {
    /* no A records — fall through; AAAA may still exist */
  }
  try {
    v6 = await resolve6(host);
  } catch {
    /* no AAAA records */
  }

  const all = [...v4, ...v6];
  if (all.length === 0) return { ok: false, reason: `host "${host}" did not resolve` };
  for (const ip of all) {
    if (isPrivateIp(ip)) {
      return { ok: false, reason: `host "${host}" resolves to private IP ${ip}` };
    }
  }
  // Pin the FIRST validated public IP. deliverWebhook forces the connection to
  // this exact IP (preserving SNI=host) so fetch/connect cannot re-resolve to a
  // rebound private address between here and the socket connect (TOCTOU).
  const pinned = v4[0] ?? v6[0];
  const family: 4 | 6 = v4[0] ? 4 : 6;
  return { ok: true, ip: pinned, family };
}

/**
 * POST `body` to `rawUrl` but force the TCP connection to the pre-validated
 * `ip` (closing the DNS-rebind window), while keeping SNI + cert validation
 * bound to the URL hostname. Built on node:https so there is no undici/external
 * dependency. Redirects are NOT followed (a 3xx surfaces as its status code and
 * is treated as a non-2xx failure by the caller).
 */
function postPinned(
  rawUrl: string,
  ip: string,
  family: 4 | 6,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      resolve({ code: null, error: "malformed webhook URL" });
      return;
    }
    let settled = false;
    const done = (r: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const req = httpsRequest(
        {
          protocol: "https:",
          hostname: u.hostname,
          servername: u.hostname, // SNI + cert validation bound to the hostname
          port: u.port ? Number(u.port) : 443,
          path: `${u.pathname}${u.search}`,
          method: "POST",
          headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
          timeout: timeoutMs,
          // Force resolution to the pre-validated IP only — defeats rebinding.
          lookup: (_hostname, _opts, cb) =>
            (cb as (e: Error | null, a: string, f: number) => void)(null, ip, family),
        },
        (res) => {
          res.resume(); // drain; we never follow redirects or read the body
          done({ code: res.statusCode ?? null });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) =>
        done({ code: null, error: err instanceof Error ? err.message : String(err) }),
      );
      req.write(body);
      req.end();
    } catch (err) {
      done({ code: null, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Enqueue
// ─────────────────────────────────────────────────────────────────────────────

export interface EnqueueWebhookArgs {
  accountId: string | null | undefined;
  jobId: string;
  callbackUrl: string | null | undefined;
  event: WebhookEvent;
  result: WebhookResult | null | undefined;
}

/**
 * Insert a 'pending' webhook_deliveries row. Payload + signature are computed
 * NOW so the signed bytes are stable across delivery retries. Best-effort:
 * never throws — a failed enqueue is logged and the terminal job write
 * proceeds regardless (the webhook is a side channel, not the source of truth).
 *
 * No-op (returns null) when there is no callback_url to deliver to.
 */
export async function enqueueWebhook(
  supabase: SupabaseClient,
  args: EnqueueWebhookArgs,
): Promise<string | null> {
  const { accountId, jobId, callbackUrl, event, result } = args;
  if (!callbackUrl || callbackUrl.trim() === "") return null;

  try {
    const payload = buildWebhookEvent(
      { id: jobId, account_id: accountId ?? null, callback_url: callbackUrl },
      event,
      result,
    );
    const rawBody = serializePayload(payload);

    // Load the account secret to pre-sign. If unavailable, store payload
    // unsigned; deliverWebhook will (re)load + sign at send time as a fallback.
    let signature: string | null = null;
    const secret = await loadAccountSecret(supabase, accountId ?? null);
    if (secret) signature = signWebhook(secret, rawBody);

    const { data, error } = await supabase
      .from("webhook_deliveries")
      .insert({
        account_id: accountId ?? null,
        job_id: jobId,
        url: callbackUrl,
        event,
        payload,
        signature,
        status: "pending",
      })
      .select("id")
      .single();

    if (error) {
      wlog.warn("enqueueWebhook insert failed", { jobId, event, error: error.message });
      return null;
    }
    const id = (data as { id: string } | null)?.id ?? null;
    wlog.info("webhook enqueued", { jobId, event, deliveryId: id });
    return id;
  } catch (err) {
    wlog.warn("enqueueWebhook threw", {
      jobId,
      event,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Load accounts.webhook_secret for an account. Returns null on miss/error. */
async function loadAccountSecret(
  supabase: SupabaseClient,
  accountId: string | null,
): Promise<string | null> {
  if (!accountId) return null;
  try {
    const { data, error } = await supabase
      .from("accounts")
      .select("webhook_secret")
      .eq("id", accountId)
      .single();
    if (error) {
      wlog.warn("loadAccountSecret failed", { accountId, error: error.message });
      return null;
    }
    const secret = (data as { webhook_secret?: string } | null)?.webhook_secret;
    return secret && secret.length > 0 ? secret : null;
  } catch (err) {
    wlog.warn("loadAccountSecret threw", {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SSRF-safe single dispatch. Re-resolves the host (reject if ANY resolved IP
 * is private), fetches with redirect:'manual' (3xx treated as failure — never
 * followed), and a 10s AbortController timeout. Success = HTTP 2xx.
 *
 * If `row.signature` is absent (secret was missing at enqueue), `secret` is
 * used to sign the stored payload at send time. Returns {ok, code, error}.
 */
export async function deliverWebhook(
  row: WebhookDeliveryRow,
  secret: string | null,
): Promise<DeliveryOutcome> {
  // 1) SSRF re-resolution — fail closed. Returns the pinned public IP we will
  //    force the connection to (no second, rebind-able resolution).
  const ssrf = await assertPublicHost(row.url);
  if (!ssrf.ok || !ssrf.ip || !ssrf.family) {
    return { ok: false, code: null, error: `ssrf_rejected: ${ssrf.reason ?? "no public IP"}` };
  }

  // 2) Reconstruct the exact signed bytes. We sign/serialize the STORED
  //    payload so the signature always matches the bytes we POST.
  if (!row.payload) {
    return { ok: false, code: null, error: "missing payload" };
  }
  const rawBody = serializePayload(row.payload);
  let signature = row.signature;
  if (!signature && secret) signature = signWebhook(secret, rawBody);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "MotionMax-Webhooks/1",
    "X-MotionMax-Event": row.event,
    "X-MotionMax-Delivery": row.id,
  };
  if (signature) headers["X-MotionMax-Signature"] = `sha256=${signature}`;

  // POST to the pinned IP (SNI/cert bound to the hostname). Redirects are not
  // followed; a 3xx is a non-2xx failure.
  const res = await postPinned(
    row.url,
    ssrf.ip,
    ssrf.family,
    rawBody,
    headers,
    WEBHOOK_TIMEOUT_MS,
  );
  if (res.code !== null && res.code >= 200 && res.code < 300) {
    return { ok: true, code: res.code };
  }
  return {
    ok: false,
    code: res.code,
    error: res.error ?? `non-2xx status ${res.code}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claim due webhook rows (status pending/delivering AND next_attempt_at<=now),
 * deliver each, and record the outcome:
 *   - success            → status='delivered', delivered_at=now, response_code set
 *   - failure (retries)  → attempts++, next_attempt_at=now()+retryDelayMs(attempts)
 *   - failure (exhausted)→ status='failed' when attempts>=max_attempts
 *
 * Claiming flips the row to 'delivering' first (best-effort soft lock) so
 * overlapping sweeps don't double-deliver. Never throws — logged-only.
 * Returns the number of rows it attempted.
 */
export async function deliverPendingWebhooks(
  supabase: SupabaseClient,
  limit: number = DEFAULT_SWEEP_LIMIT,
): Promise<number> {
  // Atomic, cross-replica-exclusive claim (claim_webhook_deliveries, migration
  // 20260524000600): FOR UPDATE SKIP LOCKED + lease + attempts++ at claim time.
  // The returned rows are already flipped to 'delivering' with attempts
  // incremented — no second soft-lock, no double-delivery across replicas.
  let rows: WebhookDeliveryRow[] = [];
  try {
    const { data, error } = await supabase.rpc("claim_webhook_deliveries", {
      p_limit: limit,
    });
    if (error) {
      // Tolerate the table/function not existing yet (pre-migration) silently.
      if (
        !error.message?.includes("claim_webhook_deliveries") &&
        !error.message?.includes("webhook_deliveries")
      ) {
        wlog.warn("deliverPendingWebhooks claim RPC failed", { error: error.message });
      }
      return 0;
    }
    rows = (data ?? []) as WebhookDeliveryRow[];
  } catch (err) {
    wlog.warn("deliverPendingWebhooks claim threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (rows.length === 0) return 0;

  let attempted = 0;
  for (const row of rows) {
    attempted++;
    const secret = await loadAccountSecret(supabase, row.account_id);
    const outcome = await deliverWebhook(row, secret);
    // attempts was already incremented by the claim RPC — use it as-is.
    const attemptsNow = row.attempts;

    if (outcome.ok) {
      await recordResult(supabase, row.id, {
        status: "delivered",
        attempts: attemptsNow,
        response_code: outcome.code,
        last_error: null,
        delivered_at: new Date().toISOString(),
      });
      wlog.info("webhook delivered", {
        deliveryId: row.id,
        jobId: row.job_id,
        event: row.event,
        code: outcome.code,
        attempts: attemptsNow,
      });
    } else {
      const exhausted = attemptsNow >= row.max_attempts;
      const next = new Date(Date.now() + retryDelayMs(attemptsNow)).toISOString();
      await recordResult(supabase, row.id, {
        status: exhausted ? "failed" : "pending",
        attempts: attemptsNow,
        response_code: outcome.code,
        last_error: outcome.error ?? "delivery failed",
        next_attempt_at: exhausted ? undefined : next,
      });
      wlog[exhausted ? "warn" : "info"]("webhook delivery failed", {
        deliveryId: row.id,
        jobId: row.job_id,
        event: row.event,
        code: outcome.code,
        attempts: attemptsNow,
        maxAttempts: row.max_attempts,
        exhausted,
        error: outcome.error,
      });
    }
  }

  return attempted;
}

/** Patch a delivery row with the post-attempt state. Never throws. */
async function recordResult(
  supabase: SupabaseClient,
  id: string,
  patch: {
    status: "delivered" | "failed" | "pending";
    attempts: number;
    response_code: number | null;
    last_error: string | null;
    next_attempt_at?: string;
    delivered_at?: string;
  },
): Promise<void> {
  try {
    const update: Record<string, unknown> = {
      status: patch.status,
      attempts: patch.attempts,
      response_code: patch.response_code,
      last_error: patch.last_error,
    };
    if (patch.next_attempt_at !== undefined) update.next_attempt_at = patch.next_attempt_at;
    if (patch.delivered_at !== undefined) update.delivered_at = patch.delivered_at;

    const { error } = await supabase.from("webhook_deliveries").update(update).eq("id", id);
    if (error) {
      wlog.warn("webhook recordResult failed", { deliveryId: id, error: error.message });
    }
  } catch (err) {
    wlog.warn("webhook recordResult threw", {
      deliveryId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
