import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Bell, CheckCircle2, XCircle, Inbox } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';

/** Per-user localStorage key for the last-seen notification timestamp.
 *  Kept flat (no JSON) because it's a single ISO string. */
function lastSeenKey(userId: string): string {
  return `mm_notifications_last_seen_${userId}`;
}

type NotificationRow = {
  id: string;
  status: string | null;
  project_id: string | null;
  created_at: string;
  completed_at: string | null;
  projects?: { title: string | null } | null;
};

export default function NotificationsPopover() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string>(() => {
    if (!user) return new Date(0).toISOString();
    return localStorage.getItem(lastSeenKey(user.id)) ?? new Date(0).toISOString();
  });

  const { data: notifications = [] } = useQuery<NotificationRow[]>({
    queryKey: ['notifications', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('generations')
        .select('id,status,project_id,created_at,completed_at,projects(title)')
        .eq('user_id', user!.id)
        .in('status', ['complete', 'completed', 'done', 'failed', 'error'])
        .gte('completed_at', since)
        .order('completed_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as NotificationRow[];
    },
  });

  // Realtime: any generation flipping to complete/failed triggers refetch.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`notifications_${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'generations', filter: `user_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey: ['notifications', user.id] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient, user]);

  const unreadCount = useMemo(() => {
    const lastSeenMs = new Date(lastSeen).getTime();
    return notifications.filter((n) => {
      const ts = n.completed_at ?? n.created_at;
      return new Date(ts).getTime() > lastSeenMs;
    }).length;
  }, [notifications, lastSeen]);

  const markAllRead = () => {
    if (!user) return;
    const now = new Date().toISOString();
    localStorage.setItem(lastSeenKey(user.id), now);
    setLastSeen(now);
  };

  const handleOpen = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) markAllRead();
  };

  const openProject = (projectId: string | null) => {
    if (!projectId) return;
    setOpen(false);
    navigate(`/app/editor/${projectId}`);
  };

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative w-11 h-11 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors"
          style={{ touchAction: 'manipulation' }}
          title="Notifications"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-[#E4C875] text-[#0A0D0F] text-[9px] font-semibold grid place-items-center border border-[#0A0D0F]">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[90vw] max-w-[340px] p-0 bg-[#10151A] border-white/10 text-[#ECEAE4]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="font-serif text-[15px] font-medium">Notifications</div>
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="font-mono text-[10px] tracking-wider uppercase text-[#14C8CC] hover:text-[#ECEAE4] transition-colors"
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Inbox className="w-6 h-6 text-[#5A6268] mx-auto mb-2" />
              <div className="text-[12.5px] text-[#8A9198]">No notifications yet</div>
              <div className="text-[11px] text-[#5A6268] mt-1">We'll ping you when a render finishes or fails.</div>
            </div>
          ) : (
            notifications.map((n) => {
              const failed = (n.status ?? '').toLowerCase() === 'failed' || (n.status ?? '').toLowerCase() === 'error';
              const ts = n.completed_at ?? n.created_at;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openProject(n.project_id)}
                  className="w-full text-left px-4 py-3 flex items-start gap-2.5 hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0"
                >
                  {failed
                    ? <XCircle className="w-4 h-4 text-[#E4C875] shrink-0 mt-0.5" />
                    : <CheckCircle2 className="w-4 h-4 text-[#14C8CC] shrink-0 mt-0.5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-[#ECEAE4] truncate">
                      {failed ? 'Render failed' : 'Render complete'}
                      {' · '}
                      <span className="text-[#8A9198]">{n.projects?.title?.trim() || 'Untitled project'}</span>
                    </div>
                    <div className="font-mono text-[10px] text-[#5A6268] tracking-wider mt-0.5">
                      {formatDistanceToNow(new Date(ts), { addSuffix: true })}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
