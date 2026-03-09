/**
 * Platform-aware video download and share helpers.
 * Handles iOS Safari/Chrome, Android, macOS Safari, and desktop strategies.
 * Always fetches as blob to ensure cross-origin downloads work correctly.
 */

const LOG = "[Export:Download]";

/** Guard against concurrent navigator.share() calls */
let shareInProgress = false;

/** Detect platform once */
function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMacSafari = /Macintosh.*Safari/i.test(ua) && !/Chrome|CriOS|FxiOS/i.test(ua);
  const isIOSChrome = isIOS && /CriOS/i.test(ua);
  const isMobile = isIOS || isAndroid;
  return { isIOS, isAndroid, isMacSafari, isIOSChrome, isMobile };
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
  }, 3000);
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
    const blob = await fetchAsBlob(url);
    const file = new File([blob], filename, { type: "video/mp4" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      console.log(LOG, "Share successful");
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
 * Download video with platform-specific strategies — always blob-based for cross-origin.
 * @param userGesture Pass true when called from a click handler (enables Share API on mobile).
 *                    Auto-downloads from useEffect should pass false to avoid gesture errors.
 */
export async function downloadVideo(url: string, filename = "video.mp4", userGesture = false): Promise<void> {
  if (!url) return;

  const { isIOS, isAndroid, isMacSafari, isIOSChrome, isMobile } = detectPlatform();
  console.log(LOG, "Starting download", { filename, isIOS, isAndroid, isMacSafari, isMobile, userGesture });

  try {
    const blob = await fetchAsBlob(url);

    // ---- iOS ----
    if (isIOS) {
      // Only try Share API if triggered by a real user gesture (tap/click)
      if (userGesture && !shareInProgress) {
        const file = new File([blob], filename, { type: "video/mp4" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            shareInProgress = true;
            console.log(LOG, "iOS: using Share API for save-to-files");
            await navigator.share({ files: [file], title: filename });
            return;
          } catch (shareErr) {
            console.warn(LOG, "iOS share cancelled:", shareErr);
          } finally {
            shareInProgress = false;
          }
        }
      }
      // iOS Chrome: navigate to blob URL (triggers "Open in..." dialog)
      if (isIOSChrome) {
        console.log(LOG, "iOS Chrome: navigating to blob URL");
        window.location.href = URL.createObjectURL(blob);
        return;
      }
      // iOS Safari fallback: blob anchor download
      console.log(LOG, "iOS Safari: blob anchor download");
      triggerBlobDownload(blob, filename);
      return;
    }

    // ---- Android ----
    if (isAndroid) {
      if (userGesture && !shareInProgress) {
        const file = new File([blob], filename, { type: "video/mp4" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            shareInProgress = true;
            console.log(LOG, "Android: using Share API");
            await navigator.share({ files: [file], title: filename });
            return;
          } catch (shareErr) {
            console.warn(LOG, "Android share cancelled:", shareErr);
          } finally {
            shareInProgress = false;
          }
        }
      }
      console.log(LOG, "Android: blob anchor download");
      triggerBlobDownload(blob, filename);
      return;
    }

    // ---- macOS Safari: blob anchor ----
    if (isMacSafari) {
      console.log(LOG, "macOS Safari: blob anchor download");
      triggerBlobDownload(blob, filename);
      return;
    }

    // ---- Desktop (Chrome, Firefox, Edge): blob anchor download ----
    console.log(LOG, "Desktop: blob anchor download");
    triggerBlobDownload(blob, filename);

  } catch (e) {
    console.warn(LOG, "Download failed, opening in new tab:", e);
    window.open(url, "_blank");
  }
}
