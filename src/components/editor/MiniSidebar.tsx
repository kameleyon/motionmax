import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sun, Moon, LogOut, Settings as SettingsIcon, History, Shield } from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { supabase } from '@/integrations/supabase/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import motionmaxLogo from '@/assets/motionmax-logo.png';

/** Icon-only 64px sidebar used by the unified Editor. Matches the
 *  design bundle's .side.mini — logo, 5 nav items (Studio / Projects
 *  active / Voices / Characters / Brand kits), profile avatar footer
 *  with the same dropdown as the dashboard sidebar. */

const NAV_ITEMS: Array<{
  to: string;
  label: string;
  icon: JSX.Element;
  active?: boolean;
}> = [
  {
    to: '/dashboard-new',
    label: 'Studio',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 12l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    to: '/projects',
    label: 'Projects',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9l5 3-5 3V9z" fill="currentColor" />
      </svg>
    ),
    active: true,
  },
  {
    to: '/voice-lab',
    label: 'Voices',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 4v16M16 4v16M4 8h4M16 8h4M4 16h4M16 16h4" />
      </svg>
    ),
  },
];

export default function MiniSidebar() {
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdminAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  const { data: profile } = useQuery({
    queryKey: ['mini-sidebar-profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('display_name, avatar_url')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data;
    },
  });

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success('Signed out');
      navigate('/');
    } catch {
      toast.error('Sign out failed. Please try again.');
    }
  };

  const avatarInitial = (profile?.display_name || user?.email || '?').charAt(0).toUpperCase();

  return (
    <aside className="w-[64px] bg-[#10151A] border-r border-white/5 flex flex-col items-center py-4 gap-4 overflow-hidden shrink-0">
      {/* Logo */}
      <Link to="/dashboard-new" className="shrink-0" style={{ textDecoration: 'none' }} aria-label="Home">
        <img src={motionmaxLogo} alt="MotionMax" className="w-8 h-8 object-contain" />
      </Link>

      {/* Nav icons */}
      <nav className="flex flex-col gap-1 flex-1 w-full items-center pt-2">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            title={item.label}
            aria-label={item.label}
            style={{ textDecoration: 'none' }}
            className={
              'w-10 h-10 rounded-lg grid place-items-center transition-colors relative ' +
              (item.active
                ? 'bg-[#151B20] text-[#ECEAE4]'
                : 'text-[#8A9198] hover:text-[#ECEAE4] hover:bg-[#151B20]')
            }
          >
            <span className="w-4 h-4 inline-block">{item.icon}</span>
            {item.active && (
              <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-[#14C8CC] rounded-full" />
            )}
          </Link>
        ))}
      </nav>

      {/* Profile footer */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="shrink-0 w-9 h-9 rounded-full grid place-items-center overflow-hidden hover:ring-2 hover:ring-[#14C8CC]/40 transition-all"
            aria-label="Account menu"
          >
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="w-full h-full grid place-items-center bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] font-serif font-semibold text-[13px]">
                {avatarInitial}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          className="w-56 rounded-xl bg-[#10151A] border-white/10 text-[#ECEAE4] shadow-xl"
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
            className="cursor-pointer rounded-lg text-[#ECEAE4] focus:bg-white/5 focus:text-[#ECEAE4]"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Sun className="mr-2 h-4 w-4 text-[#8A9198] dark:hidden" />
            <Moon className="mr-2 hidden h-4 w-4 text-[#8A9198] dark:block" />
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-white/10" />
          <DropdownMenuItem
            className="cursor-pointer rounded-lg text-[#E66666] focus:bg-[#E66666]/10 focus:text-[#E66666]"
            onClick={handleSignOut}
          >
            <LogOut className="mr-2 h-4 w-4" />
            <span>Log Out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </aside>
  );
}
