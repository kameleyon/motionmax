import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate, useSearchParams } from "react-router-dom";

import Sidebar from "@/components/dashboard/Sidebar";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { AdminCommandPalette } from "@/components/admin/AdminCommandPalette";
import { AdminRecentActions } from "@/components/admin/AdminRecentActions";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { AdminTabBoundary } from "@/components/admin/_shared/AdminTabBoundary";
import {
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
const TabUsers = lazy(() =>
  import("@/components/admin/tabs/TabUsers").then((m) => ({
    default: m.TabUsers,
  })),
);
const TabGenerations = lazy(() =>
  import("@/components/admin/tabs/TabGenerations").then((m) => ({
    default: m.TabGenerations,
  })),
);
const TabConsole = lazy(() =>
  import("@/components/admin/tabs/TabConsole").then((m) => ({
    default: m.TabConsole,
  })),
);
const TabMessages = lazy(() =>
  import("@/components/admin/tabs/TabMessages").then((m) => ({
    default: m.TabMessages,
  })),
);
const TabSupport = lazy(() =>
  import("@/components/admin/tabs/TabSupport").then((m) => ({
    default: m.TabSupport,
  })),
);
const TabApi = lazy(() =>
  import("@/components/admin/tabs/TabApi").then((m) => ({
    default: m.TabApi,
  })),
);
const TabPerformance = lazy(() =>
  import("@/components/admin/tabs/TabPerformance").then((m) => ({
    default: m.TabPerformance,
  })),
);
const TabErrors = lazy(() =>
  import("@/components/admin/tabs/TabErrors").then((m) => ({
    default: m.TabErrors,
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
const TabNotifications = lazy(() =>
  import("@/components/admin/tabs/TabNotifications").then((m) => ({
    default: m.TabNotifications,
  })),
);
const TabNewsletter = lazy(() =>
  import("@/components/admin/tabs/TabNewsletter").then((m) => ({
    default: m.TabNewsletter,
  })),
);
const TabAnnouncements = lazy(() =>
  import("@/components/admin/tabs/TabAnnouncements").then((m) => ({
    default: m.TabAnnouncements,
  })),
);
const TabKillSwitches = lazy(() =>
  import("@/components/admin/tabs/TabKillSwitches").then((m) => ({
    default: m.TabKillSwitches,
  })),
);

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
      return <TabUsers />;
    case "gens":
      return <TabGenerations />;
    case "perf":
      return <TabPerformance />;
    case "errors":
      return <TabErrors />;
    case "console":
      return <TabConsole />;
    case "messages":
      return <TabMessages />;
    case "support":
      return <TabSupport />;
    case "notifs":
      return <TabNotifications />;
    case "news":
      return <TabNewsletter />;
    case "announce":
      return <TabAnnouncements />;
    case "kill":
      return <TabKillSwitches />;
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

  // Mobile sidebar drawer — opens via the hamburger in AdminTopBar.
  const [drawerOpen, setDrawerOpen] = useState(false);

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

      {/* Desktop sidebar in grid column 1. Hidden on <md so admin's
       *  responsive single-column layout doesn't push content off-screen.
       *  Mobile users open the same Sidebar via the hamburger Sheet below. */}
      <div className="hidden md:contents">
        <Sidebar />
      </div>

      {/* Mobile sidebar drawer — same Sheet pattern as AppShell so the
       *  user can navigate out of the admin section on small screens. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[280px] p-0 bg-[#10151A] border-white/10 md:hidden [&>button]:text-[#ECEAE4]"
          style={{ height: "100dvh" }}
        >
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <SheetDescription className="sr-only">Workspace navigation and account controls.</SheetDescription>
          <div
            className="h-full overflow-y-auto [&_aside]:flex [&_aside]:w-full [&_aside]:border-r-0 [&_aside]:h-auto [&_aside]:min-h-full [&_aside]:overflow-visible [&_aside_nav]:overflow-visible"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            <Sidebar />
          </div>
        </SheetContent>
      </Sheet>

      <div className="main">
        <AdminTopBar
          activeTab={tab}
          live={live}
          onToggleLive={toggleLive}
          onOpenSidebar={() => setDrawerOpen(true)}
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
