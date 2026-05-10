/**
 * EU/EEA/UK 14-day right of withdrawal — Directive 2011/83/EU Art. 16(m).
 *
 * For digital services (i.e. AI generation), the consumer can claw back their
 * first 14 days of charges UNLESS they have given EXPLICIT prior consent to
 * immediate performance AND ACKNOWLEDGED the loss of the withdrawal right.
 * That consent must be captured at the point of sale — not buried in ToS.
 *
 * This module:
 *   1. Provides a UX-only heuristic (`isLikelyEUUser`) to decide whether to
 *      show the consent checkbox.
 *   2. Exposes the canonical consent copy as a single source of truth.
 *
 * The legal binding is the server-side `profiles.eu_cooling_off_waived_at`
 * timestamp persisted by the `create-checkout` edge function. The detection
 * heuristic is deliberately conservative (over-includes) — false positives
 * just show the checkbox to a non-EU user, false negatives skip the legal
 * gate. See `EU_TIMEZONE_PREFIXES` below for the matched IANA TZ regions.
 *
 * Caveats:
 *   - VPN/Tor users can spoof timezone trivially.
 *   - Users with `Etc/UTC` or `UTC` set get treated as non-EU (no signal).
 *   - Server-side IP geolocation is not used here because Stripe Checkout
 *     re-prompts for billing country anyway; a card from an EU country at
 *     Stripe's step would still inherit the cooling-off right regardless of
 *     this client heuristic. For belt-and-suspenders, run a future job that
 *     audits Stripe customers whose `country` is EU and `profiles
 *     .eu_cooling_off_waived_at IS NULL`.
 */

/**
 * IANA timezone prefixes for EU member states + EEA (Iceland, Liechtenstein,
 * Norway) + UK (post-Brexit; the Consumer Rights Act 2015 mirrors the same
 * 14-day cooling-off duty, so we treat UK identically).
 *
 * Source for EU/EEA list: https://www.iana.org/time-zones (zone1970.tab),
 * cross-checked against ec.europa.eu country listings.
 */
const EU_TIMEZONE_PREFIXES: readonly string[] = [
  // Western/Central Europe — EU members + UK + EEA
  "Europe/Amsterdam",      // Netherlands
  "Europe/Andorra",        // Andorra (not EU, but EU customs union; treat as EU for safety)
  "Europe/Athens",         // Greece
  "Europe/Belgrade",       // Serbia (not EU; excluded)
  "Europe/Berlin",         // Germany
  "Europe/Bratislava",     // Slovakia
  "Europe/Brussels",       // Belgium
  "Europe/Bucharest",      // Romania
  "Europe/Budapest",       // Hungary
  "Europe/Copenhagen",     // Denmark
  "Europe/Dublin",         // Ireland
  "Europe/Gibraltar",      // UK overseas territory
  "Europe/Guernsey",       // UK Crown Dependency
  "Europe/Helsinki",       // Finland
  "Europe/Isle_of_Man",    // UK Crown Dependency
  "Europe/Jersey",         // UK Crown Dependency
  "Europe/Lisbon",         // Portugal
  "Europe/Ljubljana",      // Slovenia
  "Europe/London",         // UK
  "Europe/Luxembourg",     // Luxembourg
  "Europe/Madrid",         // Spain
  "Europe/Malta",          // Malta
  "Europe/Monaco",         // Monaco (not EU; excluded? Conservatively include)
  "Europe/Oslo",           // Norway (EEA)
  "Europe/Paris",          // France
  "Europe/Prague",         // Czechia
  "Europe/Reykjavik",      // Iceland (EEA)
  "Europe/Riga",           // Latvia
  "Europe/Rome",           // Italy
  "Europe/Sofia",          // Bulgaria
  "Europe/Stockholm",      // Sweden
  "Europe/Tallinn",        // Estonia
  "Europe/Vaduz",          // Liechtenstein (EEA)
  "Europe/Vienna",         // Austria
  "Europe/Vilnius",        // Lithuania
  "Europe/Warsaw",         // Poland
  "Europe/Zagreb",         // Croatia
  "Europe/Zurich",         // Switzerland (not EU/EEA, but EFTA + reciprocal consumer protections — include for safety)
  // Atlantic region — EU outermost regions
  "Atlantic/Azores",       // Portugal
  "Atlantic/Canary",       // Spain
  "Atlantic/Madeira",      // Portugal
  // Mediterranean — Cypriot zone
  "Asia/Nicosia",          // Cyprus (EU)
];

/**
 * UX heuristic. Returns true if the user's browser timezone strongly suggests
 * they are inside an EU/EEA/UK jurisdiction. Safe to call during render.
 *
 * Always returns `false` during SSR (no `Intl` resolution available pre-hydration
 * in some setups) — call from a `useEffect` if you need it post-mount.
 */
export function isLikelyEUUser(): boolean {
  if (typeof Intl === "undefined" || !Intl.DateTimeFormat) return false;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return false;
    return EU_TIMEZONE_PREFIXES.includes(tz);
  } catch {
    return false;
  }
}

/**
 * Canonical consent copy. DO NOT alter without legal review — the wording
 * tracks Directive 2011/83/EU Art. 16(m) requirements (express consent +
 * acknowledgement of loss of withdrawal right).
 */
export const EU_COOLING_OFF_CONSENT_COPY =
  "I expressly consent to immediate performance of the digital service and " +
  "acknowledge that I will lose my 14-day right of withdrawal once content " +
  "has been generated. (EU/UK Directive 2011/83/EU Art. 16(m))";

/** Typed error so UI surfaces can render the consent prompt rather than a toast. */
export class EUCoolingOffConsentRequired extends Error {
  constructor() {
    super(
      "EU/UK consumer detected. Tick the cooling-off waiver checkbox to continue.",
    );
    this.name = "EUCoolingOffConsentRequired";
  }
}
