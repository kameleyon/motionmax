import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createScopedLogger } from "@/lib/logger";
import { invokeWithTrace, shortTraceRef } from "@/lib/tracing";

const log = createScopedLogger("VoiceCloning");

export interface UserVoice {
  id: string;
  user_id: string;
  voice_name: string;
  voice_id: string;
  sample_url: string;
  description: string | null;
  created_at: string;
}

export function useVoiceCloning() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [isCloning, setIsCloning] = useState(false);

  // Fetch user's voices
  const { data: voices = [], isLoading: voicesLoading } = useQuery({
    queryKey: ["user-voices", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from("user_voices")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data as UserVoice[];
    },
    enabled: !!user?.id,
  });

  // Upload audio file to storage and return storage path (not URL)
  const uploadAudio = async (file: Blob, fileName: string): Promise<string> => {
    if (!user?.id) throw new Error("User not authenticated");

    const filePath = `${user.id}/${Date.now()}-${fileName}`;
    
    const { error: uploadError } = await supabase.storage
      .from("voice_samples")
      .upload(filePath, file, {
        contentType: file.type || "audio/mpeg",
        upsert: false,
      });

    if (uploadError) {
      log.error("Upload error:", uploadError);
      throw new Error("Failed to upload audio file");
    }

    // Return storage path for edge function to download via service role
    return filePath;
  };

  // Clone voice mutation — Fish Audio Instant Voice Cloning.
  // Flow: upload sample to storage → invoke clone-voice-fish edge fn
  // (which queues a worker job) → poll the job until complete → read
  // the new voice id from result.voiceId. The worker handles ffmpeg
  // transcoding (WebM → MP3) and the actual Fish API call so we don't
  // need ffmpeg in the browser or the edge runtime.
  const cloneVoiceMutation = useMutation({
    mutationFn: async ({
      file,
      name,
      description,
      removeNoise,
      consentGiven,
      // C-13-3 (Comply L-C-03): biometric-data consent under BIPA / CUBI
      // / CPRA. Captured separately from `consentGiven` (which covers the
      // ownership-or-permission representation) so we can prove both at
      // audit time. The clone-voice-fish edge function stamps
      // user_voices.voice_biometric_consent_at = now() when this is TRUE.
      // Optional in the type so legacy callers continue to compile, but
      // VoiceLab.tsx now passes it on every invocation.
      biometricConsentGiven,
    }: {
      file: Blob;
      name: string;
      description?: string;
      removeNoise?: boolean;
      consentGiven: boolean;
      biometricConsentGiven?: boolean;
    }) => {
      setIsCloning(true);

      const storagePath = await uploadAudio(file, `${name.replace(/\s+/g, "_")}.mp3`);

      // Audit C-9-6: trace-propagated invoke. Voice cloning is a long-lived
      // async job; failures surface to the user via this catch and the
      // trace ID is the only link to the worker's Fish API call.
      const { data: queued, error: queueError, traceId } = await invokeWithTrace<{
        success?: boolean;
        jobId?: string;
        error?: string;
      }>("clone-voice-fish", {
        body: {
          storagePath,
          voiceName: name,
          description,
          consentGiven,
          // C-13-3: forwarded to the edge function for the timestamp
          // write into user_voices.voice_biometric_consent_at.
          biometricConsentGiven: biometricConsentGiven ?? false,
          removeNoise: removeNoise ?? true,
        },
      });

      if (queueError) {
        const qe = queueError as { context?: { body?: string }; message?: string };
        const errorBody = qe.context?.body;
        const ref = ` (Ref: ${shortTraceRef(traceId)})`;
        if (errorBody) {
          try {
            const parsed = JSON.parse(errorBody);
            throw new Error((parsed.error || "Failed to queue voice clone") + ref);
          } catch {
            throw new Error((qe.message || "Failed to queue voice clone") + ref);
          }
        }
        throw new Error((qe.message || "Failed to queue voice clone") + ref);
      }
      if (!queued?.success || !queued?.jobId) {
        throw new Error(
          `${queued?.error || "Voice clone queue returned no job id"} (Ref: ${shortTraceRef(traceId)})`,
        );
      }

      // Poll the job. Cloning typically takes 8–15s for a 30s sample
      // (download + ffmpeg transcode + Fish IVC training).
      const MAX_WAIT_MS = 90_000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await (supabase
          .from("video_generation_jobs") as unknown as ReturnType<typeof supabase.from>)
          .select("status, result, error_message")
          .eq("id", queued.jobId)
          .single();
        if (row?.status === "completed") {
          return { success: true, voiceId: row.result?.voiceId, voiceName: name };
        }
        if (row?.status === "failed") {
          throw new Error(row.error_message || "Voice clone failed");
        }
      }
      throw new Error("Voice clone timed out — try again with a shorter sample.");
    },
    onSuccess: () => {
      // Invalidate BOTH cache keys — useUserClones (consumed by Voice
      // Lab discovery + intake voice picker + Inspector) keys on
      // ["user-clones", user.id], while internal hooks use
      // ["user-voices"]. Without invalidating both, a freshly cloned
      // voice doesn't show up in the discovery grid until manual refresh.
      queryClient.invalidateQueries({ queryKey: ["user-voices"] });
      queryClient.invalidateQueries({ queryKey: ["user-clones"] });
      toast.success("Voice cloned successfully!");
    },
    onError: (error: Error) => {
      log.error("Clone voice error:", error);
      toast.error(error.message || "Failed to clone voice");
    },
    onSettled: () => {
      setIsCloning(false);
    },
  });

  // Delete voice mutation — provider-aware: the delete-voice-fish
  // edge function inspects the row's `provider` column and routes to
  // Fish or ElevenLabs accordingly, so legacy ElevenLabs clones keep
  // deleting cleanly while new Fish clones go through the right API.
  const deleteVoiceMutation = useMutation({
    mutationFn: async (voiceId: string) => {
      // Audit C-9-6: trace-propagated invoke.
      const { data, error, traceId } = await invokeWithTrace<{
        success?: boolean;
        error?: string;
      }>("delete-voice-fish", { body: { voiceId } });

      if (error) {
        const e = error as { context?: { body?: string }; message?: string };
        const errorBody = e.context?.body;
        const ref = ` (Ref: ${shortTraceRef(traceId)})`;
        if (errorBody) {
          try {
            const parsed = JSON.parse(errorBody);
            throw new Error((parsed.error || "Failed to delete voice") + ref);
          } catch {
            throw new Error((e.message || "Failed to delete voice") + ref);
          }
        }
        throw new Error((e.message || "Failed to delete voice") + ref);
      }

      if (!data?.success) {
        throw new Error(
          `${data?.error || "Failed to delete voice"} (Ref: ${shortTraceRef(traceId)})`,
        );
      }
      return data;
    },
    onSuccess: () => {
      // Invalidate BOTH cache keys — useUserClones (consumed by Voice
      // Lab discovery + intake voice picker + Inspector) keys on
      // ["user-clones", user.id], while internal hooks use
      // ["user-voices"]. Without invalidating both, a freshly cloned
      // voice doesn't show up in the discovery grid until manual refresh.
      queryClient.invalidateQueries({ queryKey: ["user-voices"] });
      queryClient.invalidateQueries({ queryKey: ["user-clones"] });
      toast.success("Your cloned voice was successfully deleted");
    },
    onError: (error: Error) => {
      toast.error("Failed to delete voice: " + error.message);
    },
  });

  // Rename clone — friendly name + optional description. Queues a
  // rename_voice worker job (worker PATCHes Fish /model/{id}, then
  // mirrors into user_voices). Polls the job until complete so the
  // caller can show in-flight UI state.
  const renameVoiceMutation = useMutation({
    mutationFn: async ({ rowId, newName, newDescription }: { rowId: string; newName: string; newDescription?: string | null }) => {
      if (!user?.id) throw new Error("Not authenticated");
      const trimmed = newName.trim();
      if (!trimmed) throw new Error("Name cannot be empty");

      const { data: job, error: queueError } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: user.id,
          task_type: "rename_voice",
          payload: { rowId, newName: trimmed, newDescription: newDescription ?? undefined },
          status: "pending",
        })
        .select("id")
        .single();
      if (queueError || !job) throw new Error(queueError?.message ?? "Failed to queue rename job");

      const MAX_WAIT = 30_000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT) {
        await new Promise((r) => setTimeout(r, 1500));
        const { data: row } = await (supabase
          .from("video_generation_jobs") as unknown as ReturnType<typeof supabase.from>)
          .select("status, error_message")
          .eq("id", job.id)
          .single();
        if (row?.status === "completed") return { rowId, newName: trimmed };
        if (row?.status === "failed") throw new Error(row.error_message ?? "Rename failed");
      }
      throw new Error("Rename timed out — try again.");
    },
    onSuccess: () => {
      // Same dual-key invalidation pattern as clone create — keeps
      // discovery + intake picker + Inspector all in sync without F5.
      queryClient.invalidateQueries({ queryKey: ["user-voices"] });
      queryClient.invalidateQueries({ queryKey: ["user-clones"] });
      toast.success("Voice renamed");
    },
    onError: (error: Error) => {
      toast.error("Rename failed: " + error.message);
    },
  });

  return {
    voices,
    voicesLoading,
    isCloning,
    cloneVoice: cloneVoiceMutation.mutateAsync,
    deleteVoice: deleteVoiceMutation.mutate,
    renameVoice: renameVoiceMutation.mutateAsync,
    isRenaming: renameVoiceMutation.isPending,
  };
}
