import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

// Generate a fresh signed URL from an old one
async function refreshSignedUrl(
  supabase: any,
  oldUrl: string,
  expiresIn: number = 604800 // 7 days
): Promise<string> {
  if (!oldUrl || !oldUrl.includes("/storage/v1/object/sign/")) {
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

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    console.error(`[get-shared-project] Failed to refresh URL: ${path}`, error);
    return oldUrl; // Fallback to original
  }

  return data.signedUrl;
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
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
      const { data: gen } = await supabase
        .from("generations")
        .select("video_url")
        .eq("project_id", sharedData.project.id)
        .eq("status", "complete")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (gen?.video_url) {
        videoUrl = await refreshSignedUrl(supabase, gen.video_url, 604800);
      }
    } catch (e) {
      console.warn("[get-shared-project] Failed to fetch project video_url", e);
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
});
