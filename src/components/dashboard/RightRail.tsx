import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { PLAN_LIMITS, normalizePlanName } from '@/lib/planLimits';
import { toast } from 'sonner';
import { Loader2, Square } from 'lucide-react';

/** Tiny 4-bar equalizer icon. Animates when `playing` is true (simulates
 *  audio levels via CSS `animate-pulse` at staggered delays). Idle render
 *  is a static 4-bar silhouette so the shape reads as "voice waveform"
 *  rather than a generic play button. */
function BarsIcon({ playing = false }: { playing?: boolean }) {
  const heights = [40, 80, 55, 90];
  const delays = ['0ms', '120ms', '60ms', '180ms'];
  return (
    <div className="flex items-end gap-[2px] h-3.5 w-3.5" aria-hidden="true">
      {heights.map((h, i) => (
        <b
          key={i}
          className={`w-[2px] rounded-[1px] bg-current ${playing ? 'animate-pulse' : ''}`}
          style={{ height: `${h}%`, animationDelay: playing ? delays[i] : undefined }}
        />
      ))}
    </div>
  );
}

/** Strip the sm:/sm2:/gm: provider prefix so UI shows "Quinn" not
 *  "sm:quinn". Capitalises the first letter of the result for
 *  display consistency. */
function prettyVoiceName(raw: string): string {
  const stripped = raw.replace(/^(sm2?|gm):/i, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

const VOICE_PREVIEW_CACHE_KEY = 'motionmax_voice_previews';

function getCachedPreview(speakerId: string, lang: string): string | null {
  try {
    const cache = JSON.parse(localStorage.getItem(VOICE_PREVIEW_CACHE_KEY) || '{}');
    return cache[`${speakerId}_${lang}`] ?? null;
  } catch { return null; }
}

function setCachedPreview(speakerId: string, lang: string, url: string) {
  try {
    const cache = JSON.parse(localStorage.getItem(VOICE_PREVIEW_CACHE_KEY) || '{}');
    cache[`${speakerId}_${lang}`] = url;
    localStorage.setItem(VOICE_PREVIEW_CACHE_KEY, JSON.stringify(cache));
  } catch { /* ignore quota errors */ }
}

type Generation = {
  id: string;
  user_id: string | null;
  status: string | null;
  progress: number | null;
  project_id: string | null;
  created_at: string;
  completed_at: string | null;
  /** Joined via Supabase foreign-table select — projects(title). */
  projects?: { title: string | null } | null;
};

/** A voice "used" by the user — derived from their projects table,
 *  not from the separate user_voices clone library. */
type UsedVoice = {
  voiceName: string;
  language: string | null;
  lastUsedAt: string;
  projectId: string;
};

function sampleTextFor(speakerLabel: string, lang: string): string {
  switch (lang) {
    case 'ht': return `Bonjou, mwen se ${speakerLabel}. Kisa n ap kreye?`;
    case 'fr': return `Bonjour, je suis ${speakerLabel}. Qu'allons-nous créer ?`;
    case 'es': return `Hola, soy ${speakerLabel}. ¿Qué vamos a crear?`;
    case 'de': return `Hallo, ich bin ${speakerLabel}. Was erschaffen wir?`;
    case 'it': return `Ciao, sono ${speakerLabel}. Cosa creeremo?`;
    case 'nl': return `Hallo, ik ben ${speakerLabel}. Wat gaan we maken?`;
    default:   return `Hello, I'm ${speakerLabel}. What are we creating?`;
  }
}

/** Count generations per day for the last 30 days, from an array of
 *  generation rows. Returns a fixed-length [oldest …today] array. */
function usageByDay(rows: Generation[], days = 30): number[] {
  const counts = new Array(days).fill(0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (const row of rows) {
    const rowDate = new Date(row.created_at);
    rowDate.setHours(0, 0, 0, 0);
    const diff = Math.floor((now.getTime() - rowDate.getTime()) / 86_400_000);
    if (diff >= 0 && diff < days) {
      counts[days - 1 - diff] += 1;
    }
  }
  return counts;
}

/** Human-readable HH:MM:SS from a total seconds value. */
function formatRuntime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function RightRail() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPreviewPlaying(null);
  }, []);

  const playPreview = useCallback(async (rawVoice: string, language: string | null) => {
    if (!user) return;
    const voiceId = rawVoice;
    const lang = language || 'en';
    const label = prettyVoiceName(rawVoice);

    if (previewPlaying === voiceId) { stopPlayback(); return; }
    stopPlayback();

    const cached = getCachedPreview(voiceId, lang);
    if (cached) {
      const audio = new Audio(cached);
      audioRef.current = audio;
      setPreviewPlaying(voiceId);
      audio.onended = () => setPreviewPlaying(null);
      audio.onerror = () => setPreviewPlaying(null);
      audio.play().catch(() => setPreviewPlaying(null));
      return;
    }

    setPreviewLoading(voiceId);
    try {
      const { data: job, error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          task_type: 'voice_preview',
          payload: { speaker: voiceId, language: lang, text: sampleTextFor(label, lang) },
          status: 'pending',
        })
        .select('id')
        .single();
      if (error || !job) throw new Error('queue failed');

      const MAX_WAIT = 30_000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await supabase
          .from('video_generation_jobs')
          .select('status, result')
          .eq('id', job.id)
          .single();
        const result = (row?.result ?? null) as { audioUrl?: string } | null;
        if (row?.status === 'completed' && result?.audioUrl) {
          setCachedPreview(voiceId, lang, result.audioUrl);
          const audio = new Audio(result.audioUrl);
          audioRef.current = audio;
          setPreviewPlaying(voiceId);
          audio.onended = () => setPreviewPlaying(null);
          audio.onerror = () => setPreviewPlaying(null);
          audio.play().catch(() => setPreviewPlaying(null));
          break;
        }
        if (row?.status === 'failed') break;
      }
    } catch {
      toast.error('Voice preview unavailable. Please try again.');
    } finally {
      setPreviewLoading(null);
    }
  }, [user, previewPlaying, stopPlayback]);

  useEffect(() => () => stopPlayback(), [stopPlayback]);

  // ── Subscription / plan ────────────────────────────────────
  const { data: subscription } = useQuery({
    queryKey: ['rightrail-subscription', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from('subscriptions')
        .select('plan_name, status')
        .eq('user_id', user!.id)
        .eq('status', 'active')
        .maybeSingle();
      return data;
    },
  });

  // ── Credits balance ────────────────────────────────────────
  const { data: credits } = useQuery({
    queryKey: ['rightrail-credits', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_credits')
        .select('credits_balance')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data;
    },
  });

  // ── Render queue (last 4) — joins projects.title so we can show a
  // human name instead of "Project 37d48da3" ─────────────────────
  const { data: renderQueue = [] } = useQuery<Generation[]>({
    queryKey: ['rightrail-generations', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generations')
        .select('id,user_id,status,progress,project_id,created_at,completed_at,projects(title)')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      return (data ?? []) as unknown as Generation[];
    },
  });

  // ── All generations from last 30 days (for sparkline + stats) ──
  const { data: recentGenerations = [] } = useQuery<Generation[]>({
    queryKey: ['rightrail-gen-30d', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('generations')
        .select('id,user_id,status,progress,project_id,created_at,completed_at')
        .eq('user_id', user!.id)
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Generation[];
    },
  });

  // ── Voices — last 3 DISTINCT voices actually used on the user's
  // own projects (not the clone library). Pulls voice_name from the
  // most-recently-updated projects, de-duplicated, max 3. ──────
  const { data: usedVoices = [] } = useQuery<UsedVoice[]>({
    queryKey: ['rightrail-used-voices', user?.id],
    enabled: !!user,
    queryFn: async () => {
      type VoiceRow = {
        id: string;
        voice_name: string | null;
        voice_inclination: string | null;
        updated_at: string;
      };
      const { data, error } = await supabase
        .from('projects')
        .select('id,voice_name,voice_inclination,updated_at')
        .eq('user_id', user!.id)
        .not('voice_name', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(30); // enough to find 3 distinct after dedup
      if (error) throw error;

      const seen = new Set<string>();
      const out: UsedVoice[] = [];
      for (const row of (data ?? []) as VoiceRow[]) {
        if (!row.voice_name || seen.has(row.voice_name)) continue;
        seen.add(row.voice_name);
        out.push({
          voiceName: row.voice_name,
          language: row.voice_inclination,
          lastUsedAt: row.updated_at,
          projectId: row.id,
        });
        if (out.length >= 3) break;
      }
      return out;
    },
  });

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`rightrail_generations_${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'generations', filter: `user_id=eq.${user.id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['rightrail-generations', user.id] });
          queryClient.invalidateQueries({ queryKey: ['rightrail-gen-30d', user.id] });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'user_credits', filter: `user_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey: ['rightrail-credits', user.id] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient, user]);

  // ── Derived: plan + credit cap ─────────────────────────────
  const plan = normalizePlanName(subscription?.plan_name ?? 'free');
  const planLabel = subscription?.plan_name ?? 'Free Plan';
  const creditsCap = PLAN_LIMITS[plan].creditsPerMonth || 1; // avoid /0
  const creditsBalance = credits?.credits_balance ?? 0;
  const usedThisMonth = Math.max(0, creditsCap - creditsBalance);
  const usedPct = Math.min(100, Math.round((usedThisMonth / creditsCap) * 100));

  // ── Derived: sparkline (30-day generation count by day) ────
  const sparkline = useMemo(() => usageByDay(recentGenerations, 30), [recentGenerations]);
  const sparkMax = Math.max(1, ...sparkline);

  // ── Derived: weekly stats ──────────────────────────────────
  const stats = useMemo(() => {
    const now = Date.now();
    const weekMs = 7 * 86_400_000;
    const thisWeekStart = now - weekMs;
    const lastWeekStart = now - 2 * weekMs;

    const thisWeek = recentGenerations.filter((g) => new Date(g.created_at).getTime() >= thisWeekStart);
    const lastWeek = recentGenerations.filter((g) => {
      const t = new Date(g.created_at).getTime();
      return t >= lastWeekStart && t < thisWeekStart;
    });

    // Total runtime: sum of (completed_at - created_at) for completed
    // this-week generations. Falls back to 11s × scene count when we
    // don't have a completed_at (still in flight).
    const runtimeSec = thisWeek.reduce((sum, g) => {
      if (g.completed_at) {
        return sum + Math.max(0, (new Date(g.completed_at).getTime() - new Date(g.created_at).getTime()) / 1000);
      }
      return sum;
    }, 0);

    const delta = lastWeek.length === 0
      ? (thisWeek.length > 0 ? 100 : 0)
      : Math.round(((thisWeek.length - lastWeek.length) / lastWeek.length) * 100);

    return {
      videosRendered: thisWeek.filter((g) => g.status === 'complete').length,
      totalRuntime: formatRuntime(runtimeSec),
      weekDeltaPct: delta,
      activeThisWeek: thisWeek.length,
    };
  }, [recentGenerations]);

  const getStatusDisplay = (gen: Generation) => {
    const status = (gen.status ?? '').toLowerCase();
    if (['pending', 'processing', 'generating', 'in_progress'].includes(status)) {
      return { text: `${gen.progress || 0}%`, state: 'active' as const };
    }
    if (status === 'complete' || status === 'completed' || status === 'done') {
      return { text: 'DONE', state: 'done' as const };
    }
    if (status === 'failed' || status === 'error') {
      return { text: 'FAILED', state: 'failed' as const };
    }
    return { text: status.toUpperCase() || 'QUEUED', state: 'queued' as const };
  };

  return (
    <aside className="flex flex-col gap-3.5">
      {/* ── Credits card ──────────────────────────────────── */}
      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.2)]" />
          Credits
        </h4>
        <div className="flex items-baseline gap-2.5 mb-3.5">
          <b className="font-serif text-[36px] tracking-tight font-normal text-[#ECEAE4]">
            {creditsBalance.toLocaleString()}
          </b>
          <span className="font-mono text-[11px] text-[#5A6268] tracking-widest">/ {creditsCap.toLocaleString()}</span>
        </div>
        <div className="h-1.5 rounded-full bg-[#1B2228] relative border border-white/5 overflow-hidden">
          <i
            className="block h-full bg-[#14C8CC] rounded-full transition-all"
            style={{ width: `${Math.min(100, Math.max(0, 100 - usedPct))}%` }}
          />
          <div className="absolute top-[-2px] w-[2px] h-2.5 bg-[#8A9198] opacity-35 left-[25%]" />
          <div className="absolute top-[-2px] w-[2px] h-2.5 bg-[#8A9198] opacity-35 left-[50%]" />
          <div className="absolute top-[-2px] w-[2px] h-2.5 bg-[#8A9198] opacity-35 left-[75%]" />
        </div>
        <div className="flex justify-between mt-2.5 font-mono text-[10px] text-[#5A6268] tracking-widest">
          <span>Used this month</span>
          <span>{usedPct}%</span>
        </div>
        <div className="flex items-end gap-[3px] h-7 mt-3.5" aria-hidden="true" title="Generations over the last 30 days">
          {sparkline.map((val, i) => {
            const heightPct = (val / sparkMax) * 100;
            return (
              <b
                key={i}
                className={`flex-1 block rounded-[2px] min-h-[2px] ${val > 0 ? 'bg-gradient-to-b from-[#14C8CC] to-[#0FA6AE]' : 'bg-white/10'}`}
                style={{ height: `${Math.max(4, heightPct)}%` }}
              />
            );
          })}
        </div>
        <div className="flex justify-between items-center mt-3.5 pt-3.5 border-t border-white/5 text-[12px] text-[#8A9198]">
          <span className="font-mono text-[10px] tracking-widest uppercase px-2 py-1 rounded bg-[#14C8CC]/10 text-[#14C8CC]">
            {planLabel}
          </span>
          <a
            href="/pricing"
            className="font-mono text-[10.5px] tracking-wider uppercase text-[#14C8CC] hover:text-[#ECEAE4] transition-colors"
            style={{ textDecoration: 'none' }}
          >
            Top up →
          </a>
        </div>
      </div>

      {/* ── Render queue ─────────────────────────────────── */}
      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.3)]" />
          Render queue
        </h4>
        <div className="flex flex-col">
          {renderQueue.length === 0 ? (
            <div className="text-[12.5px] text-[#5A6268] py-2">No active renders</div>
          ) : (
            renderQueue.map((item, i) => {
              const display = getStatusDisplay(item);
              const dotColor =
                display.state === 'active'  ? 'bg-[#14C8CC] animate-pulse shadow-[0_0_0_4px_rgba(20,200,204,0.3)]' :
                display.state === 'done'    ? 'bg-[#5CD68D]' :
                display.state === 'failed'  ? 'bg-[#E66666]' :
                                              'bg-[#5A6268]';
              return (
                <a
                  key={item.id}
                  href={item.project_id ? `/app/create?project=${item.project_id}` : '#'}
                  className={`flex items-center gap-2.5 py-2.5 hover:bg-white/5 rounded-md px-2 -mx-2 transition-colors ${i > 0 ? 'border-t border-white/5' : ''}`}
                  style={{ textDecoration: 'none' }}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                  <span className="flex-1 min-w-0 text-[12.5px] text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">
                    {item.projects?.title?.trim() || 'Untitled project'}
                  </span>
                  <span className={`font-mono text-[10px] tracking-wider ${display.state === 'active' ? 'text-[#14C8CC]' : display.state === 'failed' ? 'text-[#E66666]' : 'text-[#5A6268]'}`}>
                    {display.text}
                  </span>
                </a>
              );
            })
          )}
        </div>
      </div>

      {/* ── Recent voices — last 3 DISTINCT voices used on this user's projects ── */}
      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 font-medium flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.14)]" />
            Recent voices
          </h4>
          <a
            href="/voice-lab"
            className="font-mono text-[10px] tracking-widest uppercase text-[#14C8CC] hover:text-[#ECEAE4] transition-colors"
            style={{ textDecoration: 'none' }}
          >
            Manage →
          </a>
        </div>
        <div className="flex flex-col">
          {usedVoices.length === 0 ? (
            <div className="text-[12.5px] text-[#5A6268] py-2">
              You haven't used any voices yet.{' '}
              <a href="/app/create" className="text-[#14C8CC] hover:underline" style={{ textDecoration: 'none' }}>
                Start a project →
              </a>
            </div>
          ) : (
            usedVoices.map((voice, i) => {
              const displayName = prettyVoiceName(voice.voiceName);
              const initial = (displayName || 'V').charAt(0).toUpperCase();
              const desc = voice.language
                ? `${voice.language.toUpperCase()} · LAST USED ${new Date(voice.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}`
                : 'RECENT VOICE';
              const isLoading = previewLoading === voice.voiceName;
              const isPlaying = previewPlaying === voice.voiceName;
              const busy = previewLoading !== null;
              return (
                <div key={voice.voiceName + i} className={`flex items-center gap-2.5 py-2.5 ${i > 0 ? 'border-t border-white/5' : ''}`}>
                  <div className="w-7 h-7 rounded-full grid place-items-center font-serif text-[12px] text-[#0A0D0F] font-semibold bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE]">
                    {initial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">
                      {displayName}
                    </div>
                    <div className="font-mono text-[9.5px] text-[#5A6268] tracking-widest mt-px uppercase">
                      {desc}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy && !isLoading}
                    onClick={() => playPreview(voice.voiceName, voice.language)}
                    title={isPlaying ? 'Stop preview' : 'Play preview'}
                    className="w-7 h-7 rounded-full grid place-items-center border border-[#14C8CC]/30 text-[#14C8CC] hover:bg-[#14C8CC]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isLoading
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : isPlaying
                        ? <Square className="w-3 h-3 fill-current" />
                        : <BarsIcon />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── This week ────────────────────────────────────── */}
      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium">This week</h4>
        <div className="grid grid-cols-2 gap-2.5 font-serif">
          <div>
            <div className="text-[28px] text-[#ECEAE4] tracking-tight">{stats.videosRendered}</div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">Videos rendered</div>
          </div>
          <div>
            <div className="text-[28px] text-[#ECEAE4] tracking-tight">
              {stats.totalRuntime.split(':').slice(0, 2).join(':')}
              <span className="text-[14px] text-[#5A6268]">:{stats.totalRuntime.split(':')[2] ?? '00'}</span>
            </div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">Total runtime</div>
          </div>
          <div>
            <div className={`text-[28px] tracking-tight ${stats.weekDeltaPct >= 0 ? 'text-[#14C8CC]' : 'text-[#E66666]'}`}>
              {stats.weekDeltaPct >= 0 ? '+' : ''}{stats.weekDeltaPct}%
            </div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">vs last week</div>
          </div>
          <div>
            <div className="text-[28px] text-[#14C8CC] tracking-tight">{stats.activeThisWeek}</div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">Active renders</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
