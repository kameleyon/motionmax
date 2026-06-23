/**
 * Fleet-wide Hypereal concurrency limiter (C-8-1 / Crash CRASH-002).
 *
 * Per-instance limiters (the acquireHypereal pattern in
 * services/imageGenerator.ts, the OpenRouter cap in services/openrouter.ts)
 * only coordinate inside one Node process. With 8 worker replicas on
 * Render, 8 × 10 = up to 80 concurrent Hypereal submissions on a single
 * API key — well past the per-key budget (~10–15 concurrent before
 * cascading 429s).
 *
 * This module is a fleet-wide token bucket backed by the Postgres table
 * `hypereal_concurrency_slots` (one row = one slot, NULL worker_id =
 * free). Acquire UPDATEs the first free row to worker_id=$1 and returns
 * its id; release NULLs it back. The cap is the row count in that table
 * — operators can re-cap by INSERT/DELETE without a code redeploy.
 *
 * Reaper:
 *   Any slot held >5 min is forcibly released — the holder is presumed
 *   dead (SIGTERM mid-POST, OOM, network partition). Worker entrypoint
 *   wires runHyperealSlotReaper() into the same cadence as the
 *   stale-claim reaper.
 *
 * Slot scope:
 *   Submissions only (POST /v1/images/generate, POST /v1/videos/generate).
 *   Status polls (GET /v1/jobs/{id}) do NOT take slots — they would
 *   starve submissions behind in-flight renders that already paid for
 *   their slot, and polls are cheap on the upstream rate limiter.
 */
import { supabase } from "./supabase.js";

const ACQUIRE_BACKOFF_MS = [200, 500, 1000, 2000, 4000];
const SLOT_HOLD_REAPER_MS = 5 * 60 * 1000; // 5 min — match audit spec

/** Lazily resolved worker identity. Provided by the entrypoint via
 * setHyperealSlotWorkerId(); falls back to a hostname/pid string if
 * the entrypoint hasn't called us yet (only happens in tests). */
let _workerId: string | null = null;
export function setHyperealSlotWorkerId(workerId: string): void {
  _workerId = workerId;
}
function currentWorkerId(): string {
  if (_workerId) return _workerId;
  // Test-time fallback — never used in prod because index.ts calls
  // setHyperealSlotWorkerId before any handler runs.
  return `unset-${process.pid}`;
}

/**
 * Try to claim a free slot. Returns the slot id on success or null if
 * the bucket is fully drained. Caller decides whether to wait and
 * retry (acquireSlot below) or fall through to its own backoff.
 */
async function tryClaimSlot(accountId?: string | null): Promise<number | null> {
  const workerId = currentWorkerId();
  // CTE pattern: pick the lowest free id, UPDATE it, return the id.
  // We use rpc-less raw SQL via the Supabase REST builder — picking the
  // row in a subquery + UPDATE ... WHERE id IN (subquery) is safe
  // against duplicate acquires because UPDATE takes a row lock and the
  // WHERE re-checks worker_id IS NULL. Two concurrent acquires racing
  // for the same id will see one succeed and the other return 0 rows.
  //
  // Supabase-js doesn't expose CTEs directly, so we do a 2-step "pick a
  // candidate then conditional UPDATE" which is functionally equivalent
  // with the WHERE worker_id IS NULL guard.
  const { data: candidates, error: selErr } = await supabase
    .from("hypereal_concurrency_slots")
    .select("id")
    .is("worker_id", null)
    .order("id", { ascending: true })
    .limit(1);

  if (selErr) {
    // If the table is missing (migration not yet applied), the caller
    // should NOT block — return a sentinel that we'll translate into
    // "slot system unavailable, proceed unthrottled" upstream. Logged
    // once-per-process to avoid spam.
    if (selErr.message?.includes("hypereal_concurrency_slots")) {
      logTableMissingOnce(selErr.message);
      return -1;
    }
    // Otherwise treat as transient — let caller back off.
    return null;
  }

  if (!candidates || candidates.length === 0) return null;

  const candidateId = (candidates[0] as { id: number }).id;
  // account_id is ATTRIBUTION only (who holds the slot) — never a second hard
  // cap. Threaded through so a HyperealSlotExhausted is attributable to the
  // tenant(s) monopolising the bucket. Nullable: legacy call sites omit it.
  const { data: claimed, error: updErr } = await supabase
    .from("hypereal_concurrency_slots")
    .update({ worker_id: workerId, acquired_at: new Date().toISOString(), account_id: accountId ?? null })
    .eq("id", candidateId)
    .is("worker_id", null) // CAS guard: only claim if still free
    .select("id");

  if (updErr) return null;
  if (!claimed || claimed.length === 0) return null; // lost the race
  return (claimed[0] as { id: number }).id;
}

