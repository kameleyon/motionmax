/**
 * Tab strip rendered above the children of every Autopost lab page.
 *
 * Lives outside `_LabLayout.tsx` because the subnav is feature-scoped
 * — only Autopost pages need it, and other lab features will get their
 * own. Uses the `.ap-tabs` style from `autopost-tokens.css` so the
 * mobile rule (`max-width: 720px`) collapses to icons-only with the
 * `.t-label` text wrapped for hide/show — `aria-label` on each tab
 * keeps the section named for assistive tech.
 *
 * Post-Wave-B redesign: schedules are created from the intake form
 * (toggle "Run on a schedule" on /app/create/new) and managed inline on
 * the dashboard via cards + modals. Connect lives in /settings under the
 * Integrations tab. So the nav only needs Dashboard and Runs.
 *
 * The "Runs" tab is matched as active for both `/lab/autopost/runs`
 * and `/lab/autopost/runs/:id` because the detail view is a child of
 * the runs section conceptually.
 */

import { NavLink } from "react-router-dom";
import { LayoutDashboard, History } from "lucide-react";

const TABS: ReadonlyArray<{
  to: string;
  label: string;
  icon: React.ComponentType<{ width?: number; height?: number; className?: string }>;
  /** end=true means only exact match counts as active; false lets nested routes light it up. */
  end: boolean;
}> = [
  { to: "/lab/autopost",      label: "Dashboard", icon: LayoutDashboard, end: true  },
  { to: "/lab/autopost/runs", label: "Runs",      icon: History,         end: false },
];

export function AutopostNav() {
  return (
    <nav aria-label="Autopost sections" className="ap-tabs">
      {TABS.map(tab => {
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            aria-label={tab.label}
            className={({ isActive }) => (isActive ? "on" : "")}
          >
            <Icon width={14} height={14} />
            <span className="t-label">{tab.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export default AutopostNav;
