/**
 * Input validation, sanitization, and content moderation for generate-video.
 *
 * Contract:
 *   - validateGenerationRequest(body) — throws Error on bad input; returns
 *     a GenerationRequest with all string fields trimmed and content sanitized.
 *   - moderateContent(content) — calls Gemini to AI-screen prompts; returns
 *     { passed, reason?, flagType? }. Fails open on infra errors.
 *   - flagUserForViolation(supabase, userId, reason, details, adminUserId?) —
 *     inserts into user_flags table. Best-effort; logs but does not throw.
 *   - sanitizeContent(str) — strips HTML/attributes via DOMPurify, normalises
 *     whitespace.
 *
 * Also exports the CONTENT_COMPLIANCE_INSTRUCTION block used to prepend
 * mandatory compliance language to all script-generation prompts, and the
 * lower-level validators (validateString, validateEnum, validateUUID,
 * validateNonNegativeInt) used both internally and by the main handler for
 * fields outside the GenerationRequest schema (e.g. imageStartIndex).
 *
 * Extracted 2026-05-10 per audit C-4-2 (Arch C-A3). Zero behavior change.
 */

import DOMPurify from "https://esm.sh/dompurify@3.2.4";
import type { GenerationRequest } from "./types.ts";

// ============= INPUT VALIDATION =============
export const INPUT_LIMITS = {
  content: 500000, // Max 500K characters for content (Smart Flow data sources)
  format: 20,
  length: 20,
  style: 50,
  customStyle: 2000,
  brandMark: 500,
  presenterFocus: 500000,
  characterDescription: 500000,
  voiceId: 200,
  voiceName: 200,
  inspirationStyle: 100,
  storyTone: 100,
  storyGenre: 100,
  voiceInclination: 100,
  brandName: 200,
  newVoiceover: 5000,
  imageModification: 1000,
  generationId: 50,
  projectId: 50,
};

export const ALLOWED_FORMATS = ["landscape", "portrait", "square"];
export const ALLOWED_LENGTHS = ["short", "brief", "presentation"];
export const ALLOWED_PHASES = ["script", "audio", "images", "finalize", "regenerate-audio", "regenerate-image"];
export const ALLOWED_PROJECT_TYPES = ["doc2video", "smartflow"];
export const ALLOWED_VOICE_TYPES = ["standard", "custom"] as const;

// Validate and sanitize string input
export function validateString(value: unknown, fieldName: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
  return trimmed || null;
}

// Validate enum value
export function validateEnum<T extends string>(value: unknown, fieldName: string, allowed: readonly T[]): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const lower = value.toLowerCase().trim();
  if (!allowed.includes(lower as T)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
  }
  return lower as T;
}

// Validate UUID format
export function validateUUID(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(value.trim())) {
    throw new Error(`${fieldName} must be a valid UUID`);
  }
  return value.trim();
}

