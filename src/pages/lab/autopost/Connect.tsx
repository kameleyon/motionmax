/**
 * Connect platforms — `/lab/autopost/connect`
 *
 * One card per supported platform (YouTube, Instagram, TikTok). Each
 * card lists the admin's already-connected accounts (from
 * `autopost_social_accounts`, RLS-gated to `auth.uid()`), surfaces a
 * CTA that bounces through the Vercel-hosted OAuth-start endpoint, and
 * lets the admin disconnect an account via DELETE on the matching API
 * route.
 *
 * The TikTok card additionally reads `app_settings.autopost_tiktok_audit_status`
 * so we can warn the admin that any post will publish privately until
 * audit completes.
 */

import { Helmet } from "react-helmet-async";
import { Youtube, Instagram, AlertTriangle, Plus, Loader2, Trash2, ShieldCheck } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { LabLayout } from "../_LabLayout";
import { TikTokIcon, type AutopostPlatform, formatRelativeTime, PLATFORM_LABEL } from "./_utils";

interface ConnectedAccount {
  id: string;
  platform: AutopostPlatform;
  display_name: string;
  avatar_url: string | null;
  status: string;
  connected_at: string;
}

interface PlatformDef {
  id: AutopostPlatform;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  guidance?: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "youtube",
    name: "YouTube",
    description: "Upload as a Short or full video to a channel you own.",
    icon: Youtube,
  },
  {
    id: "instagram",
    name: "Instagram",
    description: "Publish to a Business account as a Reel.",
    icon: Instagram,
    guidance: "Must be a Business account, not a Creator account. Connect via your linked Facebook Page.",
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "Direct Post to a creator account.",
    icon: TikTokIcon,
  },
];

async function fetchAccounts(): Promise<ConnectedAccount[]> {
  const { data, error } = await supabase
    .from("autopost_social_accounts")
    .select("id, platform, display_name, avatar_url, status, connected_at")
    .order("connected_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ConnectedAccount[];
}

async function fetchTikTokAuditStatus(): Promise<string | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "autopost_tiktok_audit_status")
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  // The value is jsonb — could be a bare string ("pending") or {status:"pending"}.
  const v = data.value as unknown;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "status" in v && typeof (v as { status: unknown }).status === "string") {
    return (v as { status: string }).status;
  }
  return null;
}

