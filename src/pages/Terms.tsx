import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function Terms() {
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
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: February 2026</p>

        <div className="prose prose-sm max-w-none space-y-8 text-muted-foreground">

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
            <p>The AI-generated outputs produced by the Service are owned by you, subject to the limitations of the underlying AI model licenses. MotionMax retains all rights to the Service itself, including its software, design, and underlying technology.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. Credits and Billing</h2>
            <p>The Service operates on a credit-based system. Credits are consumed when generating content. Monthly subscription credits expire at the end of each billing period. Purchased credit packs do not expire but are non-refundable once consumed.</p>
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
            <h2 className="text-lg font-semibold text-foreground">12. Contact</h2>
            <p>If you have questions about these Terms of Service, please contact us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">support@motionmax.io</a>.
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
