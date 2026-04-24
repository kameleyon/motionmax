import { Heart, Bookmark, Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { avatarBackground, waveformBars, type CatalogVoice } from "@/lib/voiceCatalog";

/** Card used by Discovery / Liked / Bookmarked. The whole card is
 *  clickable to "select" the voice for the right-rail playground; the
 *  Play / Like / Bookmark / Use buttons stop propagation so the user
 *  can hit them without also flipping the card's selection state. */

export interface VoiceCardProps {
  voice: CatalogVoice;
  selected: boolean;
  playing: boolean;
  liked: boolean;
  bookmarked: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onLike: () => void;
  onBookmark: () => void;
}

export default function VoiceCard({
  voice,
  selected,
  playing,
  liked,
  bookmarked,
  onSelect,
  onPlay,
  onLike,
  onBookmark,
}: VoiceCardProps) {
  const bars = waveformBars(voice.id);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      onClick={onSelect}
      className={cn(
        "group relative rounded-xl border bg-[#10151A] p-3.5 cursor-pointer transition-all",
        selected
          ? "border-[#14C8CC]/60 shadow-[0_0_0_1px_rgba(20,200,204,.25)_inset]"
          : "border-white/8 hover:border-white/15",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="relative w-10 h-10 rounded-full grid place-items-center font-serif font-semibold text-[15px] text-white shrink-0"
          style={{ background: avatarBackground(voice.accent) }}
        >
          {voice.initial}
          <span className="absolute -bottom-1 -right-1 text-[11px] leading-none">{voice.flag}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-[#ECEAE4] truncate">{voice.name}</div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-[#5A6268] truncate mt-0.5">
            {voice.gender} · {voice.age} · {voice.accent}
          </div>
        </div>

        <button
          type="button"
          onClick={(e) => { stop(e); onPlay(); }}
          className={cn(
            "w-8 h-8 rounded-full grid place-items-center transition-colors shrink-0",
            playing
              ? "bg-[#14C8CC] text-[#0A0D0F]"
              : "bg-white/5 text-[#ECEAE4] hover:bg-white/10",
          )}
          aria-label={playing ? "Stop preview" : "Play preview"}
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 translate-x-px" />}
        </button>
      </div>

      {/* Mini-waveform — only visible while playing so static cards
          stay calmer. Bars use a fixed deterministic shape per voice
          id (see waveformBars) so the same voice always looks the
          same across renders. The first 12 bars render in teal to
          fake a playhead position; everything else is muted grey. */}
      {playing && (
        <div className="flex items-end gap-[2px] h-7 mt-2.5">
          {bars.map((h, i) => (
            <span
              key={i}
              className={cn(
                "w-[3px] rounded-full transition-colors",
                i < 12 ? "bg-[#14C8CC]" : "bg-white/15",
              )}
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1 mt-3">
        {voice.tags.slice(0, 3).map((t) => (
          <span
            key={t}
            className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-[#8A9198] px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/8"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-end gap-1.5 mt-3">
        <button
          type="button"
          onClick={(e) => { stop(e); onLike(); }}
          className={cn(
            "w-7 h-7 rounded-md grid place-items-center transition-colors",
            liked ? "text-[#E4C875] bg-[#E4C875]/10" : "text-[#5A6268] hover:text-[#ECEAE4] hover:bg-white/5",
          )}
          title={liked ? "Unlike" : "Like"}
        >
          <Heart className={cn("w-3.5 h-3.5", liked && "fill-current")} />
        </button>
        <button
          type="button"
          onClick={(e) => { stop(e); onBookmark(); }}
          className={cn(
            "w-7 h-7 rounded-md grid place-items-center transition-colors",
            bookmarked ? "text-[#14C8CC] bg-[#14C8CC]/10" : "text-[#5A6268] hover:text-[#ECEAE4] hover:bg-white/5",
          )}
          title={bookmarked ? "Remove bookmark" : "Bookmark"}
        >
          <Bookmark className={cn("w-3.5 h-3.5", bookmarked && "fill-current")} />
        </button>
        <button
          type="button"
          onClick={(e) => { stop(e); onSelect(); }}
          className="ml-1 px-3 h-7 rounded-md text-[11px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] hover:brightness-110 transition-all"
        >
          Use
        </button>
      </div>
    </div>
  );
}
