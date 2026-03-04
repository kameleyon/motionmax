import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    if (!ELEVENLABS_API_KEY) {
      console.error("Missing ELEVENLABS_API_KEY");
      return new Response(
        JSON.stringify({ error: "ElevenLabs API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get auth token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    
    // Create Supabase client with service role for admin operations
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Verify user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      console.error("Auth error:", authError);
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get user's subscription plan to determine voice clone limit
    const { data: subData } = await supabaseAdmin
      .from("subscriptions")
      .select("plan_name, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    const planName = subData?.plan_name ?? "free";
    const VOICE_CLONE_LIMITS: Record<string, number> = {
      free: 0,
      starter: 0,
      creator: 1,
      professional: 3,
      enterprise: 999,
    };
    const voiceCloneLimit = VOICE_CLONE_LIMITS[planName] ?? 0;

    // Check voice clone limit based on plan
    const { count: existingVoiceCount, error: countError } = await supabaseAdmin
      .from("user_voices")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      console.error("Error checking voice count:", countError);
      return new Response(
        JSON.stringify({ error: "Failed to check voice limit" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if ((existingVoiceCount ?? 0) >= voiceCloneLimit) {
      const limitMsg = voiceCloneLimit === 0
        ? "Voice cloning requires a Creator plan or higher."
        : `You have reached your plan limit of ${voiceCloneLimit} cloned voice(s). Please delete an existing voice to create a new one.`;
      console.log(`User ${user.id} (plan: ${planName}) has ${existingVoiceCount}/${voiceCloneLimit} voices — limit reached`);
      return new Response(
        JSON.stringify({ error: limitMsg }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { storagePath, voiceName, description, removeNoise } = await req.json();

    if (!storagePath || !voiceName) {
      return new Response(
        JSON.stringify({ error: "storagePath and voiceName are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Cloning voice for user ${user.id}: ${voiceName}`);
    console.log(`Storage path: ${storagePath}`);

    // Download audio file from private bucket using service role
    const { data: audioData, error: downloadError } = await supabaseAdmin.storage
      .from("voice_samples")
      .download(storagePath);

    if (downloadError || !audioData) {
      console.error("Failed to download audio:", downloadError);
      return new Response(
        JSON.stringify({ error: "Failed to download audio file from storage" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const audioBlob = audioData;
    console.log(`Audio file size: ${audioBlob.size} bytes, type: ${audioBlob.type}`);

    // Prepare multipart form data for ElevenLabs
    const formData = new FormData();
    formData.append("name", voiceName);
    formData.append("files", audioBlob, "voice_sample.mp3");
    if (description) {
      formData.append("description", description);
    }
    // Enable background noise removal based on user preference (defaults to true)
    formData.append("remove_background_noise", removeNoise !== false ? "true" : "false");

    // Call ElevenLabs Instant Voice Cloning API
    console.log("Calling ElevenLabs API with noise removal enabled...");
    const elevenLabsResponse = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    if (!elevenLabsResponse.ok) {
      const errorText = await elevenLabsResponse.text();
      console.error("ElevenLabs API error:", elevenLabsResponse.status, errorText);
      
      // Parse error for user-friendly messages
      let userMessage = "Failed to clone voice";
      let statusCode = 500;
      
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.detail?.status === "voice_limit_reached") {
          userMessage = "Voice limit reached. Please delete unused voices in your ElevenLabs account or upgrade your subscription.";
          statusCode = 400;
        } else if (errorJson.detail?.message) {
          userMessage = errorJson.detail.message;
        }
      } catch {
        // Keep default message if parsing fails
      }
      
      return new Response(
        JSON.stringify({ error: userMessage }),
        { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const elevenLabsResult = await elevenLabsResponse.json();
    const voiceId = elevenLabsResult.voice_id;
    console.log(`Voice cloned successfully! Voice ID: ${voiceId}`);

    // Generate a test phrase audio sample with the cloned voice
    const testPhrase = "I'm going to read for twenty seconds without rushing: The goal is steady rhythm, clear diction, and natural breath pauses—no robotic cadence, no random pitch jumps.";
    console.log("Generating test phrase audio with cloned voice...");
    
    let sampleUrl = ""; // Will be set by TTS generation
    
    try {
      const ttsResponse = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: testPhrase,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
              stability: 0.3,
              similarity_boost: 0.75,
              style: 0.65,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (ttsResponse.ok) {
        const audioBuffer = await ttsResponse.arrayBuffer();
        console.log(`Test phrase audio generated: ${audioBuffer.byteLength} bytes`);
        
        // Upload the generated sample to Supabase storage
        const sampleFileName = `${user.id}/${Date.now()}-sample.mp3`;
        const { error: uploadError } = await supabaseAdmin.storage
          .from("voice_samples")
          .upload(sampleFileName, audioBuffer, {
            contentType: "audio/mpeg",
            upsert: false,
          });

        if (!uploadError) {
          // Use signed URL (valid for 1 year) since bucket is now private
          const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin.storage
            .from("voice_samples")
            .createSignedUrl(sampleFileName, 60 * 60 * 24 * 365); // 1 year expiry
          
          if (signedUrlData && !signedUrlError) {
            sampleUrl = signedUrlData.signedUrl;
            console.log("Test phrase sample uploaded with signed URL");
          } else {
            console.error("Failed to create signed URL:", signedUrlError);
          }
        } else {
          console.error("Failed to upload sample:", uploadError);
        }
      } else {
        console.error("TTS generation failed:", ttsResponse.status);
      }
    } catch (ttsError) {
      console.error("TTS error (non-fatal):", ttsError);
      // Continue with original audio URL as sample
    }

    // Insert into user_voices table with the generated sample URL
    const { data: insertData, error: insertError } = await supabaseAdmin
      .from("user_voices")
      .insert({
        user_id: user.id,
        voice_name: voiceName,
        voice_id: voiceId,
        sample_url: sampleUrl,
        description: description || null,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Database insert error:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to save voice to database" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Voice saved to database:", insertData.id);

    return new Response(
      JSON.stringify({ 
        success: true, 
        voiceId, 
        voice: insertData 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Clone voice error:", error);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
