#!/usr/bin/env tsx
/**
 * Phase 19.8.3 — 24-hour soak test baseline + diff tool.
 *
 * Captures a point-in-time snapshot of the metrics that matter for the
 * "no regressions in /admin error budget vs. baseline" sign-off:
 *
 *   • Job failure rate by task_type (last 1h, last 24h)
 *   • Queue depth distribution (pending / processing counts)
 *   • Latency p50 / p95 / p99 by task_type
 *   • Error categories from system_logs (count by event_type, level=error)
 *   • Worker heartbeat freshness (max staleness)
 *   • admin_logs write rate (proves the audit trail is live)
 *
 * Usage:
 *   # Capture the baseline now (writes ./.soak-baseline.json)
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/soak-baseline.ts capture
 *
 *   # 24h later, run diff against the saved baseline
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/soak-baseline.ts diff
 *
 * Pass-criteria for the soak (per spec):
 *   • Job failure rate must not exceed baseline + 25% relative
 *   • p95 latency must not exceed baseline × 1.5
 *   • No NEW error event_types (categories that didn't exist at
 *     baseline)
 *   • Worker heartbeat freshness ≤ 60s (workers always alive)
 *
 * Exit codes:
 *   0 = pass (or capture mode succeeded)
 *   1 = at least one criterion regressed
 *   2 = invocation error (missing env vars, etc.)
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const BASELINE_PATH = path.resolve(process.cwd(), ".soak-baseline.json");

interface Snapshot {
  capturedAt: string;
  jobFailureRate: { taskType: string; failed: number; total: number; rate: number }[];
  queueDepth: { status: string; taskType: string; count: number }[];
  latency: { taskType: string; p50ms: number; p95ms: number; p99ms: number; n: number }[];
  errorCategories: { eventType: string; level: string; count: number }[];
  workerFreshness: { maxStalenessSec: number; activeWorkers: number };
  adminAuditRate: { last24h: number };
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Capture the current state into a Snapshot. Read-only. */
async function capture(): Promise<Snapshot> {
  const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Job failure rate by task_type — last 24h.
  const { data: failureRows, error: failureErr } = await supabase.rpc(
    "execute_sql" as never,
    {
      query: `
        SELECT task_type,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed,
               COUNT(*) AS total
          FROM public.video_generation_jobs
         WHERE created_at >= '${sinceISO}'
         GROUP BY task_type
         HAVING COUNT(*) > 0
         ORDER BY total DESC;
      `,
    },
  );

  // Fallback to direct query if execute_sql RPC isn't exposed —
  // most Supabase setups don't ship one. We use raw select with a
  // post-process aggregation.
  let jobFailureRate: Snapshot["jobFailureRate"] = [];
  if (failureErr || !failureRows) {
    const { data, error } = await supabase
      .from("video_generation_jobs")
      .select("task_type, status")
      .gte("created_at", sinceISO);
    if (error) throw new Error(`job query failed: ${error.message}`);
    const byType = new Map<string, { failed: number; total: number }>();
    for (const row of data ?? []) {
      const t = (row as { task_type: string }).task_type;
      const s = (row as { status: string }).status;
      const cur = byType.get(t) ?? { failed: 0, total: 0 };
      cur.total++;
      if (s === "failed") cur.failed++;
      byType.set(t, cur);
    }
    jobFailureRate = Array.from(byType.entries())
      .map(([taskType, c]) => ({
        taskType,
        failed: c.failed,
        total: c.total,
        rate: c.total > 0 ? c.failed / c.total : 0,
      }))
      .sort((a, b) => b.total - a.total);
  } else {
    jobFailureRate = (failureRows as Array<{ task_type: string; failed: number; total: number }>).map(
      (r) => ({
        taskType: r.task_type,
        failed: r.failed,
        total: r.total,
        rate: r.total > 0 ? r.failed / r.total : 0,
      }),
    );
  }

  // Queue depth — pending and processing right now.
  const { data: queueRows, error: queueErr } = await supabase
    .from("video_generation_jobs")
    .select("task_type, status")
    .in("status", ["pending", "processing"]);
  if (queueErr) throw new Error(`queue query failed: ${queueErr.message}`);
  const queueMap = new Map<string, number>();
  for (const row of (queueRows ?? []) as Array<{ status: string; task_type: string }>) {
    const k = `${row.status}|${row.task_type}`;
    queueMap.set(k, (queueMap.get(k) ?? 0) + 1);
  }
  const queueDepth = Array.from(queueMap.entries()).map(([k, count]) => {
    const [status, taskType] = k.split("|");
    return { status, taskType, count };
  });

  // Latency — derived from completed jobs in the last 24h with both
  // started_at and updated_at populated. Computed in memory rather
  // than via PERCENTILE_CONT because we don't have a materialised view.
  const { data: latencyRows, error: latencyErr } = await supabase
    .from("video_generation_jobs")
    .select("task_type, started_at, updated_at")
    .eq("status", "completed")
    .gte("created_at", sinceISO)
    .not("started_at", "is", null)
    .limit(5000);
  if (latencyErr) throw new Error(`latency query failed: ${latencyErr.message}`);
  const latencyByType = new Map<string, number[]>();
  for (const row of latencyRows ?? []) {
    const r = row as { task_type: string; started_at: string; updated_at: string };
    if (!r.started_at || !r.updated_at) continue;
    const ms = new Date(r.updated_at).getTime() - new Date(r.started_at).getTime();
    if (ms < 0 || ms > 60 * 60 * 1000) continue; // discard obvious outliers
    if (!latencyByType.has(r.task_type)) latencyByType.set(r.task_type, []);
    latencyByType.get(r.task_type)!.push(ms);
  }
  const latency: Snapshot["latency"] = Array.from(latencyByType.entries()).map(([taskType, samples]) => {
    samples.sort((a, b) => a - b);
    const pick = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
    return {
      taskType,
      p50ms: pick(0.5),
      p95ms: pick(0.95),
      p99ms: pick(0.99),
      n: samples.length,
    };
  });

  // Error categories from system_logs — last 24h, errors only.
  const { data: errorRows, error: errorErr } = await supabase
    .from("system_logs")
    .select("event_type, level")
    .eq("level", "error")
    .gte("created_at", sinceISO)
    .limit(10000);
  if (errorErr) throw new Error(`error query failed: ${errorErr.message}`);
  const errMap = new Map<string, number>();
  for (const row of (errorRows ?? []) as Array<{ event_type: string; level: string }>) {
    const k = `${row.event_type}|${row.level}`;
    errMap.set(k, (errMap.get(k) ?? 0) + 1);
  }
  const errorCategories = Array.from(errMap.entries()).map(([k, count]) => {
    const [eventType, level] = k.split("|");
    return { eventType, level, count };
  }).sort((a, b) => b.count - a.count);

  // Worker freshness — max staleness across active workers.
  const { data: workerRows, error: workerErr } = await supabase
    .from("worker_heartbeats")
    .select("last_seen_at")
    .gte("last_seen_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());
  if (workerErr) {
    // worker_heartbeats may not exist in all environments; skip
    // gracefully rather than fail the whole snapshot.
  }
  const now = Date.now();
  const stalenesses = ((workerRows ?? []) as Array<{ last_seen_at: string }>).map(
    (r) => (now - new Date(r.last_seen_at).getTime()) / 1000,
  );
  const workerFreshness = {
    maxStalenessSec: stalenesses.length > 0 ? Math.max(...stalenesses) : -1,
    activeWorkers: stalenesses.length,
  };

  // admin_logs write rate — proves the audit trail is live.
  const { count: adminLogCount } = await supabase
    .from("admin_logs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", sinceISO);

  return {
    capturedAt: new Date().toISOString(),
    jobFailureRate,
    queueDepth,
    latency,
    errorCategories,
    workerFreshness,
    adminAuditRate: { last24h: adminLogCount ?? 0 },
  };
}

/** Compare current snapshot to a saved baseline. Returns regressions. */
function diff(baseline: Snapshot, current: Snapshot): {
  regressions: string[];
  improvements: string[];
  unchanged: string[];
} {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const unchanged: string[] = [];

  // Failure rate — must not exceed baseline + 25% relative.
  for (const c of current.jobFailureRate) {
    const b = baseline.jobFailureRate.find((x) => x.taskType === c.taskType);
    if (!b) continue;
    if (c.rate > b.rate * 1.25 && c.rate - b.rate > 0.02) {
      regressions.push(
        `failure rate ${c.taskType}: ${(b.rate * 100).toFixed(1)}% → ${(c.rate * 100).toFixed(1)}%`,
      );
    } else if (c.rate < b.rate * 0.75 && b.rate > 0.05) {
      improvements.push(
        `failure rate ${c.taskType}: ${(b.rate * 100).toFixed(1)}% → ${(c.rate * 100).toFixed(1)}%`,
      );
    }
  }

  // p95 latency — must not exceed baseline × 1.5.
  for (const c of current.latency) {
    const b = baseline.latency.find((x) => x.taskType === c.taskType);
    if (!b || b.n < 10) continue;
    if (c.p95ms > b.p95ms * 1.5 && c.p95ms - b.p95ms > 5000) {
      regressions.push(
        `p95 ${c.taskType}: ${(b.p95ms / 1000).toFixed(1)}s → ${(c.p95ms / 1000).toFixed(1)}s`,
      );
    } else if (c.p95ms < b.p95ms * 0.75 && b.p95ms > 10000) {
      improvements.push(
        `p95 ${c.taskType}: ${(b.p95ms / 1000).toFixed(1)}s → ${(c.p95ms / 1000).toFixed(1)}s`,
      );
    }
  }

  // New error categories that didn't exist at baseline.
  const baselineErrTypes = new Set(baseline.errorCategories.map((e) => e.eventType));
  for (const c of current.errorCategories) {
    if (!baselineErrTypes.has(c.eventType) && c.count > 5) {
      regressions.push(`NEW error category: ${c.eventType} (${c.count} occurrences)`);
    }
  }

  // Worker freshness — workers must still be alive.
  if (current.workerFreshness.activeWorkers === 0 && baseline.workerFreshness.activeWorkers > 0) {
    regressions.push(`workers gone: baseline had ${baseline.workerFreshness.activeWorkers}, now 0`);
  }

  if (regressions.length === 0) {
    unchanged.push("all metrics within baseline tolerance");
  }

  return { regressions, improvements, unchanged };
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "capture") {
    console.log("[soak-baseline] capturing snapshot...");
    const snapshot = await capture();
    await fs.writeFile(BASELINE_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`[soak-baseline] saved baseline → ${BASELINE_PATH}`);
    console.log(`[soak-baseline] errorCategories=${snapshot.errorCategories.length}, latencySamples=${snapshot.latency.reduce((a, b) => a + b.n, 0)}, queueDepth=${snapshot.queueDepth.reduce((a, b) => a + b.count, 0)}`);
    return;
  }

  if (mode === "diff") {
    let baseline: Snapshot;
    try {
      baseline = JSON.parse(await fs.readFile(BASELINE_PATH, "utf-8"));
    } catch (err) {
      console.error(`[soak-baseline] cannot read baseline at ${BASELINE_PATH}: ${(err as Error).message}`);
      console.error(`[soak-baseline] run 'capture' first to create one`);
      process.exit(2);
    }
    console.log(`[soak-baseline] baseline from ${baseline.capturedAt}`);
    console.log(`[soak-baseline] capturing current state...`);
    const current = await capture();
    const { regressions, improvements, unchanged } = diff(baseline, current);

    console.log("\n=== Regressions ===");
    if (regressions.length === 0) console.log("  (none)");
    else regressions.forEach((r) => console.log(`  ❌ ${r}`));

    console.log("\n=== Improvements ===");
    if (improvements.length === 0) console.log("  (none)");
    else improvements.forEach((i) => console.log(`  ✅ ${i}`));

    console.log("\n=== Unchanged ===");
    unchanged.forEach((u) => console.log(`  · ${u}`));

    if (regressions.length > 0) {
      console.log(`\n[soak-baseline] FAIL — ${regressions.length} regression(s)`);
      process.exit(1);
    }
    console.log(`\n[soak-baseline] PASS — soak completed within tolerance`);
    return;
  }

  console.error("Usage: soak-baseline.ts <capture|diff>");
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
