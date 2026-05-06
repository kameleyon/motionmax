/**
 * IntegrationsTab — Settings → Integrations
 *
 * Lists the admin's connected social accounts grouped by platform
 * (YouTube / Instagram / TikTok) and exposes Connect / Disconnect
 * actions. This is the long-term "manage them" home; the intake's
 * ScheduleBlock embeds `<ConnectedAccountsList />` (exported from this
 * file) inline so both surfaces show identical data.
 *
 * Data flow:
 * - Accounts come from `autopost_social_accounts`, RLS-gated to the
 *   admin's own rows.
 * - Connect bounces through `GET /api/autopost/connect/{platform}/start`
 *   (Vercel Function) with the user's JWT as a `?token=` query param —
 *   browser navigations can't carry an Authorization header on a
 *   top-level GET.
 * - Disconnect calls `DELETE /api/autopost/accounts/{id}` with a
 *   Bearer token; the function best-effort revokes at the provider
 *   then deletes the row.
 * - TikTok shows a yellow "audit pending" banner when
 *   `app_settings.autopost_tiktok_audit_status` resolves to "pending".
 *   The value is jsonb and can be either a bare string or
 *   `{ status: "pending" }` — we handle both.
 */

import type { JSX } from "react";
import { useState, createElement } from "react";
import { Helmet } from "react-helmet-async";
import {
  Youtube,
  Instagram,
  AlertTriangle,
  Plus,
  Loader2,
  Trash2,
  ShieldCheck,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";

/* ────────────────────────────────────────────────────────────── */
/* Types + helpers                                                */
/* ────────────────────────────────────────────────────────────── */

export type AutopostPlatform = "youtube" | "instagram" | "tiktok";

export interface ConnectedAccount {
  id: string;
  platform: AutopostPlatform;
  display_name: string;
  avatar_url: string | null;
  status: string;
  connected_at: string;
}

const PLATFORM_LABEL: Record<AutopostPlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/**
 * Lucide doesn't ship a TikTok glyph, so we render a small inline SVG
 * sized via `className` (h-4 w-4 etc.) to match Lucide's API.
 */
function TikTokIcon({ className }: { className?: string }): JSX.Element {
  return createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      className,
    },
    createElement("path", {
      d: "M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.27a8.16 8.16 0 0 0 4.77 1.52V6.34a4.85 4.85 0 0 1-1.84.35z",
    }),
  );
}

const REL_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

function formatRelativeTime(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  const diffSec = (d.getTime() - Date.now()) / 1000;
  if (Math.abs(diffSec) < 30) return "Just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let value = diffSec;
  for (const [div, unit] of REL_UNITS) {
    if (Math.abs(value) < div) return rtf.format(Math.round(value), unit);
    value /= div;
  }
  return rtf.format(Math.round(value), "year");
}

/* ────────────────────────────────────────────────────────────── */
/* Data fetchers                                                  */
/* ────────────────────────────────────────────────────────────── */

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
  // jsonb value — bare string ("pending") or { status: "pending" }.
  const v = data.value as unknown;
  if (typeof v === "string") return v;
  if (
    v &&
    typeof v === "object" &&
    "status" in v &&
    typeof (v as { status: unknown }).status === "string"
  ) {
    return (v as { status: string }).status;
  }
  return null;
}

async function getJwt(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/* ────────────────────────────────────────────────────────────── */
/* Platform definitions                                           */
/* ────────────────────────────────────────────────────────────── */

interface PlatformDef {
  id: AutopostPlatform;
  name: string;
  description: string;
  icon: (props: { className?: string }) => JSX.Element;
  guidance?: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "youtube",
    name: "YouTube",
    description: "Upload as a Short or full video to a channel you own.",
    icon: ({ className }) => createElement(Youtube, { className }),
  },
  {
    id: "instagram",
    name: "Instagram",
    description: "Publish to a Business account as a Reel.",
    icon: ({ className }) => createElement(Instagram, { className }),
    guidance:
      "Must be a Business account, not a Creator account. Connect via your linked Facebook Page.",
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "Direct Post to a creator account.",
    icon: TikTokIcon,
  },
];

