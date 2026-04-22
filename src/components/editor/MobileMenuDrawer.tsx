import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sun, Moon, LogOut, Settings as SettingsIcon, History, Shield } from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { supabase } from '@/integrations/supabase/client';
import motionmaxLogo from '@/assets/motionmax-logo.png';

/** Full-height mobile navigation drawer for the Editor. Opens from the
 *  topbar hamburger (on phones the MiniSidebar is hidden). Gives users
 *  the same nav links + profile actions they get on desktop, in a
 *  scrollable layout so Log Out is always reachable even on short
 *  viewports. */

const NAV_ITEMS: Array<{ to: string; label: string; icon: JSX.Element }> = [
  {
    to: '/dashboard-new',
    label: 'Studio',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 12l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    to: '/projects',
    label: 'All projects',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9l5 3-5 3V9z" fill="currentColor" />
      </svg>
    ),
  },
  {
    to: '/voice-lab',
    label: 'Voice Lab',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 4v16M16 4v16M4 8h4M16 8h4M4 16h4M16 16h4" />
      </svg>
    ),
  },
];

export default function MobileMenuDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdminAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  const { data: profile } = useQuery({
    queryKey: ['mobile-menu-profile', user?.id],
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
      onOpenChange(false);
      toast.success('Signed out');
      navigate('/');
    } catch {
      toast.error('Sign out failed. Please try again.');
    }
  };

  const close = () => onOpenChange(false);
  const initial = (profile?.display_name || user?.email || '?').charAt(0).toUpperCase();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[280px] p-0 bg-[#10151A] border-white/10 lg:hidden flex flex-col [&>button]:text-[#ECEAE4]"
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-5 py-[18px] border-b border-white/5 shrink-0">
          <img src={motionmaxLogo} alt="MotionMax" className="h-7 w-auto shrink-0" />
          <span className="font-serif text-[20px] font-medium tracking-tight leading-none">
            <span className="text-[#14C8CC]">Motion</span>
            <span className="text-[#E4C875]">Max</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={close}
              style={{ textDecoration: 'none' }}
              className="flex items-center gap-2.5 px-5 py-2.5 text-[14px] text-[#ECEAE4] hover:bg-white/5 transition-colors"
            >
              <span className="text-[#8A9198]">{item.icon}</span>
              {item.label}
            </Link>
          ))}

          <div className="my-2 mx-5 border-t border-white/5" />

          <button
            type="button"
            onClick={() => { navigate('/settings'); close(); }}
            className="w-full flex items-center gap-2.5 px-5 py-2.5 text-[14px] text-[#ECEAE4] hover:bg-white/5 transition-colors text-left"
          >
            <SettingsIcon className="w-4 h-4 text-[#8A9198]" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => { navigate('/usage'); close(); }}
            className="w-full flex items-center gap-2.5 px-5 py-2.5 text-[14px] text-[#ECEAE4] hover:bg-white/5 transition-colors text-left"
          >
            <History className="w-4 h-4 text-[#8A9198]" />
            Usage &amp; Billing
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => { navigate('/admin'); close(); }}
              className="w-full flex items-center gap-2.5 px-5 py-2.5 text-[14px] text-[#ECEAE4] hover:bg-white/5 transition-colors text-left"
            >
              <Shield className="w-4 h-4 text-[#8A9198]" />
              Admin
            </button>
          )}
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="w-full flex items-center gap-2.5 px-5 py-2.5 text-[14px] text-[#ECEAE4] hover:bg-white/5 transition-colors text-left"
          >
            <Sun className="w-4 h-4 text-[#8A9198] dark:hidden" />
            <Moon className="w-4 h-4 text-[#8A9198] hidden dark:block" />
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
        </nav>

        {/* Profile footer with Log Out */}
        <div className="shrink-0 border-t border-white/5 p-4">
          <div className="flex items-center gap-2.5 mb-3">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE] grid place-items-center font-serif font-semibold text-[14px] text-[#0A0D0F]">
                {initial}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-[#ECEAE4] truncate">
                {profile?.display_name || user?.email || 'User'}
              </div>
              <div className="font-mono text-[10px] text-[#5A6268] tracking-wider uppercase truncate">
                {user?.email ?? ''}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[13px] font-semibold text-[#E66666] border border-[#E66666]/30 bg-[#E66666]/5 hover:bg-[#E66666]/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log Out
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
