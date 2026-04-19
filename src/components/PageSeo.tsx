import { Helmet } from "react-helmet-async";

const SITE_URL = "https://motionmax.io";
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png?v=20260129`;

interface PageSeoProps {
  title: string;
  description: string;
  canonical: string;
  /** Adds noindex,nofollow — use for private/auth pages */
  noIndex?: boolean;
  ogImage?: string;
}

/**
 * Drop-in per-page SEO block. Renders title, description, canonical, and a
 * full OG/Twitter card so each marketing page gets its own social preview
 * instead of inheriting the landing-page defaults from index.html.
 */
export default function PageSeo({
  title,
  description,
  canonical,
  noIndex = false,
  ogImage = DEFAULT_OG_IMAGE,
}: PageSeoProps) {
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      {noIndex && <meta name="robots" content="noindex, nofollow" />}

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={canonical} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={title} />
      <meta property="og:site_name" content="MotionMax" />
      <meta property="og:locale" content="en_US" />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={canonical} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta property="twitter:image" content={ogImage} />
      <meta name="twitter:image:alt" content={title} />
      <meta name="twitter:site" content="@motionmaxio" />
      <meta name="twitter:creator" content="@motionmaxio" />
    </Helmet>
  );
}
