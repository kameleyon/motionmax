import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Bot User-Agent patterns to detect social media crawlers
const BOT_PATTERNS = [
  'Twitterbot',
  'facebookexternalhit',
  'LinkedInBot',
  'WhatsApp',
  'TelegramBot',
  'Slackbot',
  'Discordbot',
  'Pinterest',
  'Googlebot',
  'bingbot',
  'iMessageLinkPreview',
  'Applebot',
  'Embedly',
  'Quora Link Preview',
  'Redditbot',
  'SkypeUri',
  'Viber',
  'Line',
  'Snapchat',
];

function isBot(userAgent: string): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_PATTERNS.some(pattern => ua.includes(pattern.toLowerCase()));
}

Deno.serve(async (req) => {
  // 1. Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const generationId = url.searchParams.get("id");
    const debug = url.searchParams.get("debug") === "true";
    const v = url.searchParams.get("v") || Date.now().toString();

    // Get User-Agent for bot detection
    const userAgent = req.headers.get("user-agent") || "";
    const isBotRequest = isBot(userAgent);

    console.log(
      `[Share-Meta] Request token=${token ?? ""} id=${generationId ?? ""} debug=${debug} v=${v} isBot=${isBotRequest} UA="${userAgent.substring(0, 100)}"`
    );

    if (!token && !generationId) {
      return Response.redirect("https://motionmax.io", 302);
    }

    // 2. Initialize Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 3. Fetch share data
    let title = "MotionMax Video";
    let description = "Watch this AI-generated story.";
    let imageUrl = "https://motionmax.io/og-image.png";
    let appUrl = "https://motionmax.io";

    let scenes: unknown = undefined;

    if (token) {
      // Token-based share (matches /share/:token route)
      const { data: shared, error: sharedError } = await supabase.rpc(
        "get_shared_project",
        { share_token_param: token },
      );

      if (sharedError || !shared) {
        console.error("[Share-Meta] Share token not found:", token, sharedError);
        return Response.redirect("https://motionmax.io", 302);
      }

      const sharedAny = shared as any;
      const projectTitle = sharedAny?.project?.title as string | undefined;
      title = projectTitle ? `${projectTitle}` : "MotionMax Video";
      scenes = sharedAny?.scenes;
      appUrl = `https://motionmax.io/share/${token}`;
    } else if (generationId) {
      // Fallback: generation-id based (kept for testing)
      const { data: generation, error: genError } = await supabase
        .from("generations")
        .select(`id, scenes, projects(title)`)
        .eq("id", generationId)
        .maybeSingle();

      if (genError || !generation) {
        console.error("[Share-Meta] Generation not found:", generationId, genError);
        return Response.redirect("https://motionmax.io", 302);
      }

      const projectData = generation.projects as unknown;
      let projectTitle: string | undefined;
      if (Array.isArray(projectData) && projectData.length > 0) {
        projectTitle = projectData[0]?.title;
      } else if (projectData && typeof projectData === "object") {
        projectTitle = (projectData as { title?: string }).title;
      }

      title = projectTitle ? `${projectTitle}` : "MotionMax Video";
      scenes = generation.scenes;
      appUrl = `https://motionmax.io/share/${generationId}`;
    }

    // Parse Scenes safely
    if (typeof scenes === "string") {
      try {
        scenes = JSON.parse(scenes);
      } catch (e) {
        console.error("[Share-Meta] JSON parse fail", e);
      }
    }

    // --- GRID LOGIC EXTRACTION ---
    if (Array.isArray(scenes) && scenes.length > 0) {
      const first = scenes[0] as any;

      console.log(`[Share-Meta] First scene keys: ${Object.keys(first ?? {}).join(", ")}`);

      // GRID LOGIC: Check 'imageUrl' first, then 'imageUrls[0]'
      let rawUrl: string | null = null;
      
      if (first?.imageUrl && typeof first.imageUrl === "string" && first.imageUrl.startsWith("http")) {
        rawUrl = first.imageUrl;
        console.log(`[Share-Meta] Using imageUrl: ${rawUrl}`);
      } else if (first?.imageUrls && Array.isArray(first.imageUrls) && first.imageUrls.length > 0) {
        const firstImageUrl = first.imageUrls[0];
        if (typeof firstImageUrl === "string" && firstImageUrl.startsWith("http")) {
          rawUrl = firstImageUrl;
          console.log(`[Share-Meta] Using imageUrls[0]: ${rawUrl}`);
        }
      }

      if (rawUrl) {
        // CLEAN UP: Remove query params from public bucket URLs to avoid expiration issues
        if (rawUrl.includes("supabase.co/storage/v1/object/public")) {
          try {
            const u = new URL(rawUrl);
            u.search = "";
            imageUrl = u.toString();
          } catch {
            imageUrl = rawUrl;
          }
        } else {
          imageUrl = rawUrl;
        }
      }

      // Extract Description from Voiceover/Script
      if (typeof first?.voiceover === "string" && first.voiceover.length > 0) {
        description = first.voiceover
          .substring(0, 160)
          .replace(/\s+/g, " ")
          .trim() + "...";
      }
    }
    // -----------------------------

    const cacheBustedImageUrl = withCacheBust(imageUrl, v);

    console.log(`[Share-Meta] Resolved: Title="${title}" | Image="${imageUrl}" | AppUrl="${appUrl}" | isBot=${isBotRequest}`);

    // 5. Return HTML (Bot vs Human handling)
    // For bots: NO meta refresh - let them see OG tags
    // For humans: meta refresh for instant redirect (unless debug mode)
    const shouldRedirect = !isBotRequest && !debug;

    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} | MotionMax</title>
    <meta name="description" content="${escapeHtml(description)}">
    
    <meta property="og:type" content="video.other">
    <meta property="og:url" content="${appUrl}">
    <meta property="og:title" content="${escapeHtml(title)} | MotionMax">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${cacheBustedImageUrl}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:site_name" content="MotionMax">
    
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)} | MotionMax">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${cacheBustedImageUrl}">

    ${shouldRedirect ? `<meta http-equiv="refresh" content="0;url=${appUrl}">` : ''}
    <link rel="canonical" href="${appUrl}">
    
    <style>
      body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0F1112; color: #fff; text-align: center; padding: 1rem; }
      h1 { font-size: 1.5rem; margin: 1rem 0; color: #2D9A8C; }
      p { color: #888; max-width: 600px; }
      a { color: #2D9A8C; text-decoration: none; }
      img { max-width: 400px; border-radius: 8px; margin: 1rem 0; }
      .debug-info { background: #1a1a1a; padding: 1rem; border-radius: 8px; text-align: left; max-width: 600px; margin-top: 1rem; }
      .debug-info code { color: #4ade80; word-break: break-all; }
    </style>
  </head>
  <body>
    ${debug 
      ? `<h1>🔍 Debug Mode</h1>
          <img src="${cacheBustedImageUrl}" alt="Thumbnail" onerror="this.style.display='none'">
         <div class="debug-info">
           <p><strong>Title:</strong> <code>${escapeHtml(title)}</code></p>
           <p><strong>Description:</strong> <code>${escapeHtml(description)}</code></p>
           <p><strong>Image URL:</strong> <code>${imageUrl}</code></p>
           <p><strong>Image URL (busted):</strong> <code>${cacheBustedImageUrl}</code></p>
           <p><strong>App URL:</strong> <code>${appUrl}</code></p>
           <p><strong>Is Bot:</strong> <code>${isBotRequest}</code></p>
           <p><strong>User-Agent:</strong> <code>${escapeHtml(userAgent.substring(0, 200))}</code></p>
         </div>
         <p style="margin-top: 1rem;"><a href="${appUrl}">→ Go to App</a></p>`
      : isBotRequest 
        ? `<h1>${escapeHtml(title)}</h1>
           <p>${escapeHtml(description)}</p>
           <a href="${appUrl}">View on MotionMax</a>`
        : `<p>Redirecting to MotionMax...</p>
           <a href="${appUrl}">Click here if not redirected</a>`
    }
  </body>
</html>`;

    return new Response(html, { 
      headers: {
        ...corsHeaders,
        "Content-Type": "text/html; charset=utf-8",
        // Shorter cache for bots to ensure fresh OG data
        "Cache-Control": isBotRequest ? "public, max-age=60" : "public, max-age=300",
      },
    });

  } catch (e: any) {
    console.error("[Share-Meta] Fatal error:", e);
    return Response.redirect("https://motionmax.io", 302);
  }
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function withCacheBust(url: string, v: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("v", v);
    return parsed.toString();
  } catch {
    return url;
  }
}
