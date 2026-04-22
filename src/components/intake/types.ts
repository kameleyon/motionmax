/** Intake form canonical types. The form posts these into
 *  `projects.intake_settings` (jsonb) so we don't need a column per
 *  feature — see `supabase/migrations/..._add_projects_intake_settings.sql`. */

export type ProjectMode = 'cinematic' | 'doc2video' | 'smartflow';

/** Short, human-facing mode label used in breadcrumbs + badges. */
export const MODE_LABEL: Record<ProjectMode, string> = {
  cinematic: 'Cinematic',
  doc2video: 'Explainer',
  smartflow: 'Smart Flow',
};

/** Which features are SURFACED for a given mode. The form uses this to
 *  decide what to render; settings for a hidden feature are simply not
 *  persisted. Derived from the user's spec:
 *    - cinematic: everything
 *    - doc2video: no lipSync, no camera motion; keeps cast + grade
 *    - smartflow: keeps music only (no sfx/lipSync/cast/camera/grade
 *                 and no duration — smartflow is always short) */
export type FeatureSet = {
  duration: boolean;
  lipSync: boolean;
  music: boolean;
  sfx: boolean;
  cast: boolean;
  characterAppearance: boolean;
  camera: boolean;
  colorGrade: boolean;
};

export const FEATURES: Record<ProjectMode, FeatureSet> = {
  cinematic: { duration: true,  lipSync: true,  music: true, sfx: true,  cast: true,  characterAppearance: true,  camera: true,  colorGrade: true },
  doc2video: { duration: true,  lipSync: false, music: true, sfx: true,  cast: true,  characterAppearance: true,  camera: false, colorGrade: true },
  smartflow: { duration: false, lipSync: false, music: true, sfx: false, cast: false, characterAppearance: false, camera: false, colorGrade: false },
};

/** Aspect ratios the form offers. 1:1 was removed per product call. */
export type IntakeAspect = '16:9' | '9:16';

/** Duration options the form offers. Stored on `projects.length` as the
 *  literal string so existing worker code sees a stable value. */
export type IntakeDuration = '<3min' | '>3min';

/** Per-mode base credit cost. Cinematic includes character consistency
 *  in the base number (that's why cast is forced-on + hidden-toggle for
 *  cinematic). Explainer/SmartFlow have their own base. Pricing may
 *  change as we finalise the feature → credits table. */
export const BASE_COST: Record<ProjectMode, number> = {
  cinematic: 750,  // includes character consistency
  doc2video: 150,
  smartflow: 75,
};

/** Add-on credits on top of the base. Music / SFX / Lip Sync are still
 *  the only things that bump the total today — character consistency is
 *  free in cinematic (folded into the base) and not offered elsewhere. */
export const ADDON_COST = {
  durationLong: 200,   // applied when duration = '>3min'
  lipSync: 120,
  music: 60,
  sfx: 30,
} as const;

export type MusicGenre = 'Cinematic' | 'Electronic' | 'Acoustic' | 'Ambient' | 'Hip-hop' | 'Jazz' | 'Orchestral';

export type CameraMotion = 'Static' | 'Dolly' | 'Handheld' | 'Drone' | 'Crane' | 'Whip Pan';

export type ColorGrade =
  | 'Kodak 250D' | 'Bleach Bypass' | 'Teal & Orange'
  | 'Warm Film'  | 'Cool Noir'    | 'Desaturated';

export type CastMember = {
  initial: string;
  name: string;
  role: 'Narrator' | 'Supporting';
  locked: boolean;
};

/** What gets persisted to `projects.intake_settings`. Keeping this shape
 *  simple — renderers read only the keys they know about. */
export type IntakeSettings = {
  visualStyle: string;
  tone: number;              // 0–100 (calm → frenetic)
  camera?: CameraMotion;
  grade?: ColorGrade;
  lipSync?: { on: boolean; strength: number };
  music?: { on: boolean; genre: MusicGenre; intensity: number; sfx: boolean; uploadUrl?: string | null };
  cast?: CastMember[];
  characterAppearance?: string;
  captionStyle?: string;
  brandName?: string;
};
