import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ThumbnailInput {
  projectId: string;
  thumbnailUrl: string | null;
}

interface ThumbnailOutput {
  projectId: string;
  thumbnailUrl: string | null;
}

// Check if a URL is a signed URL that might need refreshing
function isSignedUrl(url: string | null | undefined): boolean {
  return !!url && url.includes("/storage/v1/object/sign/");
}

/**
 * Hook to refresh expired signed URLs for project thumbnails
 */
export function useRefreshThumbnails() {
  const refreshThumbnails = useCallback(
    async (thumbnails: ThumbnailInput[]): Promise<Map<string, string | null>> => {
      const resultMap = new Map<string, string | null>();

      // Filter to only signed URLs that need refreshing
      const needsRefresh = thumbnails.filter((t) => isSignedUrl(t.thumbnailUrl));

      // If no URLs need refreshing, return original URLs
      if (needsRefresh.length === 0) {
        thumbnails.forEach((t) => resultMap.set(t.projectId, t.thumbnailUrl));
        return resultMap;
      }

      try {
        const { data: session } = await supabase.auth.getSession();
        if (!session?.session?.access_token) {
          // Not authenticated, return originals
          thumbnails.forEach((t) => resultMap.set(t.projectId, t.thumbnailUrl));
          return resultMap;
        }

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/refresh-project-thumbnails`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.session.access_token}`,
            },
            body: JSON.stringify({ thumbnails: needsRefresh }),
          }
        );

        if (!response.ok) {
          console.warn("[useRefreshThumbnails] Failed to refresh thumbnails");
          thumbnails.forEach((t) => resultMap.set(t.projectId, t.thumbnailUrl));
          return resultMap;
        }

        const data = await response.json();
        const refreshed: ThumbnailOutput[] = data.thumbnails || [];

        // Build result map with refreshed URLs
        const refreshedMap = new Map(
          refreshed.map((t) => [t.projectId, t.thumbnailUrl])
        );

        thumbnails.forEach((t) => {
          // Use refreshed URL if available, otherwise original
          const refreshedUrl = refreshedMap.get(t.projectId);
          resultMap.set(t.projectId, refreshedUrl !== undefined ? refreshedUrl : t.thumbnailUrl);
        });

        return resultMap;
      } catch (err) {
        console.error("[useRefreshThumbnails] Error:", err);
        // On error, return originals
        thumbnails.forEach((t) => resultMap.set(t.projectId, t.thumbnailUrl));
        return resultMap;
      }
    },
    []
  );

  return { refreshThumbnails };
}