let _tableMissingLogged = false;
function logTableMissingOnce(detail: string): void {
  if (_tableMissingLogged) return;
  _tableMissingLogged = true;
  console.warn(
    `[HyperealSlots] hypereal_concurrency_slots table missing — proceeding WITHOUT fleet-wide limiter. ` +
      `Apply migration 20260510250000_hypereal_concurrency_slots.sql to enable. Detail: ${detail.slice(0, 200)}`,
  );
}

/**
 * Acquire a Hypereal slot, blocking until one frees up or we hit the
 * backoff ceiling. Returns the slot id or -1 if the slot system is
 * unavailable (table missing → caller proceeds unthrottled, fail-open).
 *
 * Total wait ceiling: ~7.7s across 5 retries — past that the caller
 * better have transient-retry plumbing (every Hypereal call site does).
 */
export async function acquireHyperealSlot(accountId?: string | null): Promise<number> {
  for (let attempt = 0; attempt <= ACQUIRE_BACKOFF_MS.length; attempt++) {
    const id = await tryClaimSlot(accountId);
    if (id !== null) return id; // -1 (unavailable) or a real slot id
    if (attempt < ACQUIRE_BACKOFF_MS.length) {
      await new Promise((r) => setTimeout(r, ACQUIRE_BACKOFF_MS[attempt]));
    }
  }
  // Bucket fully drained for ~8s. Surface as a transient error so
  // withTransientRetry picks it up — never silently proceed (that's
  // exactly the C-8-1 incident). accountId is attached for attribution: it
  // tells operators WHICH tenant's submission hit the empty bucket.
  throw new Error(
    `Hypereal concurrency bucket exhausted (HyperealSlotExhausted) — all fleet-wide slots held` +
      (accountId ? ` (account=${accountId})` : ``),
  );
}

/**
 * Release a previously-acquired slot. Idempotent — calling with -1
 * (slot system was unavailable on acquire) is a no-op.
 *
 * Never throws — release failures are logged. A slot leaked here will
 * be reaped after 5 min by runHyperealSlotReaper().
 */
export async function releaseHyperealSlot(slotId: number): Promise<void> {
  if (slotId < 0) return; // fail-open sentinel from tryClaimSlot
  try {
    const { error } = await supabase
      .from("hypereal_concurrency_slots")
      .update({ worker_id: null, acquired_at: null, account_id: null })
      .eq("id", slotId);
    if (error) {
      console.warn(`[HyperealSlots] release slot=${slotId} failed: ${error.message} — will be reaped after ${SLOT_HOLD_REAPER_MS / 60000} min`);
    }
  } catch (err) {
    console.warn(`[HyperealSlots] release slot=${slotId} threw: ${(err as Error).message}`);
  }
}

/**
 * Reaper. Releases any slot whose acquired_at is older than the hold
 * window — the holder is presumed dead (SIGTERM mid-POST, OOM, network
 * partition). Called by the worker entrypoint on the same cadence as
 * the stale-claim reaper.
 *
 * Never throws — logged-only.
 */
export async function runHyperealSlotReaper(): Promise<void> {
  const cutoff = new Date(Date.now() - SLOT_HOLD_REAPER_MS).toISOString();
  try {
    const { data: freed, error } = await supabase
      .from("hypereal_concurrency_slots")
      .update({ worker_id: null, acquired_at: null, account_id: null })
      .lt("acquired_at", cutoff)
      .not("worker_id", "is", null)
      .select("id, worker_id");
    if (error) {
      // Table missing → silent (we already warned once in tryClaimSlot).
      if (!error.message?.includes("hypereal_concurrency_slots")) {
        console.warn(`[HyperealSlots] reaper failed: ${error.message}`);
      }
      return;
    }
    if (freed && freed.length > 0) {
      const holders = (freed as Array<{ worker_id: string }>).map((r) => r.worker_id);
      console.warn(
        `[HyperealSlots] reaped ${freed.length} stale slot(s) ` +
          `(held >${SLOT_HOLD_REAPER_MS / 60000} min; holders: ${[...new Set(holders)].slice(0, 4).join(", ")}${holders.length > 4 ? "…" : ""})`,
      );
    }
  } catch (err) {
    console.warn(`[HyperealSlots] reaper exception: ${(err as Error).message}`);
  }
}

/**
 * Acquire-run-release helper for the common case. The acquired slot is
 * guaranteed to be released even if `fn` throws.
 *
 * Usage:
 *   const result = await withHyperealSlot(async () => {
 *     return await fetch(url, opts);
 *   }, accountId);
 *
 * accountId is optional ATTRIBUTION (who holds the slot); omit it for legacy /
 * non-tenant submissions. It is NOT a second hard cap.
 */
export async function withHyperealSlot<T>(fn: () => Promise<T>, accountId?: string | null): Promise<T> {
  const slotId = await acquireHyperealSlot(accountId);
  try {
    return await fn();
  } finally {
    await releaseHyperealSlot(slotId);
  }
}
