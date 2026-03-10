import { supabase } from "@/integrations/supabase/client";

/**
 * Uploads a style reference image to Supabase storage and returns the public URL.
 * Throws explicitly on failure — the base64 fallback has been removed because
 * data URLs can exceed the ~2 MB Supabase Edge Function body limit, causing
 * the downstream generation request to fail with an opaque error.
 */
export async function uploadStyleReference(file: File): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const ext = file.name.split(".").pop() || "png";
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from("style-references")
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) {
    throw new Error(`Style reference upload failed: ${error.message}. Please check your connection and try again.`);
  }

  const { data: urlData } = supabase.storage
    .from("style-references")
    .getPublicUrl(path);

  return urlData.publicUrl;
}
