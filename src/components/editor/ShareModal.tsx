import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Check, Link as LinkIcon, X, Loader2 } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** Share modal for the Editor. Reuses the `project_shares` table and
 *  /share/:token route the dashboard already uses (see
 *  src/pages/Projects.tsx for the identical pattern). Opens empty,
 *  then loads / creates the token in the background. Mobile: dialog
 *  content fills the viewport via the shared Dialog primitive. */
export default function ShareModal({
  open,
  onOpenChange,
  projectId,
  projectType,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  projectType: string | null;
}) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !user || !projectId) return;

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const { data: existing } = await supabase
          .from('project_shares')
          .select('share_token')
          .eq('project_id', projectId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (cancelled) return;

        if (existing?.share_token) {
          setUrl(`${window.location.origin}/share/${existing.share_token}`);
        } else {
          const token = crypto.randomUUID().replace(/-/g, '');
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const { error } = await supabase.from('project_shares').insert({
            project_id: projectId,
            user_id: user.id,
            share_token: token,
            expires_at: expiresAt,
          });
          if (error) throw error;
          if (cancelled) return;
          setUrl(`${window.location.origin}/share/${token}`);
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Couldn't create share link: ${msg}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, user, projectId]);

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Link copied');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Copy failed — select the link manually');
    }
  };

  const handleRevoke = async () => {
    if (!user || !projectId) return;
    setLoading(true);
    try {
      await supabase.from('project_shares').delete().eq('project_id', projectId).eq('user_id', user.id);
      setUrl(null);
      toast.success('Share link revoked');
      onOpenChange(false);
    } catch {
      toast.error('Failed to revoke share link');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] w-[calc(100%-2rem)] max-w-md p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div>
            <div className="font-serif text-[16px] font-medium text-[#ECEAE4]">Share this video</div>
            <div className="text-[11.5px] text-[#8A9198] mt-0.5">
              Anyone with the link can watch for 30 days. {projectType === 'cinematic' ? 'Cinematic' : projectType === 'smartflow' ? 'Smart Flow' : 'Explainer'} project.
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="w-7 h-7 rounded-md grid place-items-center text-[#8A9198] hover:bg-white/5"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 min-w-0">
          {loading && !url ? (
            <div className="flex items-center gap-2 px-3 py-3 rounded-lg border border-white/5 bg-[#1B2228]">
              <Loader2 className="w-4 h-4 animate-spin text-[#14C8CC]" />
              <span className="text-[12.5px] text-[#8A9198]">Generating link…</span>
            </div>
          ) : url ? (
            // flex + min-w-0 on BOTH children so the long URL actually
            // truncates instead of pushing the Copy button off-screen.
            // The link chip is flex-1 min-w-0 (it shrinks); Copy is
            // shrink-0 (always visible, always tappable).
            <div className="flex items-stretch gap-2 w-full min-w-0">
              <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-lg border border-white/5 bg-[#1B2228] overflow-hidden">
                <LinkIcon className="w-3.5 h-3.5 text-[#14C8CC] shrink-0" />
                <span className="font-mono text-[11.5px] text-[#ECEAE4] truncate min-w-0 flex-1">{url}</span>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] text-[12px] hover:bg-[#14C8CC]/20 transition-colors shrink-0 whitespace-nowrap"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : null}

          <div className="flex items-center justify-between text-[11px] font-mono text-[#5A6268] tracking-wider">
            <span className="uppercase">Expires in 30 days</span>
            {url && (
              <button
                type="button"
                onClick={handleRevoke}
                disabled={loading}
                className="uppercase text-[#E66666] hover:text-[#F27B7B] disabled:opacity-50"
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
