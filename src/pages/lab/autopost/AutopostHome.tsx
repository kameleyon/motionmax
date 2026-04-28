/**
 * Autopost dashboard.
 *
 * Top of the page: 4 KPI cards (runs in last 7d, success rate, next
 * fire, active schedule count). Below them: kill-switch panel with a
 * master toggle and three per-platform toggles, all backed by direct
 * writes to `app_settings` (RLS gates the writes to admins; the
 * dispatcher reads the same keys on every tick). Bottom: quick links.
 *
 * Realtime: subscribe to changes on autopost_runs, autopost_schedules,
 * autopost_publish_jobs and app_settings so the dashboard stays in
 * sync without manual refresh. Mirror of the AdminQueueMonitor pattern.
 *
 * Disabling a switch shows an AlertDialog confirm (high-blast-radius
 * action — turning off autopost stops every active schedule). Enabling
 * is instant — re-enable accidentally and you can just disable again.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight, Cable, Calendar, History, ShieldCheck, Plus,
  CheckCircle2, AlertTriangle, Loader2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { LabLayout } from "../_LabLayout";
import { AutopostNav } from "./_AutopostNav";
import { relativeTime, platformLabel } from "./_autopostUi";

interface DashboardStats {
  runs7d: number;
  publishedJobs: number;
  failedJobs: number;
  nextFireAt: string | null;
  activeSchedules: number;
}

interface KillSwitchState {
  master: boolean;
  youtube: boolean;
  instagram: boolean;
  tiktok: boolean;
}

const KILL_KEYS = {
  master: "autopost_enabled",
  youtube: "autopost_youtube_enabled",
  instagram: "autopost_instagram_enabled",
  tiktok: "autopost_tiktok_enabled",
} as const;

type KillKey = keyof typeof KILL_KEYS;

const TILES = [
  { id: "schedules-new", title: "New schedule", description: "Define a cron, topic pool, and target accounts.", to: "/lab/autopost/schedules/new", icon: Plus },
  { id: "connect", title: "Connect platforms", description: "Hook up YouTube, Instagram Business, TikTok.", to: "/lab/autopost/connect", icon: Cable },
  { id: "runs", title: "View history", description: "Per-fire records, generation log, publish state.", to: "/lab/autopost/runs", icon: History },
] as const;

/** Coerces app_settings.value (Json) into a strict boolean. Empty / wrong-shape rows default to `def`. */
function readBool(value: unknown, def: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return def;
}

