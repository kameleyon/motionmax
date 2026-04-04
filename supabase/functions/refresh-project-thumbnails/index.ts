import { createClient } from "npm:@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

// Extract storage path from a signed URL
function extractStoragePath(signedUrl: string): string | null {
  try {
    const url = new URL(signedUrl);
    // Path format: /storage/v1/object/sign/bucket/path/to/file
    const pathMatch = url.pathname.match(/\/storage\/v1\/object\/sign\/(.+)/);
    if (pathMatch) {
      return pathMatch[1]; // Returns "bucket/path/to/file"
    }
    return null;
  } catch {
    return null;
  }
}

// Check if a URL is a signed URL that might need refreshing
function isSignedUrl(url: string): boolean {
  return url?.includes("/storage/v1/object/sign/");
}

// Generate a fresh signed URL from an old one
async function refreshSignedUrl(
  supabase: any,
  oldUrl: string,
  expiresIn: number = 604800 // 7 days
): Promise<string> {
  if (!oldUrl || !isSignedUrl(oldUrl)) {
    return oldUrl; // Return as-is if not a signed URL
  }

  const fullPath = extractStoragePath(oldUrl);
  if (!fullPath) {
    return oldUrl;
  }

  // Split bucket from path
  const slashIndex = fullPath.indexOf("/");
  if (slashIndex === -1) {
    return oldUrl;
  }

  const bucket = fullPath.substring(0, slashIndex);
  const path = fullPath.substring(slashIndex + 1);

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn);

    if (error || !data?.signedUrl) {
      console.error(`[refresh-thumbnails] Failed to refresh URL: ${path}`, error);
      return oldUrl; // Fallback to original
    }

    return data.signedUrl;
  } catch (err) {
    console.error(`[refresh-thumbnails] Error refreshing URL:`, err);
    return oldUrl;
  }
}

interface ThumbnailRequest {
  projectId: string;
  thumbnailUrl: string | null;
}

interface ThumbnailResponse {
  projectId: string;
  thumbnailUrl: string | null;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Not authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify auth and extract user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { thumbnails } = await req.json() as { thumbnails: ThumbnailRequest[] };

    if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
      return new Response(
        JSON.stringify({ error: "No thumbnails to refresh" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify ownership: only refresh thumbnails for projects the user owns
    const requestedIds = thumbnails.map(t => t.projectId);
    const { data: ownedProjects } = await supabase
      .from("projects")
      .select("id")
      .eq("user_id", user.id)
      .in("id", requestedIds);

    const ownedIds = new Set((ownedProjects ?? []).map((p: { id: string }) => p.id));
    const authorizedThumbnails = thumbnails.filter(t => ownedIds.has(t.projectId));

    console.log(`[refresh-thumbnails] Refreshing ${authorizedThumbnails.length}/${thumbnails.length} authorized thumbnails`);

    // Refresh authorized thumbnails in parallel
    const refreshedThumbnails: ThumbnailResponse[] = await Promise.all(
      authorizedThumbnails.map(async ({ projectId, thumbnailUrl }) => {
        if (!thumbnailUrl) {
          return { projectId, thumbnailUrl: null };
        }

        // Only refresh signed URLs
        if (isSignedUrl(thumbnailUrl)) {
          const refreshedUrl = await refreshSignedUrl(supabase, thumbnailUrl);
          return { projectId, thumbnailUrl: refreshedUrl };
        }

        return { projectId, thumbnailUrl };
      })
    );

    console.log(`[refresh-thumbnails] Successfully refreshed ${refreshedThumbnails.length} thumbnails`);

    return new Response(
      JSON.stringify({ thumbnails: refreshedThumbnails }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[refresh-thumbnails] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
