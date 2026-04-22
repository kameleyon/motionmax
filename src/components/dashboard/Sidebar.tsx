import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

export default function Sidebar() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name, avatar_url')
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data;
    }
  });

  const { data: subscription } = useQuery({
    queryKey: ['subscription', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('plan_name')
        .eq('user_id', user!.id)
        .eq('status', 'active')
        .single();
      if (error && error.code !== 'PGRST116') throw error;
      return data || { plan_name: 'Free' };
    }
  });

  const { data: credits } = useQuery({
    queryKey: ['credits', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_credits')
        .select('credits_balance')
        .eq('user_id', user!.id)
        .single();
      if (error && error.code !== 'PGRST116') throw error;
      return data || { credits_balance: 0 };
    }
  });

  const { data: recentProjects = [] } = useQuery({
    queryKey: ['sidebar-recent-projects', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      return data;
    }
  });

  useEffect(() => {
    const channel = supabase
      .channel('sidebar_projects_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => {
        queryClient.invalidateQueries({ queryKey: ['sidebar-recent-projects', user?.id] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const generateGradient = (id) => {
    if (!id) return '#10151A';
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = hash % 360;
    return `radial-gradient(60% 70% at 50% 50%, hsl(${hue}, 40%, 30%), hsl(${hue}, 60%, 10%) 70%, #05030a)`;
  };

  return (
    <aside className="w-[252px] bg-[#10151A] border-r border-white/5 hidden md:flex flex-col overflow-hidden shrink-0">
      <div className="flex items-center gap-2.5 px-5 py-[18px] border-b border-white/5">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#14C8CC" strokeWidth="2"><path d="M2 12h4l3-9 5 18 3-9h5"/></svg>
        <span className="font-serif text-[17px] font-medium tracking-tight">
          <b className="text-[#14C8CC] font-medium">Motion</b><i className="text-[#14C8CC] not-italic font-medium">Max</i>
        </span>
      </div>

      <div className="p-[14px_16px] border-b border-white/5">
        <div className="flex items-center gap-2 px-3 py-2 bg-[#151B20] border border-white/5 rounded-lg font-mono text-[11px] text-[#5A6268]">
          <svg className="w-3.5 h-3.5 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
          <input placeholder="Search projects…" className="flex-1 bg-transparent border-0 outline-none text-[#ECEAE4] font-sans text-[13px]" />
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">⌘K</kbd>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2.5 scrollbar-thin scrollbar-thumb-white/10">
        <div className="mb-5">
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] bg-[#151B20] text-[#ECEAE4] cursor-pointer relative before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:bg-[#14C8CC] before:rounded-full">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12l9-8 9 8"></path><path d="M5 10v10h14V10"></path></svg>
            Studio
          </div>
          <a href="/editor" className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors" style={{ textDecoration: 'none' }}>
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14"></path></svg>
            Create
            <svg className="ml-auto opacity-50 w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"></path></svg>
          </a>
          <div className="pl-4 flex flex-col gap-px mt-1">
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
              <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M10 9l5 3-5 3V9z" fill="currentColor"></path></svg>
              Cinematic <span className="ml-auto font-mono text-[9px] tracking-wide px-1.5 py-0.5 rounded bg-[#14C8CC]/10 text-[#14C8CC]">NEW</span>
            </div>
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
              <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path><path d="M14 3v5h5M9 14h6"></path></svg>
              Explainer
            </div>
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
              <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"></path></svg>
              Smart Flow
            </div>
          </div>
        </div>

        <div className="mb-5">
          <h6 className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mx-3 mb-1.5 font-medium">Tools</h6>
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors mt-1">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 4v16M16 4v16M4 8h4M16 8h4M4 16h4M16 16h4"></path></svg>
            Voice Lab
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="3"></circle><circle cx="6" cy="16" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
            Brand kits
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
            Templates
          </div>
        </div>

        <div className="mb-5">
          <h6 className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mx-3 mb-1.5 font-medium">Recent</h6>
          {recentProjects.map((item) => (
            <div key={item.id} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer hover:bg-[#151B20] transition-colors">
              <div className="w-7 h-7 rounded-[5px] shrink-0 border border-white/5 relative overflow-hidden" style={{ background: generateGradient(item.id) }}></div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">{item.title || 'Untitled'}</div>
                <div className="font-mono text-[9.5px] text-[#5A6268] tracking-widest">{format(new Date(item.updated_at), 'MMM d')}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mb-5">
          <h6 className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mx-3 mb-1.5 font-medium">Pinned</h6>
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2v8M8 10h8l-1 6h-6l-1-6zM12 16v6"></path></svg>
            35mm — origin story
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2v8M8 10h8l-1 6h-6l-1-6zM12 16v6"></path></svg>
            Brand reel · Q2
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path></svg>
            All projects
            <span className="ml-auto font-mono text-[9px] tracking-wide px-1.5 py-0.5 rounded bg-white/5 text-[#8A9198]">142</span>
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors">
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Trash
          </div>
        </div>
      </nav>

      <div className="px-4 py-3.5 border-t border-white/5 flex items-center gap-2.5">
        {profile?.avatar_url ? (
          <img src={profile.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#14C8CC] to-[#14C8CC] grid place-items-center font-serif font-semibold text-[14px] text-[#0A0D0F]">
            {(profile?.display_name || user?.email || 'J').charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-[#ECEAE4]">{profile?.display_name || user?.email || 'User'}</div>
          <div className="font-mono text-[10px] text-[#5A6268] tracking-wider uppercase">{subscription?.plan_name || 'Free'} • {Math.floor((credits?.credits_balance || 0) / 1000)}k</div>
        </div>
        <a href="/settings"><svg className="opacity-50 cursor-pointer hover:opacity-100 transition-opacity w-4 h-4 text-[#ECEAE4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg></a>
      </div>
    </aside>
  );
}