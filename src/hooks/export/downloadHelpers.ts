/**
 * Platform-aware video download and share helpers.
 *
 * Browser strategies:
 *   - iOS Safari/Chrome: Open URL directly → native video player with share/save
 *   - Android Chrome: Open URL directly → native download manager
 *   - macOS Safari: Direct anchor link (avoids blob memory issues on large files)
 *   - Desktop Chrome/Edge/Firefox: Blob anchor download (reliable for any size)
 *   - Fallback: window.open in new tab
 */

const LOG = "[Export:Download]";

/** Guard against concurrent navigator.share() calls */
let shareInProgress = false;

/** Detect platform once */
function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|Edg/i.test(ua);
  const isMacSafari = /Macintosh/i.test(ua) && isSafari;
  const isFirefox = /Firefox/i.test(ua);
  const isMobile = isIOS || isAndroid;
  return { isIOS, isAndroid, isSafari, isMacSafari, isFirefox, isMobile };
}

/** Fetch video URL as a Blob (works for cross-origin Supabase Storage URLs) */
async function fetchAsBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  return response.blob();
}

/** Create a temporary blob anchor and trigger download */
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

/**
 * Open the URL directly — lets the browser's native handler take over.
 * Safari shows the video player with share/save. Chrome triggers download manager.
 */
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

/** Share video using the Web Share API (primarily for mobile) */
export async function shareVideo(url: string, filename = "video.mp4"): Promise<boolean> {
  if (!url) return false;
  if (shareInProgress) {
    console.log(LOG, "Share already in progress, skipping");
    return false;
  }
  try {
    shareInProgress = true;
    console.log(LOG, "Attempting share", { filename });

    // Try sharing the URL directly first (no blob download needed)
    if (navigator.share) {
      try {
        await navigator.share({ url, title: filename });
        console.log(LOG, "Share URL successful");
        return true;
      } catch (e: any) {
        if (e?.name === "AbortError") return true;
        console.log(LOG, "URL share failed, trying file share");
      }
    }

    // Fallback: download as blob and share as file
    const blob = await fetchAsBlob(url);
    const file = new File([blob], filename, { type: "video/mp4" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      console.log(LOG, "Share file successful");
      return true;
    }
    console.log(LOG, "Share API not available for this content");
  } catch (e) {
    console.warn(LOG, "Share failed:", e);
  } finally {
    shareInProgress = false;
  }
  return false;
}

/**
 * Download video with platform-specific strategies.
 *
 * @param userGesture Pass true when called from a click handler.
 */
export async function downloadVideo(url: string, filename = "video.mp4", userGesture = false): Promise<void> {
  if (!url) return;

  const { isIOS, isAndroid, isSafari, isMacSafari, isMobile } = detectPlatform();
  console.log(LOG, "Starting download", { filename, isIOS, isAndroid, isSafari, isMacSafari, isMobile, userGesture });

  try {
    // ── iOS (Safari + Chrome): open URL directly ──
    // iOS cannot download files via blob or anchor. Opening the URL triggers
    // the native video player where the user can tap share → Save Video.
    // This MUST happen synchronously from the user gesture — no await before it.
    if (isIOS) {
      console.log(LOG, "iOS: opening URL directly for native save");
      window.open(url, "_blank");
      return;
    }

    // ── Android: open URL directly ──
    // Android Chrome's download manager handles direct URLs reliably.
    // Blob downloads often fail on older Android or low-memory devices.
    if (isAndroid) {
      console.log(LOG, "Android: direct link download");
      triggerDirectDownload(url, filename);
      return;
    }

    // ── macOS Safari: direct link (avoids blob memory issue) ──
    if (isMacSafari) {
      console.log(LOG, "macOS Safari: direct link download");
      triggerDirectDownload(url, filename);
      return;
    }

    // ── Desktop Chrome, Edge, Firefox, Opera: blob anchor ──
    console.log(LOG, "Desktop: blob anchor download");
    const blob = await fetchAsBlob(url);
    triggerBlobDownload(blob, filename);

  } catch (e) {
    // Last resort: open in new tab
    console.warn(LOG, "Download failed, opening in new tab:", e);
    window.open(url, "_blank");
  }
}
