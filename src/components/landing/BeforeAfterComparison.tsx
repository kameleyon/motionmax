import { useRef } from "react";
import { motion } from "framer-motion";
import { Clock, Zap, ArrowRight, FileText, Mic, Image, Film, CheckCircle2 } from "lucide-react";
import { useTrackImpression } from "@/hooks/useAnalytics";

/* ──────────────────────────────────────────────
 * Before/After comparison section for the landing
 * page. Shows manual video editing workflow vs
 * MotionMax AI-assisted workflow with time-saved.
 * ────────────────────────────────────────────── */

interface WorkflowStep {
  label: string;
  time: string;
}

const MANUAL_STEPS: WorkflowStep[] = [
  { label: "Write script", time: "2 hrs" },
  { label: "Find/create visuals", time: "4 hrs" },
  { label: "Record voiceover", time: "1 hr" },
  { label: "Edit in video software", time: "6 hrs" },
  { label: "Revisions & export", time: "2 hrs" },
];

const MOTIONMAX_STEPS: WorkflowStep[] = [
  { label: "Paste your text", time: "1 min" },
  { label: "Choose style & format", time: "1 min" },
  { label: "AI generates video", time: "3 min" },
  { label: "Review & export", time: "2 min" },
];

const MANUAL_TOTAL = "~15 hours";
const MOTIONMAX_TOTAL = "~7 minutes";
const TIME_SAVED_PERCENT = 99;

export default function BeforeAfterComparison() {
  const ref = useRef<HTMLDivElement>(null);
  useTrackImpression("before_after_section_view", ref);

  return (
    <section ref={ref} className="py-20 sm:py-28 border-t border-border/30">
      <div className="mx-auto max-w-6xl px-6 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Save {TIME_SAVED_PERCENT}% of Your Production Time
          </h2>
          <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
            What used to take a full day now takes minutes with AI-powered generation.
          </p>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-2 items-stretch">
          {/* Manual workflow */}
          <WorkflowCard
            title="Traditional Workflow"
            icon={<Clock className="h-5 w-5 text-muted-foreground" />}
            steps={MANUAL_STEPS}
            total={MANUAL_TOTAL}
            variant="manual"
            delay={0}
          />

          {/* MotionMax workflow */}
          <WorkflowCard
            title="With MotionMax"
            icon={<Zap className="h-5 w-5 text-primary" />}
            steps={MOTIONMAX_STEPS}
            total={MOTIONMAX_TOTAL}
            variant="ai"
            delay={0.15}
          />
        </div>

        {/* Time-saved highlight */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3 }}
          className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 rounded-xl border border-primary/50 bg-primary/5 p-6"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15">
              <ArrowRight className="h-6 w-6 text-primary" />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-muted-foreground">Time Saved Per Video</p>
              <p className="text-2xl font-bold text-primary">14+ hours</p>
            </div>
          </div>
          <div className="hidden sm:block h-10 w-px bg-border" />
          <TimeSavedMetrics />
        </motion.div>
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────
 * Sub-components
 * ────────────────────────────────────────────── */

interface WorkflowCardProps {
  title: string;
  icon: React.ReactNode;
  steps: WorkflowStep[];
  total: string;
  variant: "manual" | "ai";
  delay: number;
}

function WorkflowCard({ title, icon, steps, total, variant, delay }: WorkflowCardProps) {
  const isAi = variant === "ai";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay }}
      className={`rounded-xl border p-6 ${
        isAi
          ? "border-primary/50 bg-primary/5"
          : "border-border/50 bg-muted/30"
      }`}
    >
      <div className="flex items-center gap-2.5 mb-5">
        {icon}
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {isAi && (
          <span className="ml-auto bg-primary/15 text-primary text-xs font-medium px-2.5 py-0.5 rounded-full">
            AI-Powered
          </span>
        )}
      </div>

      <ol className="space-y-3">
        {steps.map((step, idx) => (
          <li key={step.label} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <StepIcon variant={variant} index={idx} />
              <span className="text-sm text-foreground truncate">{step.label}</span>
            </div>
            <span className={`text-xs font-medium shrink-0 ${
              isAi ? "text-primary" : "text-muted-foreground"
            }`}>
              {step.time}
            </span>
          </li>
        ))}
      </ol>

      <div className={`mt-5 pt-4 border-t flex items-center justify-between ${
        isAi ? "border-primary/20" : "border-border/30"
      }`}>
        <span className="text-sm font-medium text-muted-foreground">Total time</span>
        <span className={`text-lg font-bold ${isAi ? "text-primary" : "text-foreground"}`}>
          {total}
        </span>
      </div>
    </motion.div>
  );
}

const STEP_ICONS = [FileText, Image, Mic, Film, CheckCircle2];

function StepIcon({ variant, index }: { variant: "manual" | "ai"; index: number }) {
  const Icon = STEP_ICONS[index % STEP_ICONS.length];
  return (
    <div className={`flex h-6 w-6 items-center justify-center rounded-full shrink-0 ${
      variant === "ai" ? "bg-primary/15" : "bg-muted"
    }`}>
      <Icon className={`h-3 w-3 ${variant === "ai" ? "text-primary" : "text-muted-foreground"}`} />
    </div>
  );
}

function TimeSavedMetrics() {
  const metrics = [
    { label: "Faster than manual", value: "120×" },
    { label: "Cost reduction", value: "~90%" },
    { label: "No software needed", value: "Zero" },
  ];

  return (
    <div className="flex items-center gap-6">
      {metrics.map((m) => (
        <div key={m.label} className="text-center">
          <p className="text-lg font-bold text-foreground">{m.value}</p>
          <p className="text-[11px] text-muted-foreground leading-tight">{m.label}</p>
        </div>
      ))}
    </div>
  );
}
