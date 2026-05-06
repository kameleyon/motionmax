/** Locale formatters reused across billing tabs. */
export function num(n: number): string { return Math.round(n).toLocaleString("en-US"); }
export function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function moneyShort(n: number): string {
  if (n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toFixed(2);
}
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function pct(n: number): string { return Math.round(n) + "%"; }
