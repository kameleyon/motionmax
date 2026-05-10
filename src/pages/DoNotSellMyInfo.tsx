import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import PageSeo from "@/components/PageSeo";
import { ArrowLeft } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * DoNotSellMyInfo — California "Do Not Sell or Share My Personal
 * Information" landing page (Wave E-Legal Part G).
 *
 * The CCPA / CPRA give California residents the right to opt out of
 * "sale" or "sharing" of their personal information. Even when a
 * business does NOT engage in either, the AG has consistently held
 * (Sephora settlement, 2022) that a clear, dedicated page is the
 * affirmative way to communicate the position. This page is that
 * surface for motionmax.
 *
 * We do not sell or share. The page therefore acts as both the
 * disclosure and the request channel for any user who still wants to
 * exercise the right or submit a related CCPA request.
 */
export default function DoNotSellMyInfo() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <PageSeo
        title="Do Not Sell or Share My Personal Information — MotionMax"
        description="MotionMax does not sell or share personal information. Submit a CCPA / CPRA request and learn how we honour the Global Privacy Control signal."
        canonical="https://motionmax.io/do-not-sell"
        breadcrumbs={[
          { name: "Home", item: "https://motionmax.io" },
          { name: "Do Not Sell My Info", item: "https://motionmax.io/do-not-sell" },
        ]}
      />
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
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">
          Do Not Sell or Share My Personal Information
        </h1>
        <p className="text-sm text-muted-foreground mb-10">
          California Consumer Privacy Act (CCPA) / California Privacy Rights Act (CPRA)
        </p>

        <div className="space-y-8 text-muted-foreground">
          <section className="space-y-3 rounded-md border border-[#14C8CC]/30 bg-[#14C8CC]/5 p-4">
            <h2 className="text-lg font-semibold text-foreground m-0">Our position</h2>
            <p className="m-0">
              <strong className="text-foreground">MotionMax does not sell or share personal information.</strong>{" "}
              We do not engage in "sale" of personal information as defined by Cal. Civ. Code §1798.140(ad),
              and we do not engage in "sharing" for cross-context behavioural advertising as defined by
              §1798.140(ah). We do not exchange personal information for monetary or other valuable
              consideration. If our practices ever change, we will update this page and the Privacy
              Policy, and we will provide a working opt-out mechanism on this page before any sale or
              sharing begins.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">What this means in practice</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>We do not run third-party advertising pixels for retargeting.</li>
              <li>We do not sell or license your account data, generated content, voice samples, or usage history to data brokers, advertising networks, or analytics resellers.</li>
              <li>We disclose personal information only to the subprocessors listed in our{" "}
                <a href="/privacy#5" className="text-primary hover:underline">Privacy Policy §5</a>{" "}
                strictly to deliver the Service you requested.
              </li>
              <li>The Analytics cookies we use (Google Analytics 4, Sentry session replay) are consent-gated and configured for first-party measurement; they are not used for cross-context behavioural advertising.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Global Privacy Control (GPC)</h2>
            <p>
              We honour the Global Privacy Control signal. If your browser sends{" "}
              <span className="font-mono">Sec-GPC: 1</span> or sets{" "}
              <span className="font-mono">navigator.globalPrivacyControl = true</span>, we automatically
              treat it as a valid opt-out of the Analytics and Marketing cookie categories — without
              requiring a separate request. This is consistent with the California Attorney General's
              guidance following the 2022 Sephora settlement.
            </p>
            <p>
              You can read more about how GPC interacts with our consent banner on the{" "}
              <a href="/cookies#6" className="text-primary hover:underline">Cookie Policy §6</a>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Submit a CCPA request</h2>
            <p>
              California residents may also submit any CCPA / CPRA request — to know, to delete, to
              correct, to limit use of Sensitive Personal Information (including voice biometric data),
              or to opt out — via the contact path below. An authorised agent may submit on your behalf
              with written authorisation; we may verify your identity before disclosing personal
              information.
            </p>
            <p>
              Email:{" "}
              <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">
                privacy@motionmax.io
              </a>
            </p>
            <p>
              We respond to verified requests within <strong className="text-foreground">30 days</strong>,
              with a possible extension of up to 60 additional days for complex requests (we will notify
              you within the initial 30-day window).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Right to Non-Discrimination</h2>
            <p>
              We will not deny goods or services, charge different prices, or provide a different level
              of quality because you exercised any CCPA / CPRA right.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">More information</h2>
            <p>
              For the full categories of personal information we collect, business purposes, retention
              periods, and your other rights, see the California section of our{" "}
              <a href="/privacy#12" className="text-primary hover:underline">Privacy Policy §12</a>.
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
            <a href="/do-not-sell" className="hover:text-foreground transition-colors">Do Not Sell My Info</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
