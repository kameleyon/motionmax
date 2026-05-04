/**
 * Worker handler for `task_type='autopost_rerender'`.
 *
 * Re-runs the post-script phase of the autopost pipeline against an
 * existing project + generation, KEEPING the existing scene scripts
 * (voiceover, visualPrompt, characterBible, etc.) and just re-rendering
 * media: audio, images, videos, then re-exporting the final mp4.
 *
 * Why a separate task type instead of re-using autopost_render:
 *   - autopost_render runs the full script→audio→images→video→
 *     finalize→export pipeline from a fresh topic + prompt.
 *     Re-running it would generate a NEW script with potentially
 *     different scenes, breaking the user's "keep what I already have,
 *     just regenerate the visuals" intent.
 *   - This handler skips the script phase entirely. The generation
 *     row already has scenes[] with voiceover + visualPrompt populated;
 *     the existing per-scene worker handlers read from that.
 *
 * Payload : { projectId: string, generationId: string }
 * Returns : { finalUrl: string, exportJobId: string }
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";

interface AutopostRerenderPayload {
  projectId: string;
  generationId: string;
}

interface AutopostRerenderResult {
  finalUrl?: string;
  exportJobId?: string;
}

const POLL_INTERVAL_MS = 5_000;
const PHASE_TIMEOUT_MS = 30 * 60 * 1000;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      depends_on: dependsOn as any,
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
    if (row.status === "completed") return row.result ?? row.payload ?? {};
    if (row.status === "failed") {
      throw new Error(`${taskType} job ${jobId} failed: ${row.error_message ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`${taskType} job ${jobId} timed out after ${Math.round(timeoutMs / 60000)} min`);
}

export async function handleAutopostRerender(
  jobId: string,
  payload: AutopostRerenderPayload,
  userId: string,
): Promise<AutopostRerenderResult> {
  const { projectId, generationId } = payload;
  if (!projectId || !generationId) {
    throw new Error("autopost_rerender: payload requires projectId + generationId");
  }

  await writeSystemLog({
    jobId, userId, projectId, generationId,
    category: "system_info",
    eventType: "autopost_rerender_started",
    message: `Autopost rerender started for project ${projectId}`,
  });

  // Project context — type drives smartflow vs cinematic vs explainer
  // routing, format drives export aspect ratio, intake_settings holds
  // captionStyle. Keep the select narrow so we don't pull the whole row.
  const { data: proj, error: projErr } = await supabase
    .from("projects")
    .select("project_type, format, intake_settings")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr || !proj) throw new Error(`autopost_rerender: project not found: ${projErr?.message ?? "no row"}`);

  const projectType = (proj as { project_type?: string }).project_type ?? "cinematic";
  const format = (proj as { format?: string }).format ?? "landscape";
  const intake = (proj as { intake_settings?: Record<string, unknown> }).intake_settings ?? {};
  const captionStyle = (intake.captionStyle as string) ?? "none";
  const isSmartflow = projectType === "smartflow";
  const isCinematic = projectType === "cinematic";

  // Scene count — drives how many image/video jobs to queue.
  const { data: gen, error: genErr } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .maybeSingle();
  if (genErr || !gen) throw new Error(`autopost_rerender: generation not found: ${genErr?.message ?? "no row"}`);
  const scenes = ((gen as { scenes?: unknown[] }).scenes ?? []) as unknown[];
  const sceneCount = scenes.length;
  if (sceneCount === 0) throw new Error("autopost_rerender: generation has zero scenes");

  // Audio — master_audio for cinematic + explainer, per-scene for smartflow
  const audioJobIds: string[] = [];
  if (isSmartflow) {
    for (let i = 0; i < sceneCount; i++) {
      const id = await submitJob(
        userId,
        "cinematic_audio",
        { phase: "audio", projectId, generationId, sceneIndex: i },
        [],
        projectId,
      );
      audioJobIds.push(id);
    }
  } else {
    const id = await submitJob(
      userId,
      "master_audio",
      { phase: "master_audio", projectId, generationId },
      [],
      projectId,
    );
    audioJobIds.push(id);
  }

  // Images — every scene, no deps so they parallelize
  const imageJobIds: string[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const id = await submitJob(
      userId,
      "cinematic_image",
      { phase: "images", projectId, generationId, sceneIndex: i },
      [],
      projectId,
    );
    imageJobIds.push(id);
  }

  // Videos — cinematic only. Each video depends on its own image plus
  // the next scene's image (Kling V3 Pro uses next scene's first frame
  // as the end_image for seamless transitions).
  const videoJobIds: string[] = [];
  if (isCinematic) {
    for (let i = 0; i < sceneCount; i++) {
      const deps = [imageJobIds[i]];
      if (i < sceneCount - 1) deps.push(imageJobIds[i + 1]);
      const id = await submitJob(
        userId,
        "cinematic_video",
        { phase: "video", projectId, generationId, sceneIndex: i },
        deps,
        projectId,
      );
      videoJobIds.push(id);
    }
  }

  // Finalize — strips _meta from scenes, writes generation status=complete
  const finalizeDeps = [...audioJobIds, ...(isCinematic ? videoJobIds : imageJobIds)];
  const finalizeJobId = await submitJob(
    userId,
    "finalize_generation",
    { phase: "finalize", generationId, projectId },
    finalizeDeps,
    projectId,
  );
  await waitForJob(finalizeJobId, PHASE_TIMEOUT_MS, "finalize_generation");

  // Export — assembles final mp4, depends on finalize
  const exportJobId = await submitJob(
    userId,
    "export_video",
    {
      project_id: projectId,
      project_type: projectType,
      format,
      caption_style: captionStyle,
    },
    [finalizeJobId],
    projectId,
  );
  const exportResult = await waitForJob(exportJobId, EXPORT_TIMEOUT_MS, "export_video");
  const finalUrl = (exportResult.finalUrl as string) ?? (exportResult.url as string);
  if (!finalUrl) throw new Error("autopost_rerender: export_video result missing finalUrl");

  await writeSystemLog({
    jobId, userId, projectId, generationId,
    category: "system_info",
    eventType: "autopost_rerender_completed",
    message: `Autopost rerender completed`,
    details: { finalUrl, exportJobId, audioJobs: audioJobIds.length, imageJobs: imageJobIds.length, videoJobs: videoJobIds.length },
  });

  return { finalUrl, exportJobId };
}
