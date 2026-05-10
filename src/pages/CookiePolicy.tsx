import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import PageSeo from "@/components/PageSeo";
import { ArrowLeft } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  CONSENT_POLICY_VERSION,
  revokeConsent,
} from "@/lib/cookieConsent";

/**
 * CookiePolicy — standalone /cookies page enumerating every cookie /
 * localStorage key set by motionmax, with purpose, retention, category,
 * and (for third-party) the vendor's privacy policy.
 *
 * Wave E-Legal Part A — companion to the granular consent banner shipped
 * in Wave 3 B-NEW-9 / B-NEW-10. The banner is the consent capture; this
 * page is the disclosure layer the ICO + CNIL guidance both require —
 * specifically: "the user must be able to read, in one place, what each
 * cookie does, how long it lasts, and who set it."
 *
 * "Manage cookie preferences" button calls revokeConsent() to wipe the
 * stored record and dispatch the consent-changed event — the
 * CookieConsent banner in App.tsx listens for that event and re-shows.
 */

interface CookieRow {
  name: string;
  party: "First" | "Third";
  vendor?: string;
  vendorPrivacyUrl?: string;
  purpose: string;
  retention: string;
  category: "Necessary" | "Functional" | "Analytics" | "Marketing";
}

const COOKIES: CookieRow[] = [
  // Necessary
  {
    name: "sb-<project>-auth-token",
    party: "First",
    purpose: "Supabase auth session token. Keeps you signed in across page loads.",
    retention: "Session + refresh window (typically 1 hour access token, 1 week refresh)",
    category: "Necessary",
  },
  {
    name: "sb-<project>-auth-token-code-verifier",
    party: "First",
    purpose: "PKCE OAuth code verifier — required for secure sign-in flow.",
    retention: "Cleared on auth completion or 10 minutes",
    category: "Necessary",
  },
  {
    name: "__stripe_mid / __stripe_sid",
    party: "Third",
    vendor: "Stripe",
    vendorPrivacyUrl: "https://stripe.com/privacy",
    purpose: "Stripe fraud-prevention and checkout session continuity.",
    retention: "__stripe_mid: 1 year; __stripe_sid: 30 minutes",
    category: "Necessary",
  },
  {
    name: "motionmax_csrf",
    party: "First",
    purpose: "Cross-site request forgery defense token for state-changing endpoints.",
    retention: "Session",
    category: "Necessary",
  },
  // Functional
  {
    name: "motionmax_theme",
    party: "First",
    purpose: "Remembers your light/dark/system theme choice across visits.",
    retention: "1 year",
    category: "Functional",
  },
  {
    name: "motionmax_sidebar_state",
    party: "First",
    purpose: "Remembers whether the dashboard sidebar is expanded or collapsed.",
    retention: "1 year",
    category: "Functional",
  },
  {
    name: "motionmax_language_pref",
    party: "First",
    purpose: "Stores your selected interface language (when supported).",
    retention: "1 year",
    category: "Functional",
  },
  // Analytics
  {
    name: "_ga / _ga_<container>",
    party: "Third",
    vendor: "Google Analytics 4",
    vendorPrivacyUrl: "https://policies.google.com/privacy",
    purpose:
      "Distinguishes anonymous users and aggregates page-view, session, and feature-usage statistics. Loaded only after you grant analytics consent.",
    retention: "_ga: 2 years; _ga_<container>: 2 years",
    category: "Analytics",
  },
  {
    name: "sentryReplaySession / sentry-replay-*",
    party: "Third",
    vendor: "Sentry",
    vendorPrivacyUrl: "https://sentry.io/privacy/",
    purpose:
      "Session replay for error reproduction. Captures DOM mutations and user input masks, no passwords or generated content. Loaded only after analytics consent.",
    retention: "30 days on Sentry servers; cookie itself ~30 minutes",
    category: "Analytics",
  },
  // Marketing
  {
    name: "(none currently set)",
    party: "First",
    purpose:
      "motionmax does not currently use marketing or retargeting cookies. The Marketing category is reserved so that if we ever introduce them, your prior choice already applies.",
    retention: "n/a",
    category: "Marketing",
  },
];

