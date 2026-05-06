/**
 * My Automations dashboard — `/lab/autopost`.
 *
 * Restyled (2026-05-06) to match the Autopost Lab "pulse system" design.
 * The page now has four bands above the automation grid:
 *
 *   1. Lab breadcrumb + serif page hero.
 *   2. Platform health strip — 4 tiles (YT / IG / TT / X) with a 0-100%
 *      "uptime"-ish ring derived from recent autopost_publish_jobs
 *      success rate. The "warn" tile turns gold when retries pending.
 *   3. 24h radar — a horizontal timeline pinning past + upcoming runs.
 *   4. Action bar (New automation / Run history) and admin kill-row.
 *
 * The actual schedule list lives in the pulse-grid below — each row is
 * an AutomationCard rendered as a "pulse" tile. All wiring is preserved:
 *   - Realtime channels (autopost_schedules, autopost_runs, autopost_
 *     publish_jobs, app_settings) untouched.
 *   - Kill-switch upserts to app_settings unchanged.
 *   - FIFO topic semantics + Save Order + drag-reorder all live in
 *     `_GenerateTopicsDialog.tsx` which this page does not touch.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Plus, History, ShieldCheck, Calendar, ListChecks, FlaskConical, ChevronRight,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Helmet } from "react-helmet-async";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import AppShell from "@/components/dashboard/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { AutopostNav } from "./_AutopostNav";
import { AutomationCard } from "./_AutomationCard";
import { platformLabel } from "./_autopostUi";
import { formatRelativeTime } from "./_utils";
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

interface PlatformHealth {
  pct: number;
  recentCount: number;
  lastPushAt: string | null;
  warn: boolean;
}

interface RadarEvent {
  /** Hours from now (negative = past, positive = future). */
  h: number;
  schedule: string;
  topic: string;
  status: "done" | "fail" | "up";
  /** Highlights the pin as "next" — used for the very next upcoming run. */
  next?: boolean;
}

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

interface PublishJobLite {
  platform: string;
  status: string;
  created_at: string;
}

