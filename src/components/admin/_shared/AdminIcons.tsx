import type { JSX } from 'react';

/**
 * Lucide-style inline SVG icons used across the admin shell. Each entry is a
 * zero-arg component returning a 14x14 SVG that inherits `currentColor` and
 * uses a 1.6px stroke. Path data is sourced from the design reference in
 * `tmp_design/motionmax/project/upgrades/admin-data.jsx`. A handful of glyphs
 * (`play`, `more`, `smartflow`, `cinematic`) intentionally render filled
 * shapes; the inner `<path fill="currentColor">` preserves that look.
 */

type IconComponent = () => JSX.Element;

type IconSpec = {
  /** SVG inner markup as a render function (uses currentColor). */
  body: () => JSX.Element;
  /** Optional stroke width override (defaults to 1.6). */
  sw?: number;
};

function Svg({ children, sw = 1.6 }: { children: JSX.Element; sw?: number }): JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const SPECS: Record<string, IconSpec> = {
  search: { body: () => <g><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></g> },
  caret: { sw: 2, body: () => <path d="M6 9l6 6 6-6" /> },
  plus: { body: () => <path d="M12 5v14M5 12h14" /> },
  home: { body: () => <g><path d="M3 12l9-8 9 8" /><path d="M5 10v10h14V10" /></g> },
  film: { body: () => <g><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" /></g> },
  voice: { body: () => <g><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></g> },
  proj: { body: () => <g><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" /></g> },
  brand: { body: () => <g><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" /></g> },
  gear: { body: () => <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></g> },
  shield: { body: () => <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /> },
  bolt: { body: () => <path d="M13 2L3 14h7l-1 8 10-12h-7z" /> },
  users: { body: () => <g><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></g> },
  mail: { body: () => <g><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></g> },
  bell: { body: () => <g><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></g> },
  chart: { body: () => <g><path d="M3 3v18h18" /><path d="m7 14 4-4 4 4 5-7" /></g> },
  alert: { body: () => <g><path d="m10.3 3.86-8.04 14a2 2 0 0 0 1.74 3h16.08a2 2 0 0 0 1.74-3l-8.05-14a2 2 0 0 0-3.47 0z" /><path d="M12 9v4M12 17h.01" /></g> },
  terminal: { body: () => <path d="m4 17 6-6-6-6M12 19h8" /> },
  api: { body: () => <path d="M2 12h6M16 12h6M8 8l-4 4 4 4M16 16l4-4-4-4M10 21l4-18" /> },
  power: { body: () => <g><path d="M12 2v10" /><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /></g> },
  send: { body: () => <g><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></g> },
  download: { body: () => <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /> },
  refresh: { body: () => <g><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></g> },
  pause: { body: () => <g><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></g> },
  play: { body: () => <path d="M6 4l14 8-14 8z" fill="currentColor" /> },
  x: { sw: 1.8, body: () => <path d="M18 6 6 18M6 6l12 12" /> },
  check: { sw: 2, body: () => <path d="M20 6 9 17l-5-5" /> },
  arrowUp: { sw: 2.2, body: () => <path d="m18 15-6-6-6 6" /> },
  arrowDown: { sw: 2.2, body: () => <path d="m6 9 6 6 6-6" /> },
  ext: { body: () => <g><path d="M7 7h10v10" /><path d="M7 17 17 7" /></g> },
  filter: { body: () => <path d="M22 3H2l8 9.5V19l4 2v-8.5z" /> },
  more: { body: () => <g><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></g> },
  paperclip: { body: () => <path d="M21.4 11 12.5 19.9a5 5 0 0 1-7.07-7.07L14.34 3.92a3.5 3.5 0 0 1 4.95 4.95L10.4 17.76a2 2 0 1 1-2.83-2.83l8-8" /> },
  spark: { body: () => <path d="m12 2 2.4 7.4H22l-6.2 4.5 2.4 7.4-6.2-4.5-6.2 4.5 2.4-7.4L2 9.4h7.6z" /> },
  flag: { body: () => <path d="M4 21V4h12l-2 4 2 4H4" /> },
  trash: { body: () => <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /> },
  reply: { body: () => <g><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></g> },
  credit: { body: () => <g><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20M6 15h4" /></g> },
  copy: { body: () => <g><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></g> },
  cinematic: { body: () => <g><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3V9z" fill="currentColor" /></g> },
  explainer: { body: () => <g><path d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5M9 14h6" /></g> },
  smartflow: { body: () => <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" /> },
  flask: { body: () => <path d="M9 3h6M10 3v6L4 19a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 19l-6-10V3" /> },
  voicebars: { body: () => <path d="M8 4v16M16 4v16M4 8h4M16 8h4M4 16h4M16 16h4" /> },
  key: { body: () => <g><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9 3 3-3 3 3 3-3 3-3-3-3 3" /></g> },
};

function makeIcon(spec: IconSpec): IconComponent {
  return () => <Svg sw={spec.sw}>{spec.body()}</Svg>;
}

export const I = {
  search: makeIcon(SPECS.search),
  caret: makeIcon(SPECS.caret),
  plus: makeIcon(SPECS.plus),
  home: makeIcon(SPECS.home),
  film: makeIcon(SPECS.film),
  voice: makeIcon(SPECS.voice),
  proj: makeIcon(SPECS.proj),
  brand: makeIcon(SPECS.brand),
  gear: makeIcon(SPECS.gear),
  shield: makeIcon(SPECS.shield),
  bolt: makeIcon(SPECS.bolt),
  users: makeIcon(SPECS.users),
  mail: makeIcon(SPECS.mail),
  bell: makeIcon(SPECS.bell),
  chart: makeIcon(SPECS.chart),
  alert: makeIcon(SPECS.alert),
  terminal: makeIcon(SPECS.terminal),
  api: makeIcon(SPECS.api),
  power: makeIcon(SPECS.power),
  send: makeIcon(SPECS.send),
  download: makeIcon(SPECS.download),
  refresh: makeIcon(SPECS.refresh),
  pause: makeIcon(SPECS.pause),
  play: makeIcon(SPECS.play),
  x: makeIcon(SPECS.x),
  check: makeIcon(SPECS.check),
  arrowUp: makeIcon(SPECS.arrowUp),
  arrowDown: makeIcon(SPECS.arrowDown),
  ext: makeIcon(SPECS.ext),
  filter: makeIcon(SPECS.filter),
  more: makeIcon(SPECS.more),
  paperclip: makeIcon(SPECS.paperclip),
  spark: makeIcon(SPECS.spark),
  flag: makeIcon(SPECS.flag),
  trash: makeIcon(SPECS.trash),
  reply: makeIcon(SPECS.reply),
  credit: makeIcon(SPECS.credit),
  copy: makeIcon(SPECS.copy),
  cinematic: makeIcon(SPECS.cinematic),
  explainer: makeIcon(SPECS.explainer),
  smartflow: makeIcon(SPECS.smartflow),
  flask: makeIcon(SPECS.flask),
  voicebars: makeIcon(SPECS.voicebars),
  key: makeIcon(SPECS.key),
} as const;

export type AdminIconName = keyof typeof I;