/* ────────────────────────────────────────────────────────────── */
/* Visual subcomponents                                           */
/* ────────────────────────────────────────────────────────────── */

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "connected"
      ? "bg-[#11C4D0]/15 text-[#11C4D0] border-[#11C4D0]/30"
      : status === "expired"
        ? "bg-[#E4C875]/15 text-[#E4C875] border-[#E4C875]/30"
        : status === "error"
          ? "bg-[#E4C875]/15 text-[#E4C875] border-[#E4C875]/30"
          : "bg-[#E4C875]/15 text-[#E4C875] border-[#E4C875]/30";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] uppercase tracking-wider ${tone}`}
    >
      {status}
    </Badge>
  );
}

function avatarInitials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

interface AccountRowProps {
  account: ConnectedAccount;
  /** Settings mode: shows a Disconnect button. */
  onDisconnect?: (id: string) => void;
  busyId?: string | null;
  /** Intake mode: shows a checkbox so users can pick which accounts a schedule targets. */
  selected?: boolean;
  onToggle?: (id: string) => void;
  compact?: boolean;
}

function AccountRow({
  account,
  onDisconnect,
  busyId,
  selected,
  onToggle,
  compact,
}: AccountRowProps) {
  const isBusy = busyId === account.id;
  const padding = compact ? "px-2.5 py-2" : "px-3 py-2.5";
  const showCheckbox = typeof onToggle === "function";

  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-white/8 bg-black/20 ${padding}`}
    >
      {showCheckbox && (
        <Checkbox
          checked={!!selected}
          onCheckedChange={() => onToggle?.(account.id)}
          aria-label={`Select ${account.display_name}`}
          className="border-white/20 data-[state=checked]:bg-[#11C4D0] data-[state=checked]:text-black data-[state=checked]:border-[#11C4D0]"
        />
      )}
      <Avatar className={compact ? "h-8 w-8 shrink-0" : "h-9 w-9 shrink-0"}>
        {account.avatar_url && (
          <AvatarImage src={account.avatar_url} alt={account.display_name} />
        )}
        <AvatarFallback className="bg-[#11C4D0]/15 text-[11px] font-medium text-[#11C4D0]">
          {avatarInitials(account.display_name) || "?"}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="truncate text-[13px] font-medium text-[#ECEAE4]">
            {account.display_name}
          </span>
          {account.status !== "connected" && (
            <StatusPill status={account.status} />
          )}
        </div>
        <p className="text-[11px] text-[#5A6268]">
          {account.status === "connected" ? "connected" : account.status}{" "}
          {formatRelativeTime(account.connected_at)}
        </p>
      </div>
      {onDisconnect && !showCheckbox && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy}
              className="shrink-0 text-[#8A9198] hover:text-[#E4C875] hover:bg-[#E4C875]/10"
              aria-label={`Disconnect ${account.display_name}`}
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Trash2 className="h-4 w-4 sm:mr-1.5" />
                  <span className="hidden sm:inline">Disconnect</span>
                </>
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="settings-modal-content">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Disconnect {account.display_name}?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[#8A9198]">
                Schedules targeting this account will fail to publish until you
                reconnect. Existing published posts stay live on{" "}
                {PLATFORM_LABEL[account.platform]}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDisconnect(account.id)}
                className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#C9A75A]"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* ConnectedAccountsList — reusable across Settings + intake      */
/* ────────────────────────────────────────────────────────────── */

export interface ConnectedAccountsListProps {
  /** Selection mode (intake): provide selected ids + onToggle. When
   *  omitted, the list renders Disconnect buttons (settings mode). */
  selectedIds?: string[];
  onToggle?: (id: string) => void;
  /** Tighter padding for inline embedding inside the intake's
   *  ScheduleBlock. */
  compact?: boolean;
}

/**
 * Renders the same per-platform account list used inside
 * IntegrationsTab. Settings imports the parent IntegrationsTab; the
 * intake's ScheduleBlock imports this lighter export so both surfaces
 * share a single source of truth.
 *
 * Behaviour:
 * - When `selectedIds` + `onToggle` are provided → "intake mode":
 *   renders a checkbox per account, no Connect/Disconnect.
 * - When omitted → "settings mode": renders Disconnect buttons + a
 *   Connect-another CTA per platform.
 */
