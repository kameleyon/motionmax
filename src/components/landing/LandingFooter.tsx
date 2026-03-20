import motionmaxLogo from "@/assets/motionmax-logo.png";

/* ──────────────────────────────────────────────
 * Landing page footer with legal links.
 * ────────────────────────────────────────────── */

export default function LandingFooter() {
  return (
    <footer className="border-t border-border/30 py-10">
      <div className="mx-auto flex max-w-6xl flex-col sm:flex-row items-center justify-between gap-4 px-6 sm:px-8">
        <img src={motionmaxLogo} alt="MotionMax" className="h-10 w-auto" />
        <p className="text-sm text-muted-foreground">
          © 2026 MotionMax. All rights reserved.
        </p>
        <nav className="flex items-center gap-5">
          <a href="/terms" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Terms of Service
          </a>
          <a href="/privacy" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Privacy Policy
          </a>
          <a href="/acceptable-use" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Acceptable Use
          </a>
        </nav>
      </div>
    </footer>
  );
}
