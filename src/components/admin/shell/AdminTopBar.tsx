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
}

/**
 * Sticky 54 px admin topbar.
 *
 * Children (left → right):
 *   - `.crumbs`    `Operations / <activeTabLabel>`
 *   - cyan "production" pill
 *   - spacer
 *   - "All systems normal" ok pill (TODO: wire to incidents counter)
 *   - Refresh icon-button — invalidates all `['admin', ...]` queries
 *   - Live pill toggle — controls console live-tail / `?live=1`
 *   - Gear icon-button — placeholder for user dropdown
 */
export function AdminTopBar({
  activeTab,
  live,
  onToggleLive,
  onOpenSettings,
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
