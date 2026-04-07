/**
 * Video download (save) and share (link) helpers.
 *
 * downloadVideo() = SAVE the video file to device
 *   - iOS/Android: fetch blob (with timeout) → navigator.share({ files })
 *     Falls back to navigator.share({ url }) if blob is too slow / CORS fails
 *   - macOS Safari: direct anchor download
 *   - Desktop Chrome/Edge/Firefox: blob anchor download
 *
 * shareVideo() = SHARE the video link (URL only, no file)
 *   - All platforms: navigator.share({ url }) or clipboard copy
 */

import { createScopedLogger } from "@/lib/logger";

const log = createScopedLogger("Download");

let saveInProgress = false;

/**
 * Blob fetch timeouts for mobile share sheet.
 * iOS Safari needs the share() call within the user gesture chain.
 * Videos need more time — iOS 15+ preserves the gesture through async fetch chains.
 */
const MOBILE_VIDEO_BLOB_TIMEOUT_MS = 20_000;
const MOBILE_IMAGE_BLOB_TIMEOUT_MS = 10_000;

function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isSafari =
    /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|Edg/i.test(ua);
  const isMacSafari = /Macintosh/i.test(ua) && isSafari;
  const isMobile = isIOS || isAndroid;
  return { isIOS, isAndroid, isSafari, isMacSafari, isMobile };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.blob();
}

/**
 * Race a blob fetch against a tight timeout so the user gesture
 * stays valid for navigator.share() on mobile Safari.
 */
async function fetchBlobWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Blob | null> {
  try {
    const blob = await Promise.race<Blob | null>([
      fetchAsBlob(url),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
    return blob;
  } catch (e) {
    log.warn("Blob fetch error:", e);
    return null;
  }
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }, 5000);
}

function triggerDirectDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.target = "_blank";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 1000);
}

// ── DOWNLOAD / SAVE VIDEO FILE ──────────────────────────────────────

/**
 * Save the video file to the user's device.
 *
 * iOS/Android strategy (preserves user gesture for share sheet):
 *   1. Race blob fetch vs 3 s timeout
 *      → If blob arrives: navigator.share({ files }) — full save sheet
 *        (Save Video · Save to Files · AirDrop · Messages · Mail …)
 *   2. If blob was too slow or CORS blocked:
 *      → navigator.share({ url }) — share-link sheet
 *        (Messages · Mail · Copy · social media)
 *   3. Last resort: open video in new tab
 *
 * Desktop: standard anchor / blob download.
 */
export async function downloadVideo(
  url: string,
  filename = "video.mp4",
  _userGesture = false,
): Promise<void> {
  if (!url) return;
  if (saveInProgress) {
    log.debug("Save already in progress");
    return;
  }
  saveInProgress = true;

  const { isIOS, isAndroid, isMacSafari } = detectPlatform();
  log.debug("Save video", { filename, isIOS, isAndroid, isMacSafari });

  try {
    // ── Mobile (iOS + Android): native share sheet ──────────────────
    if (isIOS || isAndroid) {
      // Step 1: Fetch blob, then try file share (gives "Save Video" on iOS)
      const fileShareResult = await attemptFileShare(url, filename, MOBILE_VIDEO_BLOB_TIMEOUT_MS, "video/mp4");
      if (fileShareResult === "done" || fileShareResult === "cancelled") return;

      // Step 2: Try blob URL download (works on iOS 18+ where share may fail)
      const blobDownloadResult = await attemptBlobDownload(url, filename);
      if (blobDownloadResult === "done") return;

      // Step 3: Try URL-only share (gives Messages, Mail, social, Copy)
      const urlShareResult = await attemptUrlShare(url, filename);
      if (urlShareResult === "done" || urlShareResult === "cancelled") return;

      // Step 4: Open in new tab — user can long-press or use Safari share
      log.debug("Mobile: all save attempts failed — opening in new tab");
      window.open(url, "_blank");
      return;
    }

    // ── macOS Safari: direct anchor (avoids blob stall on large files) ──
    if (isMacSafari) {
      log.debug("macOS Safari: direct download");
      triggerDirectDownload(url, filename);
      return;
    }

    // ── Desktop Chrome / Edge / Firefox: blob download ──
    log.debug("Desktop: blob download");
    const blob = await fetchAsBlob(url);
    triggerBlobDownload(blob, filename);
  } catch (e) {
    log.warn("Save failed, opening video URL:", e);
    window.open(url, "_blank");
  } finally {
    saveInProgress = false;
  }
}

// ── Mobile share helpers ────────────────────────────────────────────

type ShareOutcome = "done" | "cancelled" | "failed";

/** Cached blob from file share attempt — reused by blob download fallback. */
let cachedBlob: Blob | null = null;

/**
 * Fetch blob then open share sheet with the file.
 * Skips the canShare guard (broken on iOS 18+) and just tries share() directly.
 */
