/**
 * Real platform publishers — YouTube Shorts, Instagram Reels, TikTok.
 *
 * Replaces the Wave 2c stubs. Same signatures as stubPublishers.ts so the
 * dispatcher only needs to swap its import.
 *
 * Design notes:
 *   - No new deps: uses built-in fetch + Buffer.
 *   - Surfaces HTTP status + body cleanly so retryPolicy.classifyError() can
 *     map outcomes to retryable/non-retryable in the dispatcher.
 *   - Stub-mode escape hatch: when env AUTOPOST_STUB_PUBLISHERS=true all three
 *     functions short-circuit with a fake post id/url. Useful for first
 *     end-to-end runs before real OAuth tokens exist.
 *   - YouTube uses resumable upload over raw HTTP per Google docs:
 *       https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *   - IG Reels uses the documented two-step container/publish flow:
 *       https://developers.facebook.com/docs/instagram-platform/content-publishing
 *   - TikTok uses Direct Post init → upload → status fetch:
 *       https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";
import { parseRetryAfterMs } from "./retryPolicy.js";
import type { PublishContext, PublishResult } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Stub-mode escape hatch
// ──────────────────────────────────────────────────────────────────────────
function stubModeEnabled(): boolean {
  const v = process.env.AUTOPOST_STUB_PUBLISHERS;
  return typeof v === "string" && v.toLowerCase() === "true";
}

async function stubResult(prefix: string, urlBuilder: (id: string) => string): Promise<PublishResult> {
  await new Promise((r) => setTimeout(r, 2000));
  const id = `stub-${prefix}-${Date.now()}`;
  return { ok: true, postId: id, postUrl: urlBuilder(id) };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Pull `#hashtag` tokens out of a free-form caption.
 *  Returns lowercased tag bodies without the `#`. */
export function extractHashtags(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const tok of text.split(/\s+/)) {
    if (tok.startsWith("#") && tok.length > 1) {
      // Strip the leading # and any trailing punctuation that snuck in.
      const cleaned = tok
        .slice(1)
        .replace(/[^A-Za-z0-9_]/g, "")
        .toLowerCase();
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

interface ProbedMetadata {
  durationMs?: number;
  width?: number;
  height?: number;
  size?: number;
}

/** Best-effort probe — trusts dispatcher-provided values, falls back to a
 *  HEAD request for content-length. We don't run ffprobe here; that would
 *  require downloading the file to disk. */
export async function getVideoMetadata(
  videoUrl: string,
  hint?: ProbedMetadata,
): Promise<ProbedMetadata> {
  const out: ProbedMetadata = { ...hint };
  if (out.size && out.size > 0) return out;

  try {
    const res = await fetch(videoUrl, { method: "HEAD" });
    const len = res.headers.get("content-length");
    if (len) {
      const n = Number(len);
      if (Number.isFinite(n) && n > 0) out.size = n;
    }
  } catch {
    // HEAD is best-effort; some signed URL endpoints may reject HEAD with
    // 400. The publisher will fall back to a GET when downloading.
  }
  return out;
}

/** Generic poller. Calls `check()` every `intervalMs` for up to `timeoutMs`,
 *  bailing as soon as the check returns 'done' or an { error } object. */
export async function pollWithTimeout<R>(
  check: () => Promise<{ kind: "continue" } | { kind: "done"; value: R } | { kind: "error"; error: string }>,
  intervalMs: number,
  timeoutMs: number,
): Promise<{ ok: true; value: R } | { ok: false; error: string; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  // First attempt immediately so callers don't pay one full interval for
  // platforms that finish ~instantly (rare but possible for IG).
  while (Date.now() < deadline) {
    let result;
    try {
      result = await check();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, timedOut: false };
    }
    if (result.kind === "done") return { ok: true, value: result.value };
    if (result.kind === "error") return { ok: false, error: result.error, timedOut: false };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, error: "poll timed out", timedOut: true };
}

/** Truncate to a hard limit while keeping whole UTF-16 code units. Platforms
 *  count characters, not bytes, so this is the right unit for caption clamps. */
function clamp(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max);
}

/** Download a remote URL into memory as a Buffer. Used by YouTube and TikTok
 *  which need direct byte uploads (IG fetches from our URL itself). */
