import fetch from "node-fetch";

export async function extractScriptWithOpenRouter(
  prompt: string,
  style: string,
  targetDuration: number,
  openRouterApiKey: string
) {
  console.log(`[OpenRouter] Extracting script for style: ${style}`);
  
  const estimatedScenes = Math.max(1, Math.floor(targetDuration / 4));
  
  const systemPrompt = `You are an expert short-form video scriptwriter. 
  Create an engaging, highly visual script tailored for a ${targetDuration} second video. 
  Break the script down into exactly ${estimatedScenes} scenes. 
  For each scene, provide a "visual_prompt" (what we see) and "narration" (what the voiceover says).
  The visual style is: ${style}. Return the result as valid JSON matching this schema: 
  { 
    "scenes": [
      { "number": 1, "visual_prompt": "...", "narration": "..." }
    ]
  }`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/o3-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${err}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) throw new Error("No content returned from OpenRouter");

    return JSON.parse(content);
  } catch (error) {
    console.error("[OpenRouter] Failed to extract script:", error);
    throw error;
  }
}