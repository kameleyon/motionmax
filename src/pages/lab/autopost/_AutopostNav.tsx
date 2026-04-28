/**
 * Tab strip rendered above the children of every Autopost lab page.
 *
 * Lives outside `_LabLayout.tsx` because the subnav is feature-scoped
 * — only Autopost pages need it, and other lab features will get their
 * own. Rendered as a horizontally scrollable strip on mobile and a
 * normal flex row on desktop. Uses `NavLink` so the active tab is
 * styled by react-router, no manual matching.
 *
 * The "Runs" tab is matched as active for both `/lab/autopost/runs`
 * and `/lab/autopost/runs/:id` because the detail view is a child of
 * the runs section conceptually.
 */

import { NavLink } from "react-router-dom";
import { LayoutDashboard, Cable, Calendar, History } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS: ReadonlyArray<{
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** end=true means only exact match counts as active; false lets nested routes light it up. */
  end: boolean;
}> = [
  { to: "/lab/autopost",           label: "Dashboard", icon: LayoutDashboard, end: true  },
  { to: "/lab/autopost/connect",   label: "Connect",   icon: Cable,           end: false },
  { to: "/lab/autopost/schedules", label: "Schedules", icon: Calendar,        end: false },
  { to: "/lab/autopost/runs",      label: "Runs",      icon: History,         end: false },
];

export function AutopostNav() {
  return (
    <nav
      aria-label="Autopost sections"
      className="-mx-4 mb-6 overflow-x-auto border-b border-white/8 px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex min-w-max items-center gap-1">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
                    isActive
                      ? "border-[#11C4D0] text-[#ECEAE4]"
                      : "border-transparent text-[#8A9198] hover:text-[#ECEAE4]",
                  )
                }
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default AutopostNav;
