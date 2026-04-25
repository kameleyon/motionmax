import { Link } from "react-router-dom";
import { Sparkles, ArrowRight } from "lucide-react";

/** Full-width gold strip above the legacy AppShell topbar, inviting
 *  users to switch to the rebuilt dashboard while we're still in beta.
 *
 *  Lives in its own row above the sidebar+main flex so it stretches
 *  the full viewport width and is impossible to miss — every legacy
 *  page sees it without needing per-page wiring. The legacy AppHeader
 *  no longer carries its own centered pill since this strip covers
 *  the same job louder. */
export default function BetaRebuildBanner() {
  return (
    <Link
      to="/dashboard-new"
      className="group block w-full bg-gradient-to-r from-[#E4C875] via-[#F2D88A] to-[#E4C875] text-[#0A0D0F] hover:brightness-105 transition-all"
      style={{ textDecoration: "none" }}
      title="Try the rebuilt dashboard"
    >
      <div className="mx-auto max-w-[1480px] px-4 sm:px-6 py-2 flex items-center justify-center gap-2 sm:gap-3 text-center">
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
        <span className="font-mono text-[9.5px] sm:text-[10px] tracking-[0.18em] uppercase rounded bg-[#0A0D0F]/15 text-[#0A0D0F] px-1.5 py-px font-bold shrink-0">
          Beta · Test mode
        </span>
        <span className="text-[12px] sm:text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
          We're rebuilding MotionMax — give the new dashboard a try
        </span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
