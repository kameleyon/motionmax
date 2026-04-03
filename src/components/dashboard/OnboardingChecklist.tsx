import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Circle, PlayCircle, Plus, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ──────────────────────────────────────────────
 * Onboarding checklist for new dashboard users.
 * Tracks step completion via localStorage so
 * progress persists across sessions.
 * ────────────────────────────────────────────── */

interface OnboardingChecklistProps {
  hasProjects: boolean;
  hasSharedProject?: boolean;
}

const STORAGE_KEY = "motionmax_onboarding";
const TUTORIAL_URL = "https://www.youtube.com/@motionmax";

interface OnboardingState {
  tutorialWatched: boolean;
  dismissed: boolean;
}

function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as OnboardingState;
  } catch {
    // corrupted – fall through to defaults
  }
  return { tutorialWatched: false, dismissed: false };
}

function saveState(state: OnboardingState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full / blocked – silent fail
  }
}

export function OnboardingChecklist({ hasProjects, hasSharedProject = false }: OnboardingChecklistProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<OnboardingState>(loadState);

  const persist = useCallback((patch: Partial<OnboardingState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      saveState(next);
      return next;
    });
  }, []);

  // User dismissed the checklist entirely
  if (state.dismissed) return null;

  const steps = [
    {
      id: "account",
      label: "Account created",
      done: true,
      action: null,
      actionLabel: "",
      icon: CheckCircle2,
    },
    {
      id: "tutorial",
      label: "Watch tutorial video",
      done: state.tutorialWatched,
      action: () => {
        window.open(TUTORIAL_URL, "_blank");
        persist({ tutorialWatched: true });
      },
      actionLabel: "Watch",
      icon: PlayCircle,
    },
    {
      id: "first-project",
      label: "Create first project",
      done: hasProjects,
      action: () => navigate("/app/create"),
      actionLabel: "Create",
      icon: Plus,
    },
    {
      id: "share",
      label: "Share a project",
      done: hasSharedProject,
      action: hasProjects ? () => navigate("/projects") : undefined,
      actionLabel: "Go to Projects",
      icon: Share2,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const progressPercent = Math.round((completedCount / steps.length) * 100);
  const allComplete = completedCount === steps.length;

  return (
    <div className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-foreground">Getting Started</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {completedCount}/{steps.length} complete
          </span>
          <Button
            variant="ghost"
            size="icon" aria-label="Dismiss"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={() => persist({ dismissed: true })}
            aria-label="Dismiss onboarding checklist"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-muted rounded-full h-1.5">
        <div
          className="bg-primary h-1.5 rounded-full transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {allComplete ? (
        <p className="text-sm text-primary font-medium text-center py-2">
          🎉 All done! You're ready to create amazing content.
        </p>
      ) : (
        <ul className="space-y-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                )}
                <span
                  className={`text-sm truncate ${
                    step.done
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {!step.done && step.action && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-2.5 text-primary hover:text-primary/80 shrink-0"
                  onClick={step.action}
                >
                  {step.actionLabel}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
