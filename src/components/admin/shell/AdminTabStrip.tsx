import { Fragment } from "react";

import { I } from "@/components/admin/_shared/AdminIcons";
import { TAB_DEFINITIONS } from "@/components/admin/_shared/adminTabs";
import type { AdminTabKey } from "@/components/admin/_shared/queries";

export interface AdminTabStripProps {
  /** Currently active tab — receives `.on` styling. */
  activeTab: AdminTabKey;
  /** Click handler — invoked with the chosen tab key. */
  onTabChange: (tab: AdminTabKey) => void;
  /** Live badge counts keyed by tab — overrides the static values in
   *  TAB_DEFINITIONS. Pass undefined / null for a key to fall back to
   *  the static value (or no badge if the static is also absent). */
  liveBadges?: Partial<Record<AdminTabKey, number | null>>;
}

/**
 * `.adm-tabs` — 15 icon-only buttons, 42×38 px, with hover tooltip from
 * `data-label` `::after` (CSS in admin-shell.css). Inserts `.seg-sep`
 * before any tab whose definition has `segSepBefore: true`.
 *
 * Mobile (≤900 px) collapses to horizontal scroll with hidden scrollbar
 * and disabled tooltips — handled entirely in admin-shell.css.
 */
export function AdminTabStrip({ activeTab, onTabChange, liveBadges }: AdminTabStripProps) {
  return (
    <div className="adm-tabs" role="tablist" aria-label="Admin sections">
      {TAB_DEFINITIONS.map((def) => {
        const Icon = I[def.icon];
        const isActive = def.key === activeTab;
        // Live count wins. `null` (loaded but zero) hides the badge —
        // 0 is not interesting; we don't want a "0" pill on every tab.
        // `undefined` (not yet loaded) falls back to static value so
        // the strip doesn't flicker on first paint.
        const liveCount = liveBadges?.[def.key];
        let badge: { value: string | number; tone: "cyan" | "danger" } | null = null;
        if (liveCount === undefined) {
          badge = def.badge ?? null;
        } else if (liveCount !== null && liveCount > 0) {
          badge = { value: liveCount, tone: def.badge?.tone ?? "cyan" };
        }
        return (
          <Fragment key={def.key}>
            {def.segSepBefore ? (
              <span className="seg-sep" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={def.label}
              data-label={def.label}
              title={def.label}
              onClick={() => onTabChange(def.key)}
              className={isActive ? "on" : undefined}
            >
              <Icon />
              {badge ? (
                <span
                  className={
                    badge.tone === "danger" ? "pill danger" : "pill cyan"
                  }
                >
                  {badge.value}
                </span>
              ) : null}
              {def.dot ? (
                <span className="tab-dot live" aria-hidden="true" />
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
