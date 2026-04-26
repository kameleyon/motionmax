import { supabase } from "@/integrations/supabase/client";

/**
 * Uploads a style reference image to Supabase storage and returns the public URL.
 * Throws explicitly on failure — the base64 fallback has been removed because
 * data URLs can exceed the ~2 MB Supabase Edge Function body limit, causing
 * the downstream generation request to fail with an opaque error.
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
// Map MIME types to safe filename extensions. We derive the storage
// extension from `file.type` (which Supabase storage validates against
// the allowlist) rather than from `file.name`, because user-controlled
// filenames like `evil.png/.svg` can produce paths with embedded
// slashes that subvert per-user folder boundaries.
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const ALLOWED_TYPES = Object.keys(MIME_EXT);

export async function uploadStyleReference(file: File): Promise<string> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("File too large. Maximum size is 10 MB.");
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Invalid file type. Please upload PNG, JPG, WEBP, or GIF.");
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Extension is derived from MIME type, not the user-supplied filename.
  // Storage path is uuid-only (no filename component) so even if MIME
  // were spoofed the path stays inside the user's namespace.
  const ext = MIME_EXT[file.type];
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
