import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { PLAN_PRICES } from "@/config/products";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { Bar } from "../_shared/Bar";
import { Toggle } from "../_shared/Toggle";
import { money, num, shortDate } from "../_shared/format";
import {
  fetchBillingOverview,
  fetchAutoRecharge,
  saveAutoRecharge,
  callCustomerPortal,
  type AutoRechargeSettings,
} from "../_shared/billingApi";
import { PauseModal } from "../PauseModal";
import { CancelRetentionModal } from "../CancelRetentionModal";

export default function TabOverview({ onGoTab }: { onGoTab: (t: string) => void }) {
  const { user, session } = useAuth();
  const qc = useQueryClient();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [editingPack, setEditingPack] = useState(false);
  const [editingCap, setEditingCap] = useState(false);

  const overviewQ = useQuery({
    queryKey: ["billing", "overview"],
    queryFn: fetchBillingOverview,
    enabled: !!user,
    staleTime: 30_000,
  });
  const arQ = useQuery({
    queryKey: ["billing", "auto-recharge", user?.id],
    queryFn: () => fetchAutoRecharge(user!.id),
    enabled: !!user,
  });
  const recentTxQ = useQuery({
    queryKey: ["billing", "recent-tx", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credit_transactions")
        .select("id, amount, transaction_type, description, created_at")
        .order("created_at", { ascending: false })
        .limit(4);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: !!user,
  });

  const arMut = useMutation({
    mutationFn: (next: AutoRechargeSettings) => saveAutoRecharge(next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing", "auto-recharge"] });
      toast.success("Auto-recharge saved");
    },
    onError: (e) => toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) }),
  });

  const o = overviewQ.data;
  const ar = arQ.data ?? { enabled: false, threshold: 2000, pack_credits: 2000, spending_cap: null };

  const monthlyAllowance = o?.monthly_allowance ?? 0;
  const usedThisMonth = o?.used_this_month ?? 0;
  const usedPct = monthlyAllowance > 0 ? Math.min(100, (usedThisMonth / monthlyAllowance) * 100) : 0;
  const credits = o?.credits_balance ?? 0;
  const runwayDays = o?.runway_days ?? 0;
  const planLabel = o?.plan ? o.plan.charAt(0).toUpperCase() + o.plan.slice(1) : "Free";

  const planMonthlyPrice =
    o?.plan === "creator" ? PLAN_PRICES.creator.monthly :
    o?.plan === "studio" || o?.plan === "professional" ? PLAN_PRICES.studio.monthly :
    PLAN_PRICES.free.monthly;

  const limits = PLAN_LIMITS[o?.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.free;
  const monthlyCreditsRender = limits.creditsPerMonth || 0;

  const portalMut = useMutation({
    mutationFn: async () => {
      if (!session?.access_token) throw new Error("Sign in required");
      return callCustomerPortal(session.access_token);
    },
    onSuccess: (url) => { window.open(url, "_blank"); },
    onError: (e) => toast.error("Could not open billing portal", { description: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <section className="bill-tab">
      {/* Hero — current plan + next payment */}
      <div className="cp-hero">
        <div className="row">
          <div>
            <div className="meta">
              <span className="live">{(o?.status ?? "active").toUpperCase()}</span>
              <span>·</span>
              <span>{planLabel}{o?.paused_until ? " · Paused" : ""}</span>
              <span>·</span>
              <span>{o?.paused_until ? `Paused until ${shortDate(o.paused_until)}` : "Renews automatically"}</span>
            </div>
            <h2>{planLabel} <em>Plan</em></h2>
            <div className="price-line">
              <b>{planMonthlyPrice} / month</b>
              {monthlyCreditsRender ? (
                <span>· {num(monthlyCreditsRender * (o?.pack_quantity ?? 1))} credits/month included</span>
              ) : null}
            </div>
            <div className="actions">
              <button type="button" className="btn-cyan" onClick={() => onGoTab("plans")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14M5 12h14" /></svg>
                Upgrade plan
              </button>
              <button type="button" className="btn-ghost" onClick={() => onGoTab("topup")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
                Buy credit pack
              </button>
              <button type="button" className="btn-ghost" onClick={() => setPauseOpen(true)} disabled={o?.plan === "free"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                Pause
              </button>
              <button type="button" className="btn-ghost danger" onClick={() => setCancelOpen(true)} disabled={o?.plan === "free"}>
                Cancel subscription
              </button>
            </div>
          </div>
          <div className="next">
            <div className="lbl">Next payment</div>
            <h3 className="date">
              {o?.period_end ? shortDate(o.period_end).replace(/, \d{4}/, "") : "—"}
              <span className="y">{o?.period_end ? `, ${new Date(o.period_end).getFullYear()}` : ""}</span>
            </h3>
            <div className="det">
              <b>{planMonthlyPrice}</b> billed via Stripe<br />
              {monthlyCreditsRender ? <>Refills <b>{num(monthlyCreditsRender * (o?.pack_quantity ?? 1))} credits</b></> : <>No recurring charge on Free plan</>}
            </div>
            {o?.period_end ? (
              <div className="countdown">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                in <b>{Math.max(0, Math.ceil((new Date(o.period_end).getTime() - Date.now()) / 86400000))} days</b>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="kpis">
        <div className="kpi">
          <div className="lbl">Credits remaining</div>
          <div className="v">{num(credits)}<span className="u">/ {num(monthlyAllowance || credits)}</span></div>
          <div className="d up">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 12l5-5 5 5 4-4" /></svg>
            {runwayDays > 0 ? `${runwayDays} days runway at current pace` : "No usage yet this month"}
          </div>
        </div>
        <div className="kpi">
          <div className="lbl">Used this month</div>
          <div className="v">{num(usedThisMonth)}<span className="u">credits</span></div>
          <div className="d">{Math.round(usedPct)}% of allowance</div>
        </div>
        <div className="kpi">
          <div className="lbl">Videos rendered</div>
          <div className="v">{num(o?.videos_rendered ?? 0)}</div>
          <div className="d">This billing period</div>
        </div>
        <div className="kpi">
          <div className="lbl">YTD spend</div>
          <div className="v">{money(o?.ytd_spend ?? 0)}</div>
          <div className="d">Estimated from credit grants</div>
        </div>
      </div>

      {/* This month + auto-recharge */}
      <div className="grid-2-1" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="h-row">
            <h3>This month at a glance</h3>
            <span className="lbl">
              {o?.period_start ? shortDate(o.period_start) : ""} – {shortDate(new Date().toISOString())}
            </span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-dim)", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <span><b style={{ color: "var(--ink)", fontWeight: 500 }}>{num(usedThisMonth)}</b> / {num(monthlyAllowance || 0)} credits</span>
            <span><b style={{ color: "var(--cyan)" }}>{Math.round(usedPct)}%</b> used</span>
          </div>
          <Bar pct={usedPct} />

          <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            <CategoryCell label="Video"  value={o?.video_used ?? 0} total={usedThisMonth} />
            <CategoryCell label="Voice"  value={o?.voice_used ?? 0} total={usedThisMonth} gold />
            <CategoryCell label="Images" value={o?.image_used ?? 0} total={usedThisMonth} gold />
          </div>
          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn-ghost" onClick={() => onGoTab("usage")} style={{ fontSize: 12, padding: "7px 12px" }}>
              Detailed breakdown
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </div>
        </div>

        <div className="card">
          <h3>Auto-recharge</h3>
          <div style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.55, marginBottom: 14 }}>
            When credits drop below a threshold, automatically buy the smallest pack that gets you above it.
          </div>

          <div className="set-row" style={{ borderTop: 0, paddingTop: 0 }}>
            <div className="info">
              <div className="t">Auto-recharge</div>
              <div className="d">When below <b>{num(ar.threshold)} credits</b></div>
            </div>
            <Toggle
              on={ar.enabled}
              ariaLabel="Enable auto-recharge"
              onChange={(next) => arMut.mutate({ ...ar, enabled: next })}
            />
          </div>
          <div className="set-row">
            <div className="info">
              <div className="t">Pack to buy</div>
              <div className="d">{num(ar.pack_credits)} credits</div>
            </div>
            <button type="button" className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setEditingPack(true)}>Change</button>
          </div>
          <div className="set-row">
            <div className="info">
              <div className="t">Spending cap</div>
              <div className="d">{ar.spending_cap ? `$${ar.spending_cap} / month` : "No cap"}</div>
            </div>
            <button type="button" className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setEditingCap(true)}>Edit</button>
          </div>
          <div className="set-row" style={{ borderTop: "1px solid var(--line)" }}>
            <div className="info">
              <div className="t">Threshold</div>
              <div className="d">{num(ar.threshold)} credits</div>
            </div>
            <button type="button" className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setEditingThreshold(true)}>Edit</button>
          </div>
        </div>
      </div>

      {/* Payment method + recent charges */}
      <div className="grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="h-row">
            <h3>Payment method</h3>
            <button type="button" className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => portalMut.mutate()}>
              + Add new
            </button>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", padding: 16, background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 12 }}>
            <div style={{ width: 56, height: 38, borderRadius: 6, background: "linear-gradient(135deg, #1a1f2e, #0a0d12)", display: "grid", placeItems: "center", border: "1px solid var(--line-2)" }}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 13, color: "#fff", letterSpacing: ".04em" }}>CARD</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 13.5, color: "var(--ink)", letterSpacing: ".04em" }}>
                Manage in Stripe Customer Portal
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 2 }}>
                {o?.plan === "free" ? "No payment method on Free plan" : "Click Update to view & manage cards"}
              </div>
            </div>
            <button type="button" className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => portalMut.mutate()} disabled={portalMut.isPending}>
              {portalMut.isPending ? "Opening…" : "Update"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="h-row">
            <h3>Recent charges</h3>
            <span className="lbl">
              <button
                type="button"
                onClick={() => onGoTab("invoices")}
                style={{ color: "var(--cyan)", textDecoration: "none", background: "none", border: 0, cursor: "pointer", font: "inherit" }}
              >
                View all →
              </button>
            </span>
          </div>
          <table className="tbl" style={{ margin: "-4px -14px -4px" }}>
            <tbody>
              {(recentTxQ.data ?? []).length === 0 ? (
                <tr><td colSpan={3} className="muted" style={{ textAlign: "center", padding: "20px 14px" }}>No recent charges</td></tr>
              ) : (recentTxQ.data ?? []).map((tx) => (
                <tr key={tx.id}>
                  <td className="mono" style={{ width: 90 }}>{shortDate(tx.created_at).replace(/, \d{4}/, "")}</td>
                  <td>{tx.description ?? tx.transaction_type}</td>
                  <td className="right strong">{tx.amount > 0 ? `+${num(tx.amount)} cr` : `${num(tx.amount)} cr`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <PauseModal
        open={pauseOpen}
        onClose={() => setPauseOpen(false)}
        onPaused={() => { qc.invalidateQueries({ queryKey: ["billing"] }); }}
      />
      <CancelRetentionModal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        videosRendered={o?.videos_rendered ?? 0}
        unusedCredits={credits}
        onChanged={() => { qc.invalidateQueries({ queryKey: ["billing"] }); }}
      />

      {editingThreshold ? (
        <NumericPromptModal
          title="Auto-recharge threshold"
          description="When credits drop below this number, the next pack is auto-purchased."
          unit="credits"
          initial={ar.threshold}
          min={100}
          max={10000}
          step={100}
          onClose={() => setEditingThreshold(false)}
          onSave={(v) => { arMut.mutate({ ...ar, threshold: v }); setEditingThreshold(false); }}
        />
      ) : null}
      {editingPack ? (
        <NumericPromptModal
          title="Pack to auto-buy"
          description="Credits to add when threshold is crossed."
          unit="credits"
          initial={ar.pack_credits}
          min={500}
          max={50000}
          step={500}
          onClose={() => setEditingPack(false)}
          onSave={(v) => { arMut.mutate({ ...ar, pack_credits: v }); setEditingPack(false); }}
        />
      ) : null}
      {editingCap ? (
        <NumericPromptModal
          title="Monthly spending cap"
          description="Auto-recharge stops once this $ amount is reached this month. Leave 0 for no cap."
          unit="$ / month"
          initial={ar.spending_cap ?? 0}
          min={0}
          max={5000}
          step={10}
          onClose={() => setEditingCap(false)}
          onSave={(v) => { arMut.mutate({ ...ar, spending_cap: v > 0 ? v : null }); setEditingCap(false); }}
        />
      ) : null}
    </section>
  );
}

function CategoryCell({ label, value, total, gold }: { label: string; value: number; total: number; gold?: boolean }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div className="lbl" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 500, lineHeight: 1 }}>{num(value)}</div>
      <div style={{ marginTop: 6 }}>
        <Bar pct={pct} gold={gold} />
      </div>
    </div>
  );
}

function NumericPromptModal({
  title, description, unit, initial, min, max, step, onClose, onSave,
}: {
  title: string; description: string; unit: string;
  initial: number; min: number; max: number; step: number;
  onClose: () => void; onSave: (v: number) => void;
}) {
  const [val, setVal] = useState(initial);
  return (
    <div className="billing-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="billing-modal" style={{ width: "min(420px, 100%)" }}>
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        <div className="top">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <div className="body">
          <input
            type="number"
            value={val}
            min={min}
            max={max}
            step={step}
            onChange={(e) => setVal(Number(e.target.value))}
            style={{
              width: "100%", padding: "10px 14px", background: "#151B20",
              border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, color: "#ECEAE4",
              fontFamily: "var(--mono)", fontSize: 14, outline: 0,
            }}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: "#5A6268", fontFamily: "var(--mono)" }}>{unit}</div>
        </div>
        <div className="foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-cyan" onClick={() => onSave(Math.max(min, Math.min(max, val)))}>Save</button>
        </div>
      </div>
    </div>
  );
}
