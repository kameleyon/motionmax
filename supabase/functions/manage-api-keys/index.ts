import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

const PBKDF2_ITERATIONS = 100_000;

/**
 * Generate a unique salt per user to prevent rainbow table attacks
 * Uses user ID to ensure each user's keys have unique encryption even if plaintext is same
 */
function generateUserSalt(userId: string): Uint8Array {
  const encoder = new TextEncoder();
  // Combine fixed prefix with user ID for uniqueness
  return encoder.encode(`motionmax-apikey-salt-v3-${userId}`);
}

// Derive AES-256-GCM key using PBKDF2 (strong KDF) with per-user salt
async function getEncryptionKey(userId: string): Promise<CryptoKey> {
  const keyString = Deno.env.get("ENCRYPTION_KEY");
  if (!keyString) {
    throw new Error("ENCRYPTION_KEY not configured");
  }

  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyString),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: generateUserSalt(userId),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Legacy SHA-256 key derivation (for decrypting old data)
async function getLegacyEncryptionKey(): Promise<CryptoKey> {
  const keyString = Deno.env.get("ENCRYPTION_KEY");
  if (!keyString) {
    throw new Error("ENCRYPTION_KEY not configured");
  }

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(keyString));

  return crypto.subtle.importKey(
    "raw",
    hashBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Prefix to distinguish v3 (per-user salt) from v2 (fixed salt) from legacy SHA-256
const V3_PREFIX = "v3:";
const V2_PREFIX = "v2:";

async function encrypt(plaintext: string, userId: string): Promise<string> {
  if (!plaintext) return "";

  const key = await getEncryptionKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  // Prefix with v3: so decrypt knows per-user salt was used
  return V3_PREFIX + btoa(String.fromCharCode(...combined));
}

async function decrypt(ciphertext: string, userId: string): Promise<{ value: string; needsReEncrypt: boolean }> {
  if (!ciphertext) return { value: "", needsReEncrypt: false };

  const isV3 = ciphertext.startsWith(V3_PREFIX);
  const isV2 = !isV3 && ciphertext.startsWith(V2_PREFIX);
  const raw = isV3 ? ciphertext.slice(V3_PREFIX.length) : isV2 ? ciphertext.slice(V2_PREFIX.length) : ciphertext;

  try {
    let key: CryptoKey;
    if (isV3) {
      key = await getEncryptionKey(userId);
    } else if (isV2) {
      // Legacy v2 used fixed salt - need to migrate
      const encoder = new TextEncoder();
      const baseKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Deno.env.get("ENCRYPTION_KEY") || ""),
        "PBKDF2",
        false,
        ["deriveKey"]
      );
      key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: encoder.encode("manage-api-keys-v2-salt"),
          iterations: PBKDF2_ITERATIONS,
          hash: "SHA-256",
        },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    } else {
      key = await getLegacyEncryptionKey();
    }

    const combined = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );

    return { value: new TextDecoder().decode(decrypted), needsReEncrypt: !isV3 };
  } catch (error) {
    // If v3 or v2 decryption failed, this is a real error
    if (isV3 || isV2) {
      console.error("Decryption failed — possible key mismatch or corrupt data:", error);
      throw new Error("Failed to decrypt API key. The encryption key may have changed.");
    }

    // Legacy fallback also failed — try treating as plaintext (very old data)
    console.warn("Legacy decryption failed, treating as unencrypted plaintext");
    return { value: ciphertext, needsReEncrypt: true };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with anon key for auth verification
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user token
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: authError } = await anonClient.auth.getClaims(token);
    
    if (authError || !claimsData?.claims?.sub) {
      console.error("Auth error:", authError);
      return new Response(
        JSON.stringify({ error: "Invalid or expired session" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.claims.sub as string;
    const method = req.method;

    if (method === "GET") {
      // Retrieve and decrypt API keys
      const { data, error } = await serviceClient
        .from("user_api_keys")
        .select("gemini_api_key, replicate_api_token")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("Database error:", error);
        throw error;
      }

      if (!data) {
        return new Response(
          JSON.stringify({ gemini_api_key: "", replicate_api_token: "" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Decrypt the keys (returns { value, needsReEncrypt })
      const geminiResult = await decrypt(data.gemini_api_key || "", userId);
      const replicateResult = await decrypt(data.replicate_api_token || "", userId);

      // Transparently re-encrypt legacy keys with PBKDF2
      if (geminiResult.needsReEncrypt || replicateResult.needsReEncrypt) {
        const updates: Record<string, string | null> = { updated_at: new Date().toISOString() };
        if (geminiResult.needsReEncrypt && geminiResult.value) {
          updates.gemini_api_key = await encrypt(geminiResult.value, userId);
        }
        if (replicateResult.needsReEncrypt && replicateResult.value) {
          updates.replicate_api_token = await encrypt(replicateResult.value, userId);
        }
        await serviceClient
          .from("user_api_keys")
          .update(updates)
          .eq("user_id", userId);
        console.log("Re-encrypted legacy keys for user:", userId);
      }

      // Return masked versions for display (show last 4 chars only)
      const maskKey = (key: string) => {
        if (!key || key.length < 8) return key ? "••••••••" : "";
        return "••••••••" + key.slice(-4);
      };

      return new Response(
        JSON.stringify({
          gemini_api_key: maskKey(geminiResult.value),
          replicate_api_token: maskKey(replicateResult.value),
          has_gemini: !!geminiResult.value,
          has_replicate: !!replicateResult.value,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (method === "POST") {
      // Save encrypted API keys
      const body = await req.json();
      const { gemini_api_key, replicate_api_token } = body;

      console.log("Encrypting and saving API keys for user:", userId);

      // Encrypt the keys
      const encryptedGemini = gemini_api_key ? await encrypt(gemini_api_key, userId) : null;
      const encryptedReplicate = replicate_api_token ? await encrypt(replicate_api_token, userId) : null;

      // Check if record exists
      const { data: existing } = await serviceClient
        .from("user_api_keys")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        // Update existing record
        const { error } = await serviceClient
          .from("user_api_keys")
          .update({
            gemini_api_key: encryptedGemini,
            replicate_api_token: encryptedReplicate,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);

        if (error) throw error;
      } else {
        // Insert new record
        const { error } = await serviceClient
          .from("user_api_keys")
          .insert({
            user_id: userId,
            gemini_api_key: encryptedGemini,
            replicate_api_token: encryptedReplicate,
          });

        if (error) throw error;
      }

      console.log("API keys saved successfully for user:", userId);

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (method === "DELETE") {
      // Delete API keys
      const { error } = await serviceClient
        .from("user_api_keys")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("Error in manage-api-keys:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
