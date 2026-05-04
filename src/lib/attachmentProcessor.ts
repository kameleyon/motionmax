/**
 * Process source attachments before generation.
 *
 * - Text files: already have content in value
 * - Images: upload to Supabase storage, return public URL
 * - Links/YouTube/GitHub: pass through (worker fetches content)
 */

import { supabase } from "@/integrations/supabase/client";
import { createScopedLogger } from "@/lib/logger";
import type { SourceAttachment } from "@/components/workspace/CinematicSourceInput";

const log = createScopedLogger("attachmentProcessor");

/**
 * Process all attachments into content sections the worker can use.
 * Returns the enriched content string to append to user's direction text.
 */
export async function processAttachments(
  attachments: SourceAttachment[],
  projectId?: string,
): Promise<string> {
  if (attachments.length === 0) return "";

  const sections: string[] = [];

  for (const a of attachments) {
    switch (a.type) {
      case "text":
        // Full text content already stored in value
        sections.push(`[SOURCE TEXT: ${a.name}]\n${a.value}`);
        break;

      case "image": {
        // Upload image to Supabase storage and get public URL
        const imageUrl = await uploadImageAttachment(a, projectId);
        if (imageUrl) {
          sections.push(`[SOURCE IMAGE] ${imageUrl}`);
        }
        break;
      }

      case "file": {
        // File content was read in the browser — value contains the text
        if (a.value.startsWith("blob:") || a.value.startsWith("data:")) {
          // PDFs aren't readable as text in-browser, but the worker can
          // parse them server-side via pdf-parse. Upload the blob to
          // scene-images and pass a [PDF_URL] tag the worker resolves.
          // Other binary types (doc/docx/etc.) still fall through.
          if (/\.pdf$/i.test(a.name)) {
            const pdfUrl = await uploadPdfAttachment(a, projectId);
            sections.push(
              pdfUrl
                ? `[PDF_URL] ${pdfUrl}`
                : `[ATTACHED FILE: ${a.name}] (PDF upload failed — content not extractable)`,
            );
          } else {
            sections.push(`[ATTACHED FILE: ${a.name}] (binary file — content not extractable)`);
          }
        } else {
          sections.push(`[SOURCE FILE: ${a.name}]\n${a.value}`);
        }
        break;
      }

      case "youtube":
        // Worker will fetch video metadata/transcript
        sections.push(`[YOUTUBE_URL] ${a.value}`);
        break;

      case "link":
        // Worker will fetch page content
        sections.push(`[FETCH_URL] ${a.value}`);
        break;

      case "github":
        // Worker will fetch README
        sections.push(`[GITHUB_URL] ${a.value}`);
        break;

      case "gdrive":
        // Can't access without OAuth — pass as reference
        sections.push(`[GOOGLE_DRIVE] ${a.value}`);
        break;
    }
  }

  return sections.length > 0
    ? `\n\n--- ATTACHED SOURCES ---\n${sections.join("\n\n")}`
    : "";
}

/**
 * Upload an image attachment to Supabase storage.
 * Returns the public URL or null on failure.
 */
async function uploadImageAttachment(
  attachment: SourceAttachment,
  projectId?: string,
): Promise<string | null> {
  try {
    // Fetch the blob URL to get actual file data
    const res = await fetch(attachment.value);
    const blob = await res.blob();

    const ext = attachment.name.split(".").pop()?.toLowerCase() || "png";
    const folder = projectId || "uploads";
    const filename = `${folder}/source-${Date.now()}.${ext}`;

    const { error } = await supabase.storage
      .from("scene-images")
      .upload(filename, blob, { contentType: blob.type, upsert: true });

    if (error) {
      log.error("Image upload failed:", error.message);
      throw new Error("Failed to upload attachment. Please try again.");
    }

    const { data: urlData } = supabase.storage
      .from("scene-images")
      .getPublicUrl(filename);

    return urlData?.publicUrl || null;
  } catch (err) {
    if (err instanceof Error && err.message === "Failed to upload attachment. Please try again.") {
      throw err;
    }
    log.error("Image upload error:", (err as Error).message);
    throw new Error("Failed to upload attachment. Please try again.");
  }
}

/**
 * Upload a PDF attachment to Supabase Storage so the worker can fetch
 * + parse it server-side via pdf-parse. Lives in the same scene-images
 * bucket that already handles image uploads (public, project-scoped
 * folder convention).
 */
async function uploadPdfAttachment(
  attachment: SourceAttachment,
  projectId?: string,
): Promise<string | null> {
  try {
    const res = await fetch(attachment.value);
    const blob = await res.blob();
    const folder = projectId || "uploads";
    const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${folder}/source-${Date.now()}-${safeName}`;
    const { error } = await supabase.storage
      .from("scene-images")
      .upload(filename, blob, { contentType: "application/pdf", upsert: true });
    if (error) {
      log.error("PDF upload failed:", error.message);
      return null;
    }
    const { data: urlData } = supabase.storage
      .from("scene-images")
      .getPublicUrl(filename);
    return urlData?.publicUrl || null;
  } catch (err) {
    log.error("PDF upload error:", (err as Error).message);
    return null;
  }
}
