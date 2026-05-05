import { lazy, Suspense, useCallback, useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate, useSearchParams } from "react-router-dom";

import Sidebar from "@/components/dashboard/Sidebar";
import { AdminCommandPalette } from "@/components/admin/AdminCommandPalette";
import { AdminRecentActions } from "@/components/admin/AdminRecentActions";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { AdminTabBoundary } from "@/components/admin/_shared/AdminTabBoundary";
import {
  TAB_DEFINITIONS,
  TAB_KEYS,
  parseTabKey,
} from "@/components/admin/_shared/adminTabs";
import type { AdminTabKey } from "@/components/admin/_shared/queries";
import { AdminHero } from "@/components/admin/shell/AdminHero";
import { AdminTabStrip } from "@/components/admin/shell/AdminTabStrip";
import { AdminTopBar } from "@/components/admin/shell/AdminTopBar";

/* ── Lazy tab content ─────────────────────────────────────────────────
 * Each existing tab component is split out into its own chunk so the
 * initial admin route stays small. Placeholder tabs render inline below
 * (no async cost). Phase 3+ rebuilds each tab in its own dedicated file.
 * ──────────────────────────────────────────────────────────────────── */

const AdminOverview = lazy(() =>
  import("@/components/admin/tabs/TabOverview").then((m) => ({
    default: m.TabOverview,
  })),
);
const AdminSubscribers = lazy(() =>
  import("@/components/admin/AdminSubscribers").then((m) => ({
    default: m.AdminSubscribers,
  })),
);
const AdminGenerations = lazy(() =>
  import("@/components/admin/AdminGenerations").then((m) => ({
    default: m.AdminGenerations,
  })),
);
const AdminLogs = lazy(() =>
  import("@/components/admin/AdminLogs").then((m) => ({
    default: m.AdminLogs,
  })),
);
const TabApi = lazy(() =>
  import("@/components/admin/tabs/TabApi").then((m) => ({
    default: m.TabApi,
  })),
);
const AdminPerformanceMetrics = lazy(() =>
  import("@/components/admin/AdminPerformanceMetrics").then((m) => ({
    default: m.AdminPerformanceMetrics,
  })),
);
const TabAnalytics = lazy(() =>
  import("@/components/admin/tabs/TabAnalytics").then((m) => ({
    default: m.TabAnalytics,
  })),
);
const TabActivity = lazy(() =>
  import("@/components/admin/tabs/TabActivity").then((m) => ({
    default: m.TabActivity,
  })),
);
const TabApiKeys = lazy(() =>
  import("@/components/admin/tabs/TabApiKeys").then((m) => ({
    default: m.TabApiKeys,
  })),
);

/** Inline placeholder for tabs whose rebuild lands in a later phase. */
function ComingSoon({ phase, tab }: { phase: string; tab: string }) {
  const label = TAB_DEFINITIONS.find((t) => t.key === tab)?.label ?? tab;
  return (
    <div
      className="rounded-xl border bg-[var(--panel-2)] p-8 text-center"
      style={{ borderColor: "var(--line)" }}
    >
      <p
        className="font-mono uppercase mb-2"
        style={{
          color: "var(--ink-mute)",
          fontSize: 10,
          letterSpacing: "0.16em",
        }}
      >
        {label}
      </p>
      <p
        className="font-serif"
        style={{ color: "var(--ink)", fontSize: 22, fontWeight: 400 }}
      >
        Coming in {phase}
      </p>
      <p
        className="mt-2 text-sm"
        style={{ color: "var(--ink-dim)" }}
      >
        This tab is being rebuilt in the admin overhaul. Existing data is
        still accessible via the legacy tabs while the new view is wired up.
      </p>
    </div>
  );
}

/**
 * Lookup `?tab=<key>` content. Each existing component is wrapped in
 * `<Suspense>` (in the parent) — placeholders render synchronously.
 *
 * The switch is exhaustive: TypeScript will flag a missing key when
 * `AdminTabKey` grows.
 */
