import { Helmet } from "react-helmet-async";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Mic, Upload, Play, Pause, Square, Trash2, Loader2, Check,
  Search, Plus, ArrowLeftRight, Wand2, ShieldCheck, Clock, X,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useVoiceCloning } from "@/hooks/useVoiceCloning";
import { useSubscription } from "@/hooks/useSubscription";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { createScopedLogger } from "@/lib/logger";
import AppShell from "@/components/dashboard/AppShell";
import VoiceCard from "@/components/voice-lab/VoiceCard";
import {
  getCatalog, cloneToCatalogVoice, LANGUAGES, avatarBackground, type CatalogVoice,
} from "@/lib/voiceCatalog";
import { useUserClones } from "@/hooks/useUserClones";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { getSampleText } from "@/components/workspace/SpeakerSelector";

const log = createScopedLogger("VoiceLab");

type Tab = "discovery" | "mine" | "clone" | "liked" | "bookmarked";

// localStorage keys — namespaced by user id at runtime so two accounts on
// the same browser don't share each other's likes/bookmarks/history.
const lsKey = (userId: string | undefined, slot: string) =>
  userId ? `motionmax_voicelab_${slot}_${userId}` : `motionmax_voicelab_${slot}_anon`;

interface PlaygroundHistoryItem {
  text: string;
  voiceId: string;
  voiceName: string;
  audioUrl: string;
  tonePacing: number;
  language: string;
  ts: number;
}

