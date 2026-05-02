import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Settings as SettingsIcon, History, Shield, LogOut, Video, FlaskConical } from 'lucide-react';
import motionmaxLogo from '@/assets/motionmax-logo.webp';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce the query term so we don't hammer Supabase on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  // Global Cmd/Ctrl+K binding to open the search modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // Modal search — queries full library when the modal is open. Under 1
  // char, we show the user's 20 most-recent projects as a "Recent" list.
  const { data: searchResults = [], isFetching: isSearching } = useQuery<SidebarProject[]>({
    queryKey: ['sidebar-search-projects', user?.id, debouncedSearch],
    enabled: !!user && searchOpen,
    queryFn: async () => {
      let q = supabase
        .from('projects')
        .select('id,title,thumbnail_url,updated_at')
        .eq('user_id', user!.id)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (debouncedSearch.length >= 1) {
        q = q.ilike('title', `%${debouncedSearch}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SidebarProject[];
    },
  });

  // Sidebar "Recent" list — always the 4 most-recent preloaded projects,
  // unaffected by the modal search state.
  const sidebarRecent = recentProjects.slice(0, 4);

  const generateGradient = (id: string) => {
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = hash % 360;
    return `radial-gradient(60% 70% at 50% 50%, hsl(${hue}, 40%, 30%), hsl(${hue}, 60%, 10%) 70%, #05030a)`;
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success('Signed out');
      window.location.href = '/';
    } catch {
      toast.error('Sign out failed. Please try again.');
    }
  };

  return (
    <aside className="w-[252px] bg-[#10151A] border-r border-white/5 hidden md:flex flex-col overflow-hidden shrink-0">
      {/* Brand — real MotionMax logo + "Motion" aqua + "Max" gold wordmark */}
      <a
        href="/dashboard-new"
        className="flex items-center gap-2.5 px-5 py-[18px] border-b border-white/5 hover:bg-white/[0.02] transition-colors no-underline"
      >
        <img src={motionmaxLogo} alt="MotionMax" className="h-7 w-auto shrink-0" />
        <span className="font-serif text-[22px] font-medium tracking-tight leading-none">
          <span className="text-[#14C8CC]">Motion</span>
          <span className="text-[#E4C875]">Max</span>
        </span>
      </a>

      {/* Search — opens a modal (Cmd/Ctrl+K also opens it) */}
      <div className="p-[14px_16px] border-b border-white/5">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-2 bg-[#151B20] border border-white/5 rounded-lg font-mono text-[11px] text-[#5A6268] hover:border-white/10 hover:text-[#8A9198] transition-colors"
          title="Search projects (Ctrl+K)"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span className="flex-1 text-left font-sans text-[13px]">Search projects…</span>
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">⌘K</kbd>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2.5 scrollbar-thin scrollbar-thumb-white/10">
        {/* Studio nav */}
        <div className="mb-5">
          <a href="/dashboard-new" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] bg-[#151B20] text-[#ECEAE4] cursor-pointer relative before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:bg-[#14C8CC] before:rounded-full no-underline">
            <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            Studio
          </a>
          <a href="/app/create/new?mode=cinematic" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
            <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
            Create
            <svg aria-hidden="true" className="ml-auto opacity-50 w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
          </a>
          <div className="pl-4 flex flex-col gap-px mt-1">
            <a href="/app/create/new?mode=cinematic" className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
              <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3V9z" fill="currentColor" /></svg>
              Cinematic <span className="ml-auto font-mono text-[9px] tracking-wide px-1.5 py-0.5 rounded bg-[#14C8CC]/10 text-[#14C8CC]">NEW</span>
            </a>
            <a href="/app/create/new?mode=doc2video" className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
              <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5M9 14h6" /></svg>
              Explainer
            </a>
            <a href="/app/create/new?mode=smartflow" className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
              <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" /></svg>
              Smart Flow
            </a>
          </div>
          {/* Autopost Lab is now visible to every signed-in user. The
              plan gate (free vs Creator+) is handled in-page: free
              users can walk the full setup flow and get the upgrade
              dialog at submit time. The DB-level is_creator_or_studio
              policy is the safety net. */}
          <a href="/lab/autopost" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors mt-1 no-underline">
            <FlaskConical className="w-4 h-4 opacity-85" />
            Autopost Lab
          </a>
          <a href="/voice-lab" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors mt-1 no-underline">
            <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 4v16M16 4v16M4 8h4M16 8h4M4 16h4M16 16h4" /></svg>
            Voice Lab
          </a>
          <a href="/projects" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
            <svg aria-hidden="true" className="w-4 h-4 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>
            All projects
          </a>
        </div>

        <div className="md:hidden mb-5">
          <h6 className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mx-3 mb-1.5 font-medium">
            Account
          </h6>
          <a href="/settings" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
            <SettingsIcon className="w-4 h-4 opacity-85" />
            <span>Settings</span>
          </a>
          <a href="/usage" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
            <History className="w-4 h-4 opacity-85" />
            <span>Usage &amp; Billing</span>
          </a>
          {isAdmin && (
            <a href="/admin" className="flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] cursor-pointer transition-colors no-underline">
              <Shield className="w-4 h-4 opacity-85" />
              <span>Admin</span>
            </a>
          )}
          <div className="bg-white/5 h-px my-1 mx-3" />
          <button onClick={handleSignOut} className="w-full flex items-center gap-2.5 px-3 py-3 my-px rounded-lg text-[13.5px] text-[#E4C875] hover:bg-[#E4C875]/10 cursor-pointer transition-colors no-underline">
            <LogOut className="w-4 h-4 opacity-85" />
            <span>Log Out</span>
          </button>
        </div>

        {/* Recent */}
        <div className="mb-5 hidden md:block">
          <h6 className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mx-3 mb-1.5 font-medium">
            Recent
          </h6>
          {sidebarRecent.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[#5A6268] italic">
              No projects yet
            </div>
          ) : (
            sidebarRecent.map((item) => (
              <a
                href={`/app/create?project=${item.id}`}
                key={item.id}
                className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer hover:bg-[#151B20] transition-colors no-underline"
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

      {/* Profile footer — the whole row is the dropdown trigger so we
          don't need a separate gear icon. Redundancy gone, target is
          larger (better tap affordance on mobile too). */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            // shrink-0 + sticky-footer behaviour: this row must always
            // render at the bottom of the drawer flexbox, never compress.
            // Slightly tighter vertical padding so the avatar + name +
            // plan/tokens line all fit on short mobile viewports without
            // being clipped by the iOS home-indicator safe area.
            className="shrink-0 w-full px-4 py-2.5 border-t border-white/5 flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors"
          >
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
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
            align="end"
            side="top"
            className="w-56 rounded-xl bg-[#10151A] border-white/10 text-[#ECEAE4] shadow-xl mb-4"
          >
            <DropdownMenuItem
              className="cursor-pointer rounded-lg text-[#ECEAE4] focus:bg-white/5 focus:text-[#ECEAE4]"
              onClick={() => navigate('/settings')}
            >
              <SettingsIcon className="mr-2 h-4 w-4 text-[#8A9198]" />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer rounded-lg text-[#ECEAE4] focus:bg-white/5 focus:text-[#ECEAE4]"
              onClick={() => navigate('/usage')}
            >
              <History className="mr-2 h-4 w-4 text-[#8A9198]" />
              <span>Usage &amp; Billing</span>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-[#ECEAE4] focus:bg-white/5 focus:text-[#ECEAE4]"
                onClick={() => navigate('/admin')}
              >
                <Shield className="mr-2 h-4 w-4 text-[#8A9198]" />
                <span>Admin</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem
              className="cursor-pointer rounded-lg text-[#E4C875] focus:bg-[#E4C875]/10 focus:text-[#E4C875]"
              onClick={handleSignOut}
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log Out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      {/* Search modal — opens from the search trigger or Cmd/Ctrl+K.
          Dark palette matches the dashboard shell (#10151A / white borders
          at 5% and 10%). */}
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <div className="bg-[#10151A] text-[#ECEAE4] [&_[cmdk-input-wrapper]]:border-white/10 [&_[cmdk-group-heading]]:text-[#5A6268] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-item]]:text-[#ECEAE4] [&_[cmdk-item][data-selected=true]]:bg-white/5 [&_[cmdk-item][data-selected=true]]:text-[#ECEAE4] [&_[cmdk-empty]]:text-[#5A6268]">
          <CommandInput
            placeholder="Search your projects…"
            value={search}
            onValueChange={setSearch}
            className="text-[#ECEAE4] placeholder:text-[#5A6268]"
          />
          <CommandList>
            <CommandEmpty>{isSearching ? 'Searching…' : 'No projects found.'}</CommandEmpty>
            <CommandGroup heading={debouncedSearch ? 'Matches' : 'Recent'}>
              {searchResults.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.title ?? 'untitled'} ${p.id}`}
                  onSelect={() => {
                    setSearchOpen(false);
                    setSearch('');
                    navigate(`/app/create?project=${p.id}`);
                  }}
                >
                  <Video className="mr-2 h-4 w-4 text-[#8A9198]" />
                  <div className="flex flex-col overflow-hidden">
                    <span className="truncate text-sm font-medium text-[#ECEAE4]">{p.title || 'Untitled'}</span>
                    <span className="text-xs text-[#5A6268]">
                      {format(new Date(p.updated_at), 'MMM d, yyyy')}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </div>
      </CommandDialog>
    </aside>
  );
}
