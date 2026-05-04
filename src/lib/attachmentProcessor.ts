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
 * Build the worker-ready content block from already-persisted
 * attachments (public URLs, no blob: prefixes). Used by the autopost
 * topic-regen flow where attachments are loaded from
 * autopost_schedules.source_attachments and forwarded to the topic
 * generator without another upload round-trip. Mirrors the format
 * processAttachments() emits and the worker's processContentAttachments
 * + buildAutopostSourcesBlock recognise.
 *
 * Returns "" when the list is empty so callers can concat unconditionally.
 */
export function serializeAttachmentsForWorker(attachments: SourceAttachment[]): string {
  if (attachments.length === 0) return "";
  const sections: string[] = [];
  for (const a of attachments) {
    switch (a.type) {
      case "text":
        sections.push(`[SOURCE TEXT: ${a.name}]\n${a.value}`);
        break;
      case "image":
        sections.push(`[SOURCE IMAGE] ${a.value}`);
        break;
      case "file":
        if (/^https?:\/\//i.test(a.value) && /\.pdf($|\?)/i.test(a.value)) {
          sections.push(`[PDF_URL] ${a.value}`);
        } else if (/^https?:\/\//i.test(a.value)) {
          sections.push(`[FETCH_URL] ${a.value}`);
        } else {
          sections.push(`[SOURCE FILE: ${a.name}]\n${a.value}`);
        }
        break;
      case "youtube":
        sections.push(`[YOUTUBE_URL] ${a.value}`);
        break;
      case "link":
        sections.push(`[FETCH_URL] ${a.value}`);
        break;
      case "github":
        sections.push(`[GITHUB_URL] ${a.value}`);
        break;
      case "gdrive":
        sections.push(`[GOOGLE_DRIVE] ${a.value}`);
        break;
    }
  }
  if (sections.length === 0) return "";
  return `\n\n--- ATTACHED SOURCES ---\n${sections.join("\n\n")}`;
}

/**
 * Upload any blob-URL attachments (images, PDFs) to Supabase Storage
 * and return a transformed SourceAttachment[] with public URLs in
 * `value`. Used by autopost where source descriptors need to outlive
 * the browser session that picked the file — text / link / youtube /
 * github / gdrive entries pass through unchanged.
 *
 * Items that fail to upload are dropped with a console warning rather
 * than throwing, so a single bad PDF doesn't block saving the rest.
 */
export async function processAttachmentsForPersistence(
  attachments: SourceAttachment[],
  projectId?: string,
): Promise<SourceAttachment[]> {
  if (attachments.length === 0) return [];
  const out: SourceAttachment[] = [];
  for (const a of attachments) {
    // Already a public URL or inline text — nothing to upload.
    if (!a.value.startsWith("blob:") && !a.value.startsWith("data:")) {
      out.push(a);
      continue;
    }

    if (a.type === "image") {
      const url = await uploadImageAttachment(a, projectId);
      if (url) out.push({ ...a, value: url });
      else log.warn("Dropping image source — upload failed", { name: a.name });
      continue;
    }

    if (a.type === "file" && /\.pdf$/i.test(a.name)) {
      const url = await uploadPdfAttachment(a, projectId);
      if (url) out.push({ ...a, value: url });
      else log.warn("Dropping PDF source — upload failed", { name: a.name });
      continue;
    }

    // Binary file we can't handle (doc/docx/etc.) or text-file blob —
    // skip rather than persist a dead blob URL. Text-file content was
    // already copied into `value` synchronously by SourceInput, so a
    // blob: prefix here means it's binary.
    log.warn("Dropping unsupported binary source", { name: a.name, type: a.type });
  }
  return out;
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
      // Surface the underlying reason — most common causes are MIME
      // rejection (bucket allowlist) and file_size_limit overage. The
      // generic "PDF upload failed" message left users guessing.
      log.error("PDF upload failed:", {
        name: attachment.name,
        size: blob.size,
        mime: blob.type,
        message: error.message,
      });
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
