import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useReferral } from "@/hooks/useReferral";


export default function ProjectsGallery() {
  const { user } = useAuth();
  const [filter, setFilter] = useState('All');
  const queryClient = useQueryClient();
  const { referralLink } = useReferral();


  const { data: projects = [] } = useQuery({
    queryKey: ['dashboard-projects', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('user_id', user!.id)
        .order('updated_at', { ascending: false })
        .limit(7);
      if (error) throw error;
      return data;
    }
  });

  useEffect(() => {
    const channel = supabase
      .channel('projects_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-projects', user?.id] });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const recentProject = projects.length > 0 ? projects[0] : null;
  const galleryProjects = filter === 'All' ? projects : projects.filter(p => p.project_type?.toLowerCase() === filter.toLowerCase() || (filter === 'Cinematic' && !p.project_type));

  const generateGradient = (id) => {
    if (!id) return '#10151A';
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = hash % 360;
    return `radial-gradient(60% 70% at 50% 50%, hsl(${hue}, 40%, 30%), hsl(${hue}, 60%, 10%) 70%, #05030a)`;
  };

  return (
    <>
      <div className="flex items-baseline justify-between mt-9 mb-3.5">
        <h2 className="font-serif font-medium text-[20px] tracking-tight m-0">Pick up where you left off</h2>
        <span className="font-mono text-[11px] tracking-widest uppercase text-[#8A9198] cursor-pointer hover:text-[#14C8CC]">
          {recentProject ? `Auto-saved - ${format(new Date(recentProject.updated_at), 'MMM d, h:mm a')}` : 'No recent projects'}
        </span>
      </div>

      {recentProject && (
      <a className="border border-white/5 rounded-2xl bg-[#10151A] overflow-hidden grid grid-cols-[240px_1fr] gap-0 text-inherit hover:border-white/10 transition-colors" href={`/editor/${recentProject.id}`} style={{ textDecoration: 'none' }}>
        <div className="relative aspect-[4/3] bg-black overflow-hidden group">
          <div className="absolute inset-0 bg-[#0a0a0b]" style={{ background: generateGradient(recentProject.id) }}></div>
          <div className="absolute left-[20%] top-[30%] w-[40%] h-[55%] rounded-full opacity-90" style={{ background: "radial-gradient(circle at 35% 30%,#d6b592,#6b462a 60%,transparent 85%)" }}></div>
          
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-[#0A0D0F]/50 border border-white/30 grid place-items-center backdrop-blur-sm group-hover:scale-105 transition-transform">
            <svg width="16" height="16" viewBox="0 0 24 24"><path d="M8 5l12 7-12 7V5z" fill="#fff"></path></svg>
          </div>
          <div className="absolute left-3 bottom-[18px] font-mono text-[10px] text-white/70 tracking-widest">{recentProject.length || '00:00'}</div>
          <div className="absolute left-3 right-3 bottom-2.5 h-[3px] bg-white/15 rounded-sm overflow-hidden">
            <div className="block w-[64%] h-full bg-[#14C8CC]"></div>
          </div>
        </div>
        <div className="p-[24px_28px] flex flex-col gap-2.5">
          <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#14C8CC]">{recentProject.project_type || 'CINEMATIC'}</div>
          <h3 className="font-serif font-medium text-[26px] m-0 tracking-tight leading-[1.15]">{recentProject.title || 'Untitled Project'}</h3>
          <p className="text-[14px] text-[#8A9198] leading-[1.55] m-0 max-w-[50ch]">
            {recentProject.description || "A project in your workspace."}
          </p>
          <div className="flex gap-5 mt-auto pt-4 border-t border-white/5">
            <div className="flex flex-col gap-0.5"><span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Duration</span><span className="font-serif text-[17px] text-[#ECEAE4]">{recentProject.length || '00:00'}</span></div>
            <div className="flex flex-col gap-0.5"><span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Language</span><span className="font-serif text-[17px] text-[#ECEAE4]">English</span></div>
            <div className="flex flex-col gap-0.5"><span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Format</span><span className="font-serif text-[17px] text-[#ECEAE4]">{recentProject.format || '16:9'}</span></div>
            <div className="flex flex-col gap-0.5"><span className="font-mono text-[10px] tracking-widest uppercase text-[#5A6268]">Voice</span><span className="font-serif text-[17px] text-[#ECEAE4]">{recentProject.voice_name || 'Default'}</span></div>
          </div>
          <div className="flex gap-2.5 mt-4">
            <span className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]">Resume editing +</span>
          </div>
        </div>
      </a>
      )}

      <div className="flex items-baseline justify-between mt-9 mb-3.5">
        <h2 className="font-serif font-medium text-[20px] tracking-tight m-0">Recent projects</h2>
      </div>

      <div className="grid grid-cols-4 gap-3.5">
        {galleryProjects.map(proj => (
          <a key={proj.id} className="relative rounded-xl overflow-hidden border border-white/5 bg-[#10151A] flex flex-col hover:-translate-y-0.5 hover:border-white/10 transition-all group" href={`/editor/${proj.id}`} style={{ textDecoration: 'none' }}>
            <div className="relative aspect-[4/5] overflow-hidden bg-black">
              {proj.thumbnail_url ? (
                <img src={proj.thumbnail_url} alt={proj.title} className="absolute inset-0 w-full h-full object-cover opacity-70 group-hover:opacity-90 transition-opacity" />
              ) : (
                <div className="absolute inset-0" style={{ background: generateGradient(proj.id) }}></div>
              )}
              <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9.5px] font-mono tracking-wider text-white/85 bg-black/55 backdrop-blur-sm border border-white/10">{proj.project_type || 'PROJ'}</div>
              <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[9.5px] font-mono tracking-widest text-white bg-black/60">{proj.length || '00:00'}</div>
            </div>
            <div className="p-[12px_14px_14px]">
              <div className="text-[13.5px] font-medium text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">{proj.title || 'Untitled'}</div>
              <div className="font-mono text-[10px] text-[#8A9198] tracking-widest mt-1 flex gap-2">
                {format(new Date(proj.created_at), 'MMM d')}<span className="text-white/20">-</span>{proj.status}
              </div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}