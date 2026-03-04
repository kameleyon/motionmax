import { useState, useCallback } from "react";
import JSZip from "jszip";

interface Scene {
  number: number;
  imageUrl?: string;
  imageUrls?: string[];
}

interface ZipDownloadState {
  status: "idle" | "downloading" | "zipping" | "complete" | "error";
  progress: number;
  error?: string;
}

export function useImagesZipDownload() {
  const [state, setState] = useState<ZipDownloadState>({ status: "idle", progress: 0 });

  const downloadImagesAsZip = useCallback(async (scenes: Scene[], projectTitle: string) => {
    setState({ status: "downloading", progress: 0 });

    try {
      // Collect all image URLs from scenes
      const imageEntries: { url: string; filename: string }[] = [];
      
      scenes.forEach((scene) => {
        if (scene.imageUrls && scene.imageUrls.length > 0) {
          scene.imageUrls.forEach((url, imgIdx) => {
            imageEntries.push({
              url,
              filename: `scene_${String(scene.number).padStart(2, "0")}_image_${imgIdx + 1}.png`,
            });
          });
        } else if (scene.imageUrl) {
          imageEntries.push({
            url: scene.imageUrl,
            filename: `scene_${String(scene.number).padStart(2, "0")}.png`,
          });
        }
      });

      if (imageEntries.length === 0) {
        setState({ status: "error", progress: 0, error: "No images to download" });
        return;
      }

      const zip = new JSZip();
      const folder = zip.folder("images");
      
      if (!folder) {
        setState({ status: "error", progress: 0, error: "Failed to create zip folder" });
        return;
      }

      // Download images with concurrency limit to avoid overwhelming the browser
      const CONCURRENCY = 4;
      let completed = 0;

      const downloadOne = async ({ url, filename }: { url: string; filename: string }) => {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            console.warn(`Failed to fetch image: ${url}`);
            return;
          }
          const blob = await response.blob();
          folder.file(filename, blob);
        } catch (err) {
          console.warn(`Error fetching image ${url}:`, err);
        } finally {
          completed++;
          setState({ status: "downloading", progress: Math.round((completed / imageEntries.length) * 80) });
        }
      };

      // Process in batches of CONCURRENCY
      for (let i = 0; i < imageEntries.length; i += CONCURRENCY) {
        const batch = imageEntries.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(downloadOne));
      }

      setState({ status: "zipping", progress: 90 });

      // Generate zip file
      const zipBlob = await zip.generateAsync({ type: "blob" });
      
      // Trigger download
      const safeName = projectTitle.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "images";
      const downloadUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `${safeName}_images.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);

      setState({ status: "complete", progress: 100 });
      
      // Reset after a short delay
      setTimeout(() => {
        setState({ status: "idle", progress: 0 });
      }, 2000);
    } catch (err) {
      setState({ 
        status: "error", 
        progress: 0, 
        error: err instanceof Error ? err.message : "Failed to create zip" 
      });
    }
  }, []);

  const reset = useCallback(() => {
    setState({ status: "idle", progress: 0 });
  }, []);

  return { state, downloadImagesAsZip, reset };
}
