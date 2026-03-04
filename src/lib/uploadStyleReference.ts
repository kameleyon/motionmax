import { supabase } from "@/integrations/supabase/client";

/**
 * Uploads a style reference image to Supabase storage and returns the public URL.
 * Falls back to the base64 data URL if upload fails.
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
    console.error("Style reference upload failed, falling back to data URL:", error.message);
    // Fallback to base64
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const { data: urlData } = supabase.storage
    .from("style-references")
    .getPublicUrl(path);

  return urlData.publicUrl;
}
