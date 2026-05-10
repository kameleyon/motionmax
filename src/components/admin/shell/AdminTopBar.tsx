import { useQueryClient } from "@tanstack/react-query";

import { I } from "@/components/admin/_shared/AdminIcons";
import { Pill } from "@/components/admin/_shared/Pill";
import { TAB_DEFINITIONS } from "@/components/admin/_shared/adminTabs";
import type { AdminTabKey } from "@/components/admin/_shared/queries";

export interface AdminTopBarProps {
  /** Currently active tab — drives the breadcrumb tail label. */
  activeTab: AdminTabKey;
  /** Live tail toggle, mirrors the `?live=1` query param. */
  live: boolean;
  /** Toggle handler for the Live pill. */
  onToggleLive: () => void;
  /** Optional gear-button click — wire to user dropdown when available. */
  onOpenSettings?: () => void;
  /** Mobile-only: opens the sidebar drawer (Sheet) so the user can
   *  navigate back to other parts of the app. Hidden on >=md. */
  onOpenSidebar?: () => void;
}

/**
 * Sticky 54 px admin topbar.
 *
 * Children (left → right):
 *   - `.crumbs`    `Operations / <activeTabLabel>`
 *   - cyan "production" pill
 *   - spacer
 *   - "All systems normal" ok pill (TODO(admin-incident-pill): wire to incidents counter)
 *   - Refresh icon-button — invalidates all `['admin', ...]` queries
 *   - Live pill toggle — controls console live-tail / `?live=1`
 *   - Gear icon-button — placeholder for user dropdown
 */
export function AdminTopBar({
  activeTab,
  live,
  onToggleLive,
  onOpenSettings,
  onOpenSidebar,
}: AdminTopBarProps) {
  const queryClient = useQueryClient();

  // Look up the human label for the active tab. `TAB_DEFINITIONS` is the
  // single source of truth — when tabs are added/removed there's exactly
  // one place to touch.
  const activeLabel =
    TAB_DEFINITIONS.find((t) => t.key === activeTab)?.label ?? "Overview";

  const handleRefresh = () => {
    // Invalidate the entire `['admin', ...]` query namespace. Per
    // `_shared/queries.ts`, every admin query is keyed under that prefix
    // so a single call refreshes the active tab and any background data.
    queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  return (
    <div className="topbar">
      {/* Mobile-only hamburger — opens the sidebar drawer so the user
       *  can leave the admin section. Hidden on >=md where the desktop
       *  sidebar is always visible in column 1. */}
      {onOpenSidebar ? (
        <button
          type="button"
          onClick={onOpenSidebar}
          className="md:hidden w-10 h-10 -ml-1 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors shrink-0"
          aria-label="Open sidebar"
          title="Menu"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
      ) : null}

      <div className="crumbs" aria-label="breadcrumb">
        <span>Operations</span>
        <span className="sep">·</span>
        <span className="cur">{activeLabel}</span>
      </div>

      <Pill variant="cyan" dot>
        production
      </Pill>

      <div className="spacer" />

      <Pill variant="ok" dot>
        All systems normal
      </Pill>

      <button
        type="button"
        className="pill-btn"
        onClick={handleRefresh}
        aria-label="Refresh admin data"
        title="Refresh admin data"
      >
        <I.refresh />
        <span>Refresh</span>
      </button>

      <button
        type="button"
        className={live ? "pill-btn on" : "pill-btn"}
        onClick={onToggleLive}
        aria-pressed={live}
        aria-label="Toggle live tail"
        title="Live tail (mirrors ?live=1)"
      >
        <I.bolt />
        <span>Live</span>
      </button>

      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        aria-label="Open settings"
        title="Settings"
      >
        <I.gear />
      </button>
    </div>
  );
}
