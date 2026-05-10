/**
 * Concurrency budget detection — cgroup-aware CPU/memory accounting and
 * per-pool slot sizing. Extracted from worker/src/index.ts on 2026-05-10
 * (per audit C-4-3). Behavior preserved exactly: same env reads, same
 * formulas, same logging. Pool gating + override application stays in
 * index.ts so module-level `let` slot vars remain owned by the
 * entrypoint.
 */
import os from "os";
import fs from "fs";
import { wlog } from "./workerLogger.js";

/**
 * Get the actual memory available to this process.
 * In containers (Docker/Render), os.totalmem() returns the HOST memory,
 * not the container's cgroup limit. We read the cgroup limit directly.
 */
export function getContainerMemoryBytes(): number {
  const hostMem = os.totalmem();

  // Try cgroup v2 first (newer Linux kernels / Render)
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
    if (raw !== "max") {
      const limit = parseInt(raw, 10);
      if (limit > 0 && limit < hostMem) return limit;
    }
  } catch { /* not cgroup v2 */ }

  // Try cgroup v1
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf-8").trim();
    const limit = parseInt(raw, 10);
    // cgroup v1 returns a huge number (9223372036854771712) when unlimited
    if (limit > 0 && limit < hostMem) return limit;
  } catch { /* not cgroup v1 */ }

  // Fallback: host memory (non-containerized or Windows)
  return hostMem;
}

/**
 * Get the CPU quota allocated to this container, in whole-CPU units.
 * `os.cpus().length` returns HOST cores even inside a container — on
 * Render's multi-tenant infra that means a 2-vCPU Pro pod reports 16
 * cores, which is what previously caused MAX_EXPORT_SLOTS to balloon
 * to 16 and oversubscribe the cgroup. We read the actual quota from
 * the cgroup CPU controller instead.
 */
export function getContainerCpuCount(): number {
  const hostCpus = Math.max(1, os.cpus().length);

  // cgroup v2: /sys/fs/cgroup/cpu.max → "<quota> <period>" or "max <period>"
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim();
    const [quotaStr, periodStr] = raw.split(/\s+/);
    if (quotaStr !== "max") {
      const quota = parseInt(quotaStr, 10);
      const period = parseInt(periodStr, 10);
      if (quota > 0 && period > 0) {
        const cpus = Math.max(1, Math.round(quota / period));
        if (cpus < hostCpus) return cpus;
      }
    }
  } catch { /* not cgroup v2 */ }

  // cgroup v1: separate quota + period files
  try {
    const quota = parseInt(
      fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8").trim(),
      10,
    );
    const period = parseInt(
      fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8").trim(),
      10,
    );
    if (quota > 0 && period > 0) {
      const cpus = Math.max(1, Math.round(quota / period));
      if (cpus < hostCpus) return cpus;
    }
  } catch { /* not cgroup v1 */ }

  // Fallback: host count (non-containerized or unrestricted cgroup)
  return hostCpus;
}

