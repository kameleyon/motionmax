/**
 * Video download (save) and share (link) helpers.
 *
 * downloadVideo() = SAVE the video file to device
 *   - iOS: navigator.share({ files }) → share sheet with "Save Video" option
 *   - Android: navigator.share({ files }) → share sheet with "Save" option
 *   - macOS Safari: direct anchor link download
 *   - Desktop Chrome/Edge/Firefox: blob anchor download
 *
 * shareVideo() = SHARE the video link (URL only, no file)
 *   - All platforms: navigator.share({ url }) or clipboard copy
 */

const LOG = "[Export:Download]";

let saveInProgress = false;

function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|Edg/i.test(ua);
  const isMacSafari = /Macintosh/i.test(ua) && isSafari;
  const isMobile = isIOS || isAndroid;
  return { isIOS, isAndroid, isSafari, isMacSafari, isMobile };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.blob();
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 5000);
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
 * On iOS/Android: fetches the video as a blob, wraps it in a File object,
 * and opens the native share sheet via navigator.share({ files }).
 * The share sheet shows "Save Video" (iOS) or "Save to device" (Android).
 *
 * On desktop: triggers a standard file download.
 */
export async function downloadVideo(url: string, filename = "video.mp4", _userGesture = false): Promise<void> {
  if (!url) return;
  if (saveInProgress) { console.log(LOG, "Save already in progress"); return; }
  saveInProgress = true;

  const { isIOS, isAndroid, isMacSafari } = detectPlatform();
  console.log(LOG, "Save video", { filename, isIOS, isAndroid, isMacSafari });

  try {
    // ── Mobile (iOS + Android): fetch as file → native share sheet ──
    if (isIOS || isAndroid) {
      console.log(LOG, "Mobile: fetching video blob for save...");

      try {
        const blob = await fetchAsBlob(url);
        const file = new File([blob], filename, { type: "video/mp4" });

        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          console.log(LOG, "Mobile: opening share sheet with video file");
          await navigator.share({ files: [file] });
          console.log(LOG, "Mobile: save/share completed");
          return;
        }
      } catch (e: any) {
        if (e?.name === "AbortError") { console.log(LOG, "Mobile: user cancelled"); return; }
        console.warn(LOG, "Mobile: file share failed:", e);
      }

      // Fallback: navigate to the video URL (opens in native player → user can save from there)
      console.log(LOG, "Mobile: fallback — opening video in native player");
      window.location.href = url;
      return;
    }

    // ── macOS Safari: direct anchor (avoids blob memory stall on large files) ──
    if (isMacSafari) {
      console.log(LOG, "macOS Safari: direct download");
      triggerDirectDownload(url, filename);
      return;
    }

    // ── Desktop Chrome / Edge / Firefox: blob download ──
    console.log(LOG, "Desktop: blob download");
    const blob = await fetchAsBlob(url);
    triggerBlobDownload(blob, filename);

  } catch (e) {
    console.warn(LOG, "Save failed, opening video URL:", e);
    window.open(url, "_blank");
  } finally {
    saveInProgress = false;
  }
}

// ── SHARE VIDEO LINK (URL ONLY) ─────────────────────────────────────

/**
 * Share the video link (URL). Does NOT send the file — just the link.
 * For texting, social media, email, etc.
 */
export async function shareVideo(url: string, _filename = "video.mp4"): Promise<boolean> {
  if (!url) return false;

  // Try native share with URL only
  if (navigator.share) {
    try {
      await navigator.share({ url, title: "Check out this video" });
      return true;
    } catch (e: any) {
      if (e?.name === "AbortError") return true;
      console.warn(LOG, "URL share failed:", e);
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
