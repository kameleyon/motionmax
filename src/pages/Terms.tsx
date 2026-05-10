import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import PageSeo from "@/components/PageSeo";
import { ArrowLeft } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LEGAL_VERSIONS, LEGAL_LAST_UPDATED_LABEL } from "@/config/legal-versions";

export default function Terms() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <PageSeo
        title="Terms of Service — MotionMax"
        description="MotionMax terms of service. Review our usage policies, subscription terms, and user agreement."
        canonical="https://motionmax.io/terms"
        breadcrumbs={[
          { name: "Home", item: "https://motionmax.io" },
          { name: "Terms of Service", item: "https://motionmax.io/terms" },
        ]}
      />
      {/* B-NEW-13 (Comply L-B-02): emit document-version meta so crawlers,
          archiving services, and the in-app version-mismatch hook can
          machine-read the binding version of this page. */}
      <Helmet>
        <meta name="document-version" content={LEGAL_VERSIONS.tos} />
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
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">
          Version <span className="font-mono">{LEGAL_VERSIONS.tos}</span> &nbsp;·&nbsp; Last updated: {LEGAL_LAST_UPDATED_LABEL}
        </p>

        <div className="prose prose-sm max-w-none space-y-8 text-muted-foreground">

          {/* C-13-8 / Tongue TONGUE-11: English-only disclosure. Wave 3
              B-NEW-11 reduced the marketing "11 languages" claim to
              "Multilingual voiceover", largely defusing the GDPR
              Art. 12(1) intelligibility concern; this notice records
              the residual position and gives the user a clear contact
              path before being bound. */}
          <section className="rounded-md border border-border/40 bg-muted/20 p-4 not-prose">
            <p className="text-sm leading-relaxed m-0">
              This document is provided in English. We are working to translate it into additional languages.
              If you do not understand any provision, please contact us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>
              {" "}for clarification before using the Service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p>By accessing or using MotionMax ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, you may not use the Service. These terms apply to all visitors, users, and others who access the Service.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">2. Description of Service</h2>
            <p>MotionMax is an AI-powered content creation platform that allows users to generate videos, audio narratives, and visual content from text inputs. The Service is provided on a subscription basis with various plan tiers as described on our Pricing page.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">3. Account Registration</h2>
            <p>To use the Service, you must create an account by providing a valid email address and password. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You must notify us immediately of any unauthorized use of your account.</p>
            <p>You must be at least 18 years of age to create an account and use the Service.</p>
            {/* Wave E-Legal Part D: COPPA carve-out + GDPR Art. 8
                deferral. Aligns ToS with Privacy §10 and AUP §2.2. */}
            <p><strong className="text-foreground">Children under 13.</strong> The Service is not directed to children under 13. We do not knowingly collect personal information from children under 13. If we learn that we have collected information from a child under 13 we will delete it promptly; parents or guardians who believe their child has registered should contact <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a>. In jurisdictions where the age of digital consent is higher than 13, the same prohibition applies at the higher local threshold.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">4. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Generate content that is unlawful, harmful, threatening, abusive, defamatory, or otherwise objectionable</li>
              <li>Violate any intellectual property rights of third parties</li>
              <li>Impersonate any person or entity or misrepresent your affiliation with any person or entity</li>
              <li>Upload or transmit viruses or any other malicious code</li>
              <li>Attempt to gain unauthorized access to any portion of the Service</li>
              <li>Generate synthetic media (deepfakes) of real individuals without their explicit consent</li>
              <li>Use the Service for any commercial purpose that violates applicable law</li>
            </ul>
            <p>We reserve the right to terminate accounts that violate these usage policies.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5. Intellectual Property</h2>
            <p>You retain ownership of the content you provide as input to the Service (your scripts, documents, and text). By submitting content to the Service, you grant MotionMax a limited, non-exclusive license to process that content solely for the purpose of providing the Service to you.</p>
            <p>The AI-generated outputs produced by the Service are owned by you, subject to the limitations of the underlying AI model licenses and any applicable terms of the third-party AI providers used to generate that content. These providers include Kling (image-to-video), Hypereal (image generation), ElevenLabs (voice synthesis and voice cloning), and Google Gemini (image generation and research), among others. You are responsible for reviewing and complying with the usage rights and restrictions published by each provider. MotionMax retains all rights to the Service itself, including its software, design, and underlying technology.</p>
          </section>

          {/* C-13-7 (Comply L-C-08): §5 previously lacked any warranty
              disclaimer for output non-infringement, an IP indemnification
              clause, and a copyright-uncertainty disclosure. After
              Andersen v. Stability AI (N.D. Cal.) and Getty v. Stability
              AI (UK High Court), generative AI providers face real
              exposure on (a) output that incorporates copyrighted
              training material and (b) the open question of whether
              AI-generated outputs are themselves copyrightable. §5.A
              strips warranty, §5.B shifts IP risk to the user-creator,
              §5.C honestly discloses the unsettled state of the law. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5.A No Warranty for AI Output</h2>
            <p>AI-generated outputs produced by the Service are provided <strong className="text-foreground">"as is" and without warranty of any kind</strong>. We make NO warranty, express or implied, that any output: (i) does not infringe third-party intellectual property rights, including copyright, trademark, publicity, or moral rights; (ii) is original or free of similarities to existing works; (iii) is non-defamatory or otherwise lawful in your jurisdiction; or (iv) is fit, suitable, or safe for any particular purpose. You are solely responsible for reviewing each output before publication or distribution and for obtaining any clearances, licences, or releases your intended use requires.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5.B IP Indemnification</h2>
            <p>You agree to <strong className="text-foreground">defend, indemnify, and hold harmless MotionMax</strong>, its officers, directors, employees, contractors, and licensors against any third-party claim, demand, action, damage, loss, liability, judgment, settlement, fine, fee, or expense (including reasonable attorneys' fees) arising from or related to your use, publication, broadcast, distribution, monetisation, or other exploitation of AI-generated content created with the Service — including without limitation claims of intellectual-property infringement, right-of-publicity violation, defamation, false advertising, unfair competition, or breach of any release or licence you were responsible for obtaining. This indemnification survives termination of these Terms.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5.C Copyright Uncertainty Disclosure</h2>
            <p>The copyright status of AI-generated content is <strong className="text-foreground">unsettled in many jurisdictions</strong>. Recent and ongoing matters — including <em>Andersen v. Stability AI</em> (N.D. Cal., 2023–) and <em>Getty Images v. Stability AI</em> (UK High Court / Delaware, 2023–) — have not yet resolved whether AI-generated outputs are copyrightable, who owns any resulting rights, or whether and to what extent training on copyrighted material affects the legality of downstream outputs. The U.S. Copyright Office's current position (as of the date of this document) is that purely AI-generated content is generally <em>not</em> registrable, and analogous positions exist in other registrars. <strong className="text-foreground">We make no representation about the copyrightability, ownership, registrability, or enforceability of outputs in any jurisdiction.</strong> If you rely on the legal status of an output for any commercial purpose, you should seek your own legal counsel.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. Credits and Billing</h2>
            {/* B-NEW-21 (2026-05-10): tier prices + credit allotments restated. ToS bumped to v2 — existing
                users get the TermsUpdateModal on next sign-in. */}
            <p>The Service operates on a credit-based system. Credits are consumed when generating content. Monthly subscription credits expire on the 28th of each month and do not roll over. Daily refresh credits added on top of every plan, and purchased credit packs (top-ups), do not expire — but credit packs are non-refundable once consumed.</p>
            <p>Current plan limits — including credits per month, voice-clone and automation slots, watermark removal, and priority-queue access — are published on the <a href="/pricing" className="text-primary hover:underline">Pricing page</a> and incorporated into these Terms by reference. Specifically: the Free tier includes 60 credits per month plus 100 daily refresh credits with full editor access; the Creator plan includes 500 credits per month (or 6,000 per year on annual billing) at $29/month after the introductory period (or $14.50/month billed annually as $174/year), with 1 voice-clone slot, 1 automation slot, watermark removal, and 200 daily refresh credits; the Studio plan includes 2,000 credits per month (or 24,000 per year) at $129/month after the introductory period (or $64.50/month billed annually as $774/year), with 5 voice-clone slots, 5 automation slots, watermark removal, priority queue, and 200 daily refresh credits. Both paid plans support a multi-pack ladder of 1×–6× the base allotment for that billing cycle.</p>
            <p>Top-up credit packs are available to all tiers (including Free) as one-time purchases: Quick (250 credits / $14.99), Plus (500 credits / $24.99), Power (1,000 credits / $44.99), Studio Pack (2,500 credits / $99.99), and Pro Pack (5,000 credits / $179.99).</p>
            <p>Limited-time promotional pricing — when shown — applies only to the first three (3) monthly billing cycles of new monthly subscriptions; pricing automatically reverts to the standard monthly rate from the fourth billing cycle onward. Yearly subscriptions are billed in full up-front for the entire 12-month term. MotionMax reserves the right to adjust plan limits or prices with 30 days' prior notice.</p>
            <p>Subscription fees are billed in advance on a monthly or annual basis. You may cancel your subscription at any time; cancellation takes effect at the end of the current billing period. No partial refunds are issued for unused subscription periods.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">7. Voice Cloning</h2>
            <p>If you use the voice cloning feature, you represent and warrant that you have the legal right to clone the voice being recorded — either your own voice or a voice for which you have obtained explicit written consent from the voice owner. Using voice cloning to impersonate individuals without consent is strictly prohibited and may result in immediate account termination and legal liability.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">8. Disclaimer of Warranties</h2>
            <p>The Service is provided "as is" and "as available" without warranties of any kind, either express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, or non-infringement. MotionMax does not warrant that the Service will be uninterrupted, error-free, or that AI-generated content will meet your specific requirements.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">9. Limitation of Liability</h2>
            <p>To the fullest extent permitted by law, MotionMax shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service, including but not limited to loss of profits, data, or goodwill. Our total liability for any claim arising from these terms or your use of the Service shall not exceed the amount you paid us in the twelve months preceding the claim.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">10. Termination</h2>
            <p>We reserve the right to suspend or terminate your account at any time for violation of these Terms of Service, with or without notice. Upon termination, your right to use the Service ceases immediately. You may export your generated content before termination; we will make reasonable efforts to provide access for a brief period following notice of termination where possible.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">11. Changes to Terms</h2>
            <p>We may update these Terms of Service from time to time. We will notify users of material changes via email or a prominent notice on the Service. Continued use of the Service after changes constitutes acceptance of the updated terms.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">12. Auto-Renewal Disclosure</h2>
            <p>Paid subscriptions automatically renew at the end of each billing period (monthly or annual) at the then-current rate unless you cancel before the renewal date. You will receive an email reminder before your renewal date. To cancel, visit your account settings or contact us at support@motionmax.io. Cancellation takes effect at the end of the current billing period; you retain access to the Service until that date.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">13. EU Consumer Right of Withdrawal</h2>
            <p>If you are a consumer located in the European Union or European Economic Area, you have the right to withdraw from a purchase of a digital service within 14 days of the transaction date (the "cooling-off period") without giving any reason, in accordance with the EU Consumer Rights Directive.</p>
            <p><strong className="text-foreground">Waiver of withdrawal right:</strong> By accessing or using the Service (including initiating any content generation) before the 14-day cooling-off period has expired, you expressly request immediate performance of the contract and acknowledge that you lose your right of withdrawal once the service has been fully performed. If you have not yet accessed the Service, you may exercise your right of withdrawal by contacting us at support@motionmax.io within 14 days of purchase.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">14. Dispute Resolution</h2>
            <p>Before initiating any formal legal proceeding, you agree to provide MotionMax with written notice of your dispute at support@motionmax.io, describing the nature of the claim and the relief sought. MotionMax will have 30 days from receipt of this notice to attempt to resolve the dispute through good-faith negotiation. If the dispute is not resolved within that period, either party may pursue the remedies described in Section 15.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">15. Governing Law</h2>
            <p>These Terms of Service are governed by and construed in accordance with the laws of the State of Delaware, United States, without regard to its conflict of law principles. Any dispute that cannot be resolved through the process described in Section 14 shall be subject to the exclusive jurisdiction of the state and federal courts located in Delaware, and you consent to personal jurisdiction in such courts. Nothing in this section limits the rights of EU/EEA consumers under mandatory local consumer protection laws.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">16. Severability</h2>
            <p>If any provision of these Terms of Service is found to be unlawful, void, or unenforceable for any reason, that provision shall be deemed severable from these Terms and shall not affect the validity and enforceability of the remaining provisions, which shall continue in full force and effect.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">17. Contact</h2>
            <p>If you have questions about these Terms of Service, please contact us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>.
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
