/**
 * Shared formatters for the admin surface.
 *
 * Pure functions only — no React, no side effects, no I/O. Safe to import
 * anywhere (including server-side prerender, edge functions, tests).
 *
 * Sourced from `tmp_design/admin-data.jsx` so the design mocks and the live
 * admin tabs agree on `'1.5k'` vs `'1.5K'`, currency precision, etc.
 */

/**
 * Human-friendly relative timestamp:
 *   < 1 min  -> 'just now'
 *   < 1 hr   -> 'Nm ago'
 *   < 1 day  -> 'Nh ago'
 *   < 7 days -> 'Nd ago'
 *   else     -> 'Mon DD' (en-US, short month + numeric day)
 */
export function formatRel(d: Date | string): string {
  const ts = d instanceof Date ? d.getTime() : new Date(d).getTime();
  const ms = Date.now() - ts;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const dd = Math.floor(h / 24);
  if (dd < 7) return dd + "d ago";
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Coerce RPC values that may be null/undefined/string ("12.5") into a
 * finite number for downstream `.toLocaleString()` calls. Postgres
 * returns NULL as `null` (becomes `undefined` after JSON), and numeric
 * columns sometimes arrive as strings — both used to crash the admin
 * with "Cannot read properties of undefined (reading 'toLocaleString')".
 */
function toFiniteNum(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (typeof n === "string") {
    const parsed = Number(n);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * USD currency at 2 decimal places — for revenue, MRR, payouts, refunds.
 * Example: `money(28420) === '$28,420.00'`. Null/undefined → `$0.00`.
 */
export function money(n: number | null | undefined): string {
  return (
    "$" +
    toFiniteNum(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * USD currency at 4 decimal places — for per-call API costs which are
 * routinely sub-cent (e.g. `$0.0118`). Null/undefined → `$0.0000`.
 */
export function money4(n: number | null | undefined): string {
  return (
    "$" +
    toFiniteNum(n).toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })
  );
}

/**
 * Locale-formatted integer (en-US thousand separators).
 * Example: `num(1500000) === '1,500,000'`. Null/undefined → `0`.
 */
export function num(n: number | null | undefined): string {
  return toFiniteNum(n).toLocaleString("en-US");
}

/**
 * Compact number for tight UI (KPI cards, sparkline labels).
 *   >= 1e6 -> 'X.XM'
 *   >= 1e3 -> 'X.Xk'
 *   else   -> raw integer string
 * Example: `short(1500) === '1.5k'`. Null/undefined → `0`.
 */
export function short(n: number | null | undefined): string {
  const v = toFiniteNum(n);
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return "" + v;
}

/**
 * Deterministic synthetic weekly array for sparklines.
 *
 * WARNING: This helper is for **storybook / skeleton / design-mode**
 * placeholders only. Real admin tabs MUST pull their sparkline data from
 * React Query against Supabase (see `_shared/queries.ts`). Using `weekly()`
 * in a production tab will silently ship fake numbers.
 *
 * @param base    Center value the series oscillates around.
 * @param jitter  Fractional spread (0.3 = ±15%). Default 0.3.
 * @param len     Number of points. Default 14 (two weeks).
 */
export function weekly(base: number, jitter = 0.3, len = 14): number[] {
  return Array.from({ length: len }, (_, i) => {
    const seed = ((i * 17 + 7) % 100) / 100;
    return Math.round(base * (1 + (seed - 0.5) * jitter));
  });
}
