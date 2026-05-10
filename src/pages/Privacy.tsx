import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import PageSeo from "@/components/PageSeo";
import { ArrowLeft } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LEGAL_VERSIONS, LEGAL_LAST_UPDATED_LABEL } from "@/config/legal-versions";

export default function Privacy() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <PageSeo
        title="Privacy Policy — MotionMax"
        description="MotionMax privacy policy. Learn how we collect, use, and protect your personal data."
        canonical="https://motionmax.io/privacy"
        breadcrumbs={[
          { name: "Home", item: "https://motionmax.io" },
          { name: "Privacy Policy", item: "https://motionmax.io/privacy" },
        ]}
      />
      {/* B-NEW-13 (Comply L-B-02): document-version meta — see Terms.tsx. */}
      <Helmet>
        <meta name="document-version" content={LEGAL_VERSIONS.privacy} />
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
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">
          Version <span className="font-mono">{LEGAL_VERSIONS.privacy}</span> &nbsp;·&nbsp; Last updated: {LEGAL_LAST_UPDATED_LABEL}
        </p>

        <div className="prose prose-sm max-w-none space-y-8 text-muted-foreground">

          {/* C-13-8 / Tongue TONGUE-11: English-only disclosure. The
              GDPR Art. 12(1) "intelligible-to-claimed-audience" concern
              was largely defused in Wave 3 (B-NEW-11) by reducing the
              marketing "11 languages" claim to "Multilingual voiceover";
              this notice records the residual position so users have a
              clear contact path before being bound. */}
          <section className="rounded-md border border-border/40 bg-muted/20 p-4 not-prose">
            <p className="text-sm leading-relaxed m-0">
              This document is provided in English. We are working to translate it into additional languages.
              If you do not understand any provision, please contact us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>
              {" "}for clarification before using the Service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">1. Introduction</h2>
            <p>MotionMax ("we", "our", "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use the MotionMax platform. Please read this policy carefully. By using the Service, you consent to the practices described herein.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">2. Information We Collect</h2>
            <p><strong className="text-foreground">Account Information:</strong> When you register, we collect your email address and a hashed password. We do not store plaintext passwords.</p>
            <p><strong className="text-foreground">Content You Provide:</strong> We store the text, documents, and scripts you submit to generate content, as well as the outputs produced (images, video, audio). This data is stored to power your project history and allow you to revisit past generations.</p>
            <p><strong className="text-foreground">Voice Data:</strong> If you use the voice cloning feature, we collect voice recordings you upload. These recordings are processed by our third-party voice synthesis provider and stored as voice models associated with your account. You can delete cloned voices at any time from your settings.</p>
            <p><strong className="text-foreground">Usage Data:</strong> We collect information about how you use the Service, including generation history, credit consumption, feature usage, and session activity. This data is used to improve the platform and prevent abuse.</p>
            <p><strong className="text-foreground">Payment Information:</strong> Payment processing is handled by Stripe. We do not store your full credit card details. We receive and store a Stripe customer ID and subscription status to manage your billing.</p>
            <p><strong className="text-foreground">Technical Data:</strong> We automatically collect IP addresses, browser type, operating system, and device identifiers for security and analytics purposes.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">3. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>To provide, maintain, and improve the Service</li>
              <li>To process your content generation requests</li>
              <li>To manage your account, subscription, and credit balance</li>
              <li>To send transactional emails (email verification, password reset, billing receipts)</li>
              <li>To detect and prevent fraud, abuse, and violations of our Terms of Service</li>
              <li>To comply with legal obligations</li>
              <li>To analyze aggregate usage patterns to improve the platform (using anonymized data)</li>
            </ul>
            <p>We do not sell your personal data to third parties. We do not use your generated content to train AI models without explicit opt-in consent.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">4. Legal Basis for Processing (GDPR Art. 6)</h2>
            <p>If you are located in the European Economic Area (EEA), we process your personal data under the following legal bases:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">Performance of a contract (Art. 6(1)(b)):</strong> Processing your account information, content, credits, and billing data to provide the Service you have subscribed to.</li>
              <li><strong className="text-foreground">Legitimate interests (Art. 6(1)(f)):</strong> Security monitoring, fraud prevention, error logging, and aggregate analytics that do not override your fundamental rights.</li>
              <li><strong className="text-foreground">Compliance with legal obligations (Art. 6(1)(c)):</strong> Retaining financial records, responding to lawful data requests, and complying with applicable law.</li>
              <li><strong className="text-foreground">Consent (Art. 6(1)(a)):</strong> Analytics cookies (Google Analytics 4), session replay (Sentry), and AI training opt-in (if you explicitly enable it). You may withdraw consent at any time via the cookie banner or by contacting us.</li>
            </ul>
          </section>

          {/* C-13-5 (Comply L-C-06): GDPR Art. 28(2) requires the full
              subprocessor list to be available to ALL customers, not
              gated behind an enterprise tier. The complete list is now
              enumerated publicly below, with company name, country of
              processing, purpose, and link to the third party's privacy
              policy / DPA. We notify all customers — not just enterprise
              — at least 10 business days before adding or replacing a
              subprocessor that processes personal data. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5. Third-Party Services &amp; Subprocessors</h2>
            <p>The following list is the complete, current set of subprocessors we use to operate the platform. Your data is transmitted securely and only as necessary for service delivery. Each entry below lists the subprocessor's primary processing location and a link to their published privacy / DPA terms.</p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li><strong className="text-foreground">Supabase</strong> (United States) — managed Postgres, authentication, and object storage for accounts, projects, generations, and voice samples. <a href="https://supabase.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://supabase.com/legal/dpa" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">Vercel</strong> (United States) — frontend hosting, edge network, and serverless functions for the marketing site and dashboard. <a href="https://vercel.com/legal/privacy-policy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://vercel.com/legal/dpa" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">Render</strong> (United States) — background worker hosting for long-running render and audio jobs. <a href="https://render.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://render.com/legal/data-processing-agreement" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">Cloudflare</strong> (United States / Global) — CDN, DNS, and DDoS protection for static assets and the marketing domain. <a href="https://www.cloudflare.com/privacypolicy/" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://www.cloudflare.com/cloudflare-customer-dpa/" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">Stripe</strong> (United States) — payment processing, subscriptions, invoices, and tax. We do not store credit-card numbers. <a href="https://stripe.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://stripe.com/legal/dpa" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">Resend</strong> (United States) — transactional email delivery (verification, password reset, billing receipts, lifecycle drips). <a href="https://resend.com/legal/privacy-policy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://resend.com/legal/dpa" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">Sentry</strong> (United States) — error reporting, stack traces, and (only when you consent) session replay. No generated content or passwords are captured. <a href="https://sentry.io/privacy/" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://sentry.io/legal/dpa/" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">BetterStack</strong> (European Union) — external uptime monitoring and incident logging. <a href="https://betterstack.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">Hypereal</strong> (United States) — image and video model inference. Receives your text prompts and uploaded reference images. <a href="https://www.hypereal.io/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">Kling (Kuaishou)</strong> (China / United States) — image-to-video conversion. Scene images and motion parameters are sent to Kling's API. <a href="https://klingai.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">OpenRouter</strong> (United States) — LLM gateway used to route script-generation and structured-output calls (including Anthropic Claude). <a href="https://openrouter.ai/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">Google (Gemini + Cloud TTS)</strong> (United States) — Gemini Flash TTS and image generation; Google Cloud TTS for default voices. <a href="https://policies.google.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">Fish Audio</strong> (Singapore / United States) — primary voice cloning (s2-pro). Receives voice samples and stores trained voice models scoped to your account. <a href="https://fish.audio/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">ElevenLabs</strong> (United States) — legacy voice cloning and select TTS voices. Voice samples and trained models are stored on ElevenLabs' infrastructure. <a href="https://elevenlabs.io/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://elevenlabs.io/dpa" className="text-primary hover:underline" target="_blank" rel="noreferrer">DPA</a></li>
              <li><strong className="text-foreground">LemonFox</strong> (United States) — supplemental TTS voices. <a href="https://lemonfox.ai/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">Smallest.ai</strong> (India / United States) — supplemental TTS voices. <a href="https://smallest.ai/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
              <li><strong className="text-foreground">Google Analytics 4</strong> (United States) — anonymized usage analytics, only loaded after you grant analytics consent via the cookie banner. <a href="https://policies.google.com/privacy" className="text-primary hover:underline" target="_blank" rel="noreferrer">Privacy</a></li>
            </ul>
            <p>We notify all customers — not only enterprise customers — at least 10 business days before adding or replacing a subprocessor that processes personal data, via the in-app changelog and an email to the address on file. To request copies of executed data-processing agreements or to ask about any subprocessor, contact <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a>.</p>
          </section>

          {/* Wave E-Legal Part F: previous draft claimed the "EU–US Data
              Privacy Framework" as a transfer mechanism. DPF is a formal
              U.S. Department of Commerce self-certification program — you
              cannot rely on it unless your organisation is listed on the
              DataPrivacyFramework.gov participants registry. motionmax is
              not on that registry, so the claim is removed. Standard
              Contractual Clauses + DPA available on request is the lawful
              transfer basis we actually have in place. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. International Data Transfers</h2>
            <p>MotionMax is operated from the United States. If you access the Service from the EEA, UK, or Switzerland, your personal data will be transferred to and processed in the United States, which may not provide the same level of data protection as your home jurisdiction.</p>
            <p>International transfers from the EU / EEA, UK, and Switzerland are covered by Standard Contractual Clauses (SCCs) approved by the European Commission, together with additional safeguards (technical and organisational measures, transfer impact assessments where applicable) documented in our Data Processing Addendum (DPA). Our key subprocessors (Supabase, Vercel, Stripe, ElevenLabs) maintain executed SCCs or equivalent safeguards. To request a copy of our DPA or details of the SCCs in place with a specific subprocessor, contact <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a>.</p>
          </section>

          {/* C-13-4 (Comply L-C-04): the previous paragraph promised
              "delete your personal data within 90 days" of account
              closure, but the actual product flow (Wave 2 B-NEW-6 grace
              period) gives users a 7-day reversal window followed by
              immediate purge. The 90-day text was a documented breach.
              Reconciled here to match the shipped behaviour, which is
              also more privacy-protective than the old promise. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">7. Data Retention</h2>
            <p>We retain your account data for as long as your account is active. Generated projects and content are retained for the duration of your account. If you delete a project, its content is removed from active storage; backups may persist for up to 30 days before permanent deletion.</p>
            <p>Voice clones are retained until you explicitly delete them from the Voice Lab. Deleted voice data is removed from our systems within 30 days (see also §7.1, Voice Biometric Data).</p>
            <p>If you close your account, you enter a <strong className="text-foreground">7-day grace period</strong> during which the deletion can be cancelled and your account fully restored. After the 7-day window elapses, your personal data is permanently deleted from active systems, with the limited exceptions listed below where we are required to retain certain records for legal or financial compliance purposes.</p>
            <p>The following specific data categories are automatically purged on a nightly schedule, regardless of account status:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">Activity &amp; security logs:</strong> automatically deleted after <strong className="text-foreground">90 days</strong>.</li>
              <li><strong className="text-foreground">Video generation job records</strong> (completed and failed jobs): automatically deleted after <strong className="text-foreground">30 days</strong>.</li>
              <li><strong className="text-foreground">Generation archives:</strong> automatically deleted after <strong className="text-foreground">1 year</strong>.</li>
              <li><strong className="text-foreground">Payment webhook records</strong> (raw Stripe event payloads + idempotency keys): automatically deleted after <strong className="text-foreground">90 days</strong>. The permanent invoice ledger (Stripe invoice IDs, amount, customer) is retained separately for the period required by applicable tax and accounting law.</li>
              <li><strong className="text-foreground">Financial records</strong> (Stripe invoices, tax records): retained for the period required by applicable tax and accounting law (typically 7 years), even after account deletion.</li>
            </ul>
          </section>

          {/* C-13-3 (Comply L-C-03): voice-clone audio is a biometric
              identifier under Illinois BIPA, Texas CUBI, California
              CPRA, and similar laws. BIPA enforcement is per-violation
              ($1k–$5k). The new §7.1 explicitly classifies voice audio
              as biometric data, records the consent and retention
              posture, and gives users a one-action withdrawal path
              that matches the Voice-Lab delete flow. See also the
              voice_biometric_consent_at column added in
              supabase/migrations/20260510260000_voice_biometric_consent.sql. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">7.1 Voice Biometric Data</h2>
            <p>Voice recordings you upload for voice cloning are <strong className="text-foreground">biometric identifiers</strong> under the Illinois Biometric Information Privacy Act ("BIPA"), the Texas Capture or Use of Biometric Identifier Act ("CUBI"), the California Consumer Privacy Act / California Privacy Rights Act ("CCPA / CPRA"), and similar laws in other jurisdictions.</p>
            <p>We collect, store, and process voice biometric data <strong className="text-foreground">only with your explicit written consent</strong>, obtained through a per-upload consent checkbox at the time of upload in the Voice Lab. The timestamp of your consent is recorded in our database (column <span className="font-mono">user_voices.voice_biometric_consent_at</span>) so we can prove the moment of consent if challenged.</p>
            <p>We <strong className="text-foreground">do not sell, lease, trade, or otherwise profit from</strong> your voice biometric data, and we do not disclose it to third parties except (i) to the voice-synthesis subprocessors listed in §5 strictly for the purpose of generating output you request, (ii) where compelled by a valid legal process, or (iii) with your separately obtained consent.</p>
            <p>We retain voice biometric data for the duration of your account plus 30 days from the date you delete the corresponding voice from the Voice Lab, after which it is permanently removed from our systems and from the upstream voice-synthesis subprocessor. To <strong className="text-foreground">withdraw consent</strong> at any time, delete the voice from the Voice Lab. Permanent removal from active systems is completed within 24 hours of that action; the 30-day window above relates only to backup snapshots.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">8. Your Rights</h2>
            <p>Depending on your jurisdiction, you may have the following rights regarding your personal data:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">Access:</strong> Request a copy of the personal data we hold about you</li>
              <li><strong className="text-foreground">Correction:</strong> Request correction of inaccurate data</li>
              <li><strong className="text-foreground">Deletion:</strong> Request deletion of your account and associated personal data</li>
              <li><strong className="text-foreground">Portability:</strong> Request an export of your generated content in a machine-readable format</li>
              <li><strong className="text-foreground">Objection:</strong> Object to certain processing activities</li>
            </ul>
            <p>To exercise any of these rights, contact us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>{" "}
              or{" "}
              <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a>.
              We respond to verified requests <strong className="text-foreground">within 30 days</strong> of receipt (GDPR Art. 12(3) and analogous timelines under CCPA / CPRA, LGPD, and other privacy regimes). For complex or high-volume requests, we may extend the response period by up to an additional <strong className="text-foreground">60 days</strong>; if we do, we will notify you within the initial 30-day window with the reason for the extension and an expected completion date.
            </p>
            <p>If you are in the EEA and believe your data has been processed unlawfully, you have the right to lodge a complaint with your national supervisory authority. For example, in Ireland: Data Protection Commission (dataprotection.ie); in Germany: your state's Datenschutzbehörde; in the UK: the Information Commissioner's Office (ico.org.uk).</p>
          </section>

          {/* Wave E-Legal Part B: GDPR Art. 22 requires explicit
              disclosure of any automated decision-making — including
              profiling — that produces legal effects or significantly
              affects the user. motionmax's generation pipeline produces
              content but does not produce decisions about users; all
              material account decisions (suspension, billing dispute
              outcomes, plan tier overrides) involve human review.
              Disclosing the negative is the safest posture under Art. 22
              and meaningful for users who do not know what "AI" actually
              does in this product. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">8.1 Automated Decision-Making (GDPR Art. 22)</h2>
            <p>MotionMax does <strong className="text-foreground">not</strong> use solely-automated decision-making to materially affect your rights, contracts, or legal status. The AI generation pipeline produces content (video, image, audio) based on your inputs, but does not make decisions about you — for example, we do not auto-approve or auto-deny accounts, auto-set pricing tiers, or auto-suspend users based solely on algorithmic output. All material account decisions (suspensions, ToS / AUP enforcement, billing exceptions) involve human review.</p>
            <p>Per GDPR Article 22, you have the right not to be subject to a decision based solely on automated processing that produces legal or similarly significant effects. If you believe an automated decision has affected you, you may obtain human review by contacting <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a>; we will review the decision, allow you to provide additional context, and confirm or correct the outcome.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">9. Security</h2>
            <p>We implement industry-standard security measures including encryption at rest and in transit (TLS/HTTPS), access controls, and regular security reviews. However, no method of transmission over the internet is 100% secure. We cannot guarantee absolute security of your data.</p>
          </section>

          {/* Wave E-Legal Part D: explicit COPPA carve-out for the U.S.
              under-13 threshold. ToS §3 already requires 18+ for the
              Service overall; this notice satisfies the FTC's separate
              expectation that any consumer site disclose its policy on
              collecting personal information from children under 13. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">10. Children's Privacy</h2>
            <p>The Service is not directed to children. We require all users to be at least 18 years of age (see Terms of Service §3 and AUP §3).</p>
            <p><strong className="text-foreground">United States — Children under 13 (COPPA).</strong> MotionMax is not directed to children under 13. We do not knowingly collect personal information from children under 13. If you are under 13, do not use the Service. If we learn that we have collected personal information from a child under 13, we will delete it promptly. Parents or guardians who believe their child has provided information without consent should contact <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a> and we will take immediate steps to delete the data and close the account.</p>
            <p>In jurisdictions where the age of digital consent is higher than 13 (e.g. 14 in Spain, 15 in France, 16 in Germany under GDPR Art. 8), the same prohibition applies at the higher local threshold.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">11. Changes to This Policy</h2>
            <p>We may update this Privacy Policy periodically. We will notify you of significant changes via email or a prominent notice within the Service. The "Last updated" date at the top of this page indicates when this policy was last revised.</p>
          </section>

          {/* Wave E-Legal Part G: full California section refactor —
              CCPA / CPRA Notice at Collection (Cal. Civ. Code §1798.100),
              Limit Use of Sensitive Personal Information (§1798.121),
              right to opt out of sale or sharing with a link to the
              standalone /do-not-sell landing page. DSAR window unified
              to 30 days (was 45) to align with the general response
              timeline in §8 — CCPA's statutory floor is 45 days but
              there is no prohibition on responding faster, and a single
              clock simplifies operations and is more user-friendly. */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">12. California Residents (CCPA / CPRA)</h2>
            <p>If you are a California resident, the California Consumer Privacy Act ("CCPA") as amended by the California Privacy Rights Act ("CPRA") grants you the rights described below. The disclosures in this section also constitute our "Notice at Collection" required under Cal. Civ. Code §1798.100.</p>

            <h3 className="text-base font-semibold text-foreground pt-2">Notice at Collection</h3>
            <p>We collect the following categories of personal information, as defined in Cal. Civ. Code §1798.140(c):</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">Identifiers:</strong> email address, IP address, account ID. Purpose: account creation, authentication, security, communications. Retention: duration of account + 7-day grace period; financial records 7 years.</li>
              <li><strong className="text-foreground">Customer records:</strong> billing email, Stripe customer ID, subscription status. Purpose: billing and tax. Retention: 7 years for tax compliance.</li>
              <li><strong className="text-foreground">Commercial information:</strong> purchase history, credit consumption. Purpose: account management, service delivery. Retention: duration of account.</li>
              <li><strong className="text-foreground">Internet activity:</strong> usage of the Service, generation history. Purpose: service delivery, abuse prevention, aggregate analytics. Retention: 30 days for video job records, 1 year for archives, 90 days for security logs.</li>
              <li><strong className="text-foreground">Sensory data (Sensitive PI):</strong> voice recordings uploaded for cloning (biometric identifiers — see §7.1). Purpose: voice synthesis output you request. Retention: account life + 30 days after deletion. We <strong className="text-foreground">limit use of this Sensitive PI</strong> to the purposes disclosed in §7.1 (CCPA §1798.121 right to limit).</li>
              <li><strong className="text-foreground">Inferences:</strong> none drawn beyond service operation; we do not build behavioural profiles for advertising.</li>
            </ul>
            <p>We do not collect categories under §1798.140(c) that are not listed above (no precise geolocation beyond IP-level, no biometric data other than voice samples, no professional or education information, no genetic data).</p>

            <h3 className="text-base font-semibold text-foreground pt-2">Your Rights</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">Right to Know:</strong> request the categories and specific pieces of personal information we have collected about you, the categories of sources, the business purpose, and the categories of third parties with whom we share it.</li>
              <li><strong className="text-foreground">Right to Delete:</strong> request deletion of personal information we have collected about you, subject to statutory exceptions (e.g. financial records we are required to retain).</li>
              <li><strong className="text-foreground">Right to Correct:</strong> request correction of inaccurate personal information.</li>
              <li><strong className="text-foreground">Right to Limit Use of Sensitive Personal Information (§1798.121):</strong> direct us to limit use of your Sensitive PI (in our case, voice biometric data) to the disclosed purposes. We already restrict this category by default — see §7.1.</li>
              <li><strong className="text-foreground">Right to Opt Out of Sale or Sharing:</strong> <strong className="text-foreground">MotionMax does not sell or share personal information for cross-context behavioural advertising, monetary consideration, or any other form of "sale" as defined under CCPA §1798.140(ad) or "sharing" under §1798.140(ah).</strong> We disclose this explicitly via our <a href="/do-not-sell" className="text-primary hover:underline">Do Not Sell or Share My Personal Information</a> page, which also describes how to submit a CCPA request and how we honour the Global Privacy Control (GPC) signal.</li>
              <li><strong className="text-foreground">Right to Non-Discrimination:</strong> we will not discriminate against you for exercising any CCPA / CPRA right.</li>
            </ul>

            <h3 className="text-base font-semibold text-foreground pt-2">How to Exercise</h3>
            <p>To exercise your California privacy rights, contact <a href="mailto:privacy@motionmax.io" className="text-primary hover:underline">privacy@motionmax.io</a>. We respond to verified requests <strong className="text-foreground">within 30 days</strong>; for complex requests we may extend by up to 60 additional days with notice, consistent with our general DSAR timeline in §8 (CCPA's statutory ceiling is 45 days, extendable; we hold ourselves to the faster GDPR Art. 12(3) cadence as a unified policy).</p>
            <p>An authorised agent may submit a request on your behalf; we will require written authorisation and may verify your identity before disclosing personal information.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">13. Contact Us</h2>
            <p>If you have questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us at:{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>
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
