/**
 * Sync Labs direct API integration (https://sync.so).
 *
 * Why sync.so direct (not Replicate-hosted):
 *   - sync.so IS the model creator. Going direct bypasses Replicate's
 *     queue (which can sit deep for 5-15 min during US business hours).
 *   - Median latency 2-5 min for a 3-min input. P95 ~10 min.
 *
 * Models:
 *   - lipsync-2         (~$0.06 / output-second)
 *   - lipsync-2-pro     (~$0.15 / output-second, sharper teeth + tongue)
 *
 * The sync.so API is async-first:
 *   1. POST /v2/generate → returns `{ id, status: PENDING }`.
 *   2. GET /v2/generate/<id> polled until status terminates.
 *   3. On COMPLETED, body carries `outputUrl` + `outputDuration`.
 *
 * Auth: `LIPSYNC_API_KEY` (passed as `x-api-key` header).
 */

import { writeApiLog } from "../lib/logger.js";

const DEFAULT_BASE = "https://api.sync.so/v2";
const POLL_INTERVAL_MS = 3_000;
// sync.so direct is roughly 3-5× faster than Replicate-hosted same
// model because there's no Replicate queue layer. 20 min is generous
// for the P99 tail (cold-start + heavy compute on a long master).
const DEFAULT_POLL_MAX_MS = 20 * 60 * 1000; // 20 min

export type LipsyncModel = "lipsync-2" | "lipsync-2-pro";

export interface LipsyncOptions {
  videoUrl: string;            // publicly fetchable MP4 (Supabase signed URL works)
  audioUrl: string;            // publicly fetchable audio (WAV or MP3)
  model?: LipsyncModel;
  userId?: string | null;      // for api_call_logs attribution
  generationId?: string | null;
  signal?: AbortSignal;        // honors worker's hard-timeout abort
  pollMaxMs?: number;
}

export interface LipsyncResult {
  videoUrl: string | null;
  durationSeconds?: number;
  provider: string;
  model: LipsyncModel;
  error?: string;
}

type SyncLabsStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELED" | "REJECTED";

interface SyncLabsJob {
  id: string;
  status: SyncLabsStatus;
  outputUrl?: string | null;
  outputDuration?: number | null; // seconds
  error?: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a full lipsync: POST → poll until terminal → return output URL.
 *
 * Returns { videoUrl: null, error } on failure. NEVER throws on transient
 * network errors during polling — the caller handles refund + status row.
 */
export async function generateLipsync(opts: LipsyncOptions): Promise<LipsyncResult> {
  const apiKey = process.env.LIPSYNC_API_KEY || process.env.SYNCLABS_API_KEY;
  const base = process.env.LIPSYNC_API_BASE || DEFAULT_BASE;
  const model: LipsyncModel = opts.model ?? "lipsync-2";
  const provider = "sync_labs";

  if (!apiKey) {
    return { videoUrl: null, provider, model, error: "LIPSYNC_API_KEY is not configured" };
  }

  const startTime = Date.now();
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  // ── 1. Submit the job ─────────────────────────────────────────────
  let jobId: string;
  try {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Sync Labs aborted before submission" };
    }

    const submitRes = await fetch(`${base}/generate`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { type: "video", url: opts.videoUrl },
          { type: "audio", url: opts.audioUrl },
        ],
      }),
      signal: opts.signal,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      const err = `Sync Labs submit ${submitRes.status}: ${errText.substring(0, 200)}`;
      console.warn(`[SyncLabs] ${err}`);
      return { videoUrl: null, provider, model, error: err };
    }

    const created = (await submitRes.json()) as SyncLabsJob;
    if (!created?.id) {
      return { videoUrl: null, provider, model, error: "Sync Labs response missing job id" };
    }
    jobId = created.id;
    console.log(`[SyncLabs] Submitted job ${jobId} (model=${model})`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { videoUrl: null, provider, model, error: "Sync Labs aborted by hard-timeout signal" };
    }
    return {
      videoUrl: null,
      provider,
      model,
      error: `Sync Labs submit threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 2. Poll until terminal or timeout ─────────────────────────────
  const pollDeadline = Date.now() + pollMaxMs;
  let lastStatus: SyncLabsStatus | "" = "";

  while (Date.now() < pollDeadline) {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Sync Labs poll aborted by hard-timeout signal" };
    }

    try {
      const pollRes = await fetch(`${base}/generate/${jobId}`, {
        headers: { "x-api-key": apiKey },
        signal: opts.signal,
      });
      if (!pollRes.ok) {
        if (pollRes.status >= 400 && pollRes.status < 500 && pollRes.status !== 429) {
          const errText = await pollRes.text().catch(() => "");
          return {
            videoUrl: null, provider, model,
            error: `Sync Labs poll ${pollRes.status}: ${errText.substring(0, 200)}`,
          };
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const body = (await pollRes.json()) as SyncLabsJob;
      if (body.status !== lastStatus) {
        console.log(`[SyncLabs] Job ${jobId} status=${body.status}`);
        lastStatus = body.status;
      }

      if (body.status === "COMPLETED") {
        if (!body.outputUrl) {
          return { videoUrl: null, provider, model, error: "Sync Labs COMPLETED but no outputUrl" };
        }
        const durationSeconds = body.outputDuration ?? undefined;
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          provider, model,
          status: "success",
          totalDurationMs: Date.now() - startTime,
          cost: lipsyncCostUsd(model, durationSeconds ?? 0),
          error: undefined,
        }).catch((e) => console.warn(`[SyncLabs] api log failed: ${(e as Error).message}`));

        return { videoUrl: body.outputUrl, durationSeconds, provider, model };
      }

      if (body.status === "FAILED" || body.status === "CANCELED" || body.status === "REJECTED") {
        return {
          videoUrl: null, provider, model,
          error: `Sync Labs ${body.status}: ${body.error ?? "no reason given"}`,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { videoUrl: null, provider, model, error: "Sync Labs poll aborted by hard-timeout signal" };
      }
      console.warn(`[SyncLabs] Poll exception (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Best-effort cancel — stop sync.so from billing once we've given up.
  cancelSyncLabsJob(base, apiKey, jobId).catch((e) =>
    console.warn(`[SyncLabs] cancel failed for ${jobId}: ${(e as Error).message}`),
  );

  writeApiLog({
    userId: opts.userId ?? null,
    generationId: opts.generationId ?? null,
    provider, model,
    status: "error",
    totalDurationMs: Date.now() - startTime,
    cost: 0,
    error: `Sync Labs poll timeout after ${Math.round(pollMaxMs / 1000)}s`,
  }).catch((e) => console.warn(`[SyncLabs] api log failed: ${(e as Error).message}`));

  return {
    videoUrl: null, provider, model,
    error: `Sync Labs job ${jobId} did not complete within ${Math.round(pollMaxMs / 1000)}s`,
  };
}

async function cancelSyncLabsJob(base: string, apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${base}/generate/${id}/cancel`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[SyncLabs] cancel returned ${res.status} for ${id}`);
  } else {
    console.log(`[SyncLabs] Cancelled job ${id}`);
  }
}

/** USD cost — sync.so bills by output duration. */
function lipsyncCostUsd(model: LipsyncModel, outputSeconds: number): number {
  const perSec = model === "lipsync-2-pro" ? 0.15 : 0.06;
  return Math.max(0, outputSeconds * perSec);
}
