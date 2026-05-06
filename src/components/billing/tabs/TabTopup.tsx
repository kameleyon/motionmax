import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { TOPUP_SKUS, tieredRate, closestSkuFor } from "@/config/billingProducts";
import { num } from "../_shared/format";

export default function TabTopup() {
  const { user } = useAuth();
  const { createCheckout } = useSubscription();
  const [selectedCredits, setSelectedCredits] = useState<number>(TOPUP_SKUS[1].credits);
  const [pending, setPending] = useState(false);

  const tile = useMemo(
    () => TOPUP_SKUS.find((t) => t.credits === selectedCredits) ?? null,
    [selectedCredits],
  );

  const sku = closestSkuFor(selectedCredits);
  const rate = tile ? tile.perCredit : tieredRate(selectedCredits);
  const isSliderValue = !tile;
  const displayPrice = tile ? tile.priceUsd : Math.round(selectedCredits * rate * 100) / 100;
  const equivSeconds = selectedCredits / 100; // 100 credits/second of finished video
  const equivLabel = equivSeconds < 60
    ? `${Math.round(equivSeconds)} seconds`
    : `${(equivSeconds / 60).toFixed(1)} minutes`;

  async function buy() {
    if (!user) { toast.error("Please sign in"); return; }
    setPending(true);
    try {
      // Slider amounts that don't match a SKU map up to the closest-up SKU.
      const url = await createCheckout(sku.priceId, "payment");
      if (url) window.location.href = url;
    } catch (err) {
      toast.error("Could not start checkout", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  }

  // slider gradient progress
  const sliderPct = ((selectedCredits - 500) / (100000 - 500)) * 100;

  return (
    <section className="bill-tab">
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: 30, margin: "0 0 6px", letterSpacing: "-.01em" }}>
          Need more credits?
        </h2>
        <p style={{ fontSize: 14, color: "var(--ink-dim)", margin: 0, maxWidth: "60ch" }}>
          Top up anytime. Credits never expire while your subscription is active and stack on top of your monthly allowance.
        </p>
      </div>

      <div className="tu-grid">
        {TOPUP_SKUS.map((s) => (
          <div
            key={s.credits}
            className={"tu" + (selectedCredits === s.credits ? " on" : "")}
            onClick={() => setSelectedCredits(s.credits)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedCredits(s.credits); }}
          >
            {s.ribbon === "popular" ? <span className="ribbon">POPULAR</span> :
             s.ribbon === "best-value" ? <span className="ribbon gold">BEST VALUE</span> : null}
            <div className="credits">{num(s.credits)}<span className="u">credits</span></div>
            <div className="pri"><b>${s.priceUsd}</b> · ${s.perCredit.toFixed(4)}/credit</div>
            <div className="equiv">≈ {(s.credits / 100).toFixed(0)} video seconds</div>
            {s.saveLabel ? <div className="save">{s.saveLabel}</div> : null}
          </div>
        ))}
      </div>

      <div className="slider-wrap">
        <div className="top">
          <div>
            <h4>Or set a custom amount: <span className="n">{num(selectedCredits)} credits</span></h4>
            <div style={{ fontSize: 12.5, color: "var(--ink-mute)", fontFamily: "var(--mono)", marginTop: 6 }}>
              ≈ {equivLabel} of finished video · ${rate.toFixed(4)}/credit
              {isSliderValue ? <span style={{ marginLeft: 8, color: "var(--gold)" }}>(charged as {num(sku.credits)}-pack)</span> : null}
            </div>
          </div>
          <div className="pri-big">${displayPrice.toFixed(displayPrice % 1 ? 2 : 0)}<span className="u">USD</span></div>
        </div>
        <input
          type="range"
          min={500}
          max={100000}
          step={500}
          value={selectedCredits}
          onChange={(e) => setSelectedCredits(Number(e.target.value))}
          style={{ ["--p" as never]: sliderPct + "%" } as React.CSSProperties}
        />
        <div className="ticks">
          <span>500</span><span>5K</span><span>20K</span><span>50K</span><span>100K</span>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-cyan" onClick={buy} disabled={pending}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            {pending ? "Opening checkout…" : `Buy ${num(sku.credits)} credits — $${sku.priceUsd}`}
          </button>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 24 }}>
        <div className="card" style={{ background: "linear-gradient(180deg, rgba(20,200,204,.06), transparent)" }}>
          <h3>How credits work</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.55 }}>
            <li>· <b style={{ color: "var(--ink)" }}>Video render</b> — 100 credits per second of finished video</li>
            <li>· <b style={{ color: "var(--ink)" }}>Voiceover</b> — 50 credits per minute (any voice, any language)</li>
            <li>· <b style={{ color: "var(--ink)" }}>Voice clone</b> — 200 to create + 50/min to use</li>
            <li>· <b style={{ color: "var(--ink)" }}>Image generation</b> — 5 credits per image</li>
            <li>· <b style={{ color: "var(--ink)" }}>AutoPost</b> — flat 45 credits per scheduled run</li>
          </ul>
        </div>
        <div className="card" style={{ background: "linear-gradient(180deg, rgba(245,176,73,.06), transparent)" }}>
          <h3>Top-up perks</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.55 }}>
            <li>· Credits <b style={{ color: "var(--ink)" }}>never expire</b> while your subscription is active</li>
            <li>· Stack on top of monthly subscription credits</li>
            <li>· No commitment — top up only when you need it</li>
            <li>· Larger packs unlock <b style={{ color: "var(--gold)" }}>up to 30% lower per-credit rate</b></li>
            <li>· Volume discount automatically applied at checkout</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
