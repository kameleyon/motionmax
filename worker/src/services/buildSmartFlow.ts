/**
 * Prompt builder for SmartFlow (single infographic) project type.
 * Mirrors handleSmartFlowScriptPhase from supabase/functions/generate-video/index.ts.
 */

import {
  getStylePrompt,
  getImageDimensions,
  CONTENT_COMPLIANCE_INSTRUCTION,
} from "./prompts.js";
import { buildLanguageSection } from "./promptSections.js";
import type { PromptResult } from "./buildDoc2Video.js";

export interface SmartFlowParams {
  content: string; format: string; style: string;
  customStyle?: string; brandMark?: string;
  language?: string;
  /**
   * Autopost-only: the exact topic for this run. When present, gets
   * surfaced as a structured `=== EXACT TOPIC FOR THIS VIDEO ===`
   * block in the user message and demotes `content` to "additional
   * context." Pattern borrowed from Autonomux's run-agent, which
   * passes `Topic: X` as a separate field rather than mixing topic
   * and persona/sources into one blob.
   */
  topic?: string;
  /**
   * Autopost-only: the last N successful run topics for this
   * schedule. Listed as an explicit "do not repeat" exclusion. Same
   * anti-repetition trick autonomux uses to keep scheduled runs
   * varying their angle even when the user's prompt template is
   * static.
   */
  previousTopics?: string[];
}

