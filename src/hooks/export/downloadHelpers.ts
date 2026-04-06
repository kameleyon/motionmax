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

/** Blob fetch timeout for mobile — keeps user gesture alive for share sheet. */
const MOBILE_BLOB_TIMEOUT_MS = 3000;

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
      // Step 1: Try blob fetch + file share (gives "Save Video" on iOS)
      const fileShareResult = await attemptFileShare(url, filename);
      if (fileShareResult === "done" || fileShareResult === "cancelled") return;

      // Step 2: Try URL-only share (gives Messages, Mail, social, Copy)
      const urlShareResult = await attemptUrlShare(url, filename);
      if (urlShareResult === "done" || urlShareResult === "cancelled") return;

      // Step 3: Open in new tab — user can long-press or use Safari share
      log.debug("Mobile: all share attempts failed — opening in new tab");
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

/**
 * Fetch blob (with timeout) then open share sheet with the video file.
 * Returns quickly if blob fetch is too slow so user gesture stays valid.
 */
async function attemptFileShare(
  url: string,
  filename: string,
): Promise<ShareOutcome> {
  try {
    log.debug("Mobile: fetching blob (timeout %dms)…", MOBILE_BLOB_TIMEOUT_MS);
    const blob = await fetchBlobWithTimeout(url, MOBILE_BLOB_TIMEOUT_MS);

    if (!blob) {
      log.debug("Mobile: blob timed out or failed — skipping file share");
      return "failed";
    }

    const file = new File([blob], filename, { type: "video/mp4" });

    if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
      log.debug("Mobile: navigator.share({ files }) not supported");
      return "failed";
    }

    log.debug("Mobile: opening share sheet with video file");
    await navigator.share({ files: [file] });
    log.debug("Mobile: file share completed");
    return "done";
  } catch (e: any) {
    if (e?.name === "AbortError") {
      log.debug("Mobile: user cancelled file share");
      return "cancelled";
    }
    log.warn("Mobile: file share failed:", e);
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
  } catch (e: any) {
    if (e?.name === "AbortError") {
      log.debug("Mobile: user cancelled URL share");
      return "cancelled";
    }
    log.warn("Mobile: URL share failed:", e);
    return "failed";
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
    } catch (e: any) {
      if (e?.name === "AbortError") return true;
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