function renderTabContent(tab: AdminTabKey) {
  switch (tab) {
    case "overview":
      return <AdminOverview />;
    case "analytics":
      return <TabAnalytics />;
    case "activity":
      return <TabActivity />;
    case "api":
      return <TabApi />;
    case "apikeys":
      return <TabApiKeys />;
    case "users":
      return <AdminSubscribers />;
    case "gens":
      return <AdminGenerations />;
    case "perf":
      return <AdminPerformanceMetrics />;
    case "errors":
      return <ComingSoon phase="Phase 11" tab="errors" />;
    case "console":
      return <AdminLogs />;
    case "messages":
      return <ComingSoon phase="Phase 13" tab="messages" />;
    case "notifs":
      return <ComingSoon phase="Phase 14" tab="notifs" />;
    case "news":
      return <ComingSoon phase="Phase 15" tab="news" />;
    case "announce":
      return <ComingSoon phase="Phase 16" tab="announce" />;
    case "kill":
      return <ComingSoon phase="Phase 17" tab="kill" />;
    default: {
      // Exhaustiveness check — `tab` should be `never` here.
      const _exhaustive: never = tab;
      void _exhaustive;
      return <AdminOverview />;
    }
  }
}

/**
 * Top-level `/admin` page. The two-zone shell:
 *   - Sidebar (column 1, reused from dashboard — DO NOT fork)
 *   - Main column (column 2): topbar → hero → tab strip → tab content
 *
 * State lives in the URL: `?tab=<key>` is the source of truth so a
 * deep-link or sidebar navigation always lands on the right tab. The
 * `?live=1` param is mirrored by the topbar Live pill so the console
 * tab can pick up the same flag.
 *
 * The outer `<AdminRoute>` gate is applied in `App.tsx`. Re-wrapping
 * here would be redundant (ref. Phase 1.3 "no changes there").
 */
export default function Admin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Validate `?tab=<key>` once per render via the shared helper. Falls
  // back to `'overview'` for null/unknown values — see `parseTabKey()`
  // in `_shared/adminTabs.ts`.
  const rawTab = searchParams.get("tab");
  const tab = useMemo(() => parseTabKey(rawTab), [rawTab]);

  // Live tail flag — mirrored as `?live=1` so deep-links share state.
  const live = searchParams.get("live") === "1";

  const setTab = useCallback(
    (next: AdminTabKey) => {
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      navigate(`/admin?${params.toString()}`, { replace: true });
    },
    [navigate, searchParams],
  );

  const setLive = useCallback(
    (nextLive: boolean) => {
      const params = new URLSearchParams(searchParams);
      if (nextLive) {
        params.set("live", "1");
      } else {
        params.delete("live");
      }
      // Always preserve `tab` — `searchParams` already includes it.
      navigate(`/admin?${params.toString()}`, { replace: true });
    },
    [navigate, searchParams],
  );

  const toggleLive = useCallback(() => setLive(!live), [live, setLive]);

  // Sanity-check exhaustiveness against `TAB_KEYS` at module-eval time
  // — guarantees the route can render every key the tab strip emits.
  if (!TAB_KEYS.includes(tab)) {
    // Shouldn't be reachable — `parseTabKey()` already coerces unknown
    // values to `'overview'`. This branch keeps TypeScript honest.
    return null;
  }

  const tabContent = renderTabContent(tab);

  return (
    <div className="admin-shell adm">
      <Helmet>
        <title>Admin · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <Sidebar />

      <div className="main">
        <AdminTopBar
          activeTab={tab}
          live={live}
          onToggleLive={toggleLive}
        />
        <div className="body">
          <div className="adm-content">
            <AdminHero onTabChange={setTab} onSetLive={setLive} />
            <AdminTabStrip activeTab={tab} onTabChange={setTab} />
            <AdminTabBoundary tabKey={tab}>
              <Suspense fallback={<AdminLoading />}>{tabContent}</Suspense>
            </AdminTabBoundary>
          </div>
        </div>
      </div>

      {/* Global Cmd+K palette and Recent Actions popover stay mounted
          across tab switches — they manage their own open state. */}
      <AdminCommandPalette onNavigate={(k) => setTab(parseTabKey(k))} />
      <AdminRecentActions />
    </div>
  );
}
