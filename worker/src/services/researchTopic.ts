/**
 * AI-powered topic research using Hypereal + Gemini 3.1 Pro.
 *
 * Generates a factual research brief about a topic before script generation.
 * The research brief covers: key facts, character descriptions (race, gender,
 * ethnicity, appearance), historical/cultural context, geography, clothing,
 * and any verifiable details needed for accurate visual representation.
 *
 * This runs as a lightweight pre-pass before the main script generation.
 * Uses Gemini 3.1 Pro via Hypereal (1M context, $0.80/M input, $4.80/M output).
 */

// Built at request time with current date injected — see buildResearchPrompt()
function buildResearchPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

  return `You are a meticulous fact-checker and visual research assistant for a cinematic AI video production team.

TODAY'S DATE: ${dateStr}, ${timeStr}. All research must reflect the world AS OF TODAY. Do not use outdated information. If a person has changed appearance, teams have new rosters, or events have occurred recently, use the MOST CURRENT information available.

STEP 1 - RESEARCH FIRST: Before generating any visual descriptions, thoroughly research the given topic. Pull verified facts, data, statistics, scholarly consensus, and contextual information from credible sources. Understand WHAT is true about the subject before describing HOW it should look. This applies to any topic - medical, scientific, cultural, sports, historical, or otherwise. If the topic involves claims, behaviors, symptoms, comparisons, or debates, establish the factual foundation first. If you cannot verify something, mark it "UNVERIFIED." Do not skip this step.

STEP 2 - VISUAL TRANSLATION: Once the research is complete, translate those verified facts into production-ready visual descriptions for the scriptwriter and image generator. Every visual detail below must be grounded in the research from Step 1.

Your job is to research the given topic and provide VERIFIED, ACCURATE facts that the video scriptwriter and image generator will use. The video team will create visual scenes based on your research, so accuracy of VISUAL DETAILS is critical.

For EVERY person/character mentioned, you MUST research and provide:
- **RACE & ETHNICITY**: Exact race, skin tone, ethnic background. DO NOT assume. Look it up.
- **GENDER**: Verified gender. DO NOT assume.
- **PHYSICAL APPEARANCE**: What they actually look like - hair color/style, facial features, body type, age
- **CLOTHING**: What they wore/wear in the relevant context. Historical accuracy matters.
  - For sports: exact team jersey colors for THAT SPECIFIC game/event, not just general team colors
  - For historical figures: period-accurate clothing
  - For modern figures: their known style/appearance

For EVERY location/setting mentioned:
- **GEOGRAPHY**: What does it actually look like? Tropical? Arid? Urban? Rural?
- **WEATHER/CLIMATE**: Is it snowing or sunny? Rainy season or dry?
- **ARCHITECTURE**: What do buildings look like in that region/era?
- **CULTURAL MARKERS**: Signs, language on buildings, cultural details

For EVERY event mentioned:
- **DATE & CONTEXT**: When did it happen? What were the circumstances?
- **KEY DETAILS**: Specific facts a viewer would notice if wrong (jersey colors, team lineups, scores, etc.)
- **CULTURAL SIGNIFICANCE**: Why does this matter? What's the emotional context?

IMPORTANT RULES:
- For REAL PEOPLE (celebrities, athletes, politicians, historical/biblical figures): You MUST describe their ACTUAL appearance based on verified knowledge. Kylian Mbappé is Black with dark brown skin. Jesus of Nazareth was a Middle Eastern Jewish man - NOT white with blue eyes. Moses was a Hebrew man from Egypt. Martin Luther King Jr. was a Black man. DO NOT whitewash or Europeanize anyone.
- If you're not sure about a detail, say "UNVERIFIED" - never make up facts
- If the topic is fictional, note what's established canon vs interpretation
- If the topic is historical, prioritize scholarly consensus and regional ethnic accuracy
- Be HYPER-SPECIFIC with physical descriptions: "warm dark brown skin, close-cropped tightly coiled black hair, strong jawline, athletic 6'0 build" - NOT "African American man"
- Include VISUAL details the AI image/video generator needs - this is for creating IMAGES and VIDEOS, not text
- For sports events: specify EXACT jersey colors, numbers, and team kits for THAT SPECIFIC match/event

Return your research as a structured brief in plain text (NOT JSON). Use sections: ## RESEARCH FINDINGS (verified facts, data, and context from Step 1), ## CHARACTER DESCRIPTIONS (with FULL physical appearance), ## VISUAL SETTING, ## CULTURAL CONTEXT. Keep it under 1500 words.`;
}

/**
 * Research a topic before script generation.
 * Returns a research brief string to inject into the script prompt.
 */
export async function researchTopic(content: string): Promise<string> {
  const apiKey = process.env.HYPEREAL_API_KEY;
  if (!apiKey) {
    console.warn("[Research] HYPEREAL_API_KEY not set — skipping research");
    return "";
  }

  console.log(`[Research] Starting topic research via Gemini 3.1 Pro (${content.length} chars input)`);
  const startTime = Date.now();

  try {
    // Extract image URLs from content for multimodal research
    const imageUrls: string[] = [];
    const imagePattern = /\[SOURCE IMAGE\]\s*(https?:\/\/[^\s]+)/g;
    let match;
    while ((match = imagePattern.exec(content)) !== null) {
      imageUrls.push(match[1]);
    }

    // Build user message — include full content (Gemini has 1M context)
    // Truncate at 50K chars to stay within reasonable request size
    const userText = `Research this topic for an AI-generated cinematic video:\n\n${content.substring(0, 50000)}`;

    // Build multimodal content parts if images are attached
    let userContent: any;
    if (imageUrls.length > 0) {
      // Multimodal: text + image URLs for Gemini to analyze
      userContent = [
        { type: "text", text: userText },
        ...imageUrls.slice(0, 5).map(url => ({
          type: "image_url",
          image_url: { url },
        })),
      ];
      console.log(`[Research] Sending ${imageUrls.length} images for multimodal analysis`);
    } else {
      userContent = userText;
    }

    // Hypereal chat API follows OpenAI format: system + user messages
    const res = await fetch("https://api.hypereal.cloud/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        max_tokens: 3000,
        temperature: 0.3,
        stream: false,
        messages: [
          { role: "system", content: buildResearchPrompt() },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(60_000), // 60s max for research
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[Research] Hypereal error ${res.status}: ${body.substring(0, 200)}`);
      return "";
    }

    const data = (await res.json()) as any;
    const brief = data.choices?.[0]?.message?.content || "";
    const elapsed = Date.now() - startTime;

    console.log(`[Research] Complete (${brief.length} chars, ${(elapsed / 1000).toFixed(1)}s, credits: ${data.creditsUsed ?? "?"})`);
    return brief;
  } catch (err) {
    console.warn(`[Research] Failed: ${(err as Error).message} — continuing without research`);
    return "";
  }
}
