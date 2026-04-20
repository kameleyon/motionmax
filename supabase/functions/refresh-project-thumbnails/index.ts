import { createClient } from "npm:@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { refreshSignedUrl } from "../_shared/signedUrlHelper.ts";

// refreshSignedUrl, extractStoragePath, and isSignedUrl are imported from
// ../_shared/signedUrlHelper.ts (consolidated from the former local copies).

interface ThumbnailRequest {
  projectId: string;
  thumbnailUrl: string | null;
}

interface ThumbnailResponse {
  projectId: string;
  thumbnailUrl: string | null;
}

export async function handler(req: Request): Promise<Response> {
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

    // Rate limit
    const rateLimitResult = await checkRateLimit(supabase, {
      key: "refresh-thumbnails",
      maxRequests: 3,
      windowSeconds: 60,
      userId: user?.id,
    });
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 429,
      });
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
}
Deno.serve(handler);
