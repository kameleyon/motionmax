/**
 * Full script generation handler for the Node.js worker.
 *
 * Flow:
 *  1. Extract payload fields & determine project type
 *  2. Route to the correct prompt builder (doc2video | storytelling | smartflow)
 *  3. Call OpenRouter LLM (no timeout — worker has no time cap)
 *  4. Parse & validate JSON response
 *  5. Post-process scenes (style append, voiceover sanitize, duration, image count)
 *  6. Create project + generation rows in Supabase
 *  7. Write result to the job row so the client can poll it
 *
 * Signature matches what worker/src/index.ts expects:
 *   handleGenerateVideo(job.id, job.payload, job.user_id)
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import {
  buildDoc2VideoPrompt,
  buildStorytellingPrompt,
  buildSmartFlowPrompt,
  buildCinematicPrompt,
  callOpenRouterLLM,
  callLLMWithFallback,
} from "../services/openrouter.js";
import type { PromptResult } from "../services/openrouter.js";
import { getStylePrompt, extractJsonFromLLMResponse } from "../services/prompts.js";
import { researchTopic } from "../services/researchTopic.js";
import { processContentAttachments } from "../services/processAttachments.js";
import {
  postProcessScenes,
  type ParsedScene,
  type ParsedScript,
} from "./sceneProcessor.js";

// ── Prompt Router ──────────────────────────────────────────────────

function buildPrompt(projectType: string, p: Record<string, any>): PromptResult {
  switch (projectType) {
    case "cinematic":
      return buildCinematicPrompt({
        content: p.content || "",
        format: p.format || "landscape",
        length: p.length || "brief",
        style: p.style || "realistic",
        customStyle: p.customStyle,
        brandMark: p.brandMark,
        presenterFocus: p.presenterFocus,
        characterDescription: p.characterDescription,
        voiceType: p.voiceType,
        disableExpressions: p.disableExpressions === true,
        characterConsistencyEnabled: p.characterConsistencyEnabled === true,
        language: p.language,
      });

    case "storytelling":
      return buildStorytellingPrompt({
        storyIdea: p.storyIdea || p.content || "",
        format: p.format || "landscape",
        length: p.length || "brief",
        style: p.style || "realistic",
        customStyle: p.customStyle,
        brandMark: p.brandMark,
        inspiration: p.inspiration,
        tone: p.tone,
        genre: p.genre,
        characterDescription: p.characterDescription,
        voiceType: p.voiceType,
        disableExpressions: p.disableExpressions === true,
        language: p.language,
      });

    case "smartflow":
      return buildSmartFlowPrompt({
        content: p.content || "",
        format: p.format || "landscape",
        style: p.style || "realistic",
        customStyle: p.customStyle,
        brandMark: p.brandMark,
        language: p.language,
      });

    default: // doc2video
      return buildDoc2VideoPrompt({
        content: p.content || "",
        format: p.format || "landscape",
        length: p.length || "brief",
        style: p.style || "realistic",
        customStyle: p.customStyle,
        brandMark: p.brandMark,
        presenterFocus: p.presenterFocus,
        characterDescription: p.characterDescription,
        voiceType: p.voiceType,
        disableExpressions: p.disableExpressions === true,
        language: p.language,
      });
  }
}

// ── DB Helpers ─────────────────────────────────────────────────────

/** Update job progress in video_generation_jobs. */
async function updateJobProgress(jobId: string, progress: number): Promise<void> {
  await supabase
    .from("video_generation_jobs")
    .update({ progress, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/** Build the project insert object with type-specific columns. */
function buildProjectInsert(
  userId: string | undefined,
  title: string,
  payload: Record<string, any>,
  projectType: string,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: userId,
    title,
    content: payload.content || payload.storyIdea || "",
    format: payload.format || "landscape",
    length: payload.length || "brief",
    style: payload.style || "realistic",
    brand_mark: payload.brandMark || payload.brandName || null,
    status: "generating",
    project_type: projectType,
    voice_type: payload.voiceType || "standard",
    voice_id: payload.voiceId || null,
    voice_name: payload.voiceName || null,
    voice_inclination: payload.language || null,
    // Store ALL shared params for every project type — enables reload/regenerate
    presenter_focus: payload.presenterFocus || null,
    character_description: payload.characterDescription || null,
    character_consistency_enabled: payload.characterConsistencyEnabled || false,
    disable_expressions: payload.disableExpressions || false,
  };

  // Type-specific columns
  if (projectType === "storytelling") {
    row.inspiration_style = payload.inspiration || null;
    row.story_tone = payload.tone || null;
    row.story_genre = payload.genre || null;
  }

  return row;
}

// ── Main Handler ───────────────────────────────────────────────────

export async function handleGenerateVideo(
  jobId: string,
  payload: any,
  userId?: string,
): Promise<Record<string, unknown>> {
  const phaseStart = Date.now();
  const projectType: string = payload.projectType || "doc2video";
  const style: string = payload.style || "realistic";
  const customStyle: string | undefined = payload.customStyle;

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "script_generation_started",
    message: `Script generation started for ${projectType} project`,
  });

  // ── Step 1: Build prompt ──────────────────────────────────────────
  await updateJobProgress(jobId, 5);
  const promptResult = buildPrompt(projectType, payload);
  console.log(
    `[GenerateVideo] Built ${projectType} prompt (maxTokens=${promptResult.maxTokens})`,
  );

  // ── Step 1.5: Research phase (cinematic + storytelling) ──────────
  // Process source attachments: fetch URLs, YouTube transcripts, GitHub READMEs
  // This enriches the content with actual data from linked sources.
  if (projectType === "cinematic" || projectType === "storytelling") {
    await updateJobProgress(jobId, 5);
    const rawContent = payload.content || "";
    if (rawContent.includes("--- ATTACHED SOURCES ---")) {
      console.log("[GenerateVideo] Processing attached sources...");
      payload.content = await processContentAttachments(rawContent);
      console.log(`[GenerateVideo] Content enriched: ${rawContent.length} → ${payload.content.length} chars`);
    }
  }

  // AI researches the topic for factual accuracy before scriptwriting.
  // Research is injected into SYSTEM prompt (not user) so the LLM treats
  // it as authoritative ground truth, not a suggestion.
  if (projectType === "cinematic" || projectType === "storytelling") {
    await updateJobProgress(jobId, 7);
    const researchBrief = await researchTopic(payload.content || "");
    if (researchBrief) {
      promptResult.system += `

=== MANDATORY RESEARCH DATA — YOU MUST USE THIS (NON-NEGOTIABLE) ===
⛔ WARNING: The following research has been independently verified. You MUST use these EXACT facts.
DO NOT invent, assume, or override ANY detail provided below. If the research says a person has
dark brown skin and black hair, your visualPrompt MUST describe dark brown skin and black hair.
If the research says the team wore blue jerseys, your visualPrompt MUST show blue jerseys.
EVERY character description in your "characters" object MUST match the research data below.
EVERY visualPrompt MUST reflect the verified appearance, clothing, setting, and cultural details.
If you contradict this research, the ENTIRE generation will be rejected and restarted.

${researchBrief}

=== END OF RESEARCH DATA ===`;
      console.log(`[GenerateVideo] Research brief injected into SYSTEM prompt (${researchBrief.length} chars)`);
    }
  }

  // ── Step 2: Call LLM ──────────────────────────────────────────────
  await updateJobProgress(jobId, 10);
  const temperature = 0.8;

  // Gemini works for SmartFlow (1 scene) and cinematic (own builder) but fails
  // for doc2video/storytelling (10+ scenes complex JSON). Route those to OpenRouter directly.
  const useOpenRouterDirect = projectType === "doc2video" || projectType === "storytelling";
  let rawText: string;
  if (useOpenRouterDirect) {
    const { callOpenRouterLLM } = await import("../services/openrouter.js");
    rawText = await callOpenRouterLLM(promptResult, {
      maxTokens: promptResult.maxTokens,
      forceJson: true,
      temperature,
    });
  } else {
    rawText = await callLLMWithFallback(promptResult, {
      maxTokens: promptResult.maxTokens,
      forceJson: true,
      temperature,
    });
  }

  // ── Step 3: Parse LLM response ───────────────────────────────────
  await updateJobProgress(jobId, 20);
  let parsed = extractJsonFromLLMResponse(
    rawText,
    `${projectType} script`,
  ) as ParsedScript;

  // SmartFlow: Gemini often ignores the output format and returns arbitrary keys.
  // Instead of falling back to another LLM, extract content from whatever structure we got.
  if (projectType === "smartflow") {
    const hasValidScenes = Array.isArray(parsed.scenes) && parsed.scenes.length > 0 &&
      !!(parsed.scenes[0].voiceover || (parsed.scenes[0] as any).narration);

    if (!hasValidScenes) {
      console.log(`[GenerateVideo] SmartFlow: transforming non-standard LLM response into expected format`);
      const raw = parsed as Record<string, unknown>;

      // Keys that contain spoken narration (for voiceover)
      const NARRATION_KEYS = /voiceover|narration|script|narrative|explanation|overview|summary|presentation|educational|synthesis|insight/i;
      // Keys that contain visual/design specs (NOT for voiceover)
      const VISUAL_KEYS = /visual|design|image|layout|style|illustration|infographic|color|palette|typography|icon|graphic|border|format|aesthetic/i;

      // Extract text from objects, separating narration from visual content
      const extractByCategory = (obj: unknown, depth = 0): { narration: string[]; visual: string[] } => {
        const result = { narration: [] as string[], visual: [] as string[] };
        if (depth > 5) return result;
        if (typeof obj === "string" && obj.length > 30) {
          // Classify standalone strings: if it mentions colors/layout/pixels, it's visual
          if (VISUAL_KEYS.test(obj) && obj.length < 200) result.visual.push(obj);
          else result.narration.push(obj);
          return result;
        }
        if (Array.isArray(obj)) {
          obj.forEach(item => {
            const sub = extractByCategory(item, depth + 1);
            result.narration.push(...sub.narration);
            result.visual.push(...sub.visual);
          });
          return result;
        }
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          for (const [key, val] of Object.entries(obj)) {
            const sub = extractByCategory(val, depth + 1);
            if (VISUAL_KEYS.test(key)) {
              // Everything under visual keys goes to visual
              result.visual.push(...sub.narration, ...sub.visual);
            } else if (NARRATION_KEYS.test(key)) {
              // Everything under narration keys goes to narration
              result.narration.push(...sub.narration);
              result.visual.push(...sub.visual);
            } else {
              result.narration.push(...sub.narration);
              result.visual.push(...sub.visual);
            }
          }
        }
        return result;
      };

      const { narration, visual } = extractByCategory(raw);

      // Deduplicate
      const dedup = (arr: string[]) => {
        const seen = new Set<string>();
        return arr.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
      };
      const uniqueNarration = dedup(narration);
      const uniqueVisual = dedup(visual);

      // Voiceover: narration texts sorted by length (longest = most substantial)
      const sortedNarration = [...uniqueNarration].sort((a, b) => b.length - a.length);
      const voiceover = sortedNarration.slice(0, 5).join(" ").trim();

      // Visual prompt: visual texts joined
      const visualPrompt = uniqueVisual.join(" ").trim();

      // Extract title
      const title = (raw.title as string) || (raw.topic as string) || (raw.headline as string) ||
        (raw.main_title as string) || (raw.coverTitle as string) || "";

      parsed.title = title || parsed.title;
      parsed.scenes = [{
        number: 1,
        voiceover: voiceover || "Unable to extract narration from LLM response.",
        visualPrompt: visualPrompt || sortedNarration[0] || "",
        coverTitle: (raw.coverTitle as string) || (raw.cover_title as string) || title || "",
        duration: 60,
      }];

      console.log(`[GenerateVideo] SmartFlow transform: voiceover=${voiceover.length} chars, visual=${visualPrompt.length} chars, title="${parsed.title}"`);
    }
  }

  // Non-SmartFlow: if no scenes array, retry with OpenRouter (Gemini sometimes returns flat { title, script } instead of scenes)
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    if (projectType !== "smartflow") {
      console.warn(`[GenerateVideo] ${projectType}: LLM returned no scenes array (keys: ${Object.keys(parsed).join(", ")}) — retrying with OpenRouter`);
      const { callOpenRouterLLM } = await import("../services/openrouter.js");
      const retryText = await callOpenRouterLLM(promptResult, {
        maxTokens: promptResult.maxTokens,
        forceJson: true,
        temperature: 0.8,
      });
      const retryParsed = extractJsonFromLLMResponse(retryText, `${projectType} script (no-scenes retry)`) as ParsedScript;
      if (Array.isArray(retryParsed.scenes) && retryParsed.scenes.length > 0) {
        console.log(`[GenerateVideo] Retry succeeded: ${retryParsed.scenes.length} scenes`);
        parsed.scenes = retryParsed.scenes;
        parsed.title = retryParsed.title || parsed.title;
        if (retryParsed.characters) parsed.characters = retryParsed.characters;
      } else {
        throw new Error(`LLM returned no scenes for ${projectType} script (retry also failed)`);
      }
    }
  }

  // Validate scene count for doc2video/storytelling — if LLM returned too few, retry with OpenRouter
  if (projectType !== "smartflow" && projectType !== "cinematic" && Array.isArray(parsed.scenes)) {
    const expectedCounts: Record<string, number> = { short: 10, brief: 28, presentation: 36 };
    const expected = expectedCounts[payload.length || "brief"] || 10;
    const minAcceptable = Math.floor(expected * 0.7); // 70% threshold

    if (parsed.scenes.length < minAcceptable) {
      console.warn(`[GenerateVideo] ${projectType}: LLM returned ${parsed.scenes.length} scenes, expected ${expected} (min ${minAcceptable}) — retrying with OpenRouter`);
      const { callOpenRouterLLM } = await import("../services/openrouter.js");
      const retryText = await callOpenRouterLLM(promptResult, {
        maxTokens: promptResult.maxTokens,
        forceJson: true,
        temperature: 0.8,
      });
      const retryParsed = extractJsonFromLLMResponse(retryText, `${projectType} script (scene count retry)`) as ParsedScript;
      if (Array.isArray(retryParsed.scenes) && retryParsed.scenes.length >= minAcceptable) {
        console.log(`[GenerateVideo] Retry succeeded: ${retryParsed.scenes.length} scenes`);
        parsed.scenes = retryParsed.scenes;
        parsed.title = retryParsed.title || parsed.title;
      } else {
        console.warn(`[GenerateVideo] Retry also returned ${retryParsed.scenes?.length || 0} scenes — using original ${parsed.scenes.length}`);
      }
    }
  }

  // ── Step 4: Post-process scenes ──────────────────────────────────
  const stylePrompt = getStylePrompt(style, customStyle, projectType);
  const length: string = payload.length || "brief";
  const { scenes, totalImages, title } = postProcessScenes(
    parsed,
    stylePrompt,
    projectType,
    length,
  );
  const phaseTime = Date.now() - phaseStart;

  // Force scene duration to 11s for cinematic (raw audio before 1.1x speed → ~10s output)
  if (projectType === "cinematic") {
    for (const s of scenes) {
      (s as any).duration = 11;
    }
  }

  console.log(
    `[GenerateVideo] Script parsed: ${scenes.length} scenes, ${totalImages} images, ${phaseTime}ms`,
  );

  // ── Step 5: Create project ────────────────────────────────────────
  const projectRow = buildProjectInsert(userId, title, payload, projectType);
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert(projectRow)
    .select("id")
    .single();

  if (projectError || !project) {
    throw new Error(
      `Failed to create project: ${projectError?.message || "no data returned"}`,
    );
  }

  // ── Step 6: Create generation ─────────────────────────────────────
  const scenesWithMeta = scenes.map((s: ParsedScene, idx: number) => ({
    ...s,
    _meta: {
      statusMessage: "Script complete. Ready for audio generation.",
      totalImages,
      completedImages: 0,
      sceneIndex: idx,
      phaseTimings: { script: phaseTime },
      characterBible: parsed.characters || null,
      projectType,
      language: payload.language || null,
    },
  }));

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .insert({
      project_id: project.id,
      user_id: userId,
      status: "generating",
      progress: 10,
      script: rawText,
      scenes: scenesWithMeta,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (genError || !generation) {
    throw new Error(
      `Failed to create generation: ${genError?.message || "no data returned"}`,
    );
  }

  // ── Step 7: Write result to job row ───────────────────────────────
  const result = {
    success: true,
    projectId: project.id,
    generationId: generation.id,
    title,
    scenes: scenesWithMeta,
    sceneCount: scenes.length,
    totalImages,
    phaseTime,
  };

  await supabase
    .from("video_generation_jobs")
    .update({
      result,
      progress: 30,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  await writeSystemLog({
    jobId,
    projectId: project.id,
    userId,
    generationId: generation.id,
    category: "system_info",
    eventType: "script_generation_completed",
    message: `Script complete: ${scenes.length} scenes, ${totalImages} images, ${phaseTime}ms`,
  });

  console.log(
    `[GenerateVideo] Job ${jobId} done → project=${project.id} gen=${generation.id}`,
  );

  return result;
}
