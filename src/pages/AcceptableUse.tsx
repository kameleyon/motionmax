import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemedLogo } from "@/components/ThemedLogo";

export default function AcceptableUse() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-4 px-4 sm:px-6">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <ThemedLogo className="h-8 w-auto" />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-10 space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Acceptable Use Policy</h1>
          <p className="mt-2 text-sm text-muted-foreground">Last updated: February 2026</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">1. Overview</h2>
          <p className="text-muted-foreground leading-relaxed">
            MotionMax provides AI-powered video generation tools. By using our platform, you agree to use it responsibly
            and in accordance with this Acceptable Use Policy ("AUP"). Violations may result in account suspension or termination.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">2. Prohibited Content</h2>
          <p className="text-muted-foreground leading-relaxed">You may not use MotionMax to create or distribute content that:</p>
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>Is illegal, harmful, threatening, abusive, harassing, or defamatory</li>
            <li>Infringes any intellectual property rights of any third party</li>
            <li>Contains explicit, pornographic, or sexually explicit material</li>
            <li>Promotes violence, terrorism, or self-harm</li>
            <li>Spreads disinformation, deepfakes, or misleading content designed to deceive</li>
            <li>Violates the privacy of any individual without consent</li>
            <li>Targets or harasses specific individuals or groups</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">3. Voice Cloning</h2>
          <p className="text-muted-foreground leading-relaxed">
            The voice cloning feature requires your explicit consent and must only be used with voices you have the legal right
            to clone. Cloning another person's voice without their explicit written consent is strictly prohibited and may
            constitute a violation of applicable laws, including those related to fraud, identity theft, and defamation.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">4. Commercial Use</h2>
          <p className="text-muted-foreground leading-relaxed">
            Commercial use of generated videos is permitted under paid plans. You are responsible for ensuring that
            content you distribute commercially complies with all applicable laws and does not infringe third-party rights.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">5. API & Automation</h2>
          <p className="text-muted-foreground leading-relaxed">
            Automated access, scraping, or reverse engineering of MotionMax's systems is prohibited without explicit written
            permission. Rate limits must be respected at all times.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">6. Enforcement</h2>
          <p className="text-muted-foreground leading-relaxed">
            We reserve the right to remove content, suspend, or permanently terminate accounts that violate this policy,
            without prior notice. Repeated violations will result in permanent bans without refund.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">7. Reporting Violations</h2>
          <p className="text-muted-foreground leading-relaxed">
            To report a violation of this policy, contact us at{" "}
            <a href="mailto:abuse@motionmax.io" className="text-primary hover:underline">abuse@motionmax.io</a>.
          </p>
        </section>

        <div className="border-t border-border/30 pt-6 text-center">
          <p className="text-sm text-muted-foreground">
            Questions?{" "}
            <a href="mailto:support@motionmax.io" className="text-primary hover:underline">Contact us</a>
            {" · "}
            <button onClick={() => navigate("/terms")} className="text-primary hover:underline">Terms</button>
            {" · "}
            <button onClick={() => navigate("/privacy")} className="text-primary hover:underline">Privacy</button>
          </p>
        </div>
      </main>
    </div>
  );
}
