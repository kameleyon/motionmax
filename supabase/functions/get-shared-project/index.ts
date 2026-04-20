import { createClient } from "npm:@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { refreshSignedUrl } from "../_shared/signedUrlHelper.ts";

interface Scene {
  imageUrl?: string;
  imageUrls?: string[];
  audioUrl?: string;
  videoUrl?: string;
  duration?: number;
  narration?: string;
  voiceover?: string;
  [key: string]: unknown;
}

// refreshSignedUrl is imported from ../_shared/signedUrlHelper.ts

// Refresh all URLs in a scene
async function refreshSceneUrls(
  supabase: any,
  scene: Scene
): Promise<Scene> {
  const refreshedScene = { ...scene };

  // Refresh single imageUrl
  if (refreshedScene.imageUrl) {
    refreshedScene.imageUrl = await refreshSignedUrl(supabase, refreshedScene.imageUrl);
  }

  // Refresh imageUrls array
  if (Array.isArray(refreshedScene.imageUrls)) {
    refreshedScene.imageUrls = await Promise.all(
      refreshedScene.imageUrls.map((url) => refreshSignedUrl(supabase, url))
    );
  }

  // Refresh audioUrl
  if (refreshedScene.audioUrl) {
    refreshedScene.audioUrl = await refreshSignedUrl(supabase, refreshedScene.audioUrl);
  }

  // Refresh videoUrl
  if (refreshedScene.videoUrl) {
    refreshedScene.videoUrl = await refreshSignedUrl(supabase, refreshedScene.videoUrl);
  }

  return refreshedScene;
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  try {
    const { token } = await req.json();

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Share token is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[get-shared-project] Fetching share: ${token}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rateLimitResult = await checkRateLimit(supabase, {
      key: "get-shared-project",
      maxRequests: 30,
      windowSeconds: 60,
      ip,
    });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use the existing RPC function to get the base data
    const { data: shared, error: sharedError } = await supabase.rpc(
      "get_shared_project",
      { share_token_param: token }
    );

    if (sharedError || !shared) {
      console.error("[get-shared-project] Share not found:", token, sharedError);
      return new Response(
        JSON.stringify({ error: "Share not found or expired" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sharedData = shared as {
      project: {
        id: string;
        title: string;
        format: string;
        style: string;
        description: string | null;
      };
      scenes: Scene[];
      share: { id: string; view_count: number };
    };

    // Refresh all scene URLs in parallel
    let scenes = sharedData.scenes || [];
    if (Array.isArray(scenes) && scenes.length > 0) {
      console.log(`[get-shared-project] Refreshing URLs for ${scenes.length} scenes`);
      scenes = await Promise.all(scenes.map((scene) => refreshSceneUrls(supabase, scene)));
    }

    // Also fetch the latest completed generation video_url (for Doc2Video exports / stitched videos)
    let videoUrl: string | null = null;
    try {
      const { data: gen, error: genError } = await supabase
        .from("generations")
        .select("video_url")
        .eq("project_id", sharedData.project.id)
        .eq("status", "complete")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (genError) {
        // Surface the error so it appears in function logs / Sentry rather than
        // silently falling back to no video URL.
        console.error("[get-shared-project] DB error fetching project video_url:", genError.message, genError.code);
      } else if (gen?.video_url) {
        videoUrl = await refreshSignedUrl(supabase, gen.video_url, 604800);
      }
    } catch (e) {
      console.error("[get-shared-project] Unexpected error fetching project video_url:", e);
    }

    const result = {
      project: sharedData.project,
      scenes,
      share: sharedData.share,
      videoUrl,
    };

    console.log(`[get-shared-project] Success: ${sharedData.project?.title}`);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[get-shared-project] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
Deno.serve(handler);