async function attemptFileShare(
  url: string,
  filename: string,
  timeoutMs = MOBILE_VIDEO_BLOB_TIMEOUT_MS,
  mimeType = "video/mp4",
): Promise<ShareOutcome> {
  if (!navigator.share) return "failed";

  try {
    log.debug("Mobile: fetching blob (timeout %dms)…", timeoutMs);
    const blob = await fetchBlobWithTimeout(url, timeoutMs);
    cachedBlob = blob;

    if (!blob) {
      log.debug("Mobile: blob timed out or failed — skipping file share");
      return "failed";
    }

    const file = new File([blob], filename, { type: mimeType });

    // Skip canShare guard — iOS 18 may return false but share() still works.
    // Just try it directly and catch failures.
    log.debug("Mobile: opening share sheet with file (%s, %d bytes)", mimeType, blob.size);
    await navigator.share({ files: [file] });
    log.debug("Mobile: file share completed");
    return "done";
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      log.debug("Mobile: user cancelled file share");
      return "cancelled";
    }
    log.warn("Mobile: file share failed:", e);
    return "failed";
  }
}

/**
 * Fallback: create a blob URL and trigger download via anchor tag.
 * Works on iOS 18+ Safari where share({ files }) may not show Save option.
 * Uses cached blob from attemptFileShare if available.
 */
async function attemptBlobDownload(
  url: string,
  filename: string,
): Promise<ShareOutcome> {
  try {
    const blob = cachedBlob || await fetchBlobWithTimeout(url, MOBILE_VIDEO_BLOB_TIMEOUT_MS);
    cachedBlob = null; // clear cache

    if (!blob) {
      log.debug("Mobile: no blob for download fallback");
      return "failed";
    }

    log.debug("Mobile: trying blob URL download (%d bytes)", blob.size);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    // Clean up after delay
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    }, 10000);

    return "done";
  } catch (e) {
    log.warn("Mobile: blob download failed:", e);
    cachedBlob = null;
    return "failed";
  }
}

/**
 * Open share sheet with just the video URL (no file download needed).
 * Works even when blob fetch failed — still lets user text, email, etc.
 */
async function attemptUrlShare(
  url: string,
  filename: string,
): Promise<ShareOutcome> {
  if (!navigator.share) return "failed";

  try {
    const title = filename.replace(/\.\w+$/, "").replace(/_/g, " ");
    log.debug("Mobile: opening share sheet with URL");
    await navigator.share({ url, title });
    log.debug("Mobile: URL share completed");
    return "done";
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      log.debug("Mobile: user cancelled URL share");
      return "cancelled";
    }
    log.warn("Mobile: URL share failed:", e);
    return "failed";
  }
}

// ── DOWNLOAD / SAVE IMAGE FILE ──────────────────────────────────────

/**
 * Save an image file to the user's device.
 *
 * iOS/Android: navigator.share({ files }) → shows "Save Image" in share sheet.
 * Desktop: standard blob anchor download.
 */
export async function downloadImage(
  url: string,
  filename = "image.png",
): Promise<void> {
  if (!url) return;

  const { isIOS, isAndroid, isMacSafari } = detectPlatform();
  log.debug("Save image", { filename, isIOS, isAndroid });

  // Detect MIME type from URL extension
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  const mime = mimeMap[ext] || "image/png";

  try {
    // ── Mobile: native share sheet with image file ──────────────────
    if (isIOS || isAndroid) {
      // Step 1: Try file share (gives "Save Image" on iOS)
      const fileResult = await attemptFileShare(url, filename, MOBILE_IMAGE_BLOB_TIMEOUT_MS, mime);
      if (fileResult === "done" || fileResult === "cancelled") return;

      // Step 2: Try blob URL download (iOS 18+ fallback)
      const blobResult = await attemptBlobDownload(url, filename);
      if (blobResult === "done") return;

      // Step 3: Share URL (no "Save Image" but still useful)
      const urlResult = await attemptUrlShare(url, filename);
      if (urlResult === "done" || urlResult === "cancelled") return;

      // Step 4: Open in new tab — user can long-press to save
      window.open(url, "_blank");
      return;
    }

    // ── macOS Safari: direct anchor ──
    if (isMacSafari) {
      triggerDirectDownload(url, filename);
      return;
    }

    // ── Desktop: blob download ──
    const blob = await fetchAsBlob(url);
    triggerBlobDownload(blob, filename);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return; // user cancelled
    log.warn("Image save failed, opening in new tab:", e);
    window.open(url, "_blank");
  }
}

// ── SHARE VIDEO LINK (URL ONLY) ─────────────────────────────────────

/**
 * Share the video link (URL). Does NOT send the file — just the link.
 * For texting, social media, email, etc.
 */
export async function shareVideo(
  url: string,
  _filename = "video.mp4",
): Promise<boolean> {
  if (!url) return false;

  // Try native share with URL only
  if (navigator.share) {
    try {
      await navigator.share({ url, title: "Check out this video" });
      return true;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return true;
      log.warn("URL share failed:", e);
    }
  }

  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}
