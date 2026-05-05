import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { I } from "@/components/admin/_shared/AdminIcons";
import { useAdminLiveCounters } from "@/components/admin/_shared/useAdminLiveCounters";
import type { AdminTabKey } from "@/components/admin/_shared/queries";

export interface AdminHeroProps {
  /** Switch tabs from the SSH / Broadcast quick-actions. */
  onTabChange: (tab: AdminTabKey) => void;
  /** Enable live-tail when the SSH button jumps to console. */
  onSetLive: (live: boolean) => void;
}

/** Format a Date as `Nh ago` / `Nm ago` / `Nd ago` / `just now`. */
function formatRelative(d: Date | null): string {
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/** Format an integer dollar value (cents → `$N` with grouping). */
function formatDollars(cents: number | null): string {
  if (cents === null) return "$—";
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString("en-US")}`;
}

/** Format an integer count with grouping commas. */
function formatCount(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

/**
 * `.adm-hero` — serif headline + live counter sub-line + action row.
 *
 * Counters come from `useAdminLiveCounters()` (Phase 1.4); the snapshot/
 * SSH/broadcast actions are minimum-viable wires for Phase 1 — they
 * navigate or toast and will be deepened in later phases.
 */
export function AdminHero({ onTabChange, onSetLive }: AdminHeroProps) {
  const counters = useAdminLiveCounters();

  const subLine = `${formatCount(counters.activeUsers)} active now · ${formatCount(
    counters.queueDepth,
  )} in queue · ${formatDollars(
    counters.mtdSpendCents,
  )} burned this month · last deploy ${formatRelative(counters.lastDeployAt)}`;

  const handleSnapshot = () => {
    toast.info("TODO: hook to overview export", {
      description:
        "CSV export of overview KPIs/timeseries lands with Phase 3 polish.",
    });
  };

  const handleSsh = () => {
    onSetLive(true);
    onTabChange("console");
  };

  const handleBroadcast = () => {
    onTabChange("announce");
  };

  return (
    <div className="adm-hero">
      <div>
        <h1>
          Admin <em>·</em> control panel
        </h1>
        <div className="sub" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span>{subLine}</span>
        </div>
      </div>
      <div className="actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleSnapshot}
          className="gap-1.5"
        >
          <I.download />
          Snapshot
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleSsh}
          className="gap-1.5"
        >
          <I.terminal />
          SSH
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleBroadcast}
          className="gap-1.5 bg-[var(--cyan)] text-[#0A0D0F] hover:bg-[var(--cyan-2)]"
        >
          <I.send />
          Broadcast
        </Button>
      </div>
    </div>
  );
}