/**
 * localStorage / sessionStorage keys are NOT cookies in the strict legal
 * sense, but ICO / CNIL guidance treats them identically for consent
 * purposes (the 2002 ePrivacy Directive uses "information stored on the
 * terminal equipment" wording that covers both). We disclose them in a
 * parallel table so the user has a complete picture.
 */
const STORAGE_KEYS: CookieRow[] = [
  {
    name: "motionmax_cookie_consent_v2",
    party: "First",
    purpose: "Stores your granular cookie-consent choices and the policy version they were given against.",
    retention: "Until you revoke or policy version bumps",
    category: "Necessary",
  },
  {
    name: "motionmax_utm",
    party: "First",
    purpose: "First-touch UTM campaign attribution captured at landing — written to your profile at signup, then cleared.",
    retention: "Cleared at signup, max 30 days",
    category: "Functional",
  },
  {
    name: "motionmax_workspace_draft",
    party: "First",
    purpose: "Auto-saves your in-progress generation draft so you don't lose it on refresh.",
    retention: "30 days or until you publish/clear the draft",
    category: "Functional",
  },
];

export default function CookiePolicy() {
  const navigate = useNavigate();

  const handleReopenBanner = () => {
    revokeConsent();
    // Banner is mounted globally in App.tsx and listens to the
    // motionmax:consent-changed event — calling revokeConsent dispatches
    // that event so the banner re-shows immediately.
  };

  return (
    <div className="min-h-screen bg-background">
      <PageSeo
        title="Cookie Policy — MotionMax"
        description="MotionMax cookie policy. The cookies and storage we use, what they do, how long they last, and how to manage them."
        canonical="https://motionmax.io/cookies"
        breadcrumbs={[
          { name: "Home", item: "https://motionmax.io" },
          { name: "Cookie Policy", item: "https://motionmax.io/cookies" },
        ]}
      />
      <Helmet>
        <meta name="document-version" content={CONSENT_POLICY_VERSION} />
      </Helmet>
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="rounded-lg">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <button onClick={() => navigate("/")}>
              <ThemedLogo className="h-8 w-auto" />
            </button>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Cookie Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">
          Consent policy version <span className="font-mono">{CONSENT_POLICY_VERSION}</span>
        </p>

        <div className="space-y-8 text-muted-foreground">
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">1. What this page covers</h2>
            <p>
              This page lists every cookie and locally-stored item motionmax sets on your browser, what
              each one does, how long it lasts, and whether it is set by us (first-party) or by a vendor
              we use to provide the Service (third-party). We disclose localStorage and sessionStorage
              entries on the same basis as cookies because UK ICO and EU CNIL guidance treats them
              identically for consent purposes under the ePrivacy Directive.
            </p>
            <p>
              You can change your category-level choices at any time using the button at the bottom of
              this page, the "Cookie preferences" link in our footer, or the Cookie preferences section
              in your account Settings. Necessary cookies cannot be disabled because the site cannot
              function without them.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">2. Categories</h2>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                <strong className="text-foreground">Necessary</strong> — auth session, security tokens,
                billing state. Required for the site to function; always on.
              </li>
              <li>
                <strong className="text-foreground">Functional</strong> — language preference, theme
                (dark/light), sidebar state, draft auto-save.
              </li>
              <li>
                <strong className="text-foreground">Analytics</strong> — Google Analytics 4 page-view
                metrics and Sentry session replay on errors. Loaded only after you grant analytics
                consent.
              </li>
              <li>
                <strong className="text-foreground">Marketing</strong> — pixel tracking and
                retargeting. Not currently used; reserved so your prior choice carries forward if we
                introduce them.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">3. Cookies we set</h2>
            <div className="not-prose overflow-x-auto rounded-md border border-border/40">
              <table className="w-full text-xs">
                <thead className="bg-muted/30">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold text-foreground">Name</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Party</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Category</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Purpose</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Retention</th>
                  </tr>
                </thead>
                <tbody>
                  {COOKIES.map((c) => (
                    <tr key={c.name} className="border-t border-border/30 align-top">
                      <td className="px-3 py-2 font-mono text-[11px] text-foreground whitespace-nowrap">
                        {c.name}
                      </td>
                      <td className="px-3 py-2">
                        {c.party}
                        {c.party === "Third" && c.vendor ? (
                          <>
                            {" — "}
                            {c.vendorPrivacyUrl ? (
                              <a
                                href={c.vendorPrivacyUrl}
                                className="text-primary hover:underline"
                                target="_blank"
                                rel="noreferrer"
                              >
                                {c.vendor}
                              </a>
                            ) : (
                              c.vendor
                            )}
                          </>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{c.category}</td>
                      <td className="px-3 py-2 leading-snug">{c.purpose}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.retention}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">4. Browser storage we use</h2>
            <p>
              The following entries are stored in your browser's localStorage. They are not transmitted
              to any server unless explicitly noted, and they obey the same category-consent rules as
              cookies.
            </p>
            <div className="not-prose overflow-x-auto rounded-md border border-border/40">
              <table className="w-full text-xs">
                <thead className="bg-muted/30">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold text-foreground">Key</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Category</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Purpose</th>
                    <th className="px-3 py-2 font-semibold text-foreground">Retention</th>
                  </tr>
                </thead>
                <tbody>
                  {STORAGE_KEYS.map((c) => (
                    <tr key={c.name} className="border-t border-border/30 align-top">
                      <td className="px-3 py-2 font-mono text-[11px] text-foreground whitespace-nowrap">
                        {c.name}
                      </td>
                      <td className="px-3 py-2">{c.category}</td>
                      <td className="px-3 py-2 leading-snug">{c.purpose}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.retention}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5. Third-party vendors</h2>
            <p>The third-party services whose cookies appear above are:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong className="text-foreground">Stripe</strong> — payment processing.{" "}
                <a
                  href="https://stripe.com/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Privacy
                </a>
              </li>
              <li>
                <strong className="text-foreground">Google Analytics 4</strong> — aggregated usage
                analytics, consent-gated.{" "}
                <a
                  href="https://policies.google.com/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Privacy
                </a>
              </li>
              <li>
                <strong className="text-foreground">Sentry</strong> — error reporting and consent-gated
                session replay.{" "}
                <a
                  href="https://sentry.io/privacy/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Privacy
                </a>
              </li>
            </ul>
            <p>
              The full subprocessor list — including those that do not set browser cookies — is in our{" "}
              <a href="/privacy#5" className="text-primary hover:underline">
                Privacy Policy &sect;5
              </a>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. Global Privacy Control (GPC)</h2>
            <p>
              If your browser sends the Global Privacy Control signal (the{" "}
              <span className="font-mono">Sec-GPC: 1</span> header or{" "}
              <span className="font-mono">navigator.globalPrivacyControl</span> property), we treat it
              as a binding opt-out of the Analytics and Marketing categories — even if you have not yet
              interacted with the consent banner. The Necessary and Functional categories remain on so
              the site continues to function. GPC takes precedence: if you grant analytics consent in
              the banner but your browser also sends GPC, the GPC opt-out wins until you disable it at
              the browser level.
            </p>
            <p>
              California residents: this honours the California "right to opt out of sale/share" under
              the CCPA / CPRA as required by AG advisory (Sephora settlement, 2022).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">7. Manage your preferences</h2>
            <p>
              Use the button below to wipe your stored consent record and re-open the granular consent
              banner. You can also browser-side delete cookies via your browser's privacy settings, and
              clear localStorage from the developer tools.
            </p>
            <div className="not-prose pt-2">
              <Button
                type="button"
                onClick={handleReopenBanner}
                className="bg-[#14C8CC] text-[#0A0D0F] hover:bg-[#0FA6AE]"
              >
                Manage cookie preferences
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">8. Contact</h2>
            <p>
              Questions about this policy? Email{" "}
              <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">
                privacy@motionmax.io
              </a>
              .
            </p>
          </section>
        </div>
      </main>

      <footer className="border-t border-border/30 py-8 mt-12">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <span>© 2026 MotionMax. All rights reserved.</span>
          <div className="flex flex-wrap gap-4">
            <a href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-foreground transition-colors">Terms of Service</a>
            <a href="/cookies" className="hover:text-foreground transition-colors">Cookie Policy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
