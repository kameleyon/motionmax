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

  // ── Step 2: Call OpenRouter LLM ───────────────────────────────────
  await updateJobProgress(jobId, 10);
  // All project types use 0.8 for creative output
  const temperature = 0.8;
  const rawText = await callLLMWithFallback(promptResult, {
    maxTokens: promptResult.maxTokens,
    forceJson: true,
    temperature,
  });

  // ── Step 3: Parse LLM response ───────────────────────────────────
  await updateJobProgress(jobId, 20);
  const parsed = extractJsonFromLLMResponse(
    rawText,
    `${projectType} script`,
  ) as ParsedScript;

  // SmartFlow may return a single scene without a scenes array
  if (projectType === "smartflow" && !Array.isArray(parsed.scenes)) {
    parsed.scenes = [
      {
        number: 1,
        visualPrompt: parsed.visualPrompt || parsed.visual_prompt || "",
        voiceover: (parsed.voiceover as string) || (parsed.narration as string) || "",
        duration: 60,
      },
    ];
  }

  if (!parsed.scenes || parsed.scenes.length === 0) {
    throw new Error(`LLM returned no scenes for ${projectType} script`);
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

  // Force scene duration to 10s for cinematic (AI sometimes outputs 15)
  if (projectType === "cinematic") {
    for (const s of scenes) {
      (s as any).duration = 10;
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
