import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";

const DISMISS_KEY = "motionmax_new_dashboard_banner_dismissed";
// 2026-05-03 — date the banner sunsets and the legacy /app/legacy
// route can be retired safely (one full week of opt-back window).
const SUNSET_DATE = new Date("2026-05-03T23:59:59-07:00");

/** Gold gradient announcement bar that sits above the new dashboard
 *  for the first week of rollout. Gives users an unmissable visual
 *  cue ("you're on the new one"), a one-click escape hatch back to
 *  the legacy dashboard, and a sunset date so they know the legacy
 *  page is going away. Auto-hides past SUNSET_DATE; users can also
 *  X it out and the dismissal persists in localStorage. */
export default function NewDashboardBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Date.now() > SUNSET_DATE.getTime()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch { /* ignore */ }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="New dashboard announcement"
      className="relative w-full bg-gradient-to-r from-[#FF6A00] via-[#F59E0B] to-[#E4C875] text-[#0A0D0F]"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-2.5 pr-12 flex items-center justify-center gap-2 text-center text-[12px] sm:text-[13px] font-medium leading-snug">
        <span className="hidden sm:inline-flex h-2 w-2 rounded-full bg-[#0A0D0F]/70 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">You&rsquo;re on the new dashboard.</strong>{" "}
          <span className="hidden sm:inline">Prefer the old one? </span>
          <Link
            to="/app/legacy"
            className="underline underline-offset-2 hover:no-underline font-semibold"
          >
            Click here to go back
          </Link>
          .{" "}
          <span className="opacity-80">Available until May 3<sup>rd</sup>.</span>
        </span>
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss announcement"
        style={{ touchAction: "manipulation" }}
        className="absolute top-1/2 -translate-y-1/2 right-2 sm:right-4 inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-black/10 active:bg-black/15 transition-colors text-[#0A0D0F]/80 hover:text-[#0A0D0F]"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