async function fetchPlatformHealth(): Promise<Record<string, PlatformHealth>> {
  const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("autopost_publish_jobs")
    .select("platform, status, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return {};
  const rows = (data ?? []) as PublishJobLite[];
  const groups = new Map<string, PublishJobLite[]>();
  for (const r of rows) {
    const list = groups.get(r.platform) ?? [];
    list.push(r);
    groups.set(r.platform, list);
  }
  const out: Record<string, PlatformHealth> = {};
  for (const [platform, list] of groups) {
    const finals = list.filter(r => r.status === "published" || r.status === "failed" || r.status === "rejected");
    const ok = list.filter(r => r.status === "published").length;
    const pct = finals.length === 0 ? 100 : Math.round((ok / finals.length) * 100);
    const pending = list.filter(r => r.status === "uploading" || r.status === "processing" || r.status === "pending").length;
    out[platform] = {
      pct,
      recentCount: list.length,
      lastPushAt: list[0]?.created_at ?? null,
      warn: pct < 90 || pending > 2,
    };
  }
  return out;
}

interface RadarRow {
  fired_at: string;
  status: string;
  topic: string | null;
  schedule: { name: string } | null;
}

async function fetchRadarRuns(): Promise<RadarRow[]> {
  const sinceIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("autopost_runs")
    .select("fired_at, status, topic, schedule:autopost_schedules(name)")
    .gte("fired_at", sinceIso)
    .order("fired_at", { ascending: true })
    .limit(40);
  if (error) return [];
  return (data ?? []) as unknown as RadarRow[];
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

  const platformHealthQuery = useQuery({
    queryKey: ["autopost", "platform-health"],
    queryFn: fetchPlatformHealth,
    staleTime: 30_000,
  });

  const radarQuery = useQuery({
    queryKey: ["autopost", "radar"],
    queryFn: fetchRadarRuns,
    staleTime: 30_000,
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
      queryClient.invalidateQueries({ queryKey: ["autopost", "platform-health"] });
      queryClient.invalidateQueries({ queryKey: ["autopost", "radar"] });
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

  // Compute next-fire countdown across all active schedules.
  const nextFireSummary = useMemo(() => {
    const upcoming = automations
      .filter(s => s.active && s.next_fire_at)
      .map(s => ({ name: s.name, at: new Date(s.next_fire_at).getTime() }))
      .filter(s => Number.isFinite(s.at))
      .sort((a, b) => a.at - b.at);
    if (upcoming.length === 0) return null;
    const next = upcoming[0];
    const diffMs = next.at - Date.now();
    if (diffMs <= 0) return { text: "now", count: upcoming.length };
    const totalMin = Math.floor(diffMs / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const text = h > 0 ? `${h}h ${m}m` : `${m}m`;
    return { text, count: upcoming.length };
  }, [automations]);

  // Build radar events from past runs + upcoming schedule fires.
  const radarEvents = useMemo<RadarEvent[]>(() => {
    const out: RadarEvent[] = [];
    const now = Date.now();
    // Past runs (within last 3h render window).
    for (const r of radarQuery.data ?? []) {
      const t = new Date(r.fired_at).getTime();
      if (!Number.isFinite(t)) continue;
      const h = (t - now) / 3_600_000;
      if (h < -3 || h > 0.5) continue;
      const status: "done" | "fail" =
        r.status === "failed" || r.status === "cancelled" ? "fail" : "done";
      out.push({
        h,
        schedule: r.schedule?.name ?? "Schedule",
        topic: r.topic ?? "",
        status,
      });
    }
    // Upcoming fires from each active schedule's next_fire_at.
    const upcoming = automations
      .filter(s => s.active && s.next_fire_at)
      .map(s => ({
        name: s.name,
        topic: (s.topic_pool && s.topic_pool[0]) || "",
        h: (new Date(s.next_fire_at).getTime() - now) / 3_600_000,
      }))
      .filter(s => s.h >= 0 && s.h <= 24)
      .sort((a, b) => a.h - b.h);

    upcoming.forEach((u, i) => {
      out.push({
        h: u.h,
        schedule: u.name,
        topic: u.topic,
        status: "up",
        next: i === 0,
      });
    });
    return out;
  }, [radarQuery.data, automations]);

  // YouTube / IG / TikTok / X tile data.
  const tiles = useMemo(() => {
    const h = platformHealthQuery.data ?? {};
    const t = (key: string, label: string, glyph: string, ic: string, suffix: string) => {
      const data = h[key];
      const pct = data?.pct ?? 100;
      const count = data?.recentCount ?? 0;
      const last = data?.lastPushAt ? formatRelativeTime(data.lastPushAt) : "—";
      const warn = data?.warn ?? false;
      return {
        key, label, glyph, ic, pct, count, last, warn,
        sub: count > 0 ? `Last push ${last} · ${count} ${suffix} / 30d` : "No publishes yet",
      };
    };
    return [
      t("youtube", "YouTube", "YT", "plic-yt", "videos"),
      t("instagram", "Instagram", "IG", "plic-ig", "reels"),
      t("tiktok", "TikTok", "TT", "plic-tt", "posts"),
      t("x", "X / Twitter", "X", "plic-x", "posts"),
    ];
  }, [platformHealthQuery.data]);

  return (
    <AppShell breadcrumb="Lab · Autopost">
      <Helmet>
        <title>Autopost · Lab · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="autopost-shell">
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "28px 32px 80px" }}>
          {/* Lab crumb */}
          <div className="lab-crumb">
            <FlaskConical width={13} height={13} />
            <Link to="/lab">Lab</Link>
            <span className="sep">›</span>
            <span className="cur">Autopost</span>
          </div>

          {/* Page hero */}
          <div className="ap-head">
            <div>
              <h1>Autopost <em>lab</em></h1>
              <p className="lede">
                Recurring video pipelines firing across your connected channels.
                Each automation writes a fresh script, renders a video, and publishes —
                on the schedule you set.
              </p>
            </div>
          </div>

          {/* Platform health strip */}
          <div className="health-strip">
            {tiles.map(t => (
              <div key={t.key} className={`hs-cell${t.warn ? " warn" : ""}`}>
                <div className="hsh">
                  <div className={`pl-ic ${t.ic}`}>{t.glyph}</div>
                  <div className="nm">{t.label}</div>
                  <div className="dt">{t.warn ? "retrying" : "live"}</div>
                </div>
                <div className="num">{t.pct}<span className="u">%</span></div>
                <div className="sub">{t.sub}</div>
                <div className="bar"><i style={{ width: `${t.pct}%` }} /></div>
              </div>
            ))}
          </div>

          {/* 24h radar */}
          <div className="radar">
            <div className="radar-h">
              <h2>
                Next 24 hours <span className="dim">— {radarEvents.filter(e => e.status === "up").length} scheduled</span>
              </h2>
              {nextFireSummary && (
                <div className="stat">
                  NEXT FIRE IN <b>{nextFireSummary.text}</b>
                </div>
              )}
            </div>
            <Radar events={radarEvents} />
            <div className="radar-foot">
              <span className="lg done">completed</span>
              <span className="lg fail">failed</span>
              <span className="lg up">upcoming</span>
            </div>
          </div>

          <AutopostNav />

          {/* Action bar */}
          <div className="act-bar">
            <Link to="/app/create/new?mode=cinematic" className="btn-cyan">
              <Plus width={14} height={14} />
              New automation
            </Link>
            <Link to="/lab/autopost/runs" className="btn-ghost">
              <History width={13} height={13} />
              Run history
              <ChevronRight width={13} height={13} />
            </Link>
            <Link to="/dashboard?tab=calendar" className="btn-ghost">
              <Calendar width={13} height={13} />
              Calendar view
            </Link>
            <Link to="/lab" className="btn-ghost">
              <ListChecks width={13} height={13} />
              All lab tools
            </Link>
          </div>

          {/* Kill switches — admin only */}
          {isAdmin && (
            <div className="kill-row">
              <div className="kt">
                <ShieldCheck width={14} height={14} />
                <b>Kill switches</b>
                <span className="ad">admin</span>
              </div>
              <KillToggle
                label="Master"
                active={switchesQuery.data?.master ?? false}
                loading={updatingKey === "master" || switchesQuery.isLoading}
                onChange={next => handleSwitchChange("master", next)}
              />
              <KillToggle
                label="YT"
                active={switchesQuery.data?.youtube ?? true}
                loading={updatingKey === "youtube" || switchesQuery.isLoading}
                onChange={next => handleSwitchChange("youtube", next)}
              />
              <KillToggle
                label="IG"
                active={switchesQuery.data?.instagram ?? true}
                loading={updatingKey === "instagram" || switchesQuery.isLoading}
                onChange={next => handleSwitchChange("instagram", next)}
              />
              <KillToggle
                label="TT"
                active={switchesQuery.data?.tiktok ?? true}
                loading={updatingKey === "tiktok" || switchesQuery.isLoading}
                onChange={next => handleSwitchChange("tiktok", next)}
              />
            </div>
          )}

          {/* Automation grid (pulse cards) */}
          {isLoading ? (
            <div className="pulse-grid">
              {[0, 1, 2, 3].map(i => (
                <Skeleton key={i} className="h-72 w-full bg-white/5 rounded-xl" />
              ))}
            </div>
          ) : !hasAutomations ? (
            <div
              className="pulse"
              style={{ padding: "48px 24px", textAlign: "center" }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 56, height: 56, borderRadius: "50%",
                    background: "rgba(20,200,204,0.1)",
                    display: "grid", placeItems: "center",
                    color: "var(--cyan)",
                  }}
                >
                  <Plus width={28} height={28} />
                </div>
                <h2 style={{
                  fontFamily: "var(--serif)", fontSize: 22, margin: 0, color: "var(--ink)",
                }}>
                  No automations yet
                </h2>
                <p style={{ color: "var(--ink-dim)", fontSize: 13, maxWidth: 460, margin: 0, lineHeight: 1.55 }}>
                  Head to a new project's intake form and toggle "Run on a schedule" at the
                  bottom to create your first one.
                </p>
                <Link to="/app/create/new?mode=cinematic" className="btn-cyan" style={{ marginTop: 8 }}>
                  <Plus width={14} height={14} />
                  New automation
                </Link>
              </div>
            </div>
          ) : (
            <div className="pulse-grid">
              {automations.map(s => (
                <AutomationCard
                  key={s.id}
                  schedule={s}
                  lastRunAt={lastRuns[s.id] ?? null}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={!!pendingDisable} onOpenChange={open => !open && setPendingDisable(null)}>
        <AlertDialogContent className="autopost-modal-content">
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
    </AppShell>
  );
}

/** A single kill-switch toggle for the .kill-row chrome. */
function KillToggle({
  label,
  active,
  loading,
  onChange,
}: {
  label: string;
  active: boolean;
  loading: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="ks">
      {label}
      <button
        type="button"
        className={`ks-tg${active ? " on" : ""}${loading ? " loading" : ""}`}
        onClick={() => onChange(!active)}
        disabled={loading}
        aria-label={`Toggle ${label}`}
        aria-pressed={active}
      />
    </div>
  );
}

/** 24-hour radar — pure-CSS pin layout. Renders the axis ticks at +0,
 *  +6h, +12h, +18h, +24h and pins each event proportionally. */
function Radar({ events }: { events: RadarEvent[] }) {
  const minH = -3;
  const maxH = 24;
  const range = maxH - minH;
  const pct = (h: number) => ((h - minH) / range) * 100;
  const ticks = [0, 6, 12, 18, 24];
  return (
    <div className="radar-track">
      <div className="radar-axis">
        {ticks.map(h => (
          <span key={h}>
            <i style={{ left: `${pct(h)}%` }} />
            <div className="lb" style={{ left: `${pct(h)}%` }}>
              {h === 0 ? "now" : h === 24 ? "+24h" : `+${h}h`}
            </div>
          </span>
        ))}
      </div>
      <div className="radar-now" style={{ left: `${pct(0)}%` }} />
      {events.map((e, i) => {
        const cls = `${e.status}${e.next ? " next" : ""}`;
        const sign = e.h < 0 ? `${Math.abs(e.h).toFixed(1)}h ago` : `+${e.h.toFixed(1)}h`;
        return (
          <div
            key={`${i}-${e.schedule}-${e.h}`}
            className={`radar-pin ${cls}`}
            style={{ left: `${pct(e.h)}%` }}
          >
            <div className="tt">
              <b>{e.schedule} · {sign}</b>
              {e.topic}
            </div>
          </div>
        );
      })}
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
