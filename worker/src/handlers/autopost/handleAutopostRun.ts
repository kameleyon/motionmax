/**
 * Worker handler for `task_type='autopost_render'`.
 *
 * Mirrors the browser-side `unifiedPipeline.ts`: walks the same per-phase
 * worker handlers (script → audio → images → video → finalize → export)
 * but driven from the worker itself so a scheduled or "Run now" autopost
 * fire produces a finished video without anyone needing to keep a tab open.
 *
 * Why this exists:
 *   - The interactive flow inserts a `projects` row, navigates to
 *     `/app/editor/:id?autostart=1`, and the editor's pipeline orchestrates
 *     phase by phase via realtime subscriptions.
 *   - Autopost has no browser. Cron's autopost_tick() and the user-driven
 *     autopost_fire_now() RPC both insert a `video_generation_jobs` row
 *     with task_type='autopost_render'. Without a handler that row would
 *     sit pending forever.
 *
 * Flow:
 *   1. Load the autopost_run + schedule + frozen config_snapshot
 *   2. Submit a `generate_video` job (script phase) with the schedule's
 *      mode, voice, style, character settings and the resolved prompt as
 *      `content`. The topic becomes the project title.
 *   3. Wait for the script job to finish; pick up sceneCount, projectId,
 *      generationId.
 *   4. Submit audio (master_audio for non-smartflow / per-scene cinematic
 *      _audio for smartflow) + per-scene cinematic_image jobs. For mode
 *      'cinematic' also submit per-scene cinematic_video jobs that depend
 *      on their image jobs.
 *   5. Submit a `finalize_generation` job depending on every audio + image
 *      (or video) job.
 *   6. Wait for finalize, then submit `export_video` and wait.
 *   7. Return the export's finalUrl + meta as this job's payload — the
 *      `autopost_on_video_completed` trigger reads it and fans out
 *      publish jobs / email / library_only based on delivery_method.
 *
 * The autopost_runs row already exists (created by autopost_tick or
 * autopost_fire_now). We update its status as we progress so the
 * dashboard's "Last Run / Next Run" cells stay live.
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";
import { generateAutopostThumbnail } from "./thumbnails.js";
import { randomUUID } from "node:crypto";

interface AutopostRenderPayload {
  autopost_run_id: string;
  prompt?: string;
  motion_preset?: string | null;
  duration_seconds?: number | null;
  resolution?: string | null;
}

interface AutopostRenderResult {
  finalUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  durationSeconds?: number;
  sizeBytes?: number;
  projectId: string;
  generationId: string;
  title: string;
  sceneCount: number;
  autopost_run_id: string;
}

interface ScheduleConfig {
  mode?: string;
  language?: string;
  voice_name?: string;
  voice_type?: string;
  voice_id?: string;
  format?: string;
  length?: string;
  style?: string;
  character_description?: string | null;
  character_consistency_enabled?: boolean;
  character_images?: string[] | null;
  intake_settings?: Record<string, unknown>;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  name: string;
  prompt_template: string;
  config_snapshot: ScheduleConfig | null;
  caption_template: string | null;
}

interface AutopostRunRow {
  id: string;
  schedule_id: string;
  topic: string | null;
  prompt_resolved: string | null;
  status: string;
}

const POLL_INTERVAL_MS = 5_000;
const SCRIPT_TIMEOUT_MS = 8 * 60 * 1000;
const PHASE_TIMEOUT_MS = 30 * 60 * 1000;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

async function setRunStatus(runId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await supabase
    .from("autopost_runs")
    .update({ status, ...extra })
    .eq("id", runId);
}

async function setRunProgress(runId: string, pct: number): Promise<void> {
  await supabase
    .from("autopost_runs")
    .update({ progress_pct: Math.max(0, Math.min(100, Math.round(pct))) })
    .eq("id", runId);
}

async function submitJob(
  userId: string,
  taskType: string,
  payload: Record<string, unknown>,
  dependsOn: string[] = [],
  projectId?: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("video_generation_jobs")
    .insert({
      user_id: userId,
      project_id: projectId ?? null,
      task_type: taskType,
      status: "pending",
      payload,
      depends_on: dependsOn,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`submitJob(${taskType}) failed: ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

async function waitForJob(jobId: string, timeoutMs: number, taskType: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("video_generation_jobs")
      .select("status, error_message, payload, result")
      .eq("id", jobId)
      .single();
    if (error) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const row = data as { status: string; error_message?: string | null; payload?: Record<string, unknown> | null; result?: Record<string, unknown> | null };
    if (row.status === "completed") {
      return row.result ?? row.payload ?? {};
    }
    if (row.status === "failed") {
      throw new Error(`${taskType} job ${jobId} failed: ${row.error_message ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`${taskType} job ${jobId} timed out after ${Math.round(timeoutMs / 60000)} min`);
}

async function markRunFailed(runId: string, error: unknown, jobId?: string, userId?: string): Promise<void> {
  // Surface the underlying cause from a depends_on chain failure: the
  // dispatcher wraps it in "finalize_generation job ... failed:
  // Upstream dependency failed: job ... (cinematic_video) — <real>"
  // — pull the trailing message after the last em-dash so users see
  // "kling: Failure to pass the risk control system" instead of the
  // whole nesting noise.
  const raw = error instanceof Error ? error.message : String(error);
  const tail = raw.split(/—|\u2014/).pop()?.trim() || raw;
  const summary = (tail.length > 240 ? `${tail.slice(0, 237)}…` : tail);
  try {
    await supabase
      .from("autopost_runs")
      .update({
        status: "failed",
        error_summary: summary,
        progress_pct: null,
      })
      .eq("id", runId);
    // Surface the failure into RunDetail's log feed too. RunDetail
    // filters system_logs on details->>autopost_run_id, so without
    // this entry the user only sees the single error_summary on the
    // run row and can't trace which phase imploded.
    await writeSystemLog({
      jobId,
      userId,
      category: "system_error",
      eventType: "autopost_render_failed",
      message: `Autopost run ${runId} marked failed: ${summary}`,
      details: { autopost_run_id: runId, error: summary, fullError: raw.slice(0, 1000) },
    });
  } catch (err) {
    console.warn(`[autopost_render] markRunFailed failed for ${runId}: ${(err as Error).message}`);
  }
}

export async function handleAutopostRun(
  jobId: string,
  payload: AutopostRenderPayload,
  userId: string | undefined,
): Promise<AutopostRenderResult> {
  const runId = payload.autopost_run_id;
  if (!runId) throw new Error("autopost_render: payload.autopost_run_id missing");
  if (!userId) throw new Error("autopost_render: job.user_id missing");

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_start",
    message: `Autopost render started for run ${runId}`,
    details: { autopost_run_id: runId },
  });

  try {
    return await runPipeline(jobId, payload, userId, runId);
  } catch (err) {
    // The orchestrator throws when ANY child job in the depends_on
    // chain fails (Kling moderation, OOM, transient API, etc.). Mark
    // the autopost_run failed so the dashboard stops showing it as
    // "GENERATING 35%" indefinitely and the user can see the real
    // reason. Re-throw so the worker dispatcher still marks the
    // autopost_render job failed itself.
    await markRunFailed(runId, err, jobId, userId);
    throw err;
  }
}

async function runPipeline(
  jobId: string,
  payload: AutopostRenderPayload,
  userId: string,
  runId: string,
): Promise<AutopostRenderResult> {

  // Load run + schedule. service_role bypasses RLS.
  const { data: runData, error: runErr } = await supabase
    .from("autopost_runs")
    .select("id, schedule_id, topic, prompt_resolved, status")
    .eq("id", runId)
    .single();
  if (runErr || !runData) throw new Error(`autopost_render: run not found: ${runErr?.message}`);
  const run = runData as AutopostRunRow;

  const { data: schedData, error: schedErr } = await supabase
    .from("autopost_schedules")
    .select("id, user_id, name, prompt_template, config_snapshot, caption_template")
    .eq("id", run.schedule_id)
    .single();
  if (schedErr || !schedData) throw new Error(`autopost_render: schedule not found: ${schedErr?.message}`);
  const schedule = schedData as ScheduleRow;

  const config: ScheduleConfig = schedule.config_snapshot ?? {};
  const projectType = config.mode ?? "smartflow";
  const isSmartflow = projectType === "smartflow";
  const isCinematic = projectType === "cinematic";

  const topic = run.topic?.trim() ?? "";
  const title = topic || schedule.name || "Autopost video";

  // Pull the last 10 topics this schedule has already produced (any
  // status), so the prompt builder can hand them to the LLM as a
  // "do not repeat" exclusion list. Pattern adapted from autonomux
  // run-agent's previousTopics gathering. Empty list is fine.
  const { data: prevRuns } = await supabase
    .from("autopost_runs")
    .select("topic")
    .eq("schedule_id", schedule.id)
    .neq("id", run.id)
    .not("topic", "is", null)
    .order("fired_at", { ascending: false })
    .limit(10);
  const previousTopics: string[] = (prevRuns ?? [])
    .map((r) => (r as { topic?: string | null }).topic)
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);

  // `content` now carries the user's intake-form prompt template
  // verbatim (style/tone/persona guidance). Topic and previousTopics
  // are passed as STRUCTURED FIELDS on the payload — the prompt
  // builders surface them as their own labeled blocks in the user
  // message ("EXACT TOPIC FOR THIS VIDEO" + "DO NOT REPEAT"). This
  // is the autonomux pattern: topic is never mixed with content.
  const baseContent = (run.prompt_resolved?.trim() || schedule.prompt_template || "").trim();

  // Autopost-only character policy. The core research + script prompts
  // (researchTopic.ts:61, buildCinematic.ts character bible, etc.)
  // train the script LLM to describe ethnicity / skin tone / detailed
  // features for any character, which produces fully-rendered humans
  // even when the chosen art style is paper-cutout or stick-figure.
  // For autopost runs (where the user's intake didn't supply a
  // character) we prepend an explicit override that tells the LLM to
  // stay in style and avoid demographic markers entirely. Only fires
  // when no schedule-level character_description is set.
  const hasUserCharacter =
    typeof config.character_description === "string" && config.character_description.trim().length > 0;
  const characterPolicy = hasUserCharacter ? "" : `=== CHARACTER POLICY (autopost-specific) ===
Do NOT invent or describe any human character's race, ethnicity, skin tone, hair, age, gender, clothing, or facial features, When the chosen art style is stick-figure / paper-cutout / moody / sketch — figures must be simple, generic, abstract shapes and stick to the style prompt strictly. If a person is in the scene, render them as described in the style prompt with no demographic markers.

`;

  const content = `${characterPolicy}${baseContent}`;

  const projectId = randomUUID();

  await setRunStatus(runId, "generating");
  await setRunProgress(runId, 5);

  // Insert the projects row up front. Two reasons:
  //   1. video_generation_jobs.project_id has a FK to projects(id), so
  //      submitting the script job with a non-existent project_id fails
  //      with a foreign-key violation.
  //   2. handleGenerateVideo looks up payload.projectId and only reuses
  //      the row when it exists — otherwise it inserts a NEW row with
  //      a different id, leaving our subsequent jobs pointing at a
  //      phantom project. Mirroring IntakeForm's "insert first, then
  //      kickoff" pattern keeps both code paths consistent.
  const intake = (config.intake_settings ?? {}) as Record<string, unknown>;
  const projectRow: Record<string, unknown> = {
    id: projectId,
    user_id: schedule.user_id,
    title,
    content,
    project_type: projectType,
    format: config.format ?? "landscape",
    length: config.length ?? "short",
    style: config.style ?? "realistic",
    voice_type: config.voice_type ?? "standard",
    voice_id: config.voice_id ?? null,
    voice_name: config.voice_name ?? null,
    voice_inclination: config.language ?? null,
    character_description: config.character_description ?? null,
    character_consistency_enabled: !!config.character_consistency_enabled,
    character_images: config.character_images ?? null,
    intake_settings: intake,
    status: "generating",
  };
  const { error: projInsertErr } = await supabase
    .from("projects")
    .insert(projectRow);
  if (projInsertErr) {
    throw new Error(`autopost_render: failed to insert projects row: ${projInsertErr.message}`);
  }

  // Phase 1 — Script. handleGenerateVideo finds the project via
  // payload.projectId and updates it with title/status, then runs the
  // script LLM call.
  const scriptPayload: Record<string, unknown> = {
    projectId,
    content,
    format: config.format ?? "landscape",
    length: config.length ?? "short",
    style: config.style ?? "realistic",
    projectType,
    voiceType: config.voice_type ?? "standard",
    voiceId: config.voice_id ?? null,
    voiceName: config.voice_name ?? null,
    voiceInclination: config.language ?? null,
    language: config.language ?? null,
    characterDescription: config.character_description ?? null,
    characterImages: config.character_images ?? null,
    characterConsistencyEnabled: !!config.character_consistency_enabled,
    title,
    // Autopost-only structured fields. buildPrompt in generateVideo.ts
    // forwards these to the per-flow builder which renders them as
    // dedicated user-message blocks ("EXACT TOPIC FOR THIS VIDEO" +
    // "DO NOT REPEAT"). Without these, the LLM had to infer the
    // subject from `content`, where it lost out to whatever the user
    // typed in their intake-form prompt template.
    topic: topic || null,
    previousTopics,
  };
  // Pull style/feature toggles out of intake_settings so they round-trip
  // through the worker prompt builders the same way the interactive
  // intake form passes them. (`intake` was hoisted above the projects
  // insert so this and the project row stay in sync.)
  if (intake.brandName) scriptPayload.brandName = intake.brandName;
  if (intake.presenterFocus) scriptPayload.presenterFocus = intake.presenterFocus;
  if (intake.disableExpressions === true) scriptPayload.disableExpressions = true;

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_script_queued",
    message: `Script job queued for run ${runId}`,
    details: { autopost_run_id: runId, projectId, scriptJobId: undefined, projectType, length: config.length ?? "short" },
  });

  const scriptJobId = await submitJob(userId, "generate_video", scriptPayload, [], projectId);
  const scriptResult = await waitForJob(scriptJobId, SCRIPT_TIMEOUT_MS, "generate_video");

  const generationId = (scriptResult.generationId as string) ?? (scriptResult.generation_id as string);
  const sceneCount = Number((scriptResult.sceneCount as number) ?? (scriptResult.scene_count as number) ?? 0);
  if (!generationId || sceneCount < 1) {
    throw new Error(`autopost_render: script result missing generationId/sceneCount (${JSON.stringify(scriptResult).slice(0, 200)})`);
  }
  await setRunProgress(runId, 25);

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_script_done",
    message: `Script ready for run ${runId} (sceneCount=${sceneCount})`,
    details: { autopost_run_id: runId, projectId, generationId, sceneCount },
  });

  // Phase 2 — submit all subsequent jobs with depends_on chains. The
  // worker handles dependency resolution itself, so we only need to wait
  // on the LAST node (finalize) instead of marshalling each step.
  const audioJobIds: string[] = [];
  const imageJobIds: string[] = [];
  const videoJobIds: string[] = [];

  if (isSmartflow) {
    for (let i = 0; i < sceneCount; i++) {
      const id = await submitJob(
        userId,
        "cinematic_audio",
        { phase: "audio", projectId, generationId, sceneIndex: i, language: config.language },
      );
      audioJobIds.push(id);
    }
  } else {
    const id = await submitJob(
      userId,
      "master_audio",
      { phase: "master_audio", projectId, generationId, language: config.language },
    );
    audioJobIds.push(id);
  }

  for (let i = 0; i < sceneCount; i++) {
    const id = await submitJob(
      userId,
      "cinematic_image",
      { phase: "images", projectId, generationId, sceneIndex: i },
    );
    imageJobIds.push(id);
  }

  if (isCinematic) {
    for (let i = 0; i < sceneCount; i++) {
      const deps = [imageJobIds[i]];
      if (i < sceneCount - 1) deps.push(imageJobIds[i + 1]);
      const id = await submitJob(
        userId,
        "cinematic_video",
        { phase: "video", projectId, generationId, sceneIndex: i },
        deps,
      );
      videoJobIds.push(id);
    }
  }

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_audio_queued",
    message: `Audio + image jobs queued for run ${runId}`,
    details: {
      autopost_run_id: runId,
      projectId,
      generationId,
      audioJobs: audioJobIds.length,
      imageJobs: imageJobIds.length,
      videoJobs: videoJobIds.length,
      mode: projectType,
    },
  });

  const finalizeDeps = [...audioJobIds, ...(isCinematic ? videoJobIds : imageJobIds)];
  const finalizeJobId = await submitJob(
    userId,
    "finalize_generation",
    { phase: "finalize", generationId, projectId },
    finalizeDeps,
  );
  await setRunProgress(runId, 35);

  await waitForJob(finalizeJobId, PHASE_TIMEOUT_MS, "finalize_generation");
  await setRunProgress(runId, 80);

  // Per-scene Kling rejection fallback surfacing. handleCinematicVideo
  // sets scene._meta.heldFrame for any scene rejected by Kling
  // moderation; the export pipeline still produces a finished mp4
  // (still image stretched over the scene's audio duration) so the
  // user gets a watchable result. Expose the count + indices on the
  // run record so RunDetail / email recipients know one or more
  // scenes were held — without this the user would assume the render
  // succeeded silently.
  const { data: finalGen } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .maybeSingle();
  const heldFrameIndices: number[] = [];
  const heldFrameReasons: string[] = [];
  if (finalGen && Array.isArray((finalGen as { scenes?: unknown[] }).scenes)) {
    const sceneArr = (finalGen as { scenes: unknown[] }).scenes;
    sceneArr.forEach((sc, i) => {
      const meta = (sc as { _meta?: { heldFrame?: { reason?: string } } } | null)?._meta;
      if (meta && meta.heldFrame) {
        heldFrameIndices.push(i);
        if (typeof meta.heldFrame.reason === "string") {
          heldFrameReasons.push(meta.heldFrame.reason);
        }
      }
    });
  }
  if (heldFrameIndices.length > 0) {
    const summary =
      heldFrameIndices.length === 1
        ? `Scene ${heldFrameIndices[0] + 1} held as still frame (Kling moderation)`
        : `${heldFrameIndices.length} scenes held as still frames (Kling moderation): ${heldFrameIndices.map((i) => i + 1).join(", ")}`;
    await supabase
      .from("autopost_runs")
      .update({ error_summary: summary })
      .eq("id", runId);
    await writeSystemLog({
      jobId,
      userId,
      category: "system_warning",
      eventType: "autopost_render_held_frames",
      message: summary,
      details: {
        autopost_run_id: runId,
        projectId,
        generationId,
        heldFrameIndices,
        sampleReasons: heldFrameReasons.slice(0, 3),
      },
    });
  }

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_finalize_done",
    message: `Finalize complete for run ${runId}`,
    details: { autopost_run_id: runId, projectId, generationId, finalizeJobId, heldFrameCount: heldFrameIndices.length },
  });

  // Phase 3 — Export. Stitches scenes into the final mp4 the publishers
  // and email handler can hand off as a URL.
  //
  // Format MUST be forwarded — exportVideo.ts defaults to "landscape"
  // when payload.format is missing, which silently downgraded every
  // portrait autopost video to 16:9 with letterboxing. The user-chosen
  // format is captured in config.format at schedule-create time and is
  // already used to insert the project row above; mirror it here so
  // the export pipeline picks the right target resolution.
  const captionStyle = (intake.captionStyle as string) ?? "none";
  const exportJobId = await submitJob(
    userId,
    "export_video",
    {
      project_id: projectId,
      project_type: projectType,
      format: config.format ?? "landscape",
      caption_style: captionStyle,
    },
    [finalizeJobId],
    projectId,
  );
  const exportResult = await waitForJob(exportJobId, EXPORT_TIMEOUT_MS, "export_video");

  const finalUrl = (exportResult.finalUrl as string) ?? (exportResult.url as string);
  if (!finalUrl) {
    throw new Error("autopost_render: export_video result missing finalUrl");
  }
  await setRunProgress(runId, 100);

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_export_done",
    message: `Export complete for run ${runId}`,
    details: {
      autopost_run_id: runId,
      projectId,
      exportJobId,
      finalUrl,
      durationSeconds: exportResult.durationSeconds,
      sizeBytes: exportResult.sizeBytes,
    },
  });

  // Tag the autopost_run with this autopost_render job id so the publish
  // dispatcher can look up finalUrl by run.video_job_id. The trigger
  // flips status='rendered' once we mark the autopost_render row
  // 'completed' (worker dispatcher does that with our return value).
  await supabase
    .from("autopost_runs")
    .update({ video_job_id: jobId })
    .eq("id", runId);

  // Generate the thumbnail BEFORE we return. The autopost_render
  // completion fires `autopost_on_video_completed`, which queues the
  // email-delivery job — if the thumbnail were still uploading in the
  // background, the email would render with no hero image. Awaiting
  // here costs ~2–5s but guarantees thumbnail_url is set before any
  // downstream step reads the run row.
  try {
    await generateAutopostThumbnail(runId, finalUrl);
    await writeSystemLog({
      jobId,
      userId,
      category: "system_info",
      eventType: "autopost_render_thumbnail_success",
      message: `Thumbnail generated for run ${runId}`,
      details: { autopost_run_id: runId, projectId },
    });
  } catch (err) {
    console.warn(`[autopost] thumbnail generation failed for run ${runId}:`, err);
    await writeSystemLog({
      jobId,
      userId,
      category: "system_warning",
      eventType: "autopost_render_thumbnail_failed",
      message: `Thumbnail generation failed for run ${runId}`,
      details: {
        autopost_run_id: runId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_render_complete",
    message: `Autopost render complete for run ${runId} (sceneCount=${sceneCount})`,
    details: { autopost_run_id: runId, projectId, generationId, sceneCount, finalUrl },
  });

  return {
    finalUrl,
    width: exportResult.width as number | undefined,
    height: exportResult.height as number | undefined,
    durationMs: exportResult.durationMs as number | undefined,
    durationSeconds: exportResult.durationSeconds as number | undefined,
    sizeBytes: exportResult.sizeBytes as number | undefined,
    projectId,
    generationId,
    title,
    sceneCount,
    autopost_run_id: runId,
  };
}
