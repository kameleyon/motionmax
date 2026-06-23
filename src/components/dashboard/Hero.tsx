import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useQuery } from '@tanstack/react-query';
import { selectActiveProfile } from '@/lib/profile-queries';
import { format } from 'date-fns';

function greetingFor(hour: number): string {
  if (hour < 5)  return 'Burning the midnight oil';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Late night creative session';
}

export default function Hero() {
  const { user } = useAuth();

  // C-5-6 (Prism PERF-010): unified `['profile', userId]` key so the
  // sidebar and the hero share the same cache entry instead of firing
  // two parallel SELECTs against profiles.
  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await selectActiveProfile('display_name, avatar_url')
        .eq('user_id', user!.id)
        .maybeSingle<{ display_name: string | null; avatar_url: string | null }>();
      return data;
    },
  });

  const { greeting, todayLabel } = useMemo(() => {
    const now = new Date();
    return {
      greeting: greetingFor(now.getHours()),
      todayLabel: format(now, 'EEE · MMM d · yyyy').toUpperCase(),
    };
  }, []);

  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'there';

  return (
    <section
      className="border border-white/5 rounded-2xl p-5 sm:p-8 md:p-10 lg:p-[42px_40px_36px] relative overflow-hidden bg-[#10151A]"
      style={{
        background: `radial-gradient(60% 80% at 85% 10%, rgba(20,200,204,.06), transparent 60%), radial-gradient(55% 70% at 10% 90%, rgba(20,200,204,.14), transparent 60%), #10151A`,
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(0deg,rgba(255,255,255,.02) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px)`,
          backgroundSize: '60px 60px',
          maskImage: 'radial-gradient(70% 70% at 50% 50%,#000,transparent 80%)',
        }}
      />

      <div className="relative flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3 sm:gap-5">
        <div className="flex-1 min-w-0">
          <h1 className="font-serif font-normal text-[clamp(24px,6vw,48px)] leading-[1.05] tracking-tight m-0 mb-1.5 max-w-[22ch]">
            {greeting}, {displayName}. What are we <em className="not-italic text-[#14C8CC]">making</em>?
          </h1>
          <p className="text-[13px] sm:text-[14px] text-[#8A9198] m-0">
            Describe a scene, paste a link, or drop in a document. MotionMax takes it from there.
          </p>
        </div>
        <div className="font-mono text-[10px] sm:text-[11px] tracking-widest uppercase text-[#5A6268] shrink-0">{todayLabel}</div>
      </div>
    </section>
  );
}