/**
 * Pool sizes split by workload type:
 *   - export pool   → CPU-bound  (FFmpeg encoding, color grade, mux)
 *   - LLM/IO pool   → memory-bound (await fetch() to Hypereal/Gemini/ElevenLabs)
 *
 * HOTFIX 2026-05-05: previous formula at 120MB/job triggered repeated
 * OOM kills at 2GB on Render — pods were getting reaped every ~30 min
 * during heavy generation traffic. Three things were wrong with the
 * old math:
 *   1. The 120MB/job budget assumed steady-state RSS but ignored brief
 *      spikes (PDF parse hits 250-300MB, FFmpeg children spawn from
 *      LLM jobs hit 200-400MB during regen flows).
 *   2. The container memory limit on this Render plan is 2GB, not 4GB
 *      — so `availableMb / 120` produced 27 LLM slots × ~150MB avg =
 *      ~4GB working set on a 2GB pod. Guaranteed OOM.
 *   3. Realtime channels + Sentry transports + Supabase clients sit
 *      around ~250-350MB even before the first job claim.
 *
 * New conservative scheme:
 *   exportSlots = max(1, cpuCount)                       — one FFmpeg per core
 *   llmSlots    = clamp(2, 8, floor(availableMb / 350))  — memory-bound, conservative
 *   total       = export + llm, hard-capped at 12
 *
 * Math on 2GB pod: (2048 - 768 reserved) / 350 = 3.6 → 4 LLM slots,
 * floor bumps to 8 only on 4GB+ pods. On a real 4GB pod (3328 / 350 = 9)
 * we land at 8 LLM slots. Total never exceeds 10-12 jobs in flight per
 * instance — well under the 2GB ceiling even with full spikes.
 *
 * For higher throughput, scale horizontally (render.yaml maxInstances)
 * rather than packing more jobs per pod. Memory-bound concurrency
 * reaches diminishing returns fast; horizontal scaling is the right
 * lever for an I/O-bound workload like ours.
 */
export interface ConcurrencyBudget { exportSlots: number; llmSlots: number; total: number; }

export function detectOptimalConcurrency(): ConcurrencyBudget {
  const hostCpuCount    = os.cpus().length;
  const containerCpus   = getContainerCpuCount();
  const hostMemMb       = Math.round(os.totalmem() / 1048576);
  const containerMemMb  = Math.round(getContainerMemoryBytes() / 1048576);

  // Reserve 768MB for OS/Node.js overhead (FFmpeg + pdfjs occasionally
  // spike past the old 512MB reservation under load).
  const availableMemMb = Math.max(256, containerMemMb - 768);

  // Env override path: split a flat WORKER_CONCURRENCY value across
  // pools using the same 25/75 ratio applyConcurrencyOverride uses,
  // so manual tuning still gets reasonable pool sizes without two env vars.
  const envOverride = process.env.WORKER_CONCURRENCY;
  if (envOverride) {
    const total = Math.max(3, parseInt(envOverride, 10));
    const exportSlots = Math.max(1, Math.floor(total * 0.25));
    const llmSlots    = Math.max(2, total - exportSlots);
    wlog.info("Concurrency from env override", { total, exportSlots, llmSlots });
    return { exportSlots, llmSlots, total: exportSlots + llmSlots };
  }

  // Export pool: bound by BOTH cgroup CPU quota AND memory headroom.
  // Each ffmpeg child with xfade+Ken Burns runs 500-700MB resident, so
  // even on a 2-vCPU pod with "enough" cores the 2GB cgroup can only
  // safely host 1-2 simultaneous exports. Hard ceiling of 4 per instance
  // — beyond that, scale horizontally.
  const exportByCpu    = Math.max(1, containerCpus);
  const exportByMemory = Math.max(1, Math.floor(availableMemMb / 700));
  const exportSlots    = Math.max(1, Math.min(exportByCpu, exportByMemory, 4));

  // LLM/IO pool: memory-bound, CONSERVATIVE 350MB/job to cover spikes.
  // Hard ceiling of 8 per instance — any further parallelism comes
  // from scaling out (more instances), not packing more in.
  const llmByMemory = Math.floor(availableMemMb / 350);
  const llmSlots    = Math.max(2, Math.min(llmByMemory, 8));

  const total = exportSlots + llmSlots;

  wlog.info("Auto-tuned concurrency", {
    hostCpus: hostCpuCount, containerCpus,
    hostRamMb: hostMemMb, containerRamMb: containerMemMb,
    availableMb: availableMemMb,
    exportSlots, exportByCpu, exportByMemory,
    llmSlots, llmByMemory,
    total,
  });
  return { exportSlots, llmSlots, total };
}

/** Returns true for the export pool task type — kept as a tiny helper
 *  so the entrypoint and any other consumer agree on what counts as an
 *  "export" workload. */
export function isExportTask(taskType: string): boolean {
  return taskType === 'export_video';
}
