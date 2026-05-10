/**
 * Terms / Privacy / AUP re-acceptance modal.
 *
 * B-NEW-13 (Comply L-B-02): UCTD Directive 93/13/EEC requires that
 * material amendments to consumer terms be re-accepted by existing
 * users — passive "continued use = acceptance" clauses are unenforceable
 * in the EU. This modal closes that gap.
 *
 * Trigger: <AuthProvider/> sets `legalVersionMismatch` to true whenever
 * a signed-in user's profiles.{tos,privacy,aup}_version_accepted does
 * not match LEGAL_VERSIONS in src/config/legal-versions.ts. This
 * component, mounted globally inside <BrowserRouter/> next to the
 * other auth-aware modals, opens whenever that flag is true.
 *
 * UX:
 *   - Non-dismissable. There is no "X" button and no "later" affordance —
 *     legal re-binding is the explicit goal, so we keep the user in the
 *     modal until they either accept or sign out.
 *   - Esc / outside-click are blocked via onInteractOutside / onEscapeKeyDown.
 *   - Two clear actions: "Review & accept" (writes the new versions)
 *     and "Sign out" (clears the session without accepting).
 *   - Links to each updated doc open in a new tab so reading the new
 *     terms doesn't require leaving the modal.
 *
 * Acceptance flow:
 *   1. User clicks "I accept the updated terms" (checkbox required).
 *   2. We call AuthContext.acceptLegalVersions() which writes the
 *      current LEGAL_VERSIONS to profiles via authenticated update.
 *   3. On success, AuthProvider clears legalVersionMismatch and the
 *      modal closes. On error, a toast surfaces the failure and the
 *      modal stays open so the user can retry.
 *
 * Self-skips on:
 *   - public/auth surfaces ("/", "/auth", "/share/*", "/legal/*",
 *     "/privacy", "/terms", "/acceptable-use", "/unsubscribe") so the
 *     user can actually read the new terms before re-accepting.
 */

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ScrollText } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { LEGAL_VERSIONS, LEGAL_LAST_UPDATED_LABEL } from "@/config/legal-versions";
import { toast } from "sonner";

function shouldGateRoute(pathname: string): boolean {
  if (pathname === "/" || pathname === "/auth") return true;
  if (pathname.startsWith("/share/")) return true;
  if (pathname.startsWith("/legal/")) return true;
  // Allow the user to read the new docs without the modal blocking.
  if (pathname === "/terms" || pathname === "/privacy" || pathname === "/acceptable-use") return true;
  if (pathname === "/unsubscribe") return true;
  return false;
}

export function TermsUpdateModal() {
  const { user, legalVersionMismatch, acceptLegalVersions, signOut } = useAuth();
  const location = useLocation();
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset the checkbox whenever the user changes (e.g. sign-out -> sign-in).
  useEffect(() => {
    setAccepted(false);
  }, [user?.id]);

  const open = !!user?.id && legalVersionMismatch && !shouldGateRoute(location.pathname);

  const handleAccept = async () => {
    if (!accepted || submitting) return;
    setSubmitting(true);
    try {
      const { error } = await acceptLegalVersions();
      if (error) {
        toast.error("Couldn't record your acceptance", {
          description: error.message ?? "Please try again.",
        });
        return;
      }
      toast.success("Thanks — your acceptance is on file.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await signOut();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-lg"
        // Block all the usual "dismiss" affordances. The user must take
        // an explicit action — accept, or sign out.
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        // Hide the built-in close X by overriding the [&>button]:hidden trick.
        // The dialog primitive renders a close X; we hide it via class.
      >
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <ScrollText className="h-5 w-5 text-primary" />
            </div>
            <DialogTitle className="text-lg">We've updated our Terms</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2">
            We've made changes to our Terms of Service, Privacy Policy, and
            Acceptable Use Policy (last updated {LEGAL_LAST_UPDATED_LABEL}).
            Please review the updated documents and confirm your acceptance
            to continue using MotionMax.
          </DialogDescription>
        </DialogHeader>

        <ul className="mt-2 space-y-2 text-sm">
          <li className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              Terms of Service
            </a>
            <span className="font-mono text-xs text-muted-foreground">{LEGAL_VERSIONS.tos}</span>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              Privacy Policy
            </a>
            <span className="font-mono text-xs text-muted-foreground">{LEGAL_VERSIONS.privacy}</span>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
            <a
              href="/acceptable-use"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              Acceptable Use Policy
            </a>
            <span className="font-mono text-xs text-muted-foreground">{LEGAL_VERSIONS.aup}</span>
          </li>
        </ul>

        <label className="mt-4 flex items-start gap-3 cursor-pointer select-none">
          <Checkbox
            id="terms-update-accept"
            checked={accepted}
            onCheckedChange={(v) => setAccepted(v === true)}
            className="mt-0.5"
            disabled={submitting}
          />
          <span className="text-sm text-foreground">
            I have read and accept the updated Terms of Service, Privacy
            Policy, and Acceptable Use Policy.
          </span>
        </label>

        <div className="flex flex-col gap-2 mt-4">
          <Button
            onClick={handleAccept}
            disabled={!accepted || submitting}
            className="w-full"
          >
            {submitting ? "Saving…" : "Accept and continue"}
          </Button>
          <Button
            variant="ghost"
            onClick={handleSignOut}
            disabled={submitting}
            className="w-full"
          >
            Sign out
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-2">
          We're required to record which version of these documents you
          accept. Continuing without acceptance is not an option under
          applicable consumer-protection law.
        </p>
      </DialogContent>
    </Dialog>
  );
}
