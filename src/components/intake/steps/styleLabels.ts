/** C-5-7 (Prism PERF-011): label-only lookup table extracted from
 *  StyleCarousel so the parent IntakeForm can resolve a styleId →
 *  display label without dragging the 17 webp/png URL handles back
 *  into the synchronous bundle. The carousel still owns the asset
 *  URLs (kept inside the lazy chunk); this file is text only. */

export const STYLE_LABELS: Record<string, string> = {
  'realistic':  'Realistic',
  '3d':   '3D Style',
  'anime':      'Anime',
  'claymation': 'Claymation',
  'storybook':  'Storybook',
  'caricature': 'Caricature',
  'doodle':     'Urban Doodle',
  'stick':      'Stick Figure',
  'sketch':     'Papercut 3D',
  'crayon':     'Crayon',
  'minimalist': 'Minimalist',
  'moody':      'Moody',
  'chalkboard': 'Chalkboard',
  'lego':       'LEGO',
  'cardboard':  'Cardboard',
  'barbie':      'Barbie',
  'custom':     'Custom',
};

/** The label shown in the IntakeRail summary chip. */
export function styleLabelFor(styleId: string): string {
  return STYLE_LABELS[styleId] ?? 'Style';
}
