import * as React from "react";
import { I } from "./AdminIcons";

export type IconKey = keyof typeof I;

/**
 * Local relative-time fallback. Once `./format.ts` lands (Phase 0.3) this
 * file's caller can pre-format and pass the string into `metaTokens` instead;
 * we keep this inline so `ActivityFeed` has zero hard dependency on `format`.
 */
function relTime(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type FeedTone = "ok" | "err" | "warn" | "cyan" | "default";

export interface FeedItem {
  id: string;
  /** Color tone for the icon tile. `default` yields the muted/no-class look. */
  tone?: FeedTone;
  /** Glyph key into the `I` icon set (e.g. `'spark' | 'alert' | 'shield'`). */
  glyph: IconKey;
  /** Timestamp shown in the meta row (rendered as relative time). */
  t: Date;
  /** Body text — accepts a string or rich nodes (e.g. `<b>` highlights). */
  bodyText: React.ReactNode;
  /** Mono meta tokens shown under the body (kind, ids, durations, etc.). */
  metaTokens: string[];
}

export interface ActivityFeedProps {
  items: FeedItem[];
  className?: string;
  /** Optional empty-state node to render when items is empty. */
  empty?: React.ReactNode;
}

function toneClass(tone?: FeedTone): string {
  if (!tone || tone === "default") return "";
  return tone;
}

/**
 * `.feed > .item` activity rows. Each row renders an icon tile (tone-tinted),
 * a body line (sans-13 / muted with bold name fragments), and a meta row of
 * mono-10 uppercase-ish tokens (typically `[relative-time, kind, ...]`).
 */
export function ActivityFeed({ items, className, empty }: ActivityFeedProps) {
  const cls = ["feed", className ?? ""].filter(Boolean).join(" ");
  if (items.length === 0 && empty !== undefined) {
    return <div className={cls}>{empty}</div>;
  }
  return (
    <div className={cls}>
      {items.map((it) => {
        const Glyph = I[it.glyph];
        return (
          <div className="item" key={it.id}>
            <div className={["ico", toneClass(it.tone)].filter(Boolean).join(" ")}>
              <Glyph />
            </div>
            <div className="body">
              <div className="t">{it.bodyText}</div>
              <div className="meta">
                <span>{relTime(it.t)}</span>
                {it.metaTokens.map((tok, idx) => (
                  <span key={idx}>{tok}</span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
