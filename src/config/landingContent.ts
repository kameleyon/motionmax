import { Film, Mic, Sparkles, Subtitles, Globe, Pencil, Shield, Users, type LucideIcon } from "lucide-react";

/* ──────────────────────────────────────────────
 * Feature cards shown on the landing page.
 * Edit here instead of touching component code.
 * ────────────────────────────────────────────── */

export interface FeatureItem {
  title: string;
  description: string;
  icon: LucideIcon;
}

export const LANDING_FEATURES: FeatureItem[] = [
  {
    title: "Cinematic AI Videos",
    description:
      "15-scene videos with AI image-to-video, seamless transitions between scenes, and camera motion direction.",
    icon: Film,
  },
  {
    title: "AI Voiceover & Cloning",
    description:
      "9+ AI voices with emotion-aware style. Clone your own voice for consistent narration across projects.",
    icon: Mic,
  },
  {
    title: "AI Research & Script",
    description:
      "Claude AI researches your topic for accuracy — verified facts, real appearances, cultural context — then writes the script.",
    icon: Sparkles,
  },
  {
    title: "25+ Caption Styles",
    description:
      "From Classic to Karaoke word-by-word. Captions burned directly into the video. Pick your style, change it anytime.",
    icon: Subtitles,
  },
  {
    title: "11 Languages",
    description:
      "English, French, Spanish, Portuguese, German, Italian, Russian, Chinese, Japanese, Korean, Haitian Creole.",
    icon: Globe,
  },
  {
    title: "Scene-by-Scene Editing",
    description:
      "Edit any image with AI text instructions. Regenerate audio or video per scene. Affected transitions auto-update.",
    icon: Pencil,
  },
];

/* ──────────────────────────────────────────────
 * Trust / social-proof indicators
 * ────────────────────────────────────────────── */

export interface TrustItem {
  icon: LucideIcon;
  label: string;
  detail: string;
}

export const TRUST_INDICATORS: TrustItem[] = [
  {
    icon: Shield,
    label: "Enterprise-Grade Security",
    detail: "End-to-end encryption · GDPR compliant",
  },
  {
    icon: Users,
    label: "Trusted by Creators",
    detail: "Thousands of videos generated every week",
  },
  {
    icon: Globe,
    label: "Global Platform",
    detail: "Accessible worldwide with multi-language narration",
  },
];

/* ──────────────────────────────────────────────
 * FAQ entries – improves SEO via long-tail
 * keywords and reduces support burden.
 * ────────────────────────────────────────────── */

export interface FaqItem {
  question: string;
  answer: string;
}

export const LANDING_FAQ: FaqItem[] = [
  {
    question: "What is MotionMax?",
    answer:
      "MotionMax is an AI-powered content creation platform that turns text, documents, and ideas into professional-quality narrated videos — complete with AI visuals, voiceovers, and multiple art styles.",
  },
  {
    question: "Do I need video editing experience?",
    answer:
      "No. MotionMax handles scene-by-scene planning, image generation, and audio narration automatically. Just paste your text or describe your topic and the AI does the rest.",
  },
  {
    question: "Is there a free plan?",
    answer:
      "Yes! The free plan includes monthly credits so you can create short videos and explore all core features — no credit card required.",
  },
  {
    question: "What video formats and resolutions are supported?",
    answer:
      "MotionMax supports 16:9 (landscape), 9:16 (portrait / Reels), and 1:1 (square) formats. Paid plans unlock 1080p and 4K exports.",
  },
  {
    question: "Can I use my own voice?",
    answer:
      "Absolutely. Creator and Professional plans include voice cloning — upload a short sample and generate narrations in your own voice.",
  },
  {
    question: "How do credits work?",
    answer:
      "Each generation (video, audio, or infographic) consumes credits based on complexity and length. Credits reset monthly and unused credits do not roll over. You can also purchase credit packs at any time.",
  },
  {
    question: "Can I cancel my subscription?",
    answer:
      "Yes, you can cancel anytime from your account Settings. You'll retain access to paid features until the end of your current billing cycle.",
  },
];
