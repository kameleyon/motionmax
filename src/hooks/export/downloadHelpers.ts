/**
 * Platform-aware video download and share helpers.
 *
 * Browser strategies:
 *   - iOS Safari/Chrome: Share as File via Web Share API → "Save Video" appears
 *   - Android Chrome: Share as File → system save/share dialog
 *   - macOS Safari: Direct anchor link (avoids blob memory issues)
 *   - Desktop Chrome/Edge/Firefox: Blob anchor download
 *   - Fallback: window.open in new tab
 */

const LOG = "[Export:Download]";

/** Guard against concurrent share/download calls */
let operationInProgress = false;

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

/** Fetch video URL as a Blob */
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

/** Direct anchor link download — browser's native handler takes over */
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

/**
 * Share a video file via Web Share API.
 * Fetches blob → creates File → navigator.share({ files: [...] })
 * This is the ONLY way to get "Save Video" / "Save to Photos" on iOS.
 */
async function shareAsFile(url: string, filename: string): Promise<boolean> {
  if (!navigator.share || !navigator.canShare) return false;

  try {
    console.log(LOG, "Fetching video for file share...");
    const blob = await fetchAsBlob(url);
    const file = new File([blob], filename, { type: "video/mp4" });

    if (!navigator.canShare({ files: [file] })) {
      console.log(LOG, "canShare returned false for video file");
      return false;
    }

    await navigator.share({ files: [file], title: filename });
    console.log(LOG, "File share successful");
    return true;
  } catch (e: any) {
    if (e?.name === "AbortError") return true; // user cancelled = handled
    console.warn(LOG, "File share failed:", e);
    return false;
  }
}

/** Share video using the Web Share API (for share buttons, not download) */
export async function shareVideo(url: string, filename = "video.mp4"): Promise<boolean> {
  if (!url || operationInProgress) return false;
  operationInProgress = true;
  try {
    // Try sharing URL directly (lighter, for messaging apps)
    if (navigator.share) {
      try {
        await navigator.share({ url, title: filename });
        return true;
      } catch (e: any) {
        if (e?.name === "AbortError") return true;
      }
    }
    return false;
  } finally {
    operationInProgress = false;
  }
}

/**
 * Download/save video with platform-specific strategies.
 */
export async function downloadVideo(url: string, filename = "video.mp4", userGesture = false): Promise<void> {
  if (!url) return;
  if (operationInProgress) {
    console.log(LOG, "Operation already in progress, skipping");
    return;
  }
  operationInProgress = true;

  const { isIOS, isAndroid, isMacSafari, isMobile } = detectPlatform();
  console.log(LOG, "Starting download", { filename, isIOS, isAndroid, isMacSafari, isMobile, userGesture });

  try {
    // ── iOS: share as File to get "Save Video" in share sheet ──
    if (isIOS) {
      console.log(LOG, "iOS: sharing as file for Save Video option");
      const shared = await shareAsFile(url, filename);
      if (shared) return;

      // Fallback: open in new tab (user can long-press video to save)
      console.log(LOG, "iOS: fallback — opening in new tab");
      window.open(url, "_blank");
      return;
    }

    // ── Android: share as File → direct link fallback ──
    if (isAndroid) {
      console.log(LOG, "Android: sharing as file for save option");
      const shared = await shareAsFile(url, filename);
      if (shared) return;

      console.log(LOG, "Android: fallback — direct link download");
      triggerDirectDownload(url, filename);
      return;
    }

    // ── macOS Safari: direct link (avoids blob memory stall) ──
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
    console.warn(LOG, "Download failed, opening in new tab:", e);
    window.open(url, "_blank");
  } finally {
    operationInProgress = false;
  }
}
