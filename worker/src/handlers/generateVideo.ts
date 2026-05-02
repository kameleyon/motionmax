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
  // Autopost passes `topic` (the exact subject for this run) and
  // `previousTopics` (recent topics for the same schedule, so the
  // model varies its angle). Both are forwarded to every flow's
  // builder so the autonomux-style structured-field treatment kicks
  // in regardless of project_type.
  const topic = typeof p.topic === "string" && p.topic.trim().length > 0 ? p.topic.trim() : undefined;
  const previousTopics = Array.isArray(p.previousTopics)
    ? (p.previousTopics as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : undefined;

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
        topic,
        previousTopics,
      });

    case "smartflow":
      return buildSmartFlowPrompt({
        content: p.content || "",
        format: p.format || "landscape",
        style: p.style || "realistic",
        customStyle: p.customStyle,
        brandMark: p.brandMark,
        language: p.language,
        topic,
        previousTopics,
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
        topic,
        previousTopics,
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
    custom_style: payload.customStyle || null,
    custom_style_image: payload.customStyleImage || null,
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
    character_images: payload.characterImages || null,
    character_consistency_enabled: payload.characterConsistencyEnabled || false,
    disable_expressions: payload.disableExpressions || false,
  };

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

  // ── Step 1.5: Research phase (ALL project types) ──────────────────
  // Process source attachments: fetch URLs, YouTube transcripts, GitHub READMEs
  // This enriches the content with actual data from linked sources.
  {
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
  // ALL project types get research — ensures accurate visuals and facts.
  {
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

  // ── Step 2: Call Gemini (same for ALL project types) ──────────────
  await updateJobProgress(jobId, 10);
  const temperature = 0.8;
  const rawText = await callLLMWithFallback(promptResult, {
    maxTokens: promptResult.maxTokens,
    forceJson: true,
    temperature,
  });

  // ── Step 3: Parse LLM response ───────────────────────────────────
  await updateJobProgress(jobId, 20);
  let parsed = extractJsonFromLLMResponse(
    rawText,
    `${projectType} script`,
  ) as ParsedScript;

  // ── UNIFIED TRANSFORM: works for ALL project types ──────────────
  // Gemini sometimes returns valid JSON in wrong structure (no scenes array,
  // flat { title, script }, or arbitrary keys). Instead of falling back to
  // another LLM, extract content from whatever we got and build scenes.

  const hasValidScenes = Array.isArray(parsed.scenes) && parsed.scenes.length > 0 &&
    parsed.scenes.some(s => !!(s.voiceover || (s as any).narration || s.visualPrompt || s.visual_prompt));

  if (!hasValidScenes) {
    console.log(`[GenerateVideo] ${projectType}: transforming non-standard LLM response (keys: ${Object.keys(parsed).join(", ")})`);
    const raw = parsed as Record<string, unknown>;

    // Extract title
    const title = (raw.title as string) || (raw.topic as string) || (raw.headline as string) ||
      (raw.main_title as string) || (raw.coverTitle as string) || "";
    parsed.title = title || parsed.title;

    // ── STEP 1: Look for a scene-like array under any key ──────────
    // Gemini often returns scenes under non-standard keys like "script_and_visuals",
    // "sections", "content_blocks", etc. If we find an array of objects, treat each as a scene.
    let sceneArray: any[] | null = null;
    for (const [key, val] of Object.entries(raw)) {
      if (key === "title" || key === "cta" || key === "call_to_action") continue;
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        sceneArray = val;
        console.log(`[GenerateVideo] Found scene-like array under key "${key}" (${val.length} items)`);
        break;
      }
    }

    if (sceneArray && sceneArray.length > 1) {
      // Map each array item to a scene — extract voiceover and visual from whatever fields exist
      parsed.scenes = sceneArray.map((item: any, idx: number) => {
        const allStrings = Object.entries(item)
          .filter(([, v]) => typeof v === "string" && (v as string).length > 20)
          .map(([k, v]) => ({ key: k, val: v as string }));

        // Find narration: longest string, or one with narration-like key
        const NARRATION_RE = /voiceover|narration|script|dialogue|text|monologue|content/i;
        const VISUAL_RE = /visual|image|illustration|design|direction|prompt|scene_description/i;

        const narrationField = allStrings.find(s => NARRATION_RE.test(s.key)) ||
          allStrings.sort((a, b) => b.val.length - a.val.length)[0];
        const visualField = allStrings.find(s => VISUAL_RE.test(s.key));

        return {
          number: idx + 1,
          voiceover: narrationField?.val || "",
          visualPrompt: visualField?.val || narrationField?.val || "",
          // SmartFlow defaults to a single 60s slide (single-image
          // infographic). If the user later picks a duration in
          // intake (currently hidden via FEATURES.smartflow.duration
          // = false), the payload.length === 'presentation' branch
          // bumps it to 90s. Other project types stick with 11s
          // estimated per scene; real audio length overrides at
          // finalize time.
          duration: projectType === "smartflow"
            ? (payload.length === 'presentation' ? 90 : 60)
            : 11,
        };
      });
      console.log(`[GenerateVideo] Transform: ${parsed.scenes.length} scenes from array`);
    } else {
      // ── STEP 2: No scene array found — extract all text and split ──
      const NARRATION_KEYS = /voiceover|narration|script|narrative|explanation|overview|summary|presentation|educational|synthesis|insight|content|scene/i;
      const VISUAL_KEYS = /visual|design|image|layout|style|illustration|infographic|color|palette|typography|icon|graphic|border|format|aesthetic/i;

      const extractByCategory = (obj: unknown, depth = 0): { narration: string[]; visual: string[] } => {
        const result = { narration: [] as string[], visual: [] as string[] };
        if (depth > 5) return result;
        if (typeof obj === "string" && obj.length > 30) {
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
              result.visual.push(...sub.narration, ...sub.visual);
            } else if (NARRATION_KEYS.test(key)) {
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
      const dedup = (arr: string[]) => {
        const seen = new Set<string>();
        return arr.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
      };
      const uniqueNarration = dedup(narration);
      const uniqueVisual = dedup(visual);
      const sortedNarration = [...uniqueNarration].sort((a, b) => b.length - a.length);

      if (projectType === "smartflow") {
        const voiceover = sortedNarration.slice(0, 5).join(" ").trim();
        const visualPrompt = uniqueVisual.join(" ").trim();
        parsed.scenes = [{
          number: 1,
          voiceover: voiceover || "Unable to extract narration.",
          visualPrompt: visualPrompt || sortedNarration[0] || "",
          coverTitle: (raw.coverTitle as string) || (raw.cover_title as string) || title || "",
          duration: 60,
        }];
        console.log(`[GenerateVideo] Transform: 1 scene, voiceover=${voiceover.length} chars, visual=${visualPrompt.length} chars`);
      } else {
        // Split narration into scene-sized chunks by sentences
        const expectedCounts: Record<string, number> = { short: 10, brief: 28, presentation: 36 };
        const targetSceneCount = expectedCounts[payload.length || "brief"] || 10;
        const allNarration = sortedNarration.join(" ").trim();
        const allVisual = uniqueVisual.join(" ").trim();

        const sentences = allNarration.split(/(?<=[.!?])\s+/).filter(s => s.length > 10);
        const scenesPerChunk = Math.max(1, Math.ceil(sentences.length / targetSceneCount));

        const builtScenes: any[] = [];
        for (let i = 0; i < targetSceneCount && i * scenesPerChunk < sentences.length; i++) {
          const chunk = sentences.slice(i * scenesPerChunk, (i + 1) * scenesPerChunk).join(" ");
          builtScenes.push({
            number: i + 1,
            voiceover: chunk,
            visualPrompt: allVisual || chunk,
            duration: 11,
          });
        }

        if (builtScenes.length > 0) {
          parsed.scenes = builtScenes;
          console.log(`[GenerateVideo] Transform: ${builtScenes.length} scenes from ${sentences.length} sentences`);
        } else {
          throw new Error(`LLM returned no usable content for ${projectType} script`);
        }
      }
    }
  }

  // Fill in missing voiceover from alternative field names in existing scenes
  if (Array.isArray(parsed.scenes)) {
    for (const scene of parsed.scenes) {
      if (!scene.voiceover) {
        scene.voiceover = (scene as any).narration || (scene as any).script || (scene as any).text || "";
      }
      if (!scene.visualPrompt && !scene.visual_prompt) {
        scene.visualPrompt = (scene as any).visual || (scene as any).image || (scene as any).description || "";
      }
    }
  }

  // ── Step 4: Post-process scenes ──────────────────────────────────
  const stylePrompt = getStylePrompt(style, customStyle, projectType);
  const length: string = payload.length || "brief";
  const { scenes, totalImages, title: parsedTitle } = postProcessScenes(
    parsed,
    stylePrompt,
    projectType,
    length,
  );

  // Title source priority:
  //   1. payload.title — set by callers that already chose a meaningful
  //      one (autopost passes the run's topic; the editor's "Restart"
  //      flow passes the original project title). These should NEVER
  //      be clobbered by the LLM's output, since postProcessScenes'
  //      fallback is the literal string "Untitled Video" which would
  //      overwrite an autopost project's topic-derived title.
  //   2. LLM-parsed title from the script JSON.
  //   3. "Untitled Video" fallback (already handled by postProcessScenes).
  const callerTitle =
    typeof payload.title === "string" && payload.title.trim().length > 0
      ? payload.title.trim()
      : null;
  const title = callerTitle ?? parsedTitle;
  const phaseTime = Date.now() - phaseStart;

  // Duration is already set by postProcessScenes/sceneProcessor (11s for non-smartflow).

  console.log(
    `[GenerateVideo] Script parsed: ${scenes.length} scenes, ${totalImages} images, ${phaseTime}ms`,
  );

  // ── Step 5: Create project (or REUSE an existing one) ──────────────
  // The new unified editor flow creates the project row client-side
  // via IntakeForm.tsx BEFORE calling callPhase. In that case payload
  // carries `projectId` and we MUST NOT insert a duplicate — the
  // user's editor is already watching the original projectId; a
  // duplicate insert would create an orphan project with the
  // generation attached, leaving the user's editor forever empty.
  // Only fall back to creating a fresh project when projectId is
  // absent (legacy workspace flow).
  const existingProjectId: string | undefined =
    typeof payload.projectId === "string" && payload.projectId.length > 0
      ? payload.projectId
      : undefined;

  let project: { id: string } | null = null;
  if (existingProjectId) {
    const { data: existing, error: fetchErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", existingProjectId)
      .maybeSingle();
    if (fetchErr) {
      throw new Error(`Failed to look up project ${existingProjectId}: ${fetchErr.message}`);
    }
    if (existing) {
      project = existing;
      // Refresh the project title + content fields from the payload
      // in case the user tweaked them before kickoff. Also flip
      // status to 'generating' so the editor can react.
      const patch: Record<string, unknown> = {
        title,
        status: "generating",
        project_type: projectType,
      };
      if (payload.style) patch.style = payload.style;
      if (payload.format) patch.format = payload.format;
      if (payload.length) patch.length = payload.length;
      await supabase.from("projects").update(patch).eq("id", existingProjectId);
      console.log(`[GenerateVideo] Reusing existing project ${existingProjectId}`);
    }
  }

  if (!project) {
    const projectRow = buildProjectInsert(userId, title, payload, projectType);
    const { data: inserted, error: projectError } = await supabase
      .from("projects")
      .insert(projectRow)
      .select("id")
      .single();

    if (projectError || !inserted) {
      throw new Error(
        `Failed to create project: ${projectError?.message || "no data returned"}`,
      );
    }
    project = inserted;
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
      status: "processing",
      progress: 10,
      script: rawText,
      scenes: scenesWithMeta,
      // Use the phaseStart captured at the VERY TOP of handleGenerateVideo —
      // that's the moment the worker picked up the job. By the time we
      // reach this insert we've already spent 30-180s on research + LLM,
      // and a fresh `new Date()` here would undercount the user's actual
      // wait. handleFinalize reads this value to compute the accurate
      // wall-clock totalTimeMs displayed in the UI.
      started_at: new Date(phaseStart).toISOString(),
    })
    .select("id")
    .single();

  if (genError || !generation) {
    throw new Error(
      `Failed to create generation: ${genError?.message || "no data returned"}`,
    );
  }

  // ── Fire-and-forget: award referral credits on first generation ───
  // Idempotent on the DB side — safe to call on every generation.
  // We deliberately do NOT await this; a referral failure must never
  // block or fail the generation itself.
  if (userId) {
    void supabase
      .rpc("award_referral_credits", { p_referred_user_id: userId })
      .then(({ error }) => {
        if (error) console.warn(`[GenerateVideo] award_referral_credits failed for ${userId}:`, error.message);
      });
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
