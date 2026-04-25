/**
 * delete-voice-fish — deletes a Fish-cloned voice end-to-end.
 *
 * Steps:
 *   1. Validate auth + voice ownership
 *   2. DELETE https://api.fish.audio/model/{external_id} so we don't
 *      leak Fish-side storage
 *   3. Drop the user_voices row
 *
 * Idempotent: Fish 404 / 200 are both treated as "gone, fine"; the row
 * delete still runs so the UI clears even if Fish has already purged
 * the model server-side.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

interface DeleteRequestBody {
  /** user_voices row id (NOT the Fish external id). */
  voiceId: string;
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  try {
    const FISH_API_KEY = Deno.env.get("FISH_AUDIO_API_KEY");
    if (!FISH_API_KEY) {
      return new Response(JSON.stringify({ error: "FISH_AUDIO_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as DeleteRequestBody;
    if (!body.voiceId) {
      return new Response(JSON.stringify({ error: "voiceId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the row + verify ownership before touching Fish.
    const { data: row, error: rowErr } = await supabase
      .from("user_voices")
      .select("id, user_id, voice_id, provider")
      .eq("id", body.voiceId)
      .single();
    if (rowErr || !row) {
      return new Response(JSON.stringify({ error: "Voice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if ((row as { user_id: string }).user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Not your voice" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const externalId = (row as { voice_id: string }).voice_id;
    const provider = (row as { provider?: string }).provider ?? "elevenlabs";

    // Provider-aware delete. Fish for new clones; ElevenLabs for legacy
    // rows that haven't been backfilled yet.
    if (provider === "fish") {
      const res = await fetch(`https://api.fish.audio/model/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${FISH_API_KEY}` },
      });
      // 404 = already gone server-side, fine; non-2xx with non-404 we
      // surface but still proceed with the row delete so the UI clears.
      if (!res.ok && res.status !== 404) {
        const errBody = await res.text().catch(() => "");
        console.warn(`[delete-voice-fish] Fish delete ${res.status}: ${errBody.slice(0, 200)}`);
      }
    } else if (provider === "elevenlabs") {
      const elevenKey = Deno.env.get("ELEVENLABS_API_KEY");
      if (elevenKey) {
        const res = await fetch(`https://api.elevenlabs.io/v1/voices/${externalId}`, {
          method: "DELETE",
          headers: { "xi-api-key": elevenKey },
        });
        if (!res.ok && res.status !== 404) {
          const errBody = await res.text().catch(() => "");
          console.warn(`[delete-voice-fish] ElevenLabs delete ${res.status}: ${errBody.slice(0, 200)}`);
        }
      }
    }

    // Drop the row regardless of remote-side outcome — the user pressed
    // delete, the UI must clear, and any orphan Fish/ElevenLabs model
    // is fine since we've now lost the reference to it.
    const { error: delErr } = await supabase
      .from("user_voices")
      .delete()
      .eq("id", body.voiceId);
    if (delErr) {
      return new Response(JSON.stringify({ error: delErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

serve(handler);
