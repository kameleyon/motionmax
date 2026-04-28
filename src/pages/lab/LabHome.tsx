import { Link } from "react-router-dom";
import { Calendar, ChevronRight, Lightbulb } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LabLayout } from "./_LabLayout";

interface Experiment {
  id: string;
  name: string;
  status: "soft-launch" | "planned";
  description: string;
  to?: string;
  icon: React.ComponentType<{ className?: string }>;
}

const EXPERIMENTS: Experiment[] = [
  {
    id: "autopost",
    name: "Autopost",
    status: "soft-launch",
    description:
      "Schedule end-to-end video generation and direct publishing to YouTube Shorts, Instagram Reels, and TikTok. Admin-only soft launch.",
    to: "/lab/autopost",
    icon: Calendar,
  },
];

export default function LabHome() {
  return (
    <LabLayout
      heading="Lab"
      title="Lab · MotionMax"
      description="Admin-only sandbox for in-flight experiments. Features here are isolated from the production app and may be removed without notice."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {EXPERIMENTS.map(exp => {
          const Icon = exp.icon;
          const inner = (
            <Card className="h-full bg-[#10151A] border-white/8 hover:border-[#11C4D0]/40 transition-colors">
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
                    <Icon className="h-5 w-5 text-[#11C4D0]" />
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      exp.status === "soft-launch"
                        ? "border-[#E4C875]/40 bg-[#E4C875]/10 text-[#E4C875]"
                        : "border-white/10 bg-white/5 text-[#8A9198]"
                    }
                  >
                    {exp.status === "soft-launch" ? "Soft launch" : "Planned"}
                  </Badge>
                </div>
                <div>
                  <CardTitle className="text-[#ECEAE4] text-lg">{exp.name}</CardTitle>
                  <CardDescription className="text-[#8A9198] mt-1.5">
                    {exp.description}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-mono uppercase tracking-[0.16em] text-[#5A6268]">
                    /lab/{exp.id}
                  </span>
                  {exp.to && (
                    <span className="inline-flex items-center gap-1 text-[#11C4D0]">
                      Open
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          );

          return exp.to ? (
            <Link key={exp.id} to={exp.to} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[#11C4D0] rounded-lg">
              {inner}
            </Link>
          ) : (
            <div key={exp.id} className="opacity-70">
              {inner}
            </div>
          );
        })}

        {/* Placeholder for future experiments */}
        <div className="hidden sm:flex items-center justify-center rounded-lg border border-dashed border-white/8 bg-[#10151A]/40 p-6 text-center">
          <div className="flex flex-col items-center gap-2 text-[#5A6268]">
            <Lightbulb className="h-5 w-5" />
            <p className="text-[12px]">More experiments will land here.</p>
          </div>
        </div>
      </div>
    </LabLayout>
  );
}
