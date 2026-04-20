import { Helmet } from "react-helmet-async";
import { LANDING_FAQ } from "@/config/landingContent";

/* ──────────────────────────────────────────────
 * <SeoHead /> — Landing-page specific meta tags.
 *
 * index.html already provides global defaults;
 * this component adds page-level overrides and
 * FAQ structured data for rich search results.
 * ────────────────────────────────────────────── */

const SITE_URL = "https://motionmax.io";
const OG_IMAGE = `${SITE_URL}/og-image.png?v=20260129`;

/** Schema.org FAQPage structured data built from config */
function buildFaqSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: LANDING_FAQ.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

export default function SeoHead() {
  return (
    <Helmet>
      <title>MotionMax &#x2013; AI Video Generator | Turn Text into Cinematic Videos</title>
      <meta
        name="description"
        content="Create stunning AI-generated cinematic videos, explainers, and visual stories from any text. AI scriptwriting, voiceover, image-to-video with 25+ caption styles. Multi-language. Start free."
      />
      <meta
        name="keywords"
        content="AI video generator, text to video, cinematic video maker, AI explainer videos, document to video, AI narration, voice cloning, video storytelling, automated video production, AI video editor, TikTok video maker, YouTube Shorts generator, AI captions, image to video, Kling video, AI voiceover, multi-language video, MotionMax"
      />
      <link rel="canonical" href={SITE_URL} />

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={SITE_URL} />
      <meta
        property="og:title"
        content="MotionMax — Turn text into engaging visual content"
      />
      <meta
        property="og:description"
        content="Turn text into engaging visual content. Create narrated videos with AI visuals and voiceovers — start free."
      />
      <meta property="og:image" content={OG_IMAGE} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta
        property="og:image:alt"
        content="MotionMax — Turn text into engaging visual content"
      />
      <meta property="og:site_name" content="MotionMax" />
      <meta property="og:locale" content="en_US" />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={SITE_URL} />
      <meta
        name="twitter:title"
        content="MotionMax — Turn text into engaging visual content"
      />
      <meta
        name="twitter:description"
        content="Turn text into engaging visual content. Create narrated videos with AI visuals and voiceovers — start free."
      />
      <meta property="twitter:image" content={OG_IMAGE} />
      <meta
        name="twitter:image:alt"
        content="MotionMax — Turn text into engaging visual content"
      />
      <meta name="twitter:creator" content="@MotionMax" />

      {/* FAQ structured data for rich search results */}
      <script type="application/ld+json">
        {JSON.stringify(buildFaqSchema())}
      </script>
    </Helmet>
  );
}