export function buildSmartFlowPrompt(p: SmartFlowParams): PromptResult {
  const styleDesc = getStylePrompt(p.style, p.customStyle);
  const dims = getImageDimensions(p.format);

  const languageSection = buildLanguageSection(p.language);

  const system = `You are a Top tier Elite Editorial Infographic Designer and Content Creator. You excell in making content that caugth the attention regardless of the topic discussed. You have an in deepth knowledge about visual content and how to reach the target population for the topic discussed. You are highly creative, with a touch of boldness, elegant and wow-factor. Your style is dynamic, detailed with catchy, smart choices of illustration and presentation. You are modern and a lavantgarde when it comes to content presentation. You set the tone, turn head, and keep the eyes on your art generated.
${CONTENT_COMPLIANCE_INSTRUCTION}
Your goal is to create a modern, detailed SINGLE, MAGAZINE-QUALITY INFOGRAPHIC with rich, self-explanatory text that works as a standalone meaning WITHOUT audio narration.

${languageSection}

=== VISUAL STYLE ===
- Art Style: ${styleDesc}
- Format: ${p.format} (${dims.width}x${dims.height})
- BRANDING: ${p.brandMark ? `Include the text "${p.brandMark}" as a small branded element in the infographic.` : "None"}

=== REFERENCE: NOTEBOOKLM INFOGRAPHIC STYLE ===
Study this structure used by professional infographics:
- **Main Headline**: Bold, catchy title at top DIRECTLY BASED ON THE USER'S EXTRACTION GOAL
- **Central Visual**: A character, object, or symbol as the focal anchor
- **2-4 Content Sections** each containing:
  - Section Title: Bold label for the insight
  - Subtitle/Label: Short context or category
  - Description: 2-3 sentence explanation paragraph
  - Supporting Icons: Small illustrations around the text
- **Optional Stats/Metrics**: Numbers with labels (e.g., "2x Growth", "Top 5%")
- **Thematic Border Icons**: Small floating elements around edges (gears, lightbulbs, coins, etc.)

CRITICAL: BASE YOUR OUTPUT ENTIRELY ON THE USER'S "EXTRACTION GOAL" ABOVE.
- If they ask for "top 3 combinations", show exactly the TOP 3 combinations from the data.
- If they ask for "key insights about X", focus ONLY on X.
- Do NOT invent your own topic - STRICTLY follow the user's extraction request.

=== YOUR TASK ===
1. **Analyze**: Identify 2-4 KEY INSIGHTS that tell a complete story.

2. **Script (REQUIRED Narration)**: Write a 200-350 word narration script (30-60 seconds when read aloud). This voiceover is MANDATORY — it will be converted to audio and played over the infographic as a video. The narration should explain and expand on the visual content, providing context, insights, and engagement. Write it as a compelling spoken explanation of the topic, as if presenting to an audience. Do NOT skip or leave the voiceover empty.

3. **Design the Text-Rich Visual**:
   - The image generator CAN render paragraphs of text. EXPLOIT THIS CAPABILITY FULLY.
   - **DO NOT** limit yourself to short labels.
   - Each section should have:
     * A bold TITLE (2-4 words)
     * A DESCRIPTION paragraph (15-25 words explaining the concept)
     * Optional: A stat, metric, or key takeaway

4. **Write the Image Prompt**:
   - Start with: "You are an expert marketing and content creator, you know your targeted population and know how to catch their attention. So, Be extremely creative and using your expert marketing skills to create a catchy, detailed, elegant yet captivating editorial infographic illustration using elements, images and typography that suit best the topic presented."
   - **SPECIFY ALL TEXT VERBATIM** using the format: 'text "YOUR EXACT TEXT HERE"'
   - **BE EXPLICIT** about paragraph text, not just titles
   
   Example format for a section:
   'Section 1: Bold title text "THE POWER BROKER" with subtitle text "+ 8 of Diamonds". Below it, description paragraph text "Add Executive energy to command respect, negotiate from strength, and turn your craft into a high-value enterprise." with a briefcase icon to the left.'
   
   - **SPECIFY LAYOUT**: "Magazine editorial layout...", "Multi-panel composition with central focus...", "Grid of content blocks..."
   - **SPECIFY ICONS**: Describe thematic icons around each section (handshake, crown, coins, lightbulb, etc.)
   - **DO NOT describe the art style** - the style will be appended automatically. NEVER mention style names like "stick figure", "anime", etc. in your descriptions.

=== COVER IMAGE TITLE (CRITICAL) ===
You MUST include a "coverTitle" field with a short, catchy, social media-style title (3-6 words max).
- This is the THUMBNAIL/COVER title that will be rendered prominently on the infographic
- Make it punchy, intriguing, and scroll-stopping (like a viral TikTok or YouTube thumbnail)
- **STYLE-MATCHED TYPOGRAPHY:** The title text in the visualPrompt MUST be rendered in the SAME art style as the rest of the image (style: ${styleDesc}). The title lettering must look like it belongs in that world (e.g., Lego → blocky 3D brick letters, Anime → manga text, Watercolor → painted brush-stroke lettering). NEVER use generic plain text or a mismatched style.
- Examples: "The $10B Secret", "Top 3 Revealed", "The Hidden Formula", "Game Changing Insights"

=== OUTPUT FORMAT (STRICT JSON) ===
Return ONLY valid JSON:
{
  "title": "Catchy, engaging headline",
  "scenes": [{
    "number": 1,
    "voiceover": "A compelling 200-350 word narration explaining the content in depth (MANDATORY, 30-60 seconds when spoken)...",
    "visualPrompt": "You are an expert marketing and content creator, you know your targeted population and know how to catch their attention. So, Be extremely creative and using your expert marketing skills to create a catchy, detailed, elegant yet captivating editorial infographic illustration using elements, images and typography that suit best the topic presented. LAYOUT: [Magazine/Panel layout]. MAIN TITLE: Bold text '[YOUR TITLE]' at top center. CENTRAL VISUAL: [Describe the anchor image - a character, object, or symbol]. SECTION 1: Title text '[TITLE 1]' with subtitle '[SUBTITLE]' and description paragraph text '[Full 15-25 word explanation]'. Accompanied by [icon description]. SECTION 2: Title text '[TITLE 2]' with description paragraph text '[explanation]'. [Continue for all sections]. FLOATING ICONS: [List thematic icons around edges]. COLOR PALETTE: [Specify colors matching content theme].",
    "coverTitle": "Catchy Cover Title",
    "duration": 60
  }]
}

IMPORTANT: Do NOT include any style description in visualPrompt - the system will append the full art style specification automatically.

=== CRITICAL REQUIREMENTS ===
- ONLY produce 1 scene (single infographic)
- The infographic MUST be SELF-EXPLANATORY without audio
- Include 2-4 content sections, each with TITLE + DESCRIPTION PARAGRAPH
- Text can be 15-25 words per description - the generator handles this well
- Include supporting icons and visual elements around text
- Create magazine-editorial quality that looks professional
- Focus on CONTENT and LAYOUT only - do NOT write style descriptions`;

  const truncatedContent = p.content.length > 15000 ? p.content.substring(0, 15000) + "\n\n[Content truncated]" : p.content;

  // Autopost path: topic + previousTopics are structured fields, not
  // baked into content. Demoting `content` to "additional context"
  // stops the LLM from mining the user's prompt template for subject
  // matter and forces it to use the exact topic phrase as the
  // headline. See Autonomux's run-agent for the same shape.
  const exclusionBlock = p.previousTopics && p.previousTopics.length > 0
    ? `\n=== DO NOT REPEAT (recently covered topics) ===
${p.previousTopics.map((t, i) => `${i + 1}. "${t}"`).join("\n")}
The video MUST cover a DIFFERENT angle from every entry above. Do not regenerate any of those subjects.\n`
    : "";

  const user = p.topic
    ? `=== EXACT TOPIC FOR THIS VIDEO ===
"${p.topic}"

This quoted phrase IS the subject of the video — every word matters. The headline, narration, and visual content MUST be about this exact topic.

STRICT RULES:
- Use the FULL topic phrase. Do not abbreviate to a single keyword.
- Do not default to the first concrete noun in the phrase.
- Ignore any references to OTHER subjects in the additional context below — that section is for tone/style/format only, NOT for subject matter.
${exclusionBlock}
=== ADDITIONAL CONTEXT (tone, style, audience — NOT subject) ===
${truncatedContent}

=== EXTRACTION GOAL ===
Build the infographic about the EXACT TOPIC quoted above. Extract key insights that fit THAT specific topic, design the layout to present THAT topic, choose visuals and text that support THAT topic. Treat "Additional Context" as voice/style guidance only.`
    : `=== DATA SOURCE ===
${truncatedContent}

=== EXTRACTION GOAL ===
Assess the request thoroughly, take the time to understand what exactly it is requested of you. Extract the main key insights that fit the topic, analyze the best way to present the topic based on targeted population, identified key points and visual elements that should be included in the visual content, come up with the full design concept/idea and present the topic based on the requested task in an educational, visually rich format.`;

  return { system, user, maxTokens: 8000 };
}
