/**
 * Dynamic Google Fonts loader for the caption-style picker + admin chrome.
 *
 * §5 PERF-002 fix (2026-05-10): the previous implementation loaded 17
 * Google Fonts families render-blocking from index.html on every public
 * visit. 14 of those families are decorative caption fonts only used
 * inside the gated CreateNew/Editor/Workspace flows, and 2 (Instrument
 * Serif + JetBrains Mono) are admin/billing chrome — none belong on the
 * critical path of the landing page.
 *
 * This module ships those families as on-demand `<link>` injections,
 * triggered by:
 *   - `loadCaptionFonts()` — call on mount of any component that renders
 *     CaptionStyleSelector or its previews (IntakeForm, IntakeRail,
 *     Editor's Inspector, every workspace variant).
 *   - `loadAdminFonts()`   — call on mount of the admin/billing/settings
 *     shells that consume `--serif` / `--mono` from the design tokens.
 *
 * Both calls are idempotent — the loader tracks injected stylesheets in
 * a module-level Set so repeated calls during navigation are no-ops.
 *
 * The `<link>`s are injected with `font-display: swap` (already on the
 * Google CSS request) so users see fallback metrics while the WOFF2
 * fetches stream in. The browser fetches each face only when a layout
 * actually requests it (per CSS Font Loading API), so even though the
 * stylesheet is requested as a single HTTP round-trip, the actual
 * binary fetches stay lazy.
 */

const loaded = new Set<string>();

function injectStylesheet(href: string): void {
  if (loaded.has(href)) return;
  if (typeof document === 'undefined') return;

  // Belt-and-suspenders: also no-op if a <link> with this exact href is
  // already in the head (defends against a parallel duplicate call from
  // SSR/hydration or a dev HMR refresh re-mounting the same component).
  if (document.querySelector(`link[href="${href}"]`)) {
    loaded.add(href);
    return;
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  // Don't block first paint of whatever component triggered this — the
  // stylesheet is only needed once swatches actually render, and the CSS
  // declares `font-display: swap`, so a brief fallback flash is fine.
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);

  loaded.add(href);
}

/**
 * Caption picker decorative families. Mirrors the family list previously
 * baked into index.html minus Inter (which stays in the critical path
 * load) and minus the admin chrome families (loaded by `loadAdminFonts`).
 *
 * Families: Montserrat, Bebas Neue, Poppins, Bangers, Comfortaa, Oswald,
 * Pangolin, Flavors, Chango, Luckiest Guy, Vina Sans, Special Elite,
 * Rubik Mono One, Pacifico (14 families).
 */
const CAPTION_FONTS_HREF =
  'https://fonts.googleapis.com/css2' +
  '?family=Montserrat:wght@700;800;900' +
  '&family=Bebas+Neue' +
  '&family=Poppins:wght@700;900' +
  '&family=Bangers' +
  '&family=Comfortaa:wght@700' +
  '&family=Oswald:wght@700' +
  '&family=Pangolin' +
  '&family=Flavors' +
  '&family=Chango' +
  '&family=Luckiest+Guy' +
  '&family=Vina+Sans' +
  '&family=Special+Elite' +
  '&family=Rubik+Mono+One' +
  '&family=Pacifico' +
  '&display=swap';

/**
 * Admin/billing/settings chrome families. Used by `--serif` / `--mono`
 * tokens in `src/styles/admin-tokens.css` etc. Loaded only when an admin
 * route mounts, so anonymous landing visitors never pay the cost.
 */
const ADMIN_FONTS_HREF =
  'https://fonts.googleapis.com/css2' +
  '?family=Instrument+Serif:ital@0;1' +
  '&family=JetBrains+Mono:wght@300;400;500' +
  '&display=swap';

/** Inject the caption decoratives stylesheet. Idempotent. */
export function loadCaptionFonts(): void {
  injectStylesheet(CAPTION_FONTS_HREF);
}

/** Inject the admin/billing serif + mono stylesheet. Idempotent. */
export function loadAdminFonts(): void {
  injectStylesheet(ADMIN_FONTS_HREF);
}
