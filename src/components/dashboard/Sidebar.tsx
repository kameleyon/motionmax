import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Settings as SettingsIcon, History, Shield, Sun, Moon, LogOut } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type SidebarProject = {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  updated_at: string;
};

export default function Sidebar() {
  const queryClient = useQueryClient();
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdminAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce the query term so we don't hammer Supabase on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name, avatar_url')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      return data;
    },
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
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      return data || { plan_name: 'Free' };
    },
  });

  const { data: credits } = useQuery({
    queryKey: ['credits', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_credits')
        .select('credits_balance')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      return data || { credits_balance: 0 };
    },
  });

  // Recent projects for this user, with thumbnail fallback from first
  // scene image when thumbnail_url is null. Mirrors the fallback logic
  // in the old Dashboard so we don't flash gradient placeholders for
  // projects that actually have generated images.
  const { data: recentProjects = [] } = useQuery<SidebarProject[]>({
    queryKey: ['sidebar-recent-projects', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: projs, error } = await supabase
        .from('projects')
        .select('id,title,thumbnail_url,updated_at')
        .eq('user_id', user!.id)
        .order('updated_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      if (!projs?.length) return [];

      const missing = projs.filter((p) => !p.thumbnail_url).map((p) => p.id);
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

      return projs.map((p) => ({
        ...p,
        thumbnail_url: p.thumbnail_url ?? fromScenes[p.id] ?? null,
      })) as SidebarProject[];
    },
  });

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`sidebar_projects_${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'projects', filter: `user_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey: ['sidebar-recent-projects', user.id] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient, user]);

  // Server-side search — only runs while the user is typing (2+ chars).
  // Below 2 chars we fall back to the preloaded recent list.
  const { data: searchResults = [], isFetching: isSearching } = useQuery<SidebarProject[]>({
    queryKey: ['sidebar-search-projects', user?.id, debouncedSearch],
    enabled: !!user && debouncedSearch.length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('id,title,thumbnail_url,updated_at')
        .eq('user_id', user!.id)
        .ilike('title', `%${debouncedSearch}%`)
        .order('updated_at', { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []) as SidebarProject[];
    },
  });

  const filteredProjects = useMemo(() => {
    if (debouncedSearch.length >= 2) return searchResults;
    if (debouncedSearch.length === 1) {
      const q = debouncedSearch.toLowerCase();
      return recentProjects.filter((p) => (p.title ?? '').toLowerCase().includes(q)).slice(0, 6);
    }
    return recentProjects.slice(0, 4);
  }, [debouncedSearch, recentProjects, searchResults]);

  const generateGradient = (id: string) => {
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = hash % 360;
    return `radial-gradient(60% 70% at 50% 50%, hsl(${hue}, 40%, 30%), hsl(${hue}, 60%, 10%) 70%, #05030a)`;
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success('Signed out');
      navigate('/');
    } catch {
      toast.error('Sign out failed. Please try again.');
    }
  };

  return (
    <aside className="w-[252px] bg-[#10151A] border-r border-white/5 hidden md:flex flex-col overflow-hidden shrink-0">
      {/* Brand — lightning icon + "Motion" aqua + "Max" gold */}
      <div className="flex items-center gap-2.5 px-5 py-[18px] border-b border-white/5">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="mm-brand" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#14C8CC" />
              <stop offset="100%" stopColor="#E4C875" />
            </linearGradient>
          </defs>
          <path d="M2 12h4l3-9 5 18 3-9h5" stroke="url(#mm-brand)" />
        </svg>
        <span className="font-serif text-[22px] font-medium tracking-tight leading-none">
          <span className="text-[#14C8CC]">Motion</span>
          <span className="text-[#E4C875]">Max</span>
        </span>
      </div>

      {/* Search */}
      <div className="p-[14px_16px] border-b border-white/5">
        <div className="flex items-center gap-2 px-3 py-2 bg-[#151B20] border border-white/5 rounded-lg font-mono text-[11px] text-[#5A6268]">
          <svg className="w-3.5 h-3.5 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects…"
            className="flex-1 bg-transparent border-0 outline-none text-[#ECEAE4] font-sans text-[13px]"
          />
          {search === '' && (
            <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">⌘K</kbd>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2.5 scrollbar-thin scrollbar-thumb-white/10">
        {/* Studio nav */}
        <div className="mb-5">
          <a href="/dashboard-new" className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] bg-[#151B20] text-[#ECEAE4] cursor-pointer relative before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:bg-[#14C8CC] before:rounded-full" style={{ textDecoration: 'none' }}>
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            Studio
          </a>
          <a href="/app/create" className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors" style={{ textDecoration: 'none' }}>
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
            Create
            <svg className="ml-auto opacity-50 w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
          </a>
          <div className="pl-4 flex flex-col gap-px mt-1">
            <a href="/app/create?mode=cinematic" className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors" style={{ textDecoration: 'none' }}>
              <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3V9z" fill="currentColor" /></svg>
              Cinematic <span className="ml-auto font-mono text-[9px] tracking-wide px-1.5 py-0.5 rounded bg-[#14C8CC]/10 text-[#14C8CC]">NEW</span>
            </a>
            <a href="/app/create?mode=doc2video" className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors" style={{ textDecoration: 'none' }}>
              <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5M9 14h6" /></svg>
              Explainer
            </a>
            <a href="/app/create?mode=smartflow" className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors" style={{ textDecoration: 'none' }}>
              <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" /></svg>
              Smart Flow
            </a>
          </div>
          <a href="/voice-lab" className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors mt-1" style={{ textDecoration: 'none' }}>
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 4v16M16 4v16M4 8h4M16 8h4M4 16h4M16 16h4" /></svg>
            Voice Lab
          </a>
          <a href="/projects" className="flex items-center gap-2.5 px-3 py-2 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors" style={{ textDecoration: 'none' }}>
            <svg className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>
            All projects
          </a>
        </div>

        {/* Recent / Search results */}
        <div className="mb-5">
          <h6 className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mx-3 mb-1.5 font-medium">
            {debouncedSearch.length >= 2
              ? (isSearching ? 'Searching…' : `Results (${filteredProjects.length})`)
              : search.trim()
                ? `Results (${filteredProjects.length})`
                : 'Recent'}
          </h6>
          {filteredProjects.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[#5A6268] italic">
              {debouncedSearch.length >= 2 && !isSearching ? 'No matches' : search.trim() ? 'No matches' : 'No projects yet'}
            </div>
          ) : (
            filteredProjects.map((item) => (
              <a
                href={`/app/create?project=${item.id}`}
                key={item.id}
                className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer hover:bg-[#151B20] transition-colors"
                style={{ textDecoration: 'none' }}
              >
                <div className="w-7 h-7 rounded-[5px] shrink-0 border border-white/5 relative overflow-hidden" style={{ background: generateGradient(item.id) }}>
                  {item.thumbnail_url && (
                    <img
                      src={item.thumbnail_url}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">{item.title || 'Untitled'}</div>
                  <div className="font-mono text-[9.5px] text-[#5A6268] tracking-widest">{format(new Date(item.updated_at), 'MMM d')}</div>
                </div>
              </a>
            ))
          )}
        </div>
      </nav>

      {/* Profile footer with dropdown — mirrors AppSidebar options */}
      <div className="px-4 py-3.5 border-t border-white/5 flex items-center gap-2.5">
        {profile?.avatar_url ? (
          <img src={profile.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE] grid place-items-center font-serif font-semibold text-[14px] text-[#0A0D0F]">
            {(profile?.display_name || user?.email || '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">
            {profile?.display_name || user?.email || 'User'}
          </div>
          <div className="font-mono text-[10px] text-[#5A6268] tracking-wider uppercase">
            {subscription?.plan_name || 'Free'} · {Math.floor((credits?.credits_balance || 0) / 1000)}k
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              title="Account menu"
              className="opacity-60 hover:opacity-100 transition-opacity text-[#ECEAE4] p-1 rounded-md hover:bg-white/5"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-56 rounded-xl border-border/50 shadow-sm">
            <DropdownMenuItem className="cursor-pointer rounded-lg" onClick={() => navigate('/settings')}>
              <SettingsIcon className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer rounded-lg" onClick={() => navigate('/usage')}>
              <History className="mr-2 h-4 w-4" />
              <span>Usage &amp; Billing</span>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem className="cursor-pointer rounded-lg" onClick={() => navigate('/admin')}>
                <Shield className="mr-2 h-4 w-4" />
                <span>Admin</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="bg-border/50" />
            <DropdownMenuItem
              className="cursor-pointer rounded-lg"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              <Sun className="mr-2 h-4 w-4 dark:hidden" />
              <Moon className="mr-2 hidden h-4 w-4 dark:block" />
              <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border/50" />
            <DropdownMenuItem className="cursor-pointer rounded-lg" onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log Out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
