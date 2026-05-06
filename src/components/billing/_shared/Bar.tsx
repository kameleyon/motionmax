/** Progress bar — `.bar > i` from the design. */
export function Bar({ pct, gold = false }: { pct: number; gold?: boolean }) {
  const safe = Math.max(0, Math.min(100, pct));
  return (
    <div className={"bar" + (gold ? " gold" : "")}>
      <i style={{ width: safe + "%" }} />
    </div>
  );
}
