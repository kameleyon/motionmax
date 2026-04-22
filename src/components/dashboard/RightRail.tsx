import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { PLAN_LIMITS, normalizePlanName } from '@/lib/planLimits';

type Generation = {
  id: string;
  user_id: string | null;
  status: string | null;
  progress: number | null;
  project_id: string | null;
  created_at: string;
  completed_at: string | null;
};

type UserVoice = {
  id: string;
  user_id: string | null;
  voice_name?: string | null;
  name?: string | null;
  language?: string | null;
  description?: string | null;
  preview_url?: string | null;
};

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

  // ── Render queue (last 4) ──────────────────────────────────
  const { data: renderQueue = [] } = useQuery<Generation[]>({
    queryKey: ['rightrail-generations', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generations')
        .select('id,user_id,status,progress,project_id,created_at,completed_at')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      return (data ?? []) as Generation[];
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

  // ── Voices ─────────────────────────────────────────────────
  const { data: userVoices = [] } = useQuery<UserVoice[]>({
    queryKey: ['rightrail-voices', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_voices')
        .select('*')
        .eq('user_id', user!.id)
        .limit(3);
      if (error) return [] as UserVoice[];
      return (data ?? []) as UserVoice[];
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
                    {item.project_id ? `Project ${item.project_id.slice(0, 8)}` : 'Generation'}
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

      {/* ── Voice lab ────────────────────────────────────── */}
      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 font-medium flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.14)]" />
            Voice lab
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
          {userVoices.length === 0 ? (
            <div className="text-[12.5px] text-[#5A6268] py-2">
              No custom voices yet.{' '}
              <a href="/voice-lab" className="text-[#14C8CC] hover:underline" style={{ textDecoration: 'none' }}>
                Clone one →
              </a>
            </div>
          ) : (
            userVoices.map((voice, i) => {
              const displayName = voice.voice_name || voice.name || 'Voice';
              const initial = displayName.charAt(0).toUpperCase();
              const desc = voice.description || (voice.language ? voice.language.toUpperCase() : 'CUSTOM VOICE');
              return (
                <div key={voice.id} className={`flex items-center gap-2.5 py-2.5 ${i > 0 ? 'border-t border-white/5' : ''}`}>
                  <div className="w-7 h-7 rounded-full grid place-items-center font-serif text-[12px] text-[#0A0D0F] font-semibold bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE]">
                    {initial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">{displayName}</div>
                    <div className="font-mono text-[9.5px] text-[#5A6268] tracking-widest mt-px uppercase">{desc}</div>
                  </div>
                  {voice.preview_url ? (
                    <button
                      type="button"
                      onClick={() => {
                        const audio = new Audio(voice.preview_url!);
                        audio.play().catch(() => { /* ignore */ });
                      }}
                      className="w-7 h-7 rounded-full grid place-items-center border border-white/10 text-[#14C8CC] hover:bg-[#14C8CC]/10 transition-colors"
                      title="Play preview"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z" /></svg>
                    </button>
                  ) : (
                    <div className="flex items-center gap-[1.5px] h-[18px] opacity-60" aria-hidden="true">
                      <b className="w-[2px] rounded-[1px] bg-[#14C8CC]" style={{ height: '40%' }} />
                      <b className="w-[2px] rounded-[1px] bg-[#14C8CC]" style={{ height: '70%' }} />
                      <b className="w-[2px] rounded-[1px] bg-[#14C8CC]" style={{ height: '55%' }} />
                      <b className="w-[2px] rounded-[1px] bg-[#14C8CC]" style={{ height: '85%' }} />
                    </div>
                  )}
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
