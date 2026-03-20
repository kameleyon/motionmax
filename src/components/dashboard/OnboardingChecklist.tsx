import { useNavigate } from "react-router-dom";
import { CheckCircle2, Circle, PlayCircle, Plus, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface OnboardingChecklistProps {
  hasProjects: boolean;
}

const TUTORIAL_URL = "https://www.youtube.com/@motionmax";

export function OnboardingChecklist({ hasProjects }: OnboardingChecklistProps) {
  const navigate = useNavigate();

  const steps = [
    {
      id: "account",
      label: "Account created",
      done: true, // Always true if they're on the dashboard
      action: null,
    },
    {
      id: "tutorial",
      label: "Watch tutorial video",
      done: false,
      action: () => window.open(TUTORIAL_URL, "_blank"),
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
      done: false,
      action: hasProjects ? () => navigate("/projects") : undefined,
      actionLabel: "Go to Projects",
      icon: Share2,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const progressPercent = Math.round((completedCount / steps.length) * 100);

  return (
    <div className="rounded-xl border border-primary/75 bg-white/90 dark:bg-card/80 backdrop-blur-sm p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-foreground">Getting Started</h3>
        <span className="text-xs text-muted-foreground">
          {completedCount}/{steps.length} complete
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-muted rounded-full h-1.5">
        <div
          className="bg-primary h-1.5 rounded-full transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Steps */}
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
    </div>
  );
}