// Validate non-negative integer
export function validateNonNegativeInt(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

// Sanitize content using DOMPurify to prevent injection attacks
export function sanitizeContent(content: string): string {
  // Configure DOMPurify to strip all HTML tags and attributes
  // This is safe for content that will be processed by AI models
  const clean = DOMPurify.sanitize(content, {
    ALLOWED_TAGS: [], // Strip all HTML tags
    ALLOWED_ATTR: [], // Strip all attributes
    KEEP_CONTENT: true, // Keep text content
    RETURN_TRUSTED_TYPE: false,
  });

  // Remove excessive whitespace while preserving structure
  const normalized = clean.replace(/\s{10,}/g, "    ");

  return normalized.trim();
}

// ============= CONTENT MODERATION (Gemini AI-Powered) =============

export interface ModerationResult {
  passed: boolean;
  reason?: string;
  flagType?: "warning" | "flagged" | "suspended" | "banned";
}

export async function moderateContent(content: string): Promise<ModerationResult> {
  try {
    // Use the first Google TTS API key (already in environment)
    const geminiKey = Deno.env.get("GOOGLE_TTS_API_KEY");

    if (!geminiKey) {
      console.warn("[MODERATION] GOOGLE_TTS_API_KEY missing, skipping AI moderation");
      return { passed: true };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

    const payload = {
      contents: [{
        parts: [{
          text: `You are an AI safety moderator for a video generation app. Analyze the following user prompt.
Strictly flag if the prompt contains: explicitly sexual content, graphic non-fictional gore, hate speech, or promotes illegal acts.
Allow: fictional drama, action movie concepts, mystery, and standard storytelling.
Reply ONLY with a valid JSON object in this exact format: {"passed": boolean, "reason": "short explanation if failed, otherwise empty string"}

User Prompt: "${content.substring(0, 5000)}"`,
        }],
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[MODERATION] Gemini API failed: ${response.status}`);
      return { passed: true }; // Fail open
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (responseText) {
      const result = JSON.parse(responseText);

      if (result.passed === false) {
        console.log(`[MODERATION] Blocked by Gemini: ${result.reason}`);
        return {
          passed: false,
          reason: `Content violates our safety policy (${result.reason}). Please revise your input.`,
          flagType: "warning",
        };
      }
    }

    return { passed: true };
  } catch (err) {
    console.error("[MODERATION] Error calling Gemini moderation:", err);
    return { passed: true }; // Fail open
  }
}

// Add compliance instructions to AI prompts
export const CONTENT_COMPLIANCE_INSTRUCTION = `
CONTENT POLICY (MANDATORY):
- Generate only family-friendly, appropriate content
- No explicit violence, gore, or disturbing imagery
- No sexual or adult content
- No hate speech, discrimination, or offensive stereotypes
- No content promoting illegal activities
- Keep all content suitable for general audiences

### TTS CONTENT FILTER SAFETY (CRITICAL) ###
The voiceover text will be read aloud by a Text-to-Speech engine with strict content safety filters.
You MUST avoid ANY words or onomatopoeia that could trigger these filters, including but not limited to:
- BANNED WORDS: "BOUM", "BOOM", "BANG", "POW", "CRASH", "KABOOM", "SLASH", "STAB", "SMASH", "BLAST", "EXPLODE", "EXPLOSION", "BLOW UP", "SHOOT", "SHOT", "KILL", "DIE", "DEAD", "BLOOD", "GUN", "BOMB", "ATTACK", "DESTROY", "MURDER", "WEAPON"
- This applies to ALL languages including Haitian Creole, French, Spanish, etc.
- Instead of violent/explosive onomatopoeia, use SAFE dramatic alternatives like: "Suddenly...", "In a flash...", "In an instant...", "Everything changed...", "Toudenkou..." (Creole), "At that very moment..."
- NEVER use ALL-CAPS onomatopoeia or sound effects in voiceover text
- Write narration that is dramatic but uses DESCRIPTIVE language, not sound-effect words

### HISTORICAL, CULTURAL & VISUAL ACCURACY (CRITICAL) ###
You are generating visual prompts that will create illustrations. You MUST ensure absolute accuracy:
- **Historical accuracy**: If the content covers a specific time period (e.g. England 1400s), ALL visual elements must match that era — architecture, clothing, weapons, tools, furniture, hairstyles, technology. Do NOT mix elements from different centuries or regions.
- **Geographic accuracy**: Landscapes, vegetation, weather, and urban design must match the real-world location depicted.
- **Ethnic & facial accuracy**: Characters must reflect the correct ethnicity, skin tone, facial features, hair texture, and body type for the culture/region described.
- **Cultural accuracy**: Clothing, jewelry, rituals, food, instruments, religious symbols, and customs must be culturally authentic and specific.
- **Name & spelling accuracy**: Proper nouns, place names, historical figures, and brand names must be spelled correctly in voiceover and visual prompts.
- **Color & material accuracy**: Use historically/culturally accurate colors for flags, uniforms, traditional garments, heraldry, and national symbols.
- **Context coherence**: Every object, person, and setting must belong to the same time, place, and cultural context. No anachronisms.
- When unsure, use the MOST COMMONLY DOCUMENTED historical/cultural representation.
`;

export async function flagUserForViolation(
  supabase: any,
  userId: string,
  reason: string,
  details: string,
  adminUserId?: string,
): Promise<void> {
  try {
    await supabase.from("user_flags").insert({
      user_id: userId,
      flag_type: "warning",
      reason: reason,
      details: details,
      flagged_by: adminUserId || userId, // System-flagged uses the user's own ID
    });
    console.log(`[MODERATION] User ${userId} flagged for: ${reason}`);
  } catch (err) {
    console.error(`[MODERATION] Failed to create flag:`, err);
  }
}

// Validate entire request body
export function validateGenerationRequest(body: unknown): GenerationRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be a JSON object");
  }

  const raw = body as Record<string, unknown>;

  const validated: GenerationRequest = {};

  // Validate phase
  if (raw.phase !== undefined) {
    validated.phase = validateEnum(raw.phase, "phase", ALLOWED_PHASES) as GenerationRequest["phase"];
  }

  // Validate content with sanitization
  const content = validateString(raw.content, "content", INPUT_LIMITS.content);
  if (content) {
    validated.content = sanitizeContent(content);
  }

  // Validate format
  validated.format = validateEnum(raw.format, "format", ALLOWED_FORMATS) ?? undefined;

  // Validate length
  validated.length = validateEnum(raw.length, "length", ALLOWED_LENGTHS) ?? undefined;

  // Validate style
  validated.style = validateString(raw.style, "style", INPUT_LIMITS.style) ?? undefined;

  // Validate optional string fields
  validated.customStyle = validateString(raw.customStyle, "customStyle", INPUT_LIMITS.customStyle) ?? undefined;
  validated.brandMark = validateString(raw.brandMark, "brandMark", INPUT_LIMITS.brandMark) ?? undefined;
  validated.presenterFocus =
    validateString(raw.presenterFocus, "presenterFocus", INPUT_LIMITS.presenterFocus) ?? undefined;
  validated.characterDescription =
    validateString(raw.characterDescription, "characterDescription", INPUT_LIMITS.characterDescription) ?? undefined;
  validated.inspirationStyle =
    validateString(raw.inspirationStyle, "inspirationStyle", INPUT_LIMITS.inspirationStyle) ?? undefined;
  validated.storyTone = validateString(raw.storyTone, "storyTone", INPUT_LIMITS.storyTone) ?? undefined;
  validated.storyGenre = validateString(raw.storyGenre, "storyGenre", INPUT_LIMITS.storyGenre) ?? undefined;
  validated.voiceInclination =
    validateString(raw.voiceInclination, "voiceInclination", INPUT_LIMITS.voiceInclination) ?? undefined;
  validated.brandName = validateString(raw.brandName, "brandName", INPUT_LIMITS.brandName) ?? undefined;
  validated.newVoiceover = validateString(raw.newVoiceover, "newVoiceover", INPUT_LIMITS.newVoiceover) ?? undefined;
  validated.imageModification =
    validateString(raw.imageModification, "imageModification", INPUT_LIMITS.imageModification) ?? undefined;

  // Validate project type
  validated.projectType =
    (validateEnum(raw.projectType, "projectType", ALLOWED_PROJECT_TYPES) as GenerationRequest["projectType"]) ??
    undefined;

  // Validate UUIDs
  validated.generationId = validateUUID(raw.generationId, "generationId") ?? undefined;
  validated.projectId = validateUUID(raw.projectId, "projectId") ?? undefined;

  // Validate boolean
  if (raw.disableExpressions !== undefined) {
    if (typeof raw.disableExpressions !== "boolean") {
      throw new Error("disableExpressions must be a boolean");
    }
    validated.disableExpressions = raw.disableExpressions;
  }

  // Validate characterConsistencyEnabled (Pro feature)
  if (raw.characterConsistencyEnabled !== undefined) {
    if (typeof raw.characterConsistencyEnabled !== "boolean") {
      throw new Error("characterConsistencyEnabled must be a boolean");
    }
    validated.characterConsistencyEnabled = raw.characterConsistencyEnabled;
  }

  // Validate voice selection
  validated.voiceType =
    (validateEnum(raw.voiceType, "voiceType", ALLOWED_VOICE_TYPES) as GenerationRequest["voiceType"]) ?? undefined;
  validated.voiceId = validateString(raw.voiceId, "voiceId", INPUT_LIMITS.voiceId) ?? undefined;
  validated.voiceName = validateString(raw.voiceName, "voiceName", INPUT_LIMITS.voiceName) ?? undefined;

  // Validate numeric fields
  validated.sceneIndex = validateNonNegativeInt(raw.sceneIndex, "sceneIndex") ?? undefined;
  validated.imageIndex = validateNonNegativeInt(raw.imageIndex, "imageIndex") ?? undefined;

  return validated;
}