export default function VoiceLab() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("discovery");
  const [language, setLanguage] = useState("en");
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);

  // Liked + bookmarked persisted per-user. We hydrate lazily on mount
  // so SSR / first-paint never reads from localStorage.
  const [liked, setLiked] = useState<string[]>([]);
  const [bookmarked, setBookmarked] = useState<string[]>([]);

  useEffect(() => {
    if (!user?.id) return;
    try {
      const l = JSON.parse(localStorage.getItem(lsKey(user.id, "liked")) || "[]");
      const b = JSON.parse(localStorage.getItem(lsKey(user.id, "bookmarked")) || "[]");
      if (Array.isArray(l)) setLiked(l);
      if (Array.isArray(b)) setBookmarked(b);
    } catch { /* ignore */ }
  }, [user?.id]);

  const persistList = useCallback((slot: "liked" | "bookmarked", list: string[]) => {
    if (!user?.id) return;
    try {
      localStorage.setItem(lsKey(user.id, slot), JSON.stringify(list));
    } catch { /* localStorage full or disabled — silently degrade */ }
  }, [user?.id]);

  const toggleLike = (id: string) => {
    setLiked((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      persistList("liked", next);
      return next;
    });
  };
  const toggleBookmark = (id: string) => {
    setBookmarked((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      persistList("bookmarked", next);
      return next;
    });
  };

  // The user's cloned voices, surfaced in the same catalog as built-in
  // speakers so the test playground (and discovery grid) can switch to
  // them. Each clone gets a "clone:<external_id>" id; the worker's
  // voice_preview handler routes those to Fish or ElevenLabs.
  const { data: userClones = [] } = useUserClones();

  // Catalog for the current language. Memoised — getCatalog walks the
  // SpeakerSelector arrays once per language change. Clones are pinned
  // to the FRONT of the catalog so they're the first thing the user
  // sees when they open the playground / discovery grid.
  const catalog = useMemo(() => {
    const builtIns = getCatalog(language);
    const clones = userClones.map((c) => cloneToCatalogVoice(c));
    return [...clones, ...builtIns];
  }, [language, userClones]);

  // Default selection on language change so the playground always has
  // a voice loaded. Preserve the user's selection if it's still valid
  // for the new language (e.g. switching from English to French keeps
  // Gemini voices selected since they're in both).
  useEffect(() => {
    if (selectedVoiceId && catalog.some((v) => v.id === selectedVoiceId)) return;
    setSelectedVoiceId(catalog[0]?.id ?? null);
  }, [catalog, selectedVoiceId]);

  // Shared audio element — one preview at a time, no two voices ever
  // overlap. Pause + clear when a new card is played.
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
    }
    setPlayingVoiceId(null);
  }, []);

  const playVoicePreview = useCallback(async (voice: CatalogVoice) => {
    if (playingVoiceId === voice.id) { stopPreview(); return; }
    stopPreview();
    if (!user?.id) { toast.error("Sign in to preview voices."); return; }

    const sampleText = getSampleText(voice.name, language);
    setPlayingVoiceId(voice.id);

    try {
      const { data: job, error } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: user.id,
          task_type: "voice_preview",
          payload: { speaker: voice.id, language, text: sampleText },
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !job) throw new Error("Failed to queue preview.");

      const MAX_WAIT = 30_000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await (supabase
          .from("video_generation_jobs") as unknown as ReturnType<typeof supabase.from>)
          .select("status, result")
          .eq("id", job.id)
          .single();
        if (row?.status === "completed" && row?.result?.audioUrl) {
          const audio = new Audio(row.result.audioUrl as string);
          previewAudioRef.current = audio;
          audio.onended = () => setPlayingVoiceId((p) => (p === voice.id ? null : p));
          audio.onerror = () => setPlayingVoiceId((p) => (p === voice.id ? null : p));
          audio.play().catch(() => setPlayingVoiceId(null));
          return;
        }
        if (row?.status === "failed") throw new Error("Preview generation failed.");
      }
      throw new Error("Preview timed out — try again.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
      setPlayingVoiceId(null);
    }
  }, [language, playingVoiceId, stopPreview, user?.id]);

  // Counts surfaced in the tab pills + hero counters.
  const { voices: clonedVoices } = useVoiceCloning();
  const counts = {
    discovery: catalog.length,
    mine: clonedVoices.length,
    liked: liked.length,
    bookmarked: bookmarked.length,
  };

  return (
    <AppShell breadcrumb="Voice Lab">
      <Helmet>
        <title>Voice Lab · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[1480px] mx-auto">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="flex flex-wrap items-end justify-between gap-3"
        >
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#14C8CC]/10 border border-[#14C8CC]/30 font-mono text-[10px] tracking-[0.16em] uppercase text-[#14C8CC] mb-3">
              <Mic className="w-3 h-3" />
              Voice Lab
            </span>
            <h1 className="font-serif text-[28px] sm:text-[34px] lg:text-[38px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">
              Voice Lab
            </h1>
            <p className="text-[13px] sm:text-[14px] text-[#8A9198] mt-1.5 max-w-prose">
              Browse studio voices, clone your own, and test before generating.
            </p>
          </div>
          <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[#5A6268] whitespace-nowrap">
            <span className="text-[#14C8CC]">{liked.length}</span> liked ·{" "}
            <span className="text-[#14C8CC]">{bookmarked.length}</span> saved
          </div>
        </motion.div>

        {/* Tabs — sized to fit all 5 on a 360 px phone without
            horizontal scroll. Mobile gets tighter padding + smaller
            text and count chip; sm: restores the original tablet+
            density. min-w-max removed so the row width caps at the
            container instead of forcing the parent to scroll. */}
        <div className="mt-6 border-b border-white/8">
          <div className="flex items-center gap-0 sm:gap-1">
            <TabButton active={tab === "discovery"}  onClick={() => setTab("discovery")}  label="Discovery"  count={counts.discovery} />
            <TabButton active={tab === "mine"}       onClick={() => setTab("mine")}       label="My Voices"  count={counts.mine} />
            <TabButton active={tab === "clone"}      onClick={() => setTab("clone")}      label="Cloned"     count="+" />
            <TabButton active={tab === "liked"}      onClick={() => setTab("liked")}      label="Liked"      count={counts.liked} />
            <TabButton active={tab === "bookmarked"} onClick={() => setTab("bookmarked")} label="Saved"      count={counts.bookmarked} />
          </div>
        </div>

        {/* Two-column layout: main + sticky right rail. Below lg the
            rail stacks underneath. */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 xl:gap-7">
          <div className="min-w-0">
            {tab === "discovery" && (
              <DiscoveryTab
                catalog={catalog}
                language={language}
                onLanguageChange={setLanguage}
                selected={selectedVoiceId}
                onSelect={setSelectedVoiceId}
                playing={playingVoiceId}
                onPlay={playVoicePreview}
                liked={liked}
                bookmarked={bookmarked}
                onLike={toggleLike}
                onBookmark={toggleBookmark}
              />
            )}

            {tab === "mine" && (
              <MyVoicesTab
                bookmarkedVoices={catalog.filter((v) => bookmarked.includes(v.id))}
                onSelect={setSelectedVoiceId}
                playing={playingVoiceId}
                onPlay={playVoicePreview}
                liked={liked}
                bookmarked={bookmarked}
                onLike={toggleLike}
                onBookmark={toggleBookmark}
                onSwitchTab={setTab}
              />
            )}

            {tab === "clone" && <ClonedTab />}

            {tab === "liked" && (
              <FilteredVoiceGrid
                voices={catalog.filter((v) => liked.includes(v.id))}
                emptyText="No liked voices yet. Tap the heart on any card."
                selected={selectedVoiceId}
                onSelect={setSelectedVoiceId}
                playing={playingVoiceId}
                onPlay={playVoicePreview}
                liked={liked}
                bookmarked={bookmarked}
                onLike={toggleLike}
                onBookmark={toggleBookmark}
              />
            )}

            {tab === "bookmarked" && (
              <FilteredVoiceGrid
                voices={catalog.filter((v) => bookmarked.includes(v.id))}
                emptyText="No bookmarks yet. Tap the bookmark icon on any card."
                selected={selectedVoiceId}
                onSelect={setSelectedVoiceId}
                playing={playingVoiceId}
                onPlay={playVoicePreview}
                liked={liked}
                bookmarked={bookmarked}
                onLike={toggleLike}
                onBookmark={toggleBookmark}
              />
            )}
          </div>

          {/* Right rail — sticky on lg+, stacks below on mobile. */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <TestPlayground
              voice={catalog.find((v) => v.id === selectedVoiceId) ?? catalog[0]}
              language={language}
              onSwap={() => setTab("discovery")}
              userId={user?.id}
            />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

// ─── Tab button ──────────────────────────────────────────────────────

function TabButton({
  active, onClick, label, count,
}: {
  active: boolean; onClick: () => void; label: string; count: number | string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Mobile: 1.5×9px padding, 11px text, tight count chip — five
        // tabs fit on a 360 px phone. sm: restores the original
        // tablet+ touch density.
        "relative px-1.5 sm:px-4 py-1.5 sm:py-2.5 text-[11px] sm:text-[13px] font-medium transition-colors whitespace-nowrap shrink-0",
        active ? "text-[#ECEAE4]" : "text-[#5A6268] hover:text-[#ECEAE4]",
      )}
    >
      {label}
      <span className={cn(
        "ml-1 sm:ml-1.5 inline-flex items-center justify-center min-w-[14px] sm:min-w-[18px] h-[14px] sm:h-[18px] px-1 sm:px-1.5 rounded-full font-mono text-[8.5px] sm:text-[9.5px]",
        active ? "bg-[#14C8CC]/20 text-[#14C8CC]" : "bg-white/[0.04] text-[#5A6268]",
      )}>{count}</span>
      {active && <span className="absolute inset-x-1.5 sm:inset-x-3 -bottom-px h-[2px] bg-[#14C8CC] rounded-full" />}
    </button>
  );
}

// ─── Discovery tab ───────────────────────────────────────────────────

const FILTER_GROUPS = {
  Gender: ["Male", "Female"],
  Age:    ["Young", "Middle Aged", "Old"],
  Style:  ["Narration", "Documentary", "Casual", "Conversational", "Energetic", "Soft", "Deep", "Professional", "Dramatic", "Mysterious", "Warm", "Bright"],
};
// FLAT_FILTERS used to drive the flat-wrap chip row — now superseded
// by the grouped layout in DiscoveryTab. Left as a one-liner doc
// pointer in case future code needs a flat list.
// const FLAT_FILTERS = Object.values(FILTER_GROUPS).flat();

function DiscoveryTab({
  catalog, language, onLanguageChange, selected, onSelect, playing, onPlay,
  liked, bookmarked, onLike, onBookmark,
}: {
  catalog: CatalogVoice[];
  language: string;
  onLanguageChange: (l: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  playing: string | null;
  onPlay: (v: CatalogVoice) => void;
  liked: string[];
  bookmarked: string[];
  onLike: (id: string) => void;
  onBookmark: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string[]>([]);
  const [sort, setSort] = useState<"trending" | "az" | "newest">("trending");

  const toggleFilter = (f: string) =>
    setActive((a) => (a.includes(f) ? a.filter((x) => x !== f) : [...a, f]));

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const matchesFilter = (v: CatalogVoice, f: string) =>
      v.gender === f || v.age === f ||
      v.tags.some((t) => t.toLowerCase().includes(f.toLowerCase())) ||
      v.description.toLowerCase().includes(f.toLowerCase());

    const list = catalog.filter((v) => {
      if (ql && !(
        v.name.toLowerCase().includes(ql) ||
        v.tags.some((t) => t.toLowerCase().includes(ql)) ||
        v.description.toLowerCase().includes(ql)
      )) return false;
      if (active.length === 0) return true;
      // OR semantics within a category, AND across categories — feels
      // closer to user intent ("Female AND Narration" not "anything
      // tagged Female or Narration").
      const byGroup = Object.values(FILTER_GROUPS).map((group) =>
        group.filter((g) => active.includes(g)),
      );
      return byGroup.every((picked) => picked.length === 0 || picked.some((p) => matchesFilter(v, p)));
    });

    if (sort === "az") list.sort((a, b) => a.name.localeCompare(b.name));
    // "trending" / "newest" don't have real signals on these voices —
    // keep the catalog's natural order for both so the page is stable.
    return list;
  }, [catalog, q, active, sort]);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5A6268]" />
          <Input
            placeholder="Search voices, accent, vibe…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 pl-9 pr-3 rounded-lg bg-[#10151A] border border-white/10 text-[13px] text-[#ECEAE4] placeholder:text-[#5A6268] focus-visible:ring-0 focus-visible:border-[#14C8CC]/40"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={language} onValueChange={onLanguageChange}>
            <SelectTrigger className="h-9 w-[150px] rounded-lg bg-[#10151A] border border-white/10 text-[12.5px] text-[#ECEAE4]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#10151A] border-white/10">
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  <span className="mr-1.5">{l.flag}</span>{l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="h-9 w-[120px] rounded-lg bg-[#10151A] border border-white/10 text-[12.5px] text-[#ECEAE4]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#10151A] border-white/10">
              <SelectItem value="trending">Trending</SelectItem>
              <SelectItem value="az">A → Z</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Filter chips — grouped by category. Was a flat-wrap pile of
          21 pills which was hard to scan and consumed 4–5 lines on
          mobile. Now each FILTER_GROUPS section gets its own row with
          a small label, mobile pills are tighter (h-6, px-2, 9.5px
          text) and desktop restores generous sizing at sm:. Fits
          Gender (2 pills) + Age (3) on a 360 px phone in one row;
          Style wraps to 2–3 rows. */}
      <div className="mt-3 space-y-1.5">
        {Object.entries(FILTER_GROUPS).map(([groupLabel, options]) => (
          <div key={groupLabel} className="flex flex-wrap items-center gap-1 sm:gap-1.5">
            <span className="font-mono text-[9.5px] tracking-[0.16em] uppercase text-[#5A6268] mr-0.5 sm:mr-1 w-12 sm:w-14 shrink-0">
              {groupLabel}
            </span>
            {options.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => toggleFilter(f)}
                className={cn(
                  "h-6 sm:h-7 px-2 sm:px-3 rounded-full font-mono text-[9.5px] sm:text-[10px] tracking-[0.1em] sm:tracking-[0.12em] uppercase border transition-colors inline-flex items-center gap-1 shrink-0",
                  active.includes(f)
                    ? "bg-[#14C8CC]/10 border-[#14C8CC]/40 text-[#14C8CC]"
                    : "bg-[#10151A] border-white/10 text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/20",
                )}
              >
                {f}
                {active.includes(f) && <X className="w-2 h-2 sm:w-2.5 sm:h-2.5" />}
              </button>
            ))}
          </div>
        ))}
        {active.length > 0 && (
          <button
            type="button"
            onClick={() => setActive([])}
            className="h-6 sm:h-7 px-2 sm:px-3 rounded-full font-mono text-[9.5px] sm:text-[10px] tracking-[0.12em] uppercase text-[#E4C875] hover:text-white transition-colors"
          >
            Clear all ({active.length})
          </button>
        )}
      </div>

      {/* Result count */}
      <div className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-[#5A6268] mt-3 mb-3">
        {filtered.length} voices · {active.length ? active.join(" · ") : "all categories"}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        <AnimatePresence mode="popLayout">
          {filtered.map((v) => (
            <motion.div
              key={v.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.18 }}
            >
              <VoiceCard
                voice={v}
                selected={selected === v.id}
                playing={playing === v.id}
                liked={liked.includes(v.id)}
                bookmarked={bookmarked.includes(v.id)}
                onSelect={() => onSelect(v.id)}
                onPlay={() => onPlay(v)}
                onLike={() => onLike(v.id)}
                onBookmark={() => onBookmark(v.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {filtered.length === 0 && (
        <div className="text-center py-14 text-[#5A6268] font-mono text-[11px] tracking-[0.12em] uppercase">
          No voices match your filters.
        </div>
      )}
    </div>
  );
}

// Reused by Liked + Bookmarked tabs — same VoiceCard grid, no toolbar.
function FilteredVoiceGrid({
  voices, emptyText, selected, onSelect, playing, onPlay,
  liked, bookmarked, onLike, onBookmark,
}: {
  voices: CatalogVoice[];
  emptyText: string;
  selected: string | null;
  onSelect: (id: string) => void;
  playing: string | null;
  onPlay: (v: CatalogVoice) => void;
  liked: string[];
  bookmarked: string[];
  onLike: (id: string) => void;
  onBookmark: (id: string) => void;
}) {
  if (voices.length === 0) {
    return (
      <div className="text-center py-16 text-[#5A6268] font-mono text-[11px] tracking-[0.12em] uppercase">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-3">
      {voices.map((v) => (
        <VoiceCard
          key={v.id}
          voice={v}
          selected={selected === v.id}
          playing={playing === v.id}
          liked={liked.includes(v.id)}
          bookmarked={bookmarked.includes(v.id)}
          onSelect={() => onSelect(v.id)}
          onPlay={() => onPlay(v)}
          onLike={() => onLike(v.id)}
          onBookmark={() => onBookmark(v.id)}
        />
      ))}
    </div>
  );
}

// ─── My Voices tab ───────────────────────────────────────────────────

function MyVoicesTab({
  bookmarkedVoices, onSelect, playing, onPlay, liked, bookmarked,
  onLike, onBookmark, onSwitchTab,
}: {
  bookmarkedVoices: CatalogVoice[];
  onSelect: (id: string) => void;
  playing: string | null;
  onPlay: (v: CatalogVoice) => void;
  liked: string[];
  bookmarked: string[];
  onLike: (id: string) => void;
  onBookmark: (id: string) => void;
  onSwitchTab: (t: Tab) => void;
}) {
  const { voices: clonedVoices, voicesLoading, deleteVoice, renameVoice, isRenaming } = useVoiceCloning();

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[#ECEAE4]">My Voices</div>
          <div className="text-[12.5px] text-[#8A9198] mt-0.5">
            Cloned + saved voices in this workspace.
          </div>
        </div>
        <button
          type="button"
          onClick={() => onSwitchTab("clone")}
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-[12.5px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] hover:brightness-110 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          Clone new voice
        </button>
      </div>

      {voicesLoading ? (
        <div className="text-[#5A6268] text-[12px] py-10 text-center">Loading…</div>
      ) : clonedVoices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
          <div className="text-[13px] text-[#ECEAE4] font-medium">No cloned voices yet</div>
          <div className="text-[12px] text-[#8A9198] mt-1">
            Head to Cloned to record or upload a sample.
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          {clonedVoices.map((v) => (
            <div
              key={v.id}
              className="flex items-center gap-3 rounded-xl border border-white/8 bg-[#10151A] p-3"
            >
              <div
                className="w-11 h-11 rounded-full grid place-items-center font-serif font-semibold text-[16px] text-white shrink-0"
                style={{ background: avatarBackground("Multi") }}
              >
                {(v.voice_name?.[0] || "?").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-[#ECEAE4] truncate">{v.voice_name}</div>
                <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-[#5A6268] truncate mt-0.5">
                  Cloned · {formatDistanceToNow(new Date(v.created_at), { addSuffix: true })}
                </div>
              </div>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#14C8CC]/10 text-[#14C8CC] font-mono text-[9.5px] tracking-[0.12em] uppercase">
                <Check className="w-3 h-3" /> Ready
              </span>
              <button
                type="button"
                onClick={async () => {
                  const next = window.prompt(`Rename "${v.voice_name}" to:`, v.voice_name);
                  if (!next || next.trim() === v.voice_name) return;
                  try { await renameVoice({ rowId: v.id, newName: next }); } catch { /* toast handled in hook */ }
                }}
                disabled={isRenaming}
                className="w-8 h-8 grid place-items-center rounded-md text-[#5A6268] hover:text-[#14C8CC] hover:bg-white/5 transition-colors disabled:opacity-40"
                title="Rename voice"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete "${v.voice_name}"? This cannot be undone.`)) deleteVoice(v.id);
                }}
                className="w-8 h-8 grid place-items-center rounded-md text-[#5A6268] hover:text-red-400 hover:bg-white/5 transition-colors"
                title="Delete voice"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-7 mb-3">
        <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[#5A6268]">
          Bookmarked
        </div>
      </div>
      {bookmarkedVoices.length === 0 ? (
        <div className="text-[#5A6268] text-[12px] font-mono tracking-[0.08em] uppercase py-6 text-center border border-dashed border-white/8 rounded-xl">
          No bookmarks yet
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {bookmarkedVoices.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              selected={false}
              playing={playing === v.id}
              liked={liked.includes(v.id)}
              bookmarked={bookmarked.includes(v.id)}
              onSelect={() => onSelect(v.id)}
              onPlay={() => onPlay(v)}
              onLike={() => onLike(v.id)}
              onBookmark={() => onBookmark(v.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Cloned tab — re-skinned recording / upload / consent flow ──────

function ClonedTab() {
  const { voices, isCloning, cloneVoice, deleteVoice, renameVoice, isRenaming } = useVoiceCloning();
  const { plan } = useSubscription();
  const voiceCloneLimit = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]?.voiceClones ?? 0;

  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [removeNoise, setRemoveNoise] = useState(true);
  const [voiceName, setVoiceName] = useState("");
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [showLimitModal, setShowLimitModal] = useState(false);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const getAudioDuration = (blob: Blob): Promise<number> => new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.addEventListener("loadedmetadata", () => {
      if (isFinite(audio.duration)) resolve(audio.duration);
      else reject(new Error("Duration not available"));
      URL.revokeObjectURL(audio.src);
    });
    audio.addEventListener("error", () => { URL.revokeObjectURL(audio.src); reject(new Error("Failed to load audio")); });
    audio.src = URL.createObjectURL(blob);
  });

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        setRecordedBlob(new Blob(chunksRef.current, { type: "audio/webm" }));
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start(100);
      setIsRecording(true);
      setRecordingDuration(0);
      timerRef.current = window.setInterval(() => setRecordingDuration((d) => d + 1), 1000);
    } catch (err) {
      log.error("Mic access failed:", err);
      toast.error("Microphone access denied", { description: "Allow mic access in your browser settings." });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
  };

  const handleFileUpload = async (file: File) => {
    const validExt = [".mp3", ".wav", ".m4a", ".mp4"];
    if (!validExt.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      toast.error("Invalid file type", { description: "MP3, WAV, M4A, or MP4 only." });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error("File too large", { description: "Maximum 20 MB." });
      return;
    }
    try {
      const dur = await getAudioDuration(file);
      if (dur < 10) { toast.error("Audio too short", { description: "10 seconds minimum." }); return; }
    } catch { /* let backend validate */ }
    setUploadedFile(file);
  };

  const handleClone = async () => {
    const audioBlob = recordedBlob || uploadedFile;
    if (!audioBlob || !voiceName.trim()) return;
    if (voices.length >= voiceCloneLimit && voiceCloneLimit > 0) {
      setShowLimitModal(true);
      return;
    }
    try {
      const dur = await getAudioDuration(audioBlob);
      if (dur < 10) { toast.error("Audio too short", { description: "10 seconds minimum." }); return; }
    } catch { /* skip */ }
    await cloneVoice({
      file: audioBlob,
      name: voiceName.trim(),
      description: `Created via ${recordedBlob ? "recording" : "file upload"}`,
      removeNoise,
      consentGiven: consentAccepted,
    });
    setVoiceName("");
    setRecordedBlob(null);
    setUploadedFile(null);
    setRecordingDuration(0);
    setConsentAccepted(false);
  };

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const hasAudio = !!recordedBlob || !!uploadedFile;
  const step = !hasAudio ? 0 : !voiceName.trim() || !consentAccepted ? 1 : 2;
  const canClone = hasAudio && voiceName.trim().length > 0 && consentAccepted && !isCloning;

  return (
    <div>
      {/* Hero pill */}
      <div className="rounded-xl border border-[#14C8CC]/20 bg-gradient-to-br from-[#10151A] to-[#0A0D0F] p-5 sm:p-6 relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none opacity-30"
          style={{
            background: "radial-gradient(60% 80% at 80% 0%, rgba(20,200,204,.15), transparent 70%)",
          }}
        />
        <span className="relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#14C8CC]/10 border border-[#14C8CC]/30 font-mono text-[10px] tracking-[0.16em] uppercase text-[#14C8CC]">
          <Wand2 className="w-3 h-3" /> Instant voice clone
        </span>
        <h2 className="relative font-serif text-[22px] sm:text-[26px] font-medium text-[#ECEAE4] mt-3 leading-tight">
          Clone your voice in minutes
        </h2>
        <p className="relative text-[13px] text-[#8A9198] mt-1.5">
          Upload 30 seconds of clean audio or record live — we'll train a high-fidelity replica.
        </p>
      </div>

      {/* Tip cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
        <TipCard icon={<ShieldCheck className="w-4 h-4" />} title="Quiet room"
          body="No echo, no fan, no background music. A closet works great." />
        <TipCard icon={<Clock className="w-4 h-4" />} title="30+ seconds"
          body="2–5 minutes of varied tone gets best results. Read naturally." />
        <TipCard icon={<Mic className="w-4 h-4" />} title="Use a real mic"
          body="Phone mic works. Laptop mic less so. AirPods are okay." />
      </div>

      {/* 3-step indicator */}
      <div className="flex items-center gap-2 sm:gap-3 mt-5 mb-4 font-mono text-[10px] sm:text-[10.5px] tracking-[0.12em] uppercase overflow-x-auto">
        <span className={cn("whitespace-nowrap", step >= 0 ? "text-[#14C8CC]" : "text-[#5A6268]")}>① Record / Upload</span>
        <span className="flex-shrink-0 w-5 sm:w-6 h-px bg-white/10" />
        <span className={cn("whitespace-nowrap", step >= 1 ? "text-[#14C8CC]" : "text-[#5A6268]")}>② Name &amp; consent</span>
        <span className="flex-shrink-0 w-5 sm:w-6 h-px bg-white/10" />
        <span className={cn("whitespace-nowrap", step >= 2 ? "text-[#14C8CC]" : "text-[#5A6268]")}>③ Train</span>
      </div>

      {/* Drop / record */}
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFileUpload(f); }}
        className={cn(
          "rounded-xl border-2 border-dashed p-8 sm:p-10 text-center cursor-pointer transition-all",
          isDragging ? "border-[#14C8CC] bg-[#14C8CC]/5" : "border-white/10 hover:border-white/20",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp3,.wav,.m4a,.mp4,audio/mpeg,audio/wav,audio/m4a,audio/x-m4a,video/mp4,audio/mp4"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
        />
        <Upload className="w-7 h-7 text-[#8A9198] mx-auto" />
        <div className="mt-3 text-[14px] font-medium text-[#ECEAE4]">Drop audio files here</div>
        <div className="text-[12px] text-[#8A9198] mt-1">WAV, MP3, M4A · up to 20 MB</div>
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[#5A6268] my-3">Or</div>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); if (isRecording) stopRecording(); else startRecording(); }}
          className={cn(
            "inline-flex items-center gap-1.5 px-4 h-9 rounded-lg text-[12.5px] font-semibold border transition-colors",
            isRecording
              ? "border-[#E4C875] text-[#E4C875] bg-[#E4C875]/10"
              : "border-white/15 text-[#ECEAE4] hover:border-white/25 hover:bg-white/5",
          )}
        >
          {isRecording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          {isRecording ? `Stop · ${fmt(recordingDuration)}` : "Record live · 0:30 minimum"}
        </button>
        {hasAudio && (
          <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#14C8CC]/10 text-[#14C8CC] font-mono text-[10.5px] tracking-[0.12em] uppercase">
            <Check className="w-3 h-3" />
            {recordedBlob ? `Recorded · ${fmt(recordingDuration)}` : `${uploadedFile?.name}`}
          </div>
        )}
      </div>

      {/* Sample read */}
      <div className="mt-4 rounded-xl border border-white/8 bg-[#10151A] p-4">
        <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[#5A6268] mb-2">
          Suggested read · phonetically diverse
        </div>
        <p className="font-serif italic text-[14px] sm:text-[14.5px] text-[#ECEAE4] leading-relaxed">
          "The quick brown fox jumps over the lazy dog. She sells seashells by the seashore.
          How vexingly quick daft zebras jump. Pack my box with five dozen liquor jugs —
          and wonder if Wednesday's weather will hold up through next Thursday morning."
        </p>
        <div className="font-mono text-[10px] tracking-[0.06em] text-[#5A6268] mt-2.5">
          ~28 seconds at natural pace
        </div>
      </div>

      {/* Name + consent */}
      <div className="mt-4 rounded-xl border border-white/8 bg-[#10151A] p-4 grid gap-3">
        <div>
          <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-1.5 block">
            Voice name
          </label>
          <Input
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
            placeholder="e.g. My Narrator Voice"
            className="h-9 bg-[#0A0D0F] border border-white/10 text-[13px] text-[#ECEAE4] focus-visible:ring-0 focus-visible:border-[#14C8CC]/40"
          />
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={removeNoise}
            onChange={(e) => setRemoveNoise(e.target.checked)}
            className="mt-0.5 accent-[#14C8CC]"
          />
          <span className="text-[12.5px] text-[#ECEAE4]">
            Remove background noise <span className="text-[#5A6268]">(recommended)</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={consentAccepted}
            onChange={(e) => setConsentAccepted(e.target.checked)}
            className="mt-0.5 accent-[#14C8CC]"
          />
          <span className="text-[12px] text-[#8A9198] leading-relaxed">
            I confirm this voice belongs to me or I have explicit consent from the owner to clone it for use in my projects.
          </span>
        </label>
        <button
          type="button"
          onClick={handleClone}
          disabled={!canClone}
          className="mt-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isCloning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
          {isCloning ? "Training your voice…" : "Train this voice"}
        </button>
      </div>

      {/* Existing cloned voices list */}
      {voices.length > 0 && (
        <div className="mt-7" id="my-voices-section">
          <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[#5A6268] mb-2.5">
            Your cloned voices
          </div>
          <div className="grid gap-2">
            {voices.map((v) => (
              <div key={v.id} className="flex items-center gap-3 rounded-xl border border-white/8 bg-[#10151A] p-3">
                <div
                  className="w-10 h-10 rounded-full grid place-items-center font-serif font-semibold text-[15px] text-white shrink-0"
                  style={{ background: avatarBackground("Multi") }}
                >
                  {(v.voice_name?.[0] || "?").toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-[#ECEAE4] truncate">{v.voice_name}</div>
                  <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-[#5A6268] truncate mt-0.5">
                    Trained {formatDistanceToNow(new Date(v.created_at), { addSuffix: true })}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-md bg-[#14C8CC]/10 text-[#14C8CC] font-mono text-[9.5px] tracking-[0.12em] uppercase">Ready</span>
                <button
                  type="button"
                  onClick={async () => {
                    const next = window.prompt(`Rename "${v.voice_name}" to:`, v.voice_name);
                    if (!next || next.trim() === v.voice_name) return;
                    try { await renameVoice({ rowId: v.id, newName: next }); } catch { /* toast handled in hook */ }
                  }}
                  disabled={isRenaming}
                  className="w-8 h-8 grid place-items-center rounded-md text-[#5A6268] hover:text-[#14C8CC] hover:bg-white/5 disabled:opacity-40"
                  title="Rename voice"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => { if (confirm(`Delete "${v.voice_name}"?`)) deleteVoice(v.id); }}
                  className="w-8 h-8 grid place-items-center rounded-md text-[#5A6268] hover:text-red-400 hover:bg-white/5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Plan-limit modal */}
      <Dialog open={showLimitModal} onOpenChange={setShowLimitModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Voice clone limit reached</DialogTitle>
            <DialogDescription>
              Your current plan allows {voiceCloneLimit} cloned voice{voiceCloneLimit === 1 ? "" : "s"}.
              Delete an existing voice or upgrade your plan to add more.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TipCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-[#10151A] p-3.5">
      <div className="w-7 h-7 rounded-md grid place-items-center bg-[#14C8CC]/10 text-[#14C8CC] mb-2">
        {icon}
      </div>
      <div className="text-[13px] font-semibold text-[#ECEAE4]">{title}</div>
      <div className="text-[12px] text-[#8A9198] mt-1 leading-relaxed">{body}</div>
    </div>
  );
}

// ─── Test Playground (right rail) ────────────────────────────────────

const SAMPLE_PROMPT =
  "In a future where every story can be told in any voice — yours included — we built a tool that takes nothing but a thought, and gives it sound.";

function TestPlayground({
  voice, language, onSwap, userId,
}: {
  voice: CatalogVoice | undefined;
  language: string;
  onSwap: () => void;
  userId: string | undefined;
}) {
  const [text, setText] = useState(SAMPLE_PROMPT);
  const [tonePacing, setTonePacing] = useState(45);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<PlaygroundHistoryItem[]>([]);
  const [playingHistoryIdx, setPlayingHistoryIdx] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const charLimit = 1000;
  const cost = Math.max(1, Math.ceil(text.length / 10));

  // Hydrate history from localStorage on mount.
  useEffect(() => {
    if (!userId) return;
    try {
      const raw = localStorage.getItem(lsKey(userId, "playground_history"));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, 10));
      }
    } catch { /* ignore */ }
  }, [userId]);

  const persistHistory = useCallback((items: PlaygroundHistoryItem[]) => {
    if (!userId) return;
    try {
      localStorage.setItem(lsKey(userId, "playground_history"), JSON.stringify(items.slice(0, 10)));
    } catch { /* ignore */ }
  }, [userId]);

  const stopHistoryAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    setPlayingHistoryIdx(null);
  }, []);

  const playHistory = (idx: number) => {
    if (playingHistoryIdx === idx) { stopHistoryAudio(); return; }
    stopHistoryAudio();
    const item = history[idx];
    if (!item) return;
    const audio = new Audio(item.audioUrl);
    audioRef.current = audio;
    setPlayingHistoryIdx(idx);
    audio.onended = () => setPlayingHistoryIdx((p) => (p === idx ? null : p));
    audio.onerror = () => setPlayingHistoryIdx((p) => (p === idx ? null : p));
    audio.play().catch(() => setPlayingHistoryIdx(null));
  };

  const generate = async () => {
    if (!voice) return;
    if (!userId) { toast.error("Sign in to generate previews."); return; }
    if (text.trim().length < 2) { toast.error("Type at least a couple of words."); return; }

    setGenerating(true);
    try {
      const { data: job, error } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: userId,
          task_type: "voice_preview",
          payload: { speaker: voice.id, language, text: text.slice(0, charLimit), tonePacing },
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !job) throw new Error("Failed to queue preview.");

      const MAX_WAIT = 30_000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await (supabase
          .from("video_generation_jobs") as unknown as ReturnType<typeof supabase.from>)
          .select("status, result")
          .eq("id", job.id)
          .single();
        if (row?.status === "completed" && row?.result?.audioUrl) {
          const url = row.result.audioUrl as string;
          const item: PlaygroundHistoryItem = {
            text: text.slice(0, 80),
            voiceId: voice.id,
            voiceName: voice.name,
            audioUrl: url,
            tonePacing,
            language,
            ts: Date.now(),
          };
          setHistory((prev) => {
            const next = [item, ...prev].slice(0, 10);
            persistHistory(next);
            return next;
          });
          stopHistoryAudio();
          const audio = new Audio(url);
          audioRef.current = audio;
          setPlayingHistoryIdx(0);
          audio.onended = () => setPlayingHistoryIdx((p) => (p === 0 ? null : p));
          audio.play().catch(() => setPlayingHistoryIdx(null));
          return;
        }
        if (row?.status === "failed") throw new Error("Preview generation failed.");
      }
      throw new Error("Preview timed out — try again.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  };

  if (!voice) {
    return (
      <div className="rounded-xl border border-white/8 bg-[#10151A] p-5 text-center text-[#5A6268] text-[12px]">
        No voices available for this language.
      </div>
    );
  }

  return (
    // overflow-x-hidden + min-w-0 + w-full so a long history line
    // (the user's prompt is rendered verbatim with `truncate`) can't
    // push the panel wider than its parent column on a 360 px phone.
    // Tighter horizontal padding on mobile (`p-3` vs `p-5` desktop)
    // gives the inner controls another 16 px of breathing room before
    // the truncate kicks in.
    <div className="w-full min-w-0 rounded-xl border border-white/8 bg-[#10151A] p-3 sm:p-5 max-h-[calc(100vh-7rem)] overflow-y-auto overflow-x-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#ECEAE4] inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] animate-pulse" />
          Test playground
        </div>
        <div className="font-mono text-[9.5px] tracking-[0.1em] text-[#14C8CC]">● LIVE</div>
      </div>

      {/* Selected voice card */}
      <div className="rounded-lg border border-white/8 bg-[#0A0D0F] p-3 flex items-center gap-2.5">
        <div
          className="w-9 h-9 rounded-full grid place-items-center font-serif font-semibold text-[14px] text-white shrink-0"
          style={{ background: avatarBackground(voice.accent) }}
        >
          {voice.initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[#ECEAE4] truncate">{voice.name}</div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-[#5A6268] truncate mt-0.5">
            {voice.gender} · {voice.accent} · {voice.tags[0] ?? "voice"}
          </div>
        </div>
        <button
          type="button"
          onClick={onSwap}
          className="font-mono text-[9.5px] tracking-[0.12em] uppercase text-[#5A6268] hover:text-[#ECEAE4] inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
        >
          <ArrowLeftRight className="w-2.5 h-2.5" /> Swap
        </button>
      </div>

      {/* Text */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, charLimit))}
        placeholder="Type something to test this voice…"
        className="mt-3 w-full min-h-[110px] p-3 rounded-lg bg-[#0A0D0F] border border-white/10 text-[13px] text-[#ECEAE4] placeholder:text-[#5A6268] focus:outline-none focus:border-[#14C8CC]/40 resize-y"
      />
      <div className="flex items-center justify-between mt-1.5">
        <button
          type="button"
          onClick={() => setText(SAMPLE_PROMPT)}
          className="font-mono text-[9.5px] tracking-[0.1em] uppercase text-[#5A6268] hover:text-[#ECEAE4] px-2 py-1 rounded border border-dashed border-white/10 hover:border-white/20 transition-colors"
        >
          + Example
        </button>
        <span className="font-mono text-[10px] text-[#5A6268]">{text.length} / {charLimit}</span>
      </div>

      {/* Tone & pacing — single horizontal slider matching Image 158. */}
      <div className="mt-4 rounded-lg border border-white/8 bg-[#0A0D0F] p-3.5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[12.5px] font-semibold text-[#ECEAE4]">Tone &amp; pacing</span>
          <span className="font-mono text-[9.5px] tracking-[0.16em] uppercase text-[#E4C875]">
            {tonePacingLabel(tonePacing)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            value={tonePacing}
            onChange={(e) => setTonePacing(+e.target.value)}
            className="flex-1 accent-[#14C8CC]"
          />
          <span className="font-mono text-[11px] text-[#8A9198] tabular-nums w-10 text-right">{tonePacing}%</span>
        </div>
      </div>

      {/* Generate */}
      <button
        type="button"
        onClick={generate}
        disabled={generating || text.trim().length < 2}
        className="mt-4 w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
        {generating ? "Generating…" : "Generate preview"}
      </button>
      <div className="font-mono text-[9.5px] tracking-[0.12em] uppercase text-[#5A6268] text-center mt-1.5">
        ~{cost} cr · ≈12 seconds
      </div>

      {/* History */}
      {history.length > 0 && (
        <>
          <div className="flex items-center justify-between mt-5 mb-2">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#ECEAE4]">Recent generations</span>
            <button
              type="button"
              onClick={() => { setHistory([]); persistHistory([]); }}
              className="font-mono text-[9.5px] tracking-[0.1em] uppercase text-[#5A6268] hover:text-[#ECEAE4]"
            >
              Clear
            </button>
          </div>
          <div className="grid gap-1.5">
            {history.map((h, i) => (
              <div key={`${h.ts}-${i}`} className="flex items-center gap-2.5 rounded-lg bg-[#0A0D0F] border border-white/8 p-2">
                <button
                  type="button"
                  onClick={() => playHistory(i)}
                  className={cn(
                    "w-7 h-7 shrink-0 rounded-full grid place-items-center transition-colors",
                    playingHistoryIdx === i ? "bg-[#14C8CC] text-[#0A0D0F]" : "bg-white/5 text-[#ECEAE4] hover:bg-white/10",
                  )}
                >
                  {playingHistoryIdx === i ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 translate-x-px" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] text-[#ECEAE4] truncate">"{h.text}…"</div>
                  <div className="font-mono text-[9.5px] tracking-[0.06em] text-[#5A6268] truncate mt-0.5">
                    {h.voiceName} · tone {h.tonePacing}%
                  </div>
                </div>
                <span className="font-mono text-[9.5px] text-[#5A6268] shrink-0">
                  {formatDistanceToNow(new Date(h.ts), { addSuffix: false })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Pacing buckets shown alongside the percentage so the slider has
 *  semantic anchor points (just a number is hard to map to a vibe). */
function tonePacingLabel(p: number): string {
  if (p <= 20) return "Slow";
  if (p <= 40) return "Measured";
  if (p <= 60) return "Natural";
  if (p <= 80) return "Brisk";
  return "Energetic";
}

