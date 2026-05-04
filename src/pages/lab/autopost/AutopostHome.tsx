/**
 * My Automations dashboard — `/lab/autopost`.
 *
 * Replaces the old wizard-based hub with an Autonomux-style stacked card
 * list. Each schedule renders as an `<AutomationCard>` that owns its own
 * inline modals (Edit / Generate Topics / Update Schedule), so users
 * never leave this page to manage day-to-day tasks.
 *
 * Quick action bar (between header and list):
 *   - "+ New Automation"  → /app/create/new?mode=cinematic (intake form;
 *      the "Run on a schedule" toggle inside the intake creates rows
 *      here when the user hits Generate).
 *   - Master + per-platform kill switches  (carried over from the old
 *      dashboard so admins can stop publishing without deleting rows).
 *   - Run history shortcut  → /lab/autopost/runs.
 *
 * Realtime: a single Supabase channel listens to autopost_schedules,
 * autopost_runs and autopost_publish_jobs; a 300ms debounce coalesces
 * bursty publish-job updates into one refetch.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Plus, ShieldCheck, History, ArrowRight, CheckCircle2, AlertTriangle, Loader2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { LabLayout } from "../_LabLayout";
import { AutopostNav } from "./_AutopostNav";
import { AutomationCard } from "./_AutomationCard";
import { platformLabel } from "./_autopostUi";
import type { AutomationSchedule } from "./_automationTypes";

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

/** Coerces app_settings.value (Json) into a strict boolean. */
function readBool(value: unknown, def: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return def;
}

async function fetchAutomations(): Promise<AutomationSchedule[]> {
  const { data, error } = await supabase
    .from("autopost_schedules")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as AutomationSchedule[];
}

async function fetchLastRuns(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("autopost_runs")
    .select("schedule_id, fired_at")
    .order("fired_at", { ascending: false })
    .limit(500);
  if (error) return {};
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ schedule_id: string; fired_at: string }>) {
    if (!out[row.schedule_id]) out[row.schedule_id] = row.fired_at;
  }
  return out;
}