export function ConnectedAccountsList({
  selectedIds,
  onToggle,
  compact = false,
}: ConnectedAccountsListProps) {
  const queryClient = useQueryClient();
  const intakeMode = typeof onToggle === "function";

  const accountsQuery = useQuery({
    queryKey: ["autopost-accounts"],
    queryFn: fetchAccounts,
  });

  const tiktokStatusQuery = useQuery({
    queryKey: ["autopost-tiktok-audit-status"],
    queryFn: fetchTikTokAuditStatus,
    staleTime: 5 * 60 * 1000,
  });

  const [pendingConnect, setPendingConnect] = useState<AutopostPlatform | null>(
    null,
  );

  const disconnectMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const jwt = await getJwt();
      if (!jwt) throw new Error("Not signed in");
      const res = await fetch(`/api/autopost/accounts/${accountId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
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
    setPendingConnect(platform);
    try {
      const jwt = await getJwt();
      if (!jwt) {
        toast.error("Session expired — please sign in again");
        return;
      }
      // Top-level navigation: JWT must ride as a query param because
      // browsers can't set Authorization on a GET navigation.
      window.location.href = `/api/autopost/connect/${platform}/start?token=${encodeURIComponent(
        jwt,
      )}`;
    } finally {
      // We're navigating away, but in case of an error fallback we
      // still want the spinner to stop on a re-render.
      setPendingConnect(null);
    }
  };

  const accounts = accountsQuery.data ?? [];
  const accountsByPlatform = (platform: AutopostPlatform) =>
    accounts.filter((a) => a.platform === platform);

  const tiktokAuditPending = tiktokStatusQuery.data === "pending";
  const isLoading = accountsQuery.isLoading;
  const busyId = disconnectMutation.isPending
    ? (disconnectMutation.variables ?? null)
    : null;

  return (
    <div className={`grid grid-cols-1 ${compact ? "" : "md:grid-cols-3"} gap-4`}>
      {PLATFORMS.map((p) => {
        const Icon = p.icon;
        const platformAccounts = accountsByPlatform(p.id);

        return (
          <Card key={p.id} className="bg-[#10151A] border-white/8 flex flex-col">
            <CardHeader className={compact ? "space-y-2 pb-3" : "space-y-3"}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#11C4D0]/10 shrink-0">
                    <Icon className="h-5 w-5 text-[#11C4D0]" />
                  </div>
                  <CardTitle className="text-[#ECEAE4] text-base truncate">
                    {p.name}
                  </CardTitle>
                </div>
                {platformAccounts.length > 0 && (
                  <Badge
                    variant="outline"
                    className="border-[#11C4D0]/30 bg-[#11C4D0]/10 text-[#11C4D0] shrink-0"
                  >
                    {platformAccounts.length}
                  </Badge>
                )}
              </div>
              {!compact && (
                <CardDescription className="text-[#8A9198]">
                  {p.description}
                </CardDescription>
              )}
            </CardHeader>

            <CardContent className="flex-1 space-y-3">
              {p.id === "tiktok" && tiktokAuditPending && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#E4C875]/30 bg-[#E4C875]/10 px-3 py-2 text-[12px] text-[#E4C875]"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    Audit pending — posts will publish privately until TikTok
                    approves the app.
                  </span>
                </div>
              )}

              {p.id === "instagram" && p.guidance && !compact && (
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
                  No accounts connected
                </div>
              ) : (
                <div className="space-y-2">
                  {platformAccounts.map((acc) => (
                    <AccountRow
                      key={acc.id}
                      account={acc}
                      onDisconnect={
                        intakeMode
                          ? undefined
                          : (id) => disconnectMutation.mutate(id)
                      }
                      busyId={busyId}
                      selected={selectedIds?.includes(acc.id)}
                      onToggle={onToggle}
                      compact={compact}
                    />
                  ))}
                </div>
              )}

              {!intakeMode && (
                <Button
                  type="button"
                  onClick={() => handleConnect(p.id)}
                  disabled={pendingConnect === p.id}
                  variant="outline"
                  className="w-full border-[#11C4D0]/40 bg-transparent text-[#ECEAE4] hover:bg-[#11C4D0]/10 hover:text-[#11C4D0]"
                >
                  {pendingConnect === p.id ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4 mr-1.5" />
                  )}
                  {platformAccounts.length > 0
                    ? "Connect another"
                    : `Connect ${p.name}`}
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* IntegrationsTab — Settings page wrapper                        */
/* ────────────────────────────────────────────────────────────── */

export default function IntegrationsTab() {
  return (
    <div className="space-y-5">
      <Helmet>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div>
        <h2 className="font-serif text-[18px] font-medium text-[#ECEAE4]">
          Connected Accounts
        </h2>
        <p className="text-[12.5px] text-[#8A9198] mt-1">
          Manage social platforms where MotionMax can publish on your behalf.
        </p>
      </div>
      <ConnectedAccountsList />
    </div>
  );
}
