import { supabase } from "@/integrations/supabase/client";

/**
 * Uploads a character reference image to Supabase Storage and returns a
 * public URL.
 *
 * Character reference images share the `style-references` bucket: both
 * are user-uploaded images consumed by the generation pipeline, and that
 * bucket is already public with per-user-folder RLS proven by
 * uploadStyleReference.ts. Storing a public URL (not a base64 data URI)
 * matters for autopost — the worker runs server-side and the image
 * models require public HTTPS URLs.
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const ALLOWED_TYPES = Object.keys(MIME_EXT);

export async function uploadCharacterReference(file: File): Promise<string> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("Character image too large. Maximum size is 10 MB.");
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Invalid image type. Please upload PNG, JPG, WEBP, or GIF.");
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Extension derived from MIME type, not the user filename; path is
  // uuid-only under the user's folder so the per-user RLS boundary holds.
  const ext = MIME_EXT[file.type];
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from("style-references")
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) {
    throw new Error(`Character image upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage
    .from("style-references")
    .getPublicUrl(path);

  return urlData.publicUrl;
}
