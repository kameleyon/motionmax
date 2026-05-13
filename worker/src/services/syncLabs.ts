/**
 * Sync Labs lipsync integration (https://sync.so).
 *
 * Two model tiers:
 *  - lipsync-2     (~$0.06/output-second) — default
 *  - lipsync-2-pro (~$0.15/output-second) — premium, sharper teeth + tongue
 *
 * The API is async: POST creates a job, GET polls for status, the
 * response carries the URL of the finished MP4 once status='COMPLETED'.
 * We poll on a 3 s tick with a configurable cap (default 10 min) and
 * honor an AbortSignal threaded from the worker's per-job timeout.
 *
 * Auth: SYNCLABS_API_KEY (x-api-key header).
 * Endpoint base: https://api.sync.so/v2 (configurable via SYNCLABS_API_BASE).
 */

import { writeApiLog } from "../lib/logger.js";

const DEFAULT_BASE = "https://api.sync.so/v2";
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_MAX_MS = 10 * 60 * 1000; // 10 min

export type SyncLabsModel = "lipsync-2" | "lipsync-2-pro";

export interface SyncLabsLipsyncOptions {
  videoUrl: string;            // publicly fetchable MP4 (Supabase signed URL works)
  audioUrl: string;            // publicly fetchable audio (WAV or MP3)
  model?: SyncLabsModel;
  userId?: string | null;      // for api_call_logs attribution
  generationId?: string | null;
  signal?: AbortSignal;        // honors worker's hard-timeout abort
  pollMaxMs?: number;
}

export interface SyncLabsResult {
  videoUrl: string | null;
  durationSeconds?: number;
  provider: string;
  model: SyncLabsModel;
  error?: string;
}

interface CreateJobResponse {
  id: string;
  status?: string;
}

interface PollResponse {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELED";
  outputUrl?: string;
  outputDuration?: number; // seconds
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a full lipsync: POST → poll until terminal → return output URL.
 *
 * Returns { videoUrl: null, error } on failure. NEVER throws on transient
 * network errors during polling — the caller handles refund + status row.
 */
export async function generateLipsync(
  opts: SyncLabsLipsyncOptions,
): Promise<SyncLabsResult> {
  const apiKey = process.env.SYNCLABS_API_KEY;
  const base = process.env.SYNCLABS_API_BASE || DEFAULT_BASE;
  const model: SyncLabsModel = opts.model ?? "lipsync-2";
  const provider = "sync_labs";

  if (!apiKey) {
    return { videoUrl: null, provider, model, error: "SYNCLABS_API_KEY is not configured" };
  }

  const startTime = Date.now();
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  // ── 1. Create the job ─────────────────────────────────────────────
  let jobId: string;
  try {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Sync Labs aborted before submission" };
    }

    const createRes = await fetch(`${base}/generate`, {
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

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      const err = `Sync Labs submit ${createRes.status}: ${errText.substring(0, 200)}`;
      console.warn(`[SyncLabs] ${err}`);
      return { videoUrl: null, provider, model, error: err };
    }

    const created = (await createRes.json()) as CreateJobResponse;
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
  let lastStatus = "";

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
        // Transient — keep polling unless we're 4xx (non-retriable)
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

      const body = (await pollRes.json()) as PollResponse;
      if (body.status !== lastStatus) {
        console.log(`[SyncLabs] Job ${jobId} status=${body.status}`);
        lastStatus = body.status;
      }

      if (body.status === "COMPLETED") {
        if (!body.outputUrl) {
          return { videoUrl: null, provider, model, error: "Sync Labs COMPLETED but no outputUrl" };
        }
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          provider, model,
          status: "success",
          totalDurationMs: Date.now() - startTime,
          cost: lipsyncCostUsd(model, body.outputDuration ?? 0),
          error: undefined,
        }).catch((e) => console.warn(`[SyncLabs] api log failed: ${(e as Error).message}`));

        return {
          videoUrl: body.outputUrl,
          durationSeconds: body.outputDuration,
          provider, model,
        };
      }

      if (body.status === "FAILED" || body.status === "CANCELED") {
        return {
          videoUrl: null, provider, model,
          error: `Sync Labs ${body.status}: ${body.error ?? "no reason given"}`,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { videoUrl: null, provider, model, error: "Sync Labs poll aborted by hard-timeout signal" };
      }
      // Network blip during poll — keep going
      console.warn(`[SyncLabs] Poll exception (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

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

/** USD cost for a completed lipsync job. Mirrors PROVIDER_RATES_USD pattern. */
function lipsyncCostUsd(model: SyncLabsModel, outputSeconds: number): number {
  const perSec = model === "lipsync-2-pro" ? 0.15 : 0.06;
  return Math.max(0, outputSeconds * perSec);
}
