/** Frontend feature flags.
 *
 *  Backed by localStorage for per-user dark-launch: set
 *  `motionmax_flags` to `{"UNIFIED_EDITOR":true}` in the browser's
 *  devtools to opt into the new editor experience without affecting
 *  anyone else. Defaults live in `FLAG_DEFAULTS` below — flip one to
 *  `true` to roll a flag out to everyone.
 *
 *  URL overrides (`?ff_UNIFIED_EDITOR=1` / `=0`) take precedence over
 *  localStorage, which takes precedence over defaults. URL overrides
 *  also persist back to localStorage so refreshing the page keeps the
 *  flag active.
 */

export type FlagName = 'UNIFIED_EDITOR';

const FLAG_DEFAULTS: Record<FlagName, boolean> = {
  // The unified Editor route (/app/editor/:id) that replaces the
  // generation progress screen, the legacy CinematicResult view, and
  // the legacy CreateWorkspace post-render UX. Flip to `true` when we
  // retire the legacy paths (see player_editor_roadmap.md Phase 13).
  UNIFIED_EDITOR: true,
};

const LS_KEY = 'motionmax_flags';

function readLocalFlags(): Partial<Record<FlagName, boolean>> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<FlagName, boolean>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeLocalFlags(patch: Partial<Record<FlagName, boolean>>) {
  try {
    const current = readLocalFlags();
    localStorage.setItem(LS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch { /* quota — ignore */ }
}

/** Returns the effective value of a flag. URL params > localStorage >
 *  defaults. URL overrides persist to localStorage on first read so a
 *  link to `?ff_X=1` flips the flag for this user for good. */
export function isFlagOn(name: FlagName): boolean {
  if (typeof window === 'undefined') return FLAG_DEFAULTS[name];

  const urlFlag = new URLSearchParams(window.location.search).get(`ff_${name}`);
  if (urlFlag === '1' || urlFlag === 'true') {
    writeLocalFlags({ [name]: true });
    return true;
  }
  if (urlFlag === '0' || urlFlag === 'false') {
    writeLocalFlags({ [name]: false });
    return false;
  }

  const local = readLocalFlags();
  if (typeof local[name] === 'boolean') return local[name] as boolean;

  return FLAG_DEFAULTS[name];
}

/** Dev helper — explicitly set a flag. */
export function setFlag(name: FlagName, value: boolean) {
  writeLocalFlags({ [name]: value });
}
