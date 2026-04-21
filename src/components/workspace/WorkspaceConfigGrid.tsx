/**
 * Shared configuration grid used by ALL workspace forms.
 * Mobile-first: stacks vertically on phone, 2-col on tablet+.
 * Format | Duration | Language+Speaker | Caption+Brand
 */
import { Monitor, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { LanguageSelector, type Language } from "./LanguageSelector";
import { SpeakerSelector, type SpeakerVoice, getDefaultSpeaker } from "./SpeakerSelector";
import { CaptionStyleSelector, type CaptionStyle } from "./CaptionStyleSelector";

interface WorkspaceConfigGridProps {
  format: "landscape" | "portrait";
  onFormatChange: (format: "landscape" | "portrait") => void;
  disabledFormats?: string[];

  duration: string;
  onDurationChange: (duration: string) => void;
  durationOptions?: { id: string; label: string }[];
  hideDuration?: boolean;

  language: Language;
  onLanguageChange: (lang: Language) => void;
  speaker: SpeakerVoice;
  onSpeakerChange: (speaker: SpeakerVoice) => void;

  captionStyle: CaptionStyle;
  onCaptionStyleChange: (style: CaptionStyle) => void;

  brandMarkText: string;
  onBrandMarkTextChange: (text: string) => void;
}

const DEFAULT_DURATIONS = [
  { id: "short", label: "\u22643 min" },
  { id: "brief", label: ">3 min" },
];

export function WorkspaceConfigGrid({
  format, onFormatChange, disabledFormats = [],
  duration, onDurationChange, durationOptions = DEFAULT_DURATIONS, hideDuration = false,
  language, onLanguageChange,
  speaker, onSpeakerChange,
  captionStyle, onCaptionStyleChange,
  brandMarkText, onBrandMarkTextChange,
}: WorkspaceConfigGridProps) {
  return (
    <div className="space-y-4">
      {/* Row 1: Format + Duration -- side by side even on mobile */}
      <div className="flex flex-wrap gap-4">
        <div className="space-y-1.5 min-w-[120px]">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Format</span>
          <div className="flex gap-2">
            {([
              { id: "landscape" as const, icon: Monitor, label: "16:9" },
              { id: "portrait" as const, icon: Smartphone, label: "9:16" },
            ]).map(({ id, icon: Icon, label }) => {
              const disabled = disabledFormats.includes(id);
              return (
                <button
                  key={id}
                  onClick={() => !disabled && onFormatChange(id)}
                  disabled={disabled}
                  data-active={format === id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors",
                    "data-[active=false]:border-border/50 data-[active=false]:bg-muted/30 data-[active=false]:text-muted-foreground data-[active=false]:hover:bg-muted/50",
                    "data-[active=true]:border-primary/50 data-[active=true]:bg-primary/10 data-[active=true]:text-foreground",
                    disabled && "opacity-40 cursor-not-allowed",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {!hideDuration && (
          <div className="space-y-1.5 min-w-[120px]">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Duration</span>
            <div className="flex gap-2">
              {durationOptions.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => onDurationChange(id)}
                  data-active={duration === id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors",
                    "data-[active=false]:border-border/50 data-[active=false]:bg-muted/30 data-[active=false]:text-muted-foreground data-[active=false]:hover:bg-muted/50",
                    "data-[active=true]:border-primary/50 data-[active=true]:bg-primary/10 data-[active=true]:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Row 2: Language + Speaker -- full width on mobile, side by side on desktop */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LanguageSelector
          value={language}
          onChange={(lang) => {
            onLanguageChange(lang);
            onSpeakerChange(getDefaultSpeaker(lang));
          }}
        />
        <SpeakerSelector value={speaker} onChange={onSpeakerChange} language={language} />
      </div>

      {/* Row 3: Caption + Brand -- full width on mobile, side by side on desktop */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <CaptionStyleSelector value={captionStyle} onChange={onCaptionStyleChange} />
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Brand Name</span>
          <input
            type="text"
            placeholder="Your brand (optional)"
            value={brandMarkText}
            maxLength={50}
            onChange={(e) => onBrandMarkTextChange(e.target.value)}
            className="flex w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
          />
        </div>
      </div>
    </div>
  );
}
