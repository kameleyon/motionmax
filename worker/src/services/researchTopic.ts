/**
 * AI-powered topic research using OpenRouter + Claude.
 *
 * Generates a factual research brief about a topic before script generation.
 * The research brief covers: key facts, character descriptions (race, gender,
 * ethnicity, appearance), historical/cultural context, geography, clothing,
 * and any verifiable details needed for accurate visual representation.
 *
 * This runs as a lightweight pre-pass before the main script generation.
 */

const RESEARCH_SYSTEM_PROMPT = `You are a meticulous fact-checker and visual research assistant for a cinematic AI video production team.

Your job is to research the given topic and provide VERIFIED, ACCURATE facts that the video scriptwriter and image generator will use. The video team will create visual scenes based on your research, so accuracy of VISUAL DETAILS is critical.

For EVERY person/character mentioned, you MUST research and provide:
- **RACE & ETHNICITY**: Exact race, skin tone, ethnic background. DO NOT assume. Look it up.
- **GENDER**: Verified gender. DO NOT assume.
- **PHYSICAL APPEARANCE**: What they actually look like — hair color/style, facial features, body type, age
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
- If you're not sure about a detail, say "UNVERIFIED" — never make up facts
- If the topic is fictional, note what's established canon vs interpretation
- If the topic is historical, prioritize scholarly consensus
- Be specific: "dark brown skin, close-cropped black hair, athletic build" not "African American man"
- Include VISUAL details the AI image/video generator needs

Return your research as a structured brief in plain text (NOT JSON). Keep it under 800 words.
Use sections: ## KEY FACTS, ## CHARACTER DESCRIPTIONS, ## VISUAL SETTING, ## CULTURAL CONTEXT`;

/**
 * Research a topic before script generation.
 * Returns a research brief string to inject into the script prompt.
 */
export async function researchTopic(content: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[Research] OPENROUTER_API_KEY not set — skipping research");
    return "";
  }

  console.log(`[Research] Starting topic research (${content.length} chars input)`);
  const startTime = Date.now();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        max_tokens: 2000,
        temperature: 0.3, // Low temperature for factual accuracy
        messages: [
          { role: "system", content: RESEARCH_SYSTEM_PROMPT },
          { role: "user", content: `Research this topic for an AI-generated cinematic video:\n\n${content.substring(0, 5000)}` },
        ],
      }),
      signal: AbortSignal.timeout(60_000), // 60s max for research
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[Research] OpenRouter error ${res.status}: ${body.substring(0, 200)}`);
      return "";
    }

    const data = (await res.json()) as any;
    const brief = data.choices?.[0]?.message?.content || "";
    const elapsed = Date.now() - startTime;

    console.log(`[Research] Complete (${brief.length} chars, ${(elapsed / 1000).toFixed(1)}s)`);
    return brief;
  } catch (err) {
    console.warn(`[Research] Failed: ${(err as Error).message} — continuing without research`);
    return "";
  }
}