async function downloadToBuffer(url: string): Promise<{ buffer: Buffer; size: number; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`video download ${res.status}: ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  return {
    buffer,
    size: buffer.byteLength,
    contentType: res.headers.get("content-type") ?? "video/mp4",
  };
}

/** Read body as text (best-effort) for error logging. */
async function readBodySafe(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// YouTube — Shorts via Data API v3 resumable upload
// ──────────────────────────────────────────────────────────────────────────
export async function publishYouTube(ctx: PublishContext): Promise<PublishResult> {
  if (stubModeEnabled()) {
    return stubResult("yt", (id) => `https://youtube.com/shorts/${id}`);
  }

  const { account, caption, videoUrl, job } = ctx;

  // 1. Probe metadata so we can pick #Shorts vs watch URL accurately.
  const meta = await getVideoMetadata(videoUrl, {
    durationMs: ctx.durationMs,
    width: ctx.width,
    height: ctx.height,
    size: ctx.sizeBytes,
  });
  const durationSeconds = meta.durationMs ? Math.round(meta.durationMs / 1000) : 30;
  const isVertical = meta.width && meta.height ? meta.height >= meta.width : true;
  const isShort = durationSeconds <= 60 && isVertical;

  // 2. Build snippet/status body.
  const firstLine = caption.split("\n")[0] ?? "";
  const title = clamp(firstLine || "MotionMax video", 100);
  const description = isShort && !caption.includes("#Shorts") ? `${caption}\n#Shorts` : caption;
  const tags = extractHashtags(caption).slice(0, 30);

  const metadata = {
    snippet: {
      title,
      description,
      tags,
      categoryId: "22", // People & Blogs
    },
    status: {
      privacyStatus: "public",
      containsSyntheticMedia: true,
      selfDeclaredMadeForKids: false,
    },
  };

  // 3. Download the video bytes. Per the spec, in-memory is fine for the
  //    typical 5–15MB autopost output. Larger files would still fit in
  //    Node's heap; if that ever changes we'd switch to chunked PUT.
  let videoBytes: Buffer;
  let videoSize: number;
  try {
    const dl = await downloadToBuffer(videoUrl);
    videoBytes = dl.buffer;
    videoSize = dl.size;
  } catch (e) {
    return {
      ok: false,
      errorCode: "video_download_failed",
      errorMessage: e instanceof Error ? e.message : String(e),
      retryable: true,
    };
  }

  await writeSystemLog({
    jobId: job.id,
    category: "system_info",
    eventType: "autopost_publish_started",
    message: `YouTube upload starting (${(videoSize / 1024 / 1024).toFixed(1)}MB)`,
    details: {
      jobId: job.id,
      runId: ctx.runId,
      platform: "youtube",
      accountId: account.id,
      sizeBytes: videoSize,
      isShort,
    },
  });

  // 4. Resumable upload — step 1: initiate session.
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.access_token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(videoSize),
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!initRes.ok) {
    const body = await readBodySafe(initRes);
    return mapYouTubeError(initRes.status, body, "init", initRes.headers.get("retry-after"));
  }
  const uploadUrl = initRes.headers.get("Location") ?? initRes.headers.get("location");
  if (!uploadUrl) {
    return {
      ok: false,
      errorCode: "yt_no_upload_url",
      errorMessage: "YouTube init returned 200 but no Location header",
      retryable: true,
    };
  }

  // 5. Resumable upload — step 2: PUT bytes. For now we send everything in
  //    one PUT (works for files well under YouTube's per-request cap). If
  //    we ever need chunked re-tries we'd loop with Content-Range.
  // Node's fetch typings (TS 5.x + @types/node 22) clash with the lib.dom
  // BodyInit type — a Buffer is a perfectly valid body at runtime, but the
  // overlap between Node Buffer and DOM-typed Uint8Array isn't recognized.
  // Cast to BodyInit to keep the call site readable.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoSize),
    },
    body: videoBytes as unknown as BodyInit,
  });

  if (!putRes.ok) {
    const body = await readBodySafe(putRes);
    return mapYouTubeError(putRes.status, body, "upload", putRes.headers.get("retry-after"));
  }

  let videoId = "";
  try {
    const parsed = (await putRes.json()) as { id?: string };
    videoId = parsed.id ?? "";
  } catch {
    // ignore — fall through to error case below
  }
  if (!videoId) {
    return {
      ok: false,
      errorCode: "yt_no_video_id",
      errorMessage: "YouTube upload returned 200 but no video id",
      retryable: true,
    };
  }

  const postUrl = isShort
    ? `https://youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;

  return { ok: true, postId: videoId, postUrl };
}

function mapYouTubeError(
  status: number,
  body: string,
  stage: "init" | "upload",
  retryAfterHeader?: string | null,
): PublishResult {
  // Try to parse Google's error envelope.
  let reason = "";
  let message = body;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    if (parsed.error) {
      message = parsed.error.message ?? body;
      reason = parsed.error.errors?.[0]?.reason ?? "";
    }
  } catch {
    // body wasn't JSON — keep raw
  }

  // Honor Retry-After on any error path that exposes it (typically 429,
  // sometimes 503). The dispatcher's max(baseDelay, retryAfterMs) ensures
  // the longer wait wins.
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? undefined;

  if (status === 401) {
    return {
      ok: false,
      errorCode: "token_expired",
      errorMessage: `YouTube ${stage} 401: ${message.slice(0, 200)}`,
      retryable: true,
    };
  }
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || /quota/i.test(message)) {
      return {
        ok: false,
        errorCode: "quota_exceeded",
        errorMessage: `YouTube ${stage} 403 quota: ${message.slice(0, 200)}`,
        retryable: false,
      };
    }
    return {
      ok: false,
      errorCode: "forbidden",
      errorMessage: `YouTube ${stage} 403: ${message.slice(0, 200)}`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      errorCode: "rate_limited",
      errorMessage: `YouTube ${stage} 429: ${message.slice(0, 200)}`,
      retryable: true,
      retryAfterMs,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      errorCode: "server_error",
      errorMessage: `YouTube ${stage} ${status}: ${message.slice(0, 200)}`,
      retryable: true,
      retryAfterMs,
    };
  }
  return {
    ok: false,
    errorCode: "yt_client_error",
    errorMessage: `YouTube ${stage} ${status}: ${message.slice(0, 200)}`,
    retryable: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Instagram — Reels via Graph API v19 container/publish flow
// ──────────────────────────────────────────────────────────────────────────
const IG_GRAPH = "https://graph.facebook.com/v19.0";

export async function publishInstagram(ctx: PublishContext): Promise<PublishResult> {
  if (stubModeEnabled()) {
    return stubResult("ig", (id) => `https://instagram.com/reel/${id}`);
  }

  const { account, caption, videoUrl, job } = ctx;
  const igUserId = account.platform_account_id;

  // 1. Pre-flight constraint checks.
  const meta = await getVideoMetadata(videoUrl, {
    durationMs: ctx.durationMs,
    width: ctx.width,
    height: ctx.height,
    size: ctx.sizeBytes,
  });

  if (meta.durationMs && meta.durationMs > 90_000) {
    return {
      ok: false,
      errorCode: "ig_duration_too_long",
      errorMessage: `IG Reels max 90s, got ${Math.round(meta.durationMs / 1000)}s`,
      retryable: false,
    };
  }
  if (meta.size && meta.size > 100 * 1024 * 1024) {
    return {
      ok: false,
      errorCode: "ig_file_too_large",
      errorMessage: `IG Reels max 100MB, got ${(meta.size / 1024 / 1024).toFixed(1)}MB`,
      retryable: false,
    };
  }
  // Aspect ratio: only enforce strictly when we have dims. Production output
  // is already 9:16 from the autopost render path.
  if (meta.width && meta.height) {
    const ratio = meta.width / meta.height;
    // 9:16 = 0.5625 — allow ±5% slack for rounding.
    if (ratio < 0.534 || ratio > 0.591) {
      return {
        ok: false,
        errorCode: "ig_aspect_invalid",
        errorMessage: `IG Reels requires 9:16, got ${meta.width}x${meta.height}`,
        retryable: false,
      };
    }
  }

  // 2. Verify the URL is publicly fetchable (IG fetches it server-side).
  //    If our HEAD fails with 401/403, IG will fail too — better to bail now.
  try {
    const probe = await fetch(videoUrl, { method: "HEAD" });
    if (probe.status === 401 || probe.status === 403) {
      return {
        ok: false,
        errorCode: "ig_video_url_not_public",
        errorMessage: `videoUrl not fetchable by IG (HEAD ${probe.status})`,
        retryable: false,
      };
    }
  } catch {
    // Some Supabase signed URL hosts reject HEAD; let IG try anyway.
  }

  await writeSystemLog({
    jobId: job.id,
    category: "system_info",
    eventType: "autopost_publish_started",
    message: `Instagram container create starting`,
    details: { jobId: job.id, runId: ctx.runId, platform: "instagram", accountId: account.id },
  });

  // 3. Create media container.
  const createBody = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption: clamp(caption, 2200),
    share_to_feed: "true",
    access_token: account.access_token,
  });
  const createRes = await fetch(`${IG_GRAPH}/${encodeURIComponent(igUserId)}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createBody.toString(),
  });

  if (!createRes.ok) {
    const body = await readBodySafe(createRes);
    return mapInstagramError(createRes.status, body, "create", createRes.headers.get("retry-after"));
  }
  let containerId = "";
  try {
    const parsed = (await createRes.json()) as { id?: string };
    containerId = parsed.id ?? "";
  } catch {
    // fall through
  }
  if (!containerId) {
    return {
      ok: false,
      errorCode: "ig_no_container_id",
      errorMessage: "IG /media returned no container id",
      retryable: true,
    };
  }

  // 4. Poll the container until FINISHED (or ERROR / timeout).
  const polled = await pollWithTimeout<{ statusCode: string }>(
    async () => {
      const url = `${IG_GRAPH}/${encodeURIComponent(containerId)}?fields=status_code&access_token=${encodeURIComponent(account.access_token)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await readBodySafe(res);
        return { kind: "error", error: `IG status ${res.status}: ${body.slice(0, 200)}` };
      }
      const parsed = (await res.json()) as { status_code?: string };
      const code = parsed.status_code ?? "";
      if (code === "FINISHED") return { kind: "done", value: { statusCode: code } };
      if (code === "ERROR" || code === "EXPIRED") {
        return { kind: "error", error: `IG container ${code}` };
      }
      // IN_PROGRESS / PUBLISHED (rare) → keep polling
      return { kind: "continue" };
    },
    5_000,
    5 * 60_000,
  );

  if (!polled.ok) {
    return {
      ok: false,
      errorCode: polled.timedOut ? "ig_processing_timeout" : "ig_processing_error",
      errorMessage: polled.error,
      retryable: false,
    };
  }

  // 5. Publish.
  const pubRes = await fetch(
    `${IG_GRAPH}/${encodeURIComponent(igUserId)}/media_publish?creation_id=${encodeURIComponent(containerId)}&access_token=${encodeURIComponent(account.access_token)}`,
    { method: "POST" },
  );

  if (!pubRes.ok) {
    const body = await readBodySafe(pubRes);
    return mapInstagramError(pubRes.status, body, "publish", pubRes.headers.get("retry-after"));
  }
  let mediaId = "";
  try {
    const parsed = (await pubRes.json()) as { id?: string };
    mediaId = parsed.id ?? "";
  } catch {
    // fall through
  }
  if (!mediaId) {
    return {
      ok: false,
      errorCode: "ig_no_media_id",
      errorMessage: "IG media_publish returned no media id",
      retryable: true,
    };
  }

  return {
    ok: true,
    postId: mediaId,
    // Note: this URL may 404 briefly while IG indexes the new reel; that's
    // expected. The numeric media id resolves once IG's CDN catches up.
    postUrl: `https://www.instagram.com/reel/${mediaId}/`,
  };
}

