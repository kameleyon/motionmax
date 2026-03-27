/**
 * Shared prompt text sections reused across doc2video, storytelling,
 * and smartflow prompt builders.  Pure strings — no API calls.
 */

// ── Language & Localisation ────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  fr: "French (Français)",
  ht: "Haitian Creole (Kreyòl Ayisyen)",
  es: "Spanish (Español)",
  pt: "Portuguese (Português)",
};

/**
 * Build a language instruction section for the LLM prompt based on selected language.
 * All user-facing text (voiceovers, titles, coverTitle, text overlays, captions)
 * MUST be in the project's language.  Technical fields (JSON keys, visualPrompt
 * scene descriptions for the image AI) stay in English.
 */
export function buildLanguageSection(language?: string): string {
  const lang = language || "en";
  const langName = LANGUAGE_NAMES[lang] || lang;

  if (lang === "en") {
    return `=== LANGUAGE REQUIREMENT (CRITICAL) ===
Generate ALL user-facing content in ENGLISH:
- "voiceover" field: English
- "coverTitle" field (Scene 1): English
- "title" field: English
- Any text that appears IN the visual illustrations (typography, captions, signs, banners, titles burned into images): English
If the input content is in another language, TRANSLATE it to English for the output.

=== SMART TEXT RULES ===
- PRESERVE proper nouns, brand names, slogans, and specific terminology in their ORIGINAL form
- Example: "Lionel Messi" stays "Lionel Messi", "Nike - Just Do It" stays "Nike - Just Do It"
- Do NOT mechanically translate names, acronyms, or well-known branded terms
- Keep JSON property names, visualPrompt technical descriptions, and narrativeBeat labels in English`;
  }

  return `=== LANGUAGE REQUIREMENT (CRITICAL) ===
The project language is **${langName}**. ALL user-facing text MUST be in ${langName}:

1. **"voiceover" field:** Write natural, fluent narration in ${langName}
2. **"coverTitle" field (Scene 1):** The cover/thumbnail title MUST be in ${langName}
3. **"title" field:** The video title MUST be in ${langName}
4. **Visual illustration text:** Any text that appears IN the images (typography, captions, signs, banners, titles burned into visuals) MUST be written in ${langName}

=== TECHNICAL FIELDS (stay in English) ===
- JSON property names (keys): English
- "visualPrompt" scene descriptions (for the image AI): English
- "narrativeBeat" labels: English

=== SMART TEXT RULES ===
- PRESERVE proper nouns, brand names, slogans, and specific terminology in their ORIGINAL form — do NOT translate them
- Example: "Lionel Messi" stays "Lionel Messi", "Nike - Just Do It" stays "Nike - Just Do It"
- Translate descriptive and narrative text to ${langName}, but keep recognizable names and branded terms unchanged
- Do NOT mechanically translate everything — use contextual judgment
- Acronyms, technical terms, and universally recognized phrases may stay in their original language when it sounds more natural`;
}

/** @deprecated Use buildLanguageSection(language) instead. Kept for backward compatibility. */
export const LANGUAGE_SECTION = buildLanguageSection("en");

// ── Sub-Visuals ────────────────────────────────────────────────────

export const SUB_VISUALS_SECTION = `=== SUB-VISUALS (REQUIRED FOR DYNAMIC PACING) ===
- EVERY scene MUST include 2-3 subVisuals (additional visual moments)
- subVisuals create variety and dynamic visual pacing within each scene
- Each subVisual should show a different angle, moment, or detail of the scene
- These create smooth transitions and keep viewers engaged`;

// ── Prompt Engineering Rules (for image prompts) ───────────────────

export const PROMPT_ENGINEERING_SECTION = `=== PROMPT ENGINEERING RULES (FOR IMAGE PROMPTS) ===
When generating the 'visualPrompt' for each scene, you MUST:
1. COPY-PASTE the full physical description from the CHARACTER BIBLE into the prompt (do not just use the name)
2. Describe the ACTION clearly (e.g., "running", "sitting", "celebrating")
3. Define the SETTING (background, lighting, weather, environment)
4. Include CAMERA ANGLE (close-up, wide shot, low angle, over-shoulder, etc.)
5. NO TEXT in images unless specifically requested
6. **DO NOT** describe the art style, visual style, or aesthetic in your visualPrompt - the system will automatically append the exact user-selected style. Only focus on CONTENT (who, what, where, action, camera). NEVER mention style names like "stick figure", "anime", "realistic", etc. in your descriptions - just describe the subject as "a person", "a man", "a woman", etc.`;

// ── Cover Title Section Builder ────────────────────────────────────

export function buildCoverTitleSection(examples: string, styleDesc?: string): string {
  const styleMatch = styleDesc
    ? `\n- **STYLE-MATCHED TYPOGRAPHY:** The title text in the visualPrompt for Scene 1 MUST be rendered in the SAME art style as the rest of the image. If the style is "${styleDesc}", the title lettering must look like it belongs in that world (e.g., Lego style → blocky 3D brick letters, Anime → manga-style text, Watercolor → painted brush-stroke lettering, etc.). NEVER use generic plain text or a mismatched style for the title.`
    : "";
  return `=== COVER IMAGE TITLE (CRITICAL FOR SCENE 1) ===
For Scene 1 ONLY, you MUST include a "coverTitle" field with a short, catchy, social media-style title (3-6 words max).
- This is the THUMBNAIL/COVER title that will be rendered prominently on the first image
- Make it punchy, intriguing, and scroll-stopping (like a viral TikTok or YouTube thumbnail)${styleMatch}
- Examples: ${examples}`;
}

// ── Brand Attribution Section Builder ──────────────────────────────

export function buildBrandSection(brandMark?: string): string {
  if (!brandMark) return "";
  return `\n=== BRAND ATTRIBUTION (REQUIRED) ===
Subtly weave "${brandMark}" into the content:
- Include "${brandMark}" as a small branded footer or logo text in Scene 1's visualPrompt
- Mention "${brandMark}" naturally in the voiceover of the first or last scene (e.g., "Brought to you by ${brandMark}" or "A ${brandMark} production")
- Do NOT make it intrusive — it should feel like a natural part of the content\n`;
}

// ── Output Format Builder ──────────────────────────────────────────

export function buildOutputFormat(opts: {
  charExamples: string;
  narrativeBeatExample: string;
  voiceoverExample: string;
  includeTextOverlay: boolean;
  textOverlayExample?: string;
}): string {
  const textOverlayFields = opts.includeTextOverlay && opts.textOverlayExample
    ? `,\n      ${opts.textOverlayExample}`
    : "";
  return `=== OUTPUT FORMAT ===
Return ONLY valid JSON (no markdown, no \`\`\`json blocks):
{
  "title": "Video Title",
  "characters": {
    ${opts.charExamples}
  },
  "scenes": [
    {
      "number": 1,
      "narrativeBeat": "${opts.narrativeBeatExample}",
      "voiceover": "${opts.voiceoverExample}",
      "visualPrompt": "Full prompt including CHARACTER BIBLE description + action + setting + camera angle...",
      "subVisuals": ["Second visual moment for variety...", "Third visual moment for dynamic pacing..."],
      "coverTitle": "Catchy Cover Title",
      "duration": 15${textOverlayFields}
    }
  ]
}`;
}
