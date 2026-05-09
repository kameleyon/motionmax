#!/usr/bin/env tsx
/**
 * Phase 19.3 — Console tab sustained-throughput test.
 *
 * The spec requires the admin Console tab to handle 100 logs/sec for
 * 60 s without dropping or freezing the UI. This script generates the
 * load by inserting synthetic system_logs rows at the target rate,
 * letting the operator open /admin?tab=console&live=1 in a browser
 * and observe whether the live tail keeps up.
 *
 * Run with:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/console-sustain-test.ts
 *
 * Cleanup: every row inserted carries `category = 'console_sustain_test'`
 * and a `details.test_run_id` UUID — see the cleanup query at the bottom.
 *
 * What "passes" looks like:
 *   • The Console tab keeps rendering new rows in real time (no
 *     visible freeze, no dropped rows).
 *   • Browser DevTools' Performance tab shows commit times under
 *     ~16ms during the run (60 fps).
 *   • RSS in the worker process doesn't grow unbounded.
 *
 * Failure modes to watch for:
 *   • The realtime channel falls behind; the live tail UI freezes.
 *   • Memory grows without bound (suggests buffer cap > 500 leak).
 *   • The browser tab pegs CPU.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

const RATE_PER_SECOND = Number(process.env.RATE || 100);
const DURATION_SEC = Number(process.env.DURATION || 60);
const TEST_RUN_ID = randomUUID();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const LEVELS = ["info", "ok", "warn", "error", "debug"] as const;

async function insertBatch(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    category: "console_sustain_test",
    event_type: `sustain_test_${i % 5}`,
    message: `synthetic load row ${Date.now()}_${i}`,
    level: LEVELS[i % LEVELS.length],
    details: { test_run_id: TEST_RUN_ID, seq: i },
  }));
  const { error } = await supabase.from("system_logs").insert(rows as never);
  if (error) console.warn(`[sustain] insert error: ${error.message}`);
}

async function main(): Promise<void> {
  console.log(`[sustain] test_run_id=${TEST_RUN_ID}`);
  console.log(`[sustain] target: ${RATE_PER_SECOND} logs/sec for ${DURATION_SEC}s = ${RATE_PER_SECOND * DURATION_SEC} rows total`);
  console.log(`[sustain] open /admin?tab=console&live=1 in a browser to observe`);
  console.log(`[sustain] starting in 3s...`);
  await new Promise((r) => setTimeout(r, 3000));

  const startedAt = Date.now();
  let inserted = 0;
  // Tick every 100ms inserting RATE/10 rows. Smaller tick = smoother
  // realtime broadcast distribution; bigger = less HTTP overhead.
  const ROWS_PER_TICK = Math.max(1, Math.floor(RATE_PER_SECOND / 10));
  const TICK_MS = 100;

  while (Date.now() - startedAt < DURATION_SEC * 1000) {
    const tickStart = Date.now();
    await insertBatch(ROWS_PER_TICK);
    inserted += ROWS_PER_TICK;
    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, TICK_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
    if (inserted % (RATE_PER_SECOND * 5) === 0) {
      const sec = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[sustain] ${sec}s — ${inserted} rows inserted`);
    }
  }

  console.log(`[sustain] done — ${inserted} rows inserted over ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`[sustain] cleanup: DELETE FROM public.system_logs WHERE category='console_sustain_test' AND details->>'test_run_id'='${TEST_RUN_ID}';`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