export default function AutopostHome() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAdminAuth();

  const statsQuery = useQuery<DashboardStats>({
    queryKey: ["autopost", "home-stats"],
    queryFn: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [runsRes, publishedRes, failedRes, schedulesRes] = await Promise.all([
        supabase
          .from("autopost_runs")
          .select("id", { count: "exact", head: true })
          .gte("fired_at", sevenDaysAgo),
        supabase
          .from("autopost_publish_jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "published")
          .gte("created_at", sevenDaysAgo),
        supabase
          .from("autopost_publish_jobs")
          .select("id", { count: "exact", head: true })
          .in("status", ["failed", "rejected"])
          .gte("created_at", sevenDaysAgo),
        supabase
          .from("autopost_schedules")
          .select("next_fire_at, active")
          .eq("active", true)
          .order("next_fire_at", { ascending: true }),
      ]);

      const activeRows = (schedulesRes.data ?? []) as Array<{ next_fire_at: string | null; active: boolean }>;
      const nextFireAt = activeRows.find(r => r.next_fire_at)?.next_fire_at ?? null;

      return {
        runs7d: runsRes.count ?? 0,
        publishedJobs: publishedRes.count ?? 0,
        failedJobs: failedRes.count ?? 0,
        nextFireAt,
        activeSchedules: activeRows.length,
      };
    },
    staleTime: 10_000,
  });

  const switchesQuery = useQuery<KillSwitchState>({
    queryKey: ["autopost", "kill-switches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", Object.values(KILL_KEYS));
      if (error) throw error;
      const byKey = new Map((data ?? []).map(r => [r.key, r.value]));
      return {
        master:    readBool(byKey.get(KILL_KEYS.master),    false),
        youtube:   readBool(byKey.get(KILL_KEYS.youtube),   true),
        instagram: readBool(byKey.get(KILL_KEYS.instagram), true),
        tiktok:    readBool(byKey.get(KILL_KEYS.tiktok),    true),
      };
    },
    enabled: isAdmin,
    staleTime: 10_000,
  });

  // Realtime: re-fetch stats on any change to autopost tables; re-fetch
  // switches when app_settings changes. Coalesce updates into the same
  // microtask via a debounce so we don't fire 4 refetches for one event.
  useEffect(() => {
    const debouncedRefetch = debounce(() => {
      queryClient.invalidateQueries({ queryKey: ["autopost", "home-stats"] });
    }, 300);
    const channel = supabase
      .channel("lab-autopost-home")
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_runs" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_publish_jobs" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_schedules" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
        queryClient.invalidateQueries({ queryKey: ["autopost", "kill-switches"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Switch UX: disable shows a confirm; enable is instant. We hold a
  // pending "ask to disable" target in state; the AlertDialog reads it.
  const [pendingDisable, setPendingDisable] = useState<KillKey | null>(null);
  const [updatingKey, setUpdatingKey] = useState<KillKey | null>(null);

  const writeSwitch = async (key: KillKey, value: boolean) => {
    setUpdatingKey(key);
    const dbKey = KILL_KEYS[key];
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: dbKey, value: value as never, updated_at: new Date().toISOString() }, { onConflict: "key" });
    setUpdatingKey(null);
    if (error) {
      toast.error(`Could not update ${key}: ${error.message}`);
      return;
    }
    toast.success(value ? `${prettyName(key)} enabled` : `${prettyName(key)} disabled`);
    queryClient.invalidateQueries({ queryKey: ["autopost", "kill-switches"] });
  };

  const handleSwitchChange = (key: KillKey, next: boolean) => {
    if (!next) {
      setPendingDisable(key);
      return;
    }
    void writeSwitch(key, true);
  };

  const successRate = useMemo(() => {
    if (!statsQuery.data) return null;
    const { publishedJobs, failedJobs } = statsQuery.data;
    const denom = publishedJobs + failedJobs;
    if (denom === 0) return null;
    return Math.round((publishedJobs / denom) * 100);
  }, [statsQuery.data]);

  return (
    <LabLayout
      heading="Autopost"
      title="Autopost · Lab"
      description="Schedule a content cadence once. MotionMax generates and publishes each video automatically across YouTube Shorts, Instagram Reels, and TikTok."
      breadcrumbs={[{ label: "Autopost" }]}
    >
      <AutopostNav />

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <KpiCard
          label="Runs (7d)"
          value={statsQuery.isLoading ? "—" : statsQuery.data?.runs7d.toLocaleString() ?? "0"}
          hint="Schedule fires + manual"
        />
        <KpiCard
          label="Success rate"
          value={statsQuery.isLoading ? "—" : successRate === null ? "—" : `${successRate}%`}
          hint={statsQuery.data ? `${statsQuery.data.publishedJobs} published / ${statsQuery.data.failedJobs} failed` : ""}
        />
        <KpiCard
          label="Next fire"
          value={statsQuery.isLoading ? "—" : statsQuery.data?.nextFireAt ? relativeTime(statsQuery.data.nextFireAt) : "—"}
          hint={statsQuery.data?.nextFireAt ? new Date(statsQuery.data.nextFireAt).toLocaleString() : "No active schedules"}
        />
        <KpiCard
          label="Active schedules"
          value={statsQuery.isLoading ? "—" : (statsQuery.data?.activeSchedules ?? 0).toLocaleString()}
          hint=""
        />
      </div>

      {/* Kill switches */}
      <Card className="mt-6 bg-[#10151A] border-white/8">
        <CardHeader className="border-b border-white/8">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-[#ECEAE4] text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#E4C875]" />
                Kill switches
              </CardTitle>
              <CardDescription className="text-[#8A9198] mt-1">
                Master controls. The dispatcher checks these on every tick — disable a platform and queued publishes for that target are skipped (rescheduled +10min, no retry burned).
              </CardDescription>
            </div>
            <Badge variant="outline" className="self-start border-[#E4C875]/40 bg-[#E4C875]/10 text-[#E4C875]">
              admin only
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="py-5 space-y-3">
          <KillSwitchRow
            label="Master autopost"
            description="Top-level off switch. Off = nothing publishes, regardless of per-platform state."
            isActive={switchesQuery.data?.master ?? false}
            isLoading={updatingKey === "master" || switchesQuery.isLoading}
            disabled={!isAdmin}
            onToggle={next => handleSwitchChange("master", next)}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["youtube", "instagram", "tiktok"] as const).map(p => (
              <KillSwitchRow
                key={p}
                label={platformLabel(p)}
                description=""
                compact
                isActive={(switchesQuery.data?.[p]) ?? true}
                isLoading={updatingKey === p || switchesQuery.isLoading}
                disabled={!isAdmin}
                onToggle={next => handleSwitchChange(p, next)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Quick links */}
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {TILES.map(t => {
          const Icon = t.icon;
          return (
            <Link
              key={t.id}
              to={t.to}
              className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#11C4D0]"
            >
              <Card className="h-full bg-[#10151A] border-white/8 hover:border-[#11C4D0]/40 transition-colors">
                <CardHeader className="space-y-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
                    <Icon className="h-5 w-5 text-[#11C4D0]" />
                  </div>
                  <div>
                    <CardTitle className="text-[#ECEAE4] text-base">{t.title}</CardTitle>
                    <CardDescription className="text-[#8A9198] mt-1.5">{t.description}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-[#11C4D0]">
                    Open <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <AlertDialog open={!!pendingDisable} onOpenChange={open => !open && setPendingDisable(null)}>
        <AlertDialogContent className="bg-[#10151A] border-white/8 text-[#ECEAE4]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#ECEAE4]">
              Disable {pendingDisable ? prettyName(pendingDisable) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              {pendingDisable === "master"
                ? "All schedules will stop publishing. Already-rendered runs will sit in 'pending' until you re-enable. Continue?"
                : "Pending publishes for this platform will be skipped (+10min reschedule) until re-enabled. Continue?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-[#F47272] text-[#0A0D0F] hover:bg-[#F47272]/90"
              onClick={() => {
                if (pendingDisable) void writeSwitch(pendingDisable, false);
                setPendingDisable(null);
              }}
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </LabLayout>
  );
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="bg-[#10151A] border-white/8">
      <CardContent className="py-4 sm:py-5 space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-[#8A9198]">{label}</p>
        <p className="font-serif text-2xl text-[#ECEAE4]">{value}</p>
        {hint && <p className="text-[11px] text-[#5A6268] truncate">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function KillSwitchRow({
  label,
  description,
  isActive,
  isLoading,
  disabled,
  onToggle,
  compact,
}: {
  label: string;
  description: string;
  isActive: boolean;
  isLoading: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md border border-white/8 px-3 ${compact ? "py-2.5" : "py-3"}`}
    >
      <div className="min-w-0 flex items-center gap-2.5">
        {isLoading ? (
          <Loader2 className="h-4 w-4 shrink-0 text-[#8A9198] animate-spin" />
        ) : isActive ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[#7BD389]" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-[#F47272]" />
        )}
        <div className="min-w-0">
          <p className="text-[13px] text-[#ECEAE4] truncate">{label}</p>
          {description && (
            <p className="text-[11px] text-[#8A9198] mt-0.5 line-clamp-2">{description}</p>
          )}
        </div>
      </div>
      <Switch
        checked={isActive}
        onCheckedChange={onToggle}
        disabled={disabled || isLoading}
        aria-label={`Toggle ${label}`}
      />
    </div>
  );
}

function prettyName(key: KillKey): string {
  if (key === "master") return "Master autopost";
  return platformLabel(key);
}

/** Tiny inline debounce to avoid pulling in lodash. */
function debounce<F extends (...args: unknown[]) => unknown>(fn: F, ms: number): F {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as F;
}
