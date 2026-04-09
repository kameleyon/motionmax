import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import {
  actionListAll,
  actionListBucket,
  actionManifest,
  actionDownload,
} from "./storageHelpers.ts";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[MIGRATE-STORAGE] ${step}${d}`);
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    log("Function invoked");

    // ── Auth: require Bearer token ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: claimsData, error: claimsError } =
      await supabaseAuth.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return jsonResponse({ error: "Invalid session" }, 401);
    }

    const userId = claimsData.claims.sub as string;
    log("Authenticated", { userId });

    // ── Admin check ──
    const { data: adminRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .single();

    if (!adminRole) {
      log("Access denied — not admin", { userId });
      return jsonResponse({ error: "Admin privileges required" }, 403);
    }

    log("Admin verified");

    // ── Route by ?action= query param ──
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const bucket = url.searchParams.get("bucket");
    const filePath = url.searchParams.get("path");

    log("Action requested", { action, bucket, path: filePath });

    switch (action) {
      case "list": {
        const result = bucket
          ? await actionListBucket(supabaseAdmin, bucket)
          : await actionListAll(supabaseAdmin);
        if ("error" in result) return jsonResponse(result, 400);
        return jsonResponse(result);
      }

      case "manifest": {
        if (!bucket) {
          return jsonResponse({ error: "bucket param required" }, 400);
        }
        const result = await actionManifest(supabaseAdmin, bucket);
        if ("error" in result) return jsonResponse(result, 400);
        return jsonResponse(result);
      }

      case "download": {
        if (!bucket || !filePath) {
          return jsonResponse(
            { error: "bucket and path params required" },
            400
          );
        }
        const result = await actionDownload(supabaseAdmin, bucket, filePath);
        if (result && typeof result === "object" && "error" in result) {
          return jsonResponse(result, 404);
        }
        const blob = result as Blob;
        const filename = filePath.split("/").pop() ?? "file";
        return new Response(blob, {
          headers: {
            ...corsHeaders,
            "Content-Type": blob.type || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      }

      default:
        return jsonResponse(
          {
            error: "Invalid or missing action param",
            usage: {
              list_all: "?action=list",
              list_bucket: "?action=list&bucket=BUCKET",
              manifest: "?action=manifest&bucket=BUCKET",
              download: "?action=download&bucket=BUCKET&path=FILE_PATH",
            },
          },
          400
        );
    }
  } catch (err) {
    log("Error", { message: (err as Error).message });
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
