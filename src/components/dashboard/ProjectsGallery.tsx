import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { useAuth } from '@/hooks/useAuth';
import { useReferral } from '@/hooks/useReferral';
import { toast } from 'sonner';
import { Copy, Check } from 'lucide-react';

type Project = {
  id: string;
  user_id: string | null;
  title: string | null;
  project_type: string | null;
  format: string | null;
  length: string | null;
  status: string | null;
  voice_name: string | null;
  voice_inclination: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
};

const LANGUAGE_LABEL: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  ht: 'Kreyòl',
  de: 'Deutsch',
  it: 'Italiano',
  nl: 'Nederlands',
};

const FILTER_PILLS: Array<{ id: string; label: string; match: (p: Project) => boolean }> = [
  { id: 'All',        label: 'All',        match: () => true },
  { id: 'cinematic',  label: 'Cinematic',  match: (p) => (p.project_type || '').toLowerCase() === 'cinematic' },
  { id: 'doc2video',  label: 'Explainer',  match: (p) => (p.project_type || '').toLowerCase() === 'doc2video' },
  { id: 'smartflow',  label: 'Smart Flow', match: (p) => (p.project_type || '').toLowerCase() === 'smartflow' },
];

export default function ProjectsGallery() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<string>('All');
  const queryClient = useQueryClient();
  const { referralLink, totalCreditsEarned } = useReferral();
  const [linkCopied, setLinkCopied] = useState(false);

  const { data: projects = [], isLoading, isError } = useQuery<Project[]>({
    queryKey: ['dashboard-projects', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: projs, error } = await supabase
        .from('projects')
        .select('id,user_id,title,project_type,format,length,status,voice_name,voice_inclination,thumbnail_url,created_at,updated_at')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(12);
      if (error) throw error;
      if (!projs?.length) return [];

      // Belt-and-suspenders: RLS should already scope this to the
      // signed-in user, but we filter client-side too in case a row
      // slipped through (e.g. shared projects or RLS misconfig).
      const mine = projs.filter((p) => p.user_id === user!.id);

      // For projects without a thumbnail_url, pull the first generated
      // scene image so we don't flash a placeholder gradient.
      const missing = mine.filter((p) => !p.thumbnail_url).map((p) => p.id);
      const fromScenes: Record<string, string | null> = {};
      if (missing.length > 0) {
        const { data: gens } = await supabase
          .from('generations')
          .select('project_id, scenes')
          .in('project_id', missing)
          .eq('status', 'complete')
          .order('created_at', { ascending: false });
        if (gens) {
          for (const gen of gens) {
            if (fromScenes[gen.project_id] !== undefined) continue;
            const scenes = gen.scenes as Array<{ imageUrl?: string; image_url?: string; imageUrls?: string[] }>;
            if (!Array.isArray(scenes) || scenes.length === 0) continue;
            for (const scene of scenes) {
              const url = scene?.imageUrl
                || scene?.image_url
                || (Array.isArray(scene?.imageUrls) && scene.imageUrls[0]);
              if (url) {
                fromScenes[gen.project_id] = url;
                break;
              }
            }
            if (fromScenes[gen.project_id] === undefined) fromScenes[gen.project_id] = null;
          }
        }
      }

      return mine.map((p) => ({
        ...p,
        thumbnail_url: p.thumbnail_url ?? fromScenes[p.id] ?? null,
      })) as Project[];
    },
  });

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`gallery_projects_${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'projects', filter: `user_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey: ['dashboard-projects', user.id] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient, user]);

  const activeFilter = FILTER_PILLS.find((f) => f.id === filter) ?? FILTER_PILLS[0];
  const galleryProjects = projects.filter(activeFilter.match);
  const recentProject = projects[0] ?? null;

  const generateGradient = (id: string | null | undefined) => {
    if (!id) return '#10151A';
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = hash % 360;
    return `radial-gradient(60% 70% at 50% 50%, hsl(${hue}, 40%, 30%), hsl(${hue}, 60%, 10%) 70%, #05030a)`;
  };

  const copyReferral = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setLinkCopied(true);
      toast.success('Referral link copied');
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error('Copy failed — select the link manually.');
    }
  };

  // ── Loading skeleton ─────────────────────────────────────────
  if (isLoading) {
    return (
      <>
        <div className="flex items-baseline justify-between mt-9 mb-3.5">
          <div className="h-5 w-64 rounded bg-white/5 animate-pulse" />
          <div className="h-4 w-36 rounded bg-white/5 animate-pulse" />
        </div>
        <div className="border border-white/5 rounded-2xl bg-[#10151A] overflow-hidden grid grid-cols-[240px_1fr] gap-0 h-[210px] animate-pulse">
          <div className="bg-white/5" />
          <div className="p-[24px_28px] flex flex-col gap-2.5">
            <div className="h-3 w-20 bg-white/5 rounded" />
            <div className="h-7 w-2/3 bg-white/5 rounded" />
            <div className="h-3 w-full bg-white/5 rounded" />
          </div>
        </div>
        <div className="flex items-baseline justify-between mt-9 mb-3.5">
          <div className="h-5 w-40 rounded bg-white/5 animate-pulse" />
        </div>
        <div className="grid grid-cols-4 gap-3.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="relative rounded-xl overflow-hidden border border-white/5 bg-[#10151A] flex flex-col animate-pulse">
              <div className="aspect-[4/5] bg-white/5" />
              <div className="p-[12px_14px_14px]">
                <div className="h-3 w-3/4 bg-white/5 rounded" />
                <div className="h-2 w-1/2 bg-white/5 rounded mt-2" />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  // ── Error state ──────────────────────────────────────────────
  if (isError) {
    return (
      <div className="mt-9 border border-white/5 rounded-2xl bg-[#10151A] p-10 text-center">
        <p className="text-[15px] text-[#ECEAE4] font-serif">Couldn't load your projects.</p>
        <p className="text-[12.5px] text-[#8A9198] mt-2">
          Check your connection or reload the page. If this keeps happening, contact support.
        </p>
      </div>
    );
  }

  // ── Empty state ──────────────────────────────────────────────
  if (projects.length === 0) {
    return (
      <div className="mt-9 border border-white/5 rounded-2xl bg-[#10151A] p-12 text-center">
        <div className="mx-auto w-14 h-14 rounded-full grid place-items-center bg-gradient-to-br from-[#14C8CC]/20 to-[#0FA6AE]/10 border border-[#14C8CC]/20 mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#14C8CC" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3V9z" fill="#14C8CC" /></svg>
        </div>
        <h3 className="font-serif font-medium text-[20px] tracking-tight m-0">No projects yet</h3>
        <p className="text-[13px] text-[#8A9198] mt-2 max-w-[42ch] mx-auto">
          Drop an idea into the prompt above, or start with one of the creative modes — Cinematic, Explainer, or Smart Flow.
        </p>
        <div className="flex items-center justify-center gap-2 mt-5">
          <a
            href="/app/create?mode=cinematic"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]"
            style={{ textDecoration: 'none' }}
          >
            Start a cinematic
          </a>
          <a
            href="/app/create?mode=doc2video"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-[#ECEAE4] border border-white/10 hover:bg-white/5 transition-colors"
            style={{ textDecoration: 'none' }}
          >
            Explainer
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-baseline justify-between mt-9 mb-3.5">
        <h2 className="font-serif font-medium text-[20px] tracking-tight m-0">Pick up where you left off</h2>
        <span className="font-mono text-[11px] tracking-widest uppercase text-[#8A9198]">
          {recentProject ? `Auto-saved · ${format(new Date(recentProject.updated_at), 'MMM d, h:mm a')}` : 'No recent projects'}
        </span>
      </div>

      {recentProject && (
        <a
          className="border border-white/5 rounded-2xl bg-[#10151A] overflow-hidden grid grid-cols-[240px_1fr] gap-0 text-inherit hover:border-white/10 transition-colors"
          href={`/app/create?project=${recentProject.id}`}
          style={{ textDecoration: 'none' }}
        >
          <div className="relative aspect-[4/3] bg-black overflow-hidden group">
            {recentProject.thumbnail_url ? (
              <img src={recentProject.thumbnail_url} alt={recentProject.title ?? ''} className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
            ) : (
              <div className="absolute inset-0" style={{ background: generateGradient(recentProject.id) }} />
            )}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-[#0A0D0F]/50 border border-white/30 grid place-items-center backdrop-blur-sm group-hover:scale-105 transition-transform">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M8 5l12 7-12 7V5z" fill="#fff" /></svg>
            </div>
          </div>
          <div className="p-[24px_28px] flex flex-col gap-2.5">
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#14C8CC]">
              {recentProject.project_type || 'PROJECT'}
            </div>
            <h3 className="font-serif font-medium text-[26px] m-0 tracking-tight leading-[1.15]">
              {recentProject.title || 'Untitled Project'}
            </h3>
            <p className="text-[14px] text-[#8A9198] leading-[1.55] m-0 max-w-[50ch]">
              {recentProject.status === 'complete'
                ? 'Ready to watch or iterate — pick up where you left off.'
                : 'Picking up from your latest edit.'}
            </p>
            <div className="flex gap-5 mt-auto pt-4 border-t border-white/5">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Length</span>
                <span className="font-serif text-[17px] text-[#ECEAE4]">{recentProject.length || 'brief'}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Language</span>
                <span className="font-serif text-[17px] text-[#ECEAE4]">
                  {LANGUAGE_LABEL[recentProject.voice_inclination ?? 'en'] ?? 'English'}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Format</span>
                <span className="font-serif text-[17px] text-[#ECEAE4]">
                  {recentProject.format === 'portrait' ? '9:16' : recentProject.format === 'square' ? '1:1' : '16:9'}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Voice</span>
                <span className="font-serif text-[17px] text-[#ECEAE4]">{recentProject.voice_name || '—'}</span>
              </div>
            </div>
            <div className="flex gap-2.5 mt-4">
              <span className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]">
                Resume editing →
              </span>
            </div>
          </div>
        </a>
      )}

      {/* Filter pills */}
      <div className="flex items-baseline justify-between mt-9 mb-3.5">
        <h2 className="font-serif font-medium text-[20px] tracking-tight m-0">Recent projects</h2>
        <div className="flex gap-1 p-1 bg-[#1B2228] rounded-lg border border-white/5">
          {FILTER_PILLS.map((pill) => (
            <button
              key={pill.id}
              onClick={() => setFilter(pill.id)}
              className={
                `px-3 py-1.5 text-[12px] rounded-md font-medium transition-colors ` +
                (filter === pill.id
                  ? 'bg-[#10151A] text-[#ECEAE4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                  : 'text-[#8A9198] hover:text-[#ECEAE4]')
              }
              type="button"
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      {galleryProjects.length === 0 ? (
        <div className="border border-white/5 rounded-xl bg-[#10151A] p-8 text-center text-[13px] text-[#8A9198]">
          No projects match this filter.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
          {galleryProjects.map((proj) => (
            <a
              key={proj.id}
              className="relative rounded-xl overflow-hidden border border-white/5 bg-[#10151A] flex flex-col hover:-translate-y-0.5 hover:border-white/10 transition-all group"
              href={`/app/create?project=${proj.id}`}
              style={{ textDecoration: 'none' }}
            >
              <div className="relative aspect-[4/5] overflow-hidden bg-black">
                {proj.thumbnail_url ? (
                  <img src={proj.thumbnail_url} alt={proj.title ?? ''} className="absolute inset-0 w-full h-full object-cover opacity-75 group-hover:opacity-95 transition-opacity" />
                ) : (
                  <div className="absolute inset-0" style={{ background: generateGradient(proj.id) }} />
                )}
                <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9.5px] font-mono tracking-wider text-white/85 bg-black/55 backdrop-blur-sm border border-white/10">
                  {(proj.project_type || 'PROJ').toUpperCase()}
                </div>
                <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[9.5px] font-mono tracking-widest text-white bg-black/60">
                  {proj.length || '—'}
                </div>
              </div>
              <div className="p-[12px_14px_14px]">
                <div className="text-[13.5px] font-medium text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">
                  {proj.title || 'Untitled'}
                </div>
                <div className="font-mono text-[10px] text-[#8A9198] tracking-widest mt-1 flex gap-2">
                  {format(new Date(proj.created_at), 'MMM d')}
                  <span className="text-white/20">·</span>
                  {proj.status || 'draft'}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* Referral banner */}
      <div className="mt-10 border border-[#14C8CC]/15 rounded-2xl bg-gradient-to-r from-[#14C8CC]/5 via-transparent to-[#14C8CC]/5 p-5 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="font-serif text-[16px] text-[#ECEAE4] font-medium">
            Refer a friend, get 10,000 credits
          </div>
          <div className="font-mono text-[10.5px] text-[#8A9198] tracking-widest mt-1 uppercase">
            {totalCreditsEarned > 0 ? `You've earned ${totalCreditsEarned.toLocaleString()} credits so far` : 'Share your link and earn when they join'}
          </div>
        </div>
        <button
          type="button"
          onClick={copyReferral}
          disabled={!referralLink}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[12.5px] font-medium border border-[#14C8CC]/30 bg-[#14C8CC]/10 text-[#14C8CC] hover:bg-[#14C8CC]/20 transition-colors disabled:opacity-50"
        >
          {linkCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {linkCopied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </>
  );
}
