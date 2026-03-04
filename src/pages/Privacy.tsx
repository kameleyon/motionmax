import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function Privacy() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="rounded-full">
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
        <p className="text-sm text-muted-foreground mb-10">Last updated: February 2026</p>

        <div className="prose prose-sm max-w-none space-y-8 text-muted-foreground">

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
            <h2 className="text-lg font-semibold text-foreground">4. Third-Party Services</h2>
            <p>We use the following categories of third-party services to operate the platform:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">AI Model Providers:</strong> We send your text and content inputs to AI providers (including Google and OpenAI) for processing. These providers process data under their own privacy policies.</li>
              <li><strong className="text-foreground">Voice Synthesis:</strong> Voice recordings and cloning requests are processed by our voice AI partner. Voice data is transmitted securely and not shared further.</li>
              <li><strong className="text-foreground">Payment Processing:</strong> Stripe handles all payment data. See Stripe's privacy policy at stripe.com/privacy.</li>
              <li><strong className="text-foreground">Cloud Infrastructure:</strong> Our backend infrastructure is hosted on secure cloud providers. Data is stored in encrypted databases with access controls.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5. Data Retention</h2>
            <p>We retain your account data for as long as your account is active. Generated projects and content are retained for the duration of your account. If you delete a project, its content is removed from active storage; backups may persist for up to 30 days before permanent deletion.</p>
            <p>Voice clones are retained until you explicitly delete them from the Voice Lab. Deleted voice data is removed from our systems within 30 days.</p>
            <p>If you close your account, we will delete your personal data within 90 days, except where we are required to retain it for legal or financial compliance purposes.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. Your Rights</h2>
            <p>Depending on your jurisdiction, you may have the following rights regarding your personal data:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong className="text-foreground">Access:</strong> Request a copy of the personal data we hold about you</li>
              <li><strong className="text-foreground">Correction:</strong> Request correction of inaccurate data</li>
              <li><strong className="text-foreground">Deletion:</strong> Request deletion of your account and associated personal data</li>
              <li><strong className="text-foreground">Portability:</strong> Request an export of your generated content in a machine-readable format</li>
              <li><strong className="text-foreground">Objection:</strong> Object to certain processing activities</li>
            </ul>
            <p>To exercise any of these rights, contact us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>.
              We will respond to verified requests within 30 days.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">7. Security</h2>
            <p>We implement industry-standard security measures including encryption at rest and in transit (TLS/HTTPS), access controls, and regular security reviews. However, no method of transmission over the internet is 100% secure. We cannot guarantee absolute security of your data.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">8. Children's Privacy</h2>
            <p>The Service is not directed to individuals under the age of 18. We do not knowingly collect personal information from children. If we become aware that a child has provided us with personal information, we will delete it promptly.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">9. Changes to This Policy</h2>
            <p>We may update this Privacy Policy periodically. We will notify you of significant changes via email or a prominent notice within the Service. The "Last updated" date at the top of this page indicates when this policy was last revised.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">10. Contact Us</h2>
            <p>If you have questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us at:{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>
            </p>
          </section>
        </div>
      </main>

      <footer className="border-t border-border/30 py-8 mt-12">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <span>© 2026 MotionMax. All rights reserved.</span>
          <div className="flex gap-4">
            <a href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-foreground transition-colors">Terms of Service</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
