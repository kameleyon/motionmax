/**
 * Platform-aware video download and share helpers.
 * Handles iOS Safari/Chrome, Android, and desktop download strategies.
 */

const LOG = "[Export:Download]";

/** Share video using the Web Share API (primarily for mobile) */
export async function shareVideo(url: string, filename = "video.mp4"): Promise<boolean> {
  if (!url) return false;
  try {
    console.log(LOG, "Attempting share", { filename });
    const response = await fetch(url);
    const blob = await response.blob();
    const file = new File([blob], filename, { type: "video/mp4" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      console.log(LOG, "Share successful");
      return true;
    }
    console.log(LOG, "Share API not available for this content");
  } catch (e) {
    console.warn(LOG, "Share failed:", e);
  }
  return false;
}

/** Download video with platform-specific strategies */
export async function downloadVideo(url: string, filename = "video.mp4"): Promise<void> {
  if (!url) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOSChrome = isIOS && /CriOS/i.test(navigator.userAgent);

  console.log(LOG, "Starting download", { filename, isIOS, isAndroid, isIOSChrome });

  // ---- iOS ----
  if (isIOS) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const file = new File([blob], filename, { type: "video/mp4" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        console.log(LOG, "iOS: using Share API");
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      console.warn(LOG, "iOS share failed:", e);
    }

    // iOS Chrome: open in same tab
    if (isIOSChrome) {
      try {
        console.log(LOG, "iOS Chrome: navigating to blob URL");
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        window.location.href = blobUrl;
        return;
      } catch (e) {
        console.warn(LOG, "iOS Chrome blob navigation failed:", e);
        alert("To save the video: Long-press on the video above and select 'Save Video'");
        return;
      }
    }

    // iOS Safari fallback: data URL
    try {
      console.log(LOG, "iOS Safari: using data URL fallback");
      const response = await fetch(url);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        const a = document.createElement("a");
        a.href = reader.result as string;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        console.log(LOG, "iOS Safari: data URL download triggered");
      };
      reader.readAsDataURL(blob);
      return;
    } catch (e) {
      console.warn(LOG, "iOS data URL download failed:", e);
      alert("To save the video: Long-press on the video above and select 'Save Video'");
      return;
    }
  }

  // ---- Android ----
  if (isAndroid) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const file = new File([blob], filename, { type: "video/mp4" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        console.log(LOG, "Android: using Share API");
        await navigator.share({ files: [file], title: filename });
        return;
      }

      console.log(LOG, "Android: using anchor download");
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
      }, 1000);
      return;
    } catch (e) {
      console.warn(LOG, "Android download failed:", e);
      alert("To save the video: Long-press on the video above and select 'Download video'");
      return;
    }
  }

  // ---- Desktop ----
  try {
    console.log(LOG, "Desktop: using anchor download");
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  } catch (e) {
    console.warn(LOG, "Desktop download failed:", e);
    window.open(url, "_blank");
  }
}