async function getJwt(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "connected"
    ? "bg-[#11C4D0]/15 text-[#11C4D0] border-[#11C4D0]/30"
    : status === "expired"
    ? "bg-[#E4C875]/15 text-[#E4C875] border-[#E4C875]/30"
    : "bg-red-500/15 text-red-400 border-red-500/30";
  return (
    <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${tone}`}>
      {status}
    </Badge>
  );
}

function AccountRow({
  account,
  onDisconnect,
  busyId,
}: {
  account: ConnectedAccount;
  onDisconnect: (id: string) => void;
  busyId: string | null;
}) {
  const initials = account.display_name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const isBusy = busyId === account.id;

  return (
    <div className="flex items-center gap-3 rounded-md border border-white/8 bg-black/20 px-3 py-2.5">
      <Avatar className="h-9 w-9 shrink-0">
        {account.avatar_url && <AvatarImage src={account.avatar_url} alt={account.display_name} />}
        <AvatarFallback className="bg-[#11C4D0]/15 text-[11px] font-medium text-[#11C4D0]">
          {initials || "?"}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[13px] font-medium text-[#ECEAE4]">{account.display_name}</span>
          <StatusPill status={account.status} />
        </div>
        <p className="text-[11px] text-[#5A6268]">Connected {formatRelativeTime(account.connected_at)}</p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isBusy}
            className="shrink-0 text-[#8A9198] hover:text-red-400 hover:bg-red-500/10"
            aria-label={`Disconnect ${account.display_name}`}
          >
            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {account.display_name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              Schedules targeting this account will fail to publish until you reconnect. Existing
              published posts stay live on {PLATFORM_LABEL[account.platform]}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onDisconnect(account.id)}
              className="bg-red-500 text-white hover:bg-red-500/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function Connect() {
  const queryClient = useQueryClient();

  const accountsQuery = useQuery({
    queryKey: ["autopost-accounts"],
    queryFn: fetchAccounts,
  });

  const tiktokStatusQuery = useQuery({
    queryKey: ["autopost-tiktok-audit-status"],
    queryFn: fetchTikTokAuditStatus,
    staleTime: 5 * 60 * 1000,
  });

  const disconnectMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const jwt = await getJwt();
      if (!jwt) throw new Error("Not signed in");
      const res = await fetch(`/api/autopost/accounts/${accountId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Disconnect failed (${res.status})`);
      }
      return accountId;
    },
    onSuccess: () => {
      toast.success("Account disconnected");
      void queryClient.invalidateQueries({ queryKey: ["autopost-accounts"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Disconnect failed";
      toast.error(message);
    },
  });

  const handleConnect = async (platform: AutopostPlatform) => {
    const jwt = await getJwt();
    if (!jwt) {
      toast.error("Session expired — please sign in again");
      return;
    }
    // Hand off to the Vercel function. We pass the JWT as a query
    // param because the browser navigation can't set Authorization on
    // a top-level GET. `requireAdmin` accepts either form.
    window.location.href = `/api/autopost/connect/${platform}/start?token=${encodeURIComponent(jwt)}`;
  };

  const accounts = accountsQuery.data ?? [];
  const accountsByPlatform = (platform: AutopostPlatform) =>
    accounts.filter((a) => a.platform === platform);

  const tiktokAuditPending = tiktokStatusQuery.data === "pending";

  return (
    <LabLayout
      heading="Connect accounts"
      title="Connect · Autopost · Lab"
      description="Link the social platforms Autopost can publish to. One row per connected account."
      breadcrumbs={[
        { label: "Autopost", to: "/lab/autopost" },
        { label: "Connect" },
      ]}
    >
      <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLATFORMS.map((p) => {
          const Icon = p.icon;
          const platformAccounts = accountsByPlatform(p.id);
          const isLoading = accountsQuery.isLoading;
          const isBusyId = disconnectMutation.isPending ? disconnectMutation.variables ?? null : null;

          return (
            <Card key={p.id} className="bg-[#10151A] border-white/8 flex flex-col">
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
                    <Icon className="h-5 w-5 text-[#11C4D0]" />
                  </div>
                  {platformAccounts.length > 0 && (
                    <Badge variant="outline" className="border-[#11C4D0]/30 bg-[#11C4D0]/10 text-[#11C4D0]">
                      {platformAccounts.length} connected
                    </Badge>
                  )}
                </div>
                <div>
                  <CardTitle className="text-[#ECEAE4] text-base">{p.name}</CardTitle>
                  <CardDescription className="text-[#8A9198] mt-1.5">
                    {p.description}
                  </CardDescription>
                </div>
              </CardHeader>

              <CardContent className="flex-1 space-y-3">
                {p.id === "tiktok" && tiktokAuditPending && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-[#E4C875]/30 bg-[#E4C875]/10 px-3 py-2 text-[12px] text-[#E4C875]"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      TikTok audit pending — posts will publish privately (Self-Only) until approval clears.
                    </span>
                  </div>
                )}

                {p.id === "instagram" && p.guidance && (
                  <div className="flex items-start gap-2 rounded-md border border-white/8 bg-black/20 px-3 py-2 text-[12px] text-[#8A9198]">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#11C4D0]" />
                    <span>{p.guidance}</span>
                  </div>
                )}

                {isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-12 w-full bg-white/5" />
                    <Skeleton className="h-12 w-full bg-white/5" />
                  </div>
                ) : platformAccounts.length === 0 ? (
                  <div className="rounded-md border border-dashed border-white/10 bg-black/20 px-3 py-4 text-center text-[12px] text-[#5A6268]">
                    No {p.name} {p.id === "youtube" ? "channels" : "accounts"} connected.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {platformAccounts.map((acc) => (
                      <AccountRow
                        key={acc.id}
                        account={acc}
                        onDisconnect={(id) => disconnectMutation.mutate(id)}
                        busyId={isBusyId}
                      />
                    ))}
                  </div>
                )}

                <Button
                  type="button"
                  onClick={() => handleConnect(p.id)}
                  variant="outline"
                  className="w-full border-[#11C4D0]/40 bg-transparent text-[#ECEAE4] hover:bg-[#11C4D0]/10 hover:text-[#11C4D0]"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  {platformAccounts.length > 0 ? "Connect another" : `Connect ${p.name}`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </LabLayout>
  );
}
