/**
 * Shared prompt text sections reused across doc2video, storytelling,
 * and smartflow prompt builders.  Pure strings — no API calls.
 */

// ── Language & Localisation ────────────────────────────────────────

export const LANGUAGE_SECTION = `=== LANGUAGE REQUIREMENT (CRITICAL) ===
ALWAYS generate ALL content (voiceovers, titles, subtitles) in ENGLISH, regardless of the input language.
The ONLY exception: If the user EXPLICITLY requests Haitian Creole (Kreyòl Ayisyen), then generate in Haitian Creole.
If the input content is in another language (French, Spanish, Portuguese, etc.), TRANSLATE it to English for the output.
We do NOT support other languages at this time.

=== HAITIAN CREOLE ILLUSTRATION TEXT RULES ===
When generating content in Haitian Creole:
- Write ALL illustration text, captions, and visual descriptions in Haitian Creole
- PRESERVE proper nouns, brand names, and specific terminology in their ORIGINAL form (do NOT translate names, slogans, or technical terms)
- Example: "Lionel Messi" stays "Lionel Messi", "Nike - Just Do It" stays "Nike - Just Do It"
- Translate descriptive and narrative text to Haitian Creole, but keep recognizable names and branded terms unchanged`;

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

export function buildCoverTitleSection(examples: string): string {
  return `=== COVER IMAGE TITLE (CRITICAL FOR SCENE 1) ===
For Scene 1 ONLY, you MUST include a "coverTitle" field with a short, catchy, social media-style title (3-6 words max).
- This is the THUMBNAIL/COVER title that will be rendered prominently on the first image
- Make it punchy, intriguing, and scroll-stopping (like a viral TikTok or YouTube thumbnail)
- It should match the visual style and create curiosity/interest
- Examples: ${examples}`;
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
