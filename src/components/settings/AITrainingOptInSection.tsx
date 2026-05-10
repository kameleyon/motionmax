/**
 * AITrainingOptInSection — Settings → Security → AI model training
 *
 * Surfaces the user-facing toggle for profiles.ai_training_opt_in.
 *
 *   • Default = OPT-OUT. motionmax does NOT use the user's projects,
 *     scripts, voice samples or generated content to train AI models
 *     unless the user explicitly toggles this on. Every legacy and
 *     newly-created profile row starts with FALSE.
 *   • Toggle writes through the user's own JWT so the existing
 *     profiles-self-update RLS policy enforces ownership.
 *   • Each toggle bumps profiles.ai_training_opt_in_changed_at = now()
 *     so the "Last changed" sub-label and the export-my-data archive
 *     can prove the effective date of the user's current consent state.
 *
 * Compliance context — B-NEW-14 / Comply L-B-03:
 *
 *   Privacy Policy §3 — "We do not use your generated content to train
 *   AI models without explicit opt-in consent."
 *   Privacy Policy §4 — "Consent (Art. 6(1)(a)): […] AI training opt-in
 *   (if you explicitly enable it)."
 *
 * Promising functionality that did not exist was an FTC §5
 * strict-liability deceptive-practice risk; the corresponding column
 * arrives in supabase/migrations/20260510150000_ai_training_opt_in.sql
 * and this component is the matching UI affordance.
 *
 * See docs/ai-training-policy.md — at time of writing, NO code in the
 * repo harvests user content for training. Any future harvest path
 * must gate on profiles.ai_training_opt_in === TRUE.
 */

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

type ProfileAiOptInRow = {
  ai_training_opt_in: boolean | null;
  ai_training_opt_in_changed_at: string | null;
};

export default function AITrainingOptInSection() {
  const { user } = useAuth();
  const [optIn, setOptIn] = useState<boolean>(false);
  const [changedAt, setChangedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!user?.id) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        // Cast: ai_training_opt_in / _changed_at are new columns not yet
        // in the generated Supabase types. Migration 20260510150000.
        const { data, error } = (await supabase
          .from("profiles")
          .select("ai_training_opt_in, ai_training_opt_in_changed_at")
          .eq("user_id", user.id)
          .single()) as unknown as {
            data: ProfileAiOptInRow | null;
            error: { message: string } | null;
          };
        if (cancelled) return;
        if (error) {
          // Non-fatal — surface the conservative default and let the user
          // try again. We don't toast here because Settings.tsx does its
          // own profile fetch in parallel; spamming the user with two
          // identical errors on a transient network blip is worse than
          // silently falling back to "off" (which is also the safe
          // default for AI training).
          setOptIn(false);
          setChangedAt(null);
        } else {
          setOptIn(Boolean(data?.ai_training_opt_in));
          setChangedAt(data?.ai_training_opt_in_changed_at ?? null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleToggle = async (next: boolean) => {
    if (!user?.id || isSaving) return;
    const previous = optIn;
    const previousChangedAt = changedAt;
    // Optimistic update — flip the UI immediately, roll back on error.
    setOptIn(next);
    setIsSaving(true);
    const nowIso = new Date().toISOString();
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          ai_training_opt_in: next,
          ai_training_opt_in_changed_at: nowIso,
          updated_at: nowIso,
        } as never)
        .eq("user_id", user.id);
      if (error) throw error;
      setChangedAt(nowIso);
      toast.success(
        next
          ? "Thanks — you've opted in to help improve our AI models."
          : "You've opted out. We won't use your content to train AI models.",
      );
    } catch (err) {
      setOptIn(previous);
      setChangedAt(previousChangedAt);
      const message = err instanceof Error ? err.message : "Please try again.";
      toast.error(`Couldn't save your preference: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const lastChangedLabel = changedAt
    ? new Date(changedAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <div className="card" data-testid="ai-training-opt-in-section">
      <h3 style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Sparkles size={18} style={{ color: "var(--cyan)" }} />
        AI model training
      </h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-dim)",
          margin: "0 0 14px",
          lineHeight: 1.55,
        }}
      >
        By default, motionmax does <strong>NOT</strong> use your projects,
        scripts, voices, or generated content to train AI models. Opt in below
        if you&apos;d like to help improve our models. You can change this at
        any time.
      </p>
      <div className="set-row" style={{ borderTop: 0, paddingTop: 0 }}>
        <div className="info">
          <div className="t">Use my content to improve AI models</div>
          <div className="d">
            {isLoading
              ? "Loading your current preference…"
              : optIn
                ? "Opted in — your content may be used to train motionmax models."
                : "Opted out — your content is never used for AI training."}
            {lastChangedLabel && !isLoading && (
              <>
                {" "}
                <span style={{ color: "var(--ink-mute)" }}>
                  Last changed: {lastChangedLabel}.
                </span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {(isLoading || isSaving) && (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          )}
          <Switch
            checked={optIn}
            onCheckedChange={handleToggle}
            disabled={isLoading || isSaving || !user?.id}
            aria-label="Allow motionmax to use my content for AI model training"
          />
        </div>
      </div>
    </div>
  );
}
