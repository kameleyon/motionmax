/**
 * Platform-aware video download and share helpers.
 * Handles iOS Safari/Chrome, Android, macOS Safari, and desktop strategies.
 *
 * Key browser considerations:
 *   - Safari (macOS): Blob downloads fail silently on large files. Use direct
 *     link with Content-Disposition or window.open fallback.
 *   - Safari (iOS): No filesystem download. Must use Web Share API.
 *   - Chrome/Edge/Firefox: Blob anchor works reliably for all sizes.
 *   - Firefox: Respects `a.download` attribute on same-origin and blob URLs.
 *   - All browsers: `a.click()` must happen in the same task as the user
 *     gesture or within a short microtask. Long async gaps (e.g. fetching a
 *     200MB file) break the gesture chain and browsers silently block the click.
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
  const isIOSChrome = isIOS && /CriOS/i.test(ua);
  const isFirefox = /Firefox/i.test(ua);
  const isMobile = isIOS || isAndroid;
  return { isIOS, isAndroid, isSafari, isMacSafari, isIOSChrome, isFirefox, isMobile };
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
 * Open the URL directly in a new tab / trigger native download.
 * Safari handles this reliably for large files — the browser's native
 * download manager takes over instead of loading into JS memory.
 */
function triggerDirectDownload(url: string, filename: string): void {
  // Try anchor with download attribute first (same-origin or CORS-allowed)
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.target = "_blank";        // fallback: opens in new tab if download blocked
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
 * Download video with platform-specific strategies.
 *
 * @param userGesture Pass true when called from a click handler (enables Share API on mobile).
 *                    Auto-downloads from useEffect should pass false to avoid gesture errors.
 */
export async function downloadVideo(url: string, filename = "video.mp4", userGesture = false): Promise<void> {
  if (!url) return;

  const { isIOS, isAndroid, isSafari, isMacSafari, isFirefox, isMobile } = detectPlatform();
  console.log(LOG, "Starting download", { filename, isIOS, isAndroid, isSafari, isMacSafari, isFirefox, isMobile, userGesture });

  try {
    // ── Mobile (iOS + Android): Web Share API for saving files ──
    if (isMobile) {
      const blob = await fetchAsBlob(url);
      const file = new File([blob], filename, { type: "video/mp4" });
      if (!shareInProgress && navigator.share) {
        try {
          shareInProgress = true;
          console.log(LOG, "Mobile: using Share API to save file");
          await navigator.share({ files: [file], title: filename });
          console.log(LOG, "Mobile: Share API save successful");
          return;
        } catch (shareErr: any) {
          if (shareErr?.name === 'AbortError') {
            console.log(LOG, "Mobile: user cancelled share dialog");
            return;
          }
          console.warn(LOG, "Mobile: Share API failed, trying blob download:", shareErr);
        } finally {
          shareInProgress = false;
        }
      }
      // Fallback: blob anchor (may open in browser on iOS)
      console.log(LOG, "Mobile: fallback blob anchor download");
      triggerBlobDownload(blob, filename);
      return;
    }

    // ── macOS Safari: direct link download (avoid blob for large files) ──
    // Safari silently fails on large blob downloads because the fetch-to-blob
    // breaks the user gesture chain. Instead, trigger the browser's native
    // download manager via a direct link.
    if (isMacSafari) {
      console.log(LOG, "macOS Safari: direct link download (avoids blob memory issue)");
      triggerDirectDownload(url, filename);
      return;
    }

    // ── Desktop Chrome, Edge, Firefox, Opera: blob anchor download ──
    // These browsers handle blob downloads reliably for any file size.
    console.log(LOG, "Desktop: blob anchor download");
    const blob = await fetchAsBlob(url);
    triggerBlobDownload(blob, filename);

  } catch (e) {
    // Last resort: open in new tab so the user can right-click → Save As
    console.warn(LOG, "Download failed, opening in new tab:", e);
    window.open(url, "_blank");
  }
}