function mapInstagramError(
  status: number,
  body: string,
  stage: "create" | "publish",
  retryAfterHeader?: string | null,
): PublishResult {
  // Meta error envelope: { error: { message, type, code, error_subcode } }
  let message = body;
  let code = 0;
  let subcode = 0;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    if (parsed.error) {
      message = parsed.error.message ?? body;
      code = parsed.error.code ?? 0;
      subcode = parsed.error.error_subcode ?? 0;
    }
  } catch {
    // raw
  }

  // Meta rarely sends Retry-After, but when it does, honor it.
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? undefined;

  if (status === 401 || code === 190) {
    return {
      ok: false,
      errorCode: "token_expired",
      errorMessage: `IG ${stage} 401: ${message.slice(0, 200)}`,
      retryable: true,
    };
  }
  if (status === 403) {
    return {
      ok: false,
      errorCode: "forbidden",
      errorMessage: `IG ${stage} 403: ${message.slice(0, 200)}`,
      retryable: false,
    };
  }
  if (status === 429 || code === 4 || code === 17 || code === 32) {
    return {
      ok: false,
      errorCode: "rate_limited",
      errorMessage: `IG ${stage} rate limited: ${message.slice(0, 200)}`,
      retryable: true,
      retryAfterMs,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      errorCode: "server_error",
      errorMessage: `IG ${stage} ${status}: ${message.slice(0, 200)}`,
      retryable: true,
      retryAfterMs,
    };
  }
  return {
    ok: false,
    errorCode: "ig_client_error",
    errorMessage: `IG ${stage} ${status} (code=${code}/${subcode}): ${message.slice(0, 200)}`,
    retryable: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// TikTok — Direct Post init → upload → status fetch
// ──────────────────────────────────────────────────────────────────────────
const TIKTOK_DAILY_CAP = 15;

export async function publishTikTok(ctx: PublishContext): Promise<PublishResult> {
  if (stubModeEnabled()) {
    return stubResult("tt", (id) => `https://tiktok.com/@stub/video/${id}`);
  }

  const { account, caption, videoUrl, job } = ctx;

  // 1. Daily-cap check (per-creator). TikTok enforces ~15/day across all
  //    Direct Post API clients; we mirror that locally to avoid burning
  //    failed publish attempts on a known-blocked window.
  try {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { count } = await supabase
      .from("autopost_publish_jobs")
      .select("id", { count: "exact", head: true })
      .eq("social_account_id", account.id)
      .eq("status", "published")
      .gte("created_at", since.toISOString());

    if (typeof count === "number" && count >= TIKTOK_DAILY_CAP) {
      const tomorrow = new Date(since);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const retryAfterMs = Math.max(60_000, tomorrow.getTime() - Date.now());
      return {
        ok: false,
        errorCode: "tiktok_daily_cap",
        errorMessage: `TikTok daily cap (${TIKTOK_DAILY_CAP}) reached for account ${account.id}`,
        retryable: true,
        retryAfterMs,
      };
    }
  } catch (e) {
    // Don't hard-fail on a count query — log and continue. Worst case
    // TikTok returns a 4xx for over-cap and we fail naturally.
    console.warn(`[Autopost] TikTok cap check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Read audit status to decide privacy_level.
  let privacyLevel: "PUBLIC_TO_EVERYONE" | "SELF_ONLY" = "SELF_ONLY";
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "autopost_tiktok_audit_status")
      .maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    const status = typeof v === "string" ? v : v != null ? String(v) : "";
    // jsonb stored values may come back as strings with surrounding quotes.
    const normalized = status.replace(/^"|"$/g, "");
    if (normalized === "approved") privacyLevel = "PUBLIC_TO_EVERYONE";
  } catch {
    // default SELF_ONLY
  }

  // 3. Download video bytes (TikTok's Direct Post wants a single chunk PUT).
  let videoBytes: Buffer;
  let videoSize: number;
  try {
    const dl = await downloadToBuffer(videoUrl);
    videoBytes = dl.buffer;
    videoSize = dl.size;
  } catch (e) {
    return {
      ok: false,
      errorCode: "video_download_failed",
      errorMessage: e instanceof Error ? e.message : String(e),
      retryable: true,
    };
  }

  const meta = await getVideoMetadata(videoUrl, {
    durationMs: ctx.durationMs,
    width: ctx.width,
    height: ctx.height,
    size: videoSize,
  });
  const durationMs = meta.durationMs ?? 30_000;

  await writeSystemLog({
    jobId: job.id,
    category: "system_info",
    eventType: "autopost_publish_started",
    message: `TikTok init starting (${(videoSize / 1024 / 1024).toFixed(1)}MB, privacy=${privacyLevel})`,
    details: {
      jobId: job.id,
      runId: ctx.runId,
      platform: "tiktok",
      accountId: account.id,
      privacyLevel,
      sizeBytes: videoSize,
    },
  });

  // 4. Init.
  const initBody = {
    post_info: {
      title: clamp(caption, 2200),
      privacy_level: privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: Math.round(durationMs / 2),
      brand_content_toggle: false,
      brand_organic_toggle: false,
      is_aigc: true,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1,
    },
  };

  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(initBody),
  });

  if (!initRes.ok) {
    const body = await readBodySafe(initRes);
    return mapTikTokError(initRes.status, body, "init", initRes.headers.get("retry-after"));
  }

  let uploadUrl = "";
  let publishId = "";
  try {
    const parsed = (await initRes.json()) as {
      data?: { upload_url?: string; publish_id?: string };
      error?: { code?: string; message?: string };
    };
    uploadUrl = parsed.data?.upload_url ?? "";
    publishId = parsed.data?.publish_id ?? "";
    // TikTok wraps logical errors in 200 responses; check explicitly.
    if (parsed.error && parsed.error.code && parsed.error.code !== "ok") {
      return {
        ok: false,
        errorCode: "tiktok_init_error",
        errorMessage: `${parsed.error.code}: ${parsed.error.message ?? ""}`,
        retryable: parsed.error.code === "rate_limit_exceeded",
      };
    }
  } catch {
    // fall through
  }
  if (!uploadUrl || !publishId) {
    return {
      ok: false,
      errorCode: "tiktok_no_upload_url",
      errorMessage: "TikTok init returned no upload_url/publish_id",
      retryable: true,
    };
  }

  // 5. PUT video bytes. See note in publishYouTube about the BodyInit cast.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
      "Content-Length": String(videoSize),
    },
    body: videoBytes as unknown as BodyInit,
  });

  if (!putRes.ok) {
    const body = await readBodySafe(putRes);
    return mapTikTokError(putRes.status, body, "upload", putRes.headers.get("retry-after"));
  }

  // 6. Poll status.
  const polled = await pollWithTimeout<{ status: string }>(
    async () => {
      const res = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.access_token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
      });
      if (!res.ok) {
        const body = await readBodySafe(res);
        return { kind: "error", error: `TikTok status ${res.status}: ${body.slice(0, 200)}` };
      }
      const parsed = (await res.json()) as {
        data?: { status?: string; fail_reason?: string };
        error?: { code?: string; message?: string };
      };
      if (parsed.error && parsed.error.code && parsed.error.code !== "ok") {
        return { kind: "error", error: `${parsed.error.code}: ${parsed.error.message ?? ""}` };
      }
      const status = parsed.data?.status ?? "";
      if (status === "PUBLISH_COMPLETE") return { kind: "done", value: { status } };
      if (status === "FAILED") {
        return { kind: "error", error: `TikTok publish FAILED: ${parsed.data?.fail_reason ?? "unknown"}` };
      }
      // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SEND_TO_USER_INBOX → keep polling.
      return { kind: "continue" };
    },
    5_000,
    5 * 60_000,
  );

  if (!polled.ok) {
    return {
      ok: false,
      errorCode: polled.timedOut ? "tiktok_processing_timeout" : "tiktok_processing_error",
      errorMessage: polled.error,
      retryable: false,
    };
  }

  return {
    ok: true,
    postId: publishId,
    // platform_account_id is the open_id; TikTok will resolve the URL even
    // though it's not the @username. The frontend can substitute the real
    // username later if/when we store it.
    postUrl: `https://www.tiktok.com/@${account.platform_account_id}/video/${publishId}`,
  };
}

function mapTikTokError(
  status: number,
  body: string,
  stage: "init" | "upload",
  retryAfterHeader?: string | null,
): PublishResult {
  let message = body;
  let code = "";
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    if (parsed.error) {
      message = parsed.error.message ?? body;
      code = parsed.error.code ?? "";
    }
  } catch {
    // raw
  }

  // TikTok's Direct Post 429s reliably include Retry-After in seconds.
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? undefined;

  if (status === 401 || code === "access_token_invalid") {
    return {
      ok: false,
      errorCode: "token_expired",
      errorMessage: `TikTok ${stage} 401: ${message.slice(0, 200)}`,
      retryable: true,
    };
  }
  if (status === 403 || code === "scope_not_authorized") {
    return {
      ok: false,
      errorCode: "forbidden",
      errorMessage: `TikTok ${stage} 403: ${message.slice(0, 200)}`,
      retryable: false,
    };
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return {
      ok: false,
      errorCode: "rate_limited",
      errorMessage: `TikTok ${stage} rate limited: ${message.slice(0, 200)}`,
      retryable: true,
      retryAfterMs,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      errorCode: "server_error",
      errorMessage: `TikTok ${stage} ${status}: ${message.slice(0, 200)}`,
      retryable: true,
      retryAfterMs,
    };
  }
  return {
    ok: false,
    errorCode: "tiktok_client_error",
    errorMessage: `TikTok ${stage} ${status} (code=${code}): ${message.slice(0, 200)}`,
    retryable: false,
  };
}