export default function AutopostHome() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAdminAuth();

  const automationsQuery = useQuery({
    queryKey: ["autopost", "schedules-list"],
    queryFn: fetchAutomations,
  });

  const lastRunsQuery = useQuery({
    queryKey: ["autopost", "last-runs"],
    queryFn: fetchLastRuns,
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

  // Realtime — single debounced channel covering all relevant tables.
  // Mirrors the AdminQueueMonitor / RunHistory pattern.
  useEffect(() => {
    const debouncedRefetch = debounce(() => {
      queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      queryClient.invalidateQueries({ queryKey: ["autopost", "last-runs"] });
    }, 300);
    const channel = supabase
      .channel("lab-autopost-home")
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_schedules" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_runs" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_publish_jobs" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
        queryClient.invalidateQueries({ queryKey: ["autopost", "kill-switches"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const [pendingDisable, setPendingDisable] = useState<KillKey | null>(null);
  const [updatingKey, setUpdatingKey] = useState<KillKey | null>(null);

  const writeSwitch = async (key: KillKey, value: boolean) => {
    setUpdatingKey(key);
    const dbKey = KILL_KEYS[key];
    const { error } = await supabase
      .from("app_settings")
      .upsert(
        { key: dbKey, value: value as never, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
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

  const automations = automationsQuery.data ?? [];
  const lastRuns = lastRunsQuery.data ?? {};
  const isLoading = automationsQuery.isLoading;

  const hasAutomations = automations.length > 0;

  const newCta = useMemo(
    () => (
      <Button
        asChild
        size="default"
        className="h-10 px-4 bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
        style={{ backgroundImage: "linear-gradient(180deg, #11C4D0 0%, #0EA8B3 100%)" }}
      >
        <Link to="/app/create/new?mode=cinematic">
          <Plus className="h-4 w-4 mr-1.5" />
          New Automation
        </Link>
      </Button>
    ),
    [],
  );

  return (
    <LabLayout
      heading="My Automations"
      title="My Automations · Autopost · Lab"
      description="Recurring video pipelines. Each automation generates a fresh video on a schedule and publishes it to your connected accounts."
      breadcrumbs={[{ label: "Autopost" }]}
    >
      <AutopostNav />

      {/* Quick action bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div className="flex items-center gap-2">
          {newCta}
          <Button
            asChild
            variant="outline"
            size="default"
            className="h-10 px-4 border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
          >
            <Link to="/lab/autopost/runs">
              <History className="h-4 w-4 mr-1.5" />
              Run history
              <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Link>
          </Button>
        </div>
      </div>

      {/* Compact kill-switch row — admin only. The card itself is
          gated, not just its toggles, so non-admins don't see the
          "admin only" badge or the disabled switches at all. */}
      {isAdmin && (
        <Card className="bg-[#10151A] border-white/8 mb-6">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-[#ECEAE4] text-[13px] font-medium flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#E4C875]" />
                Kill switches
              </CardTitle>
              <Badge
                variant="outline"
                className="self-start border-[#E4C875]/40 bg-[#E4C875]/10 text-[#E4C875] text-[10px]"
              >
                admin only
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0 pb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <CompactSwitch
              label="Master"
              isActive={switchesQuery.data?.master ?? false}
              isLoading={updatingKey === "master" || switchesQuery.isLoading}
              disabled={!isAdmin}
              onToggle={next => handleSwitchChange("master", next)}
            />
            {(["youtube", "instagram", "tiktok"] as const).map(p => (
              <CompactSwitch
                key={p}
                label={platformLabel(p)}
                isActive={(switchesQuery.data?.[p]) ?? true}
                isLoading={updatingKey === p || switchesQuery.isLoading}
                disabled={!isAdmin}
                onToggle={next => handleSwitchChange(p, next)}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Automation list */}
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <Skeleton key={i} className="h-32 w-full bg-white/5" />
          ))}
        </div>
      ) : !hasAutomations ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-12 sm:py-16">
            <div className="flex flex-col items-center text-center max-w-md mx-auto space-y-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#11C4D0]/10">
                <Plus className="h-7 w-7 text-[#11C4D0]" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-serif text-xl text-[#ECEAE4]">No automations yet</h2>
                <p className="text-[13px] text-[#8A9198] leading-relaxed">
                  Head to a new project's intake form and toggle "Run on a schedule" at the bottom to create your first one.
                </p>
              </div>
              {newCta}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {automations.map(s => (
            <AutomationCard
              key={s.id}
              schedule={s}
              lastRunAt={lastRuns[s.id] ?? null}
            />
          ))}
        </div>
      )}

      <AlertDialog open={!!pendingDisable} onOpenChange={open => !open && setPendingDisable(null)}>
        <AlertDialogContent className="bg-[#10151A] border-white/8 text-[#ECEAE4]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#ECEAE4]">
              Disable {pendingDisable ? prettyName(pendingDisable) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              {pendingDisable === "master"
                ? "All automations will stop publishing. Already-rendered runs will sit in 'pending' until you re-enable. Continue?"
                : "Pending publishes for this platform will be skipped (+10min reschedule) until re-enabled. Continue?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#E4C875]/90"
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

function CompactSwitch({
  label,
  isActive,
  isLoading,
  disabled,
  onToggle,
}: {
  label: string;
  isActive: boolean;
  isLoading: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-white/8 px-3 py-2">
      <div className="min-w-0 flex items-center gap-2">
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 text-[#8A9198] animate-spin" />
        ) : isActive ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#11C4D0]" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#E4C875]" />
        )}
        <span className="text-[12px] text-[#ECEAE4] truncate">{label}</span>
      </div>
      <Switch
        checked={isActive}
        onCheckedChange={onToggle}
        disabled={disabled || isLoading}
        aria-label={`Toggle ${label}`}
        className="scale-90"
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
