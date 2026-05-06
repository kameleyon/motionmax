import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { PLAN_PRICES } from "@/config/products";
import { STRIPE_PLANS } from "@/config/stripeProducts";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { PackSelect, type PackOption } from "../_shared/PackSelect";
import { fetchBillingOverview, callUpdatePackQuantity } from "../_shared/billingApi";
import { num } from "../_shared/format";

type Interval = "monthly" | "yearly";

interface PlanCard {
  id: "free" | "creator" | "studio";
  name: string;
  tag: string;
  current?: boolean;
  featured?: boolean;
}

export default function TabPlans() {
  const { user, session } = useAuth();
  const { createCheckout } = useSubscription();
  const qc = useQueryClient();
  const [interval, setInterval] = useState<Interval>("yearly");
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  const overviewQ = useQuery({
    queryKey: ["billing", "overview"],
    queryFn: fetchBillingOverview,
    enabled: !!user,
  });

  const currentPlan = (overviewQ.data?.plan ?? "free") as PlanCard["id"] | "professional";
  const normalizedCurrent: PlanCard["id"] =
    currentPlan === "professional" ? "studio" :
    currentPlan === "creator" || currentPlan === "studio" || currentPlan === "free" ? currentPlan : "free";

  const plans: PlanCard[] = [
    { id: "free", name: "Free", tag: "Try MotionMax with no credit card." },
    { id: "creator", name: "Creator", tag: "For creators and content producers." },
    { id: "studio", name: "Studio", tag: "For teams, agencies, and power creators." },
  ];

  async function handleCta(planId: PlanCard["id"]) {
    if (planId === "free") return;
    if (!user) { toast.error("Please sign in"); return; }
    const sp = STRIPE_PLANS[planId];
    const priceId = interval === "yearly" ? sp.yearly.priceId : sp.monthly.priceId;
    if (!priceId) { toast.error("Plan not yet configured"); return; }
    setPendingPlan(planId);
    try {
      const url = await createCheckout(priceId, "subscription");
      if (url) window.location.href = url;
    } catch (err) {
      toast.error("Could not start checkout", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setPendingPlan(null);
    }
  }

  async function handlePackChange(planId: "creator" | "studio", mult: PackOption["multiplier"]) {
    if (!session?.access_token) { toast.error("Please sign in"); return; }
    if (normalizedCurrent !== planId) {
      toast.info("Switch to this plan first to change pack quantity.");
      return;
    }
    try {
      await callUpdatePackQuantity(session.access_token, mult);
      toast.success(`Pack quantity set to ${mult}×`);
      qc.invalidateQueries({ queryKey: ["billing"] });
    } catch (err) {
      toast.error("Could not update pack", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  const packQty = (overviewQ.data?.pack_quantity ?? 1) as PackOption["multiplier"];

  return (
    <section className="bill-tab">
      <div style={{ textAlign: "center", marginBottom: 8 }}>
        <h2 style={{
          fontFamily: "var(--serif)", fontWeight: 400, fontSize: 42,
          lineHeight: 1.05, letterSpacing: "-.02em", margin: "14px 0 6px",
        }}>
          Choose a <em style={{ fontStyle: "normal", color: "var(--cyan)" }}>plan</em>
        </h2>
        <p style={{ fontSize: 14, color: "var(--ink-dim)", margin: 0 }}>
          Start free. Upgrade when you're ready. Switch anytime.
        </p>
      </div>

      <div className="plans-toggle-wrap">
        <div className="plans-toggle">
          <button type="button" className={interval === "yearly" ? "on" : ""} onClick={() => setInterval("yearly")}>
            Yearly <span className="save">save ~30%</span>
          </button>
          <button type="button" className={interval === "monthly" ? "on" : ""} onClick={() => setInterval("monthly")}>
            Monthly
          </button>
        </div>
      </div>

      <div className="plans">
        {plans.map((plan) => {
          const isCur = normalizedCurrent === plan.id;
          const isFeatured = plan.id === "creator";
          const limits = PLAN_LIMITS[plan.id];
          const monthlyPrice = PLAN_PRICES[plan.id]?.monthly ?? "$0";
          const yearlyPrice = PLAN_PRICES[plan.id]?.yearly ?? "$0";
          const displayPrice = interval === "yearly" ? yearlyPrice : monthlyPrice;

          // Pack add-on options (only for creator/studio).
          // Per-unit pricing matches scripts/stripe-create-billing-products.ts:
          //   Creator: $5/mo or $50/yr per extra pack (= 500 credits)
          //   Studio:  $20/mo or $200/yr per extra pack (= 2,500 credits)
          const perUnitMonthly = plan.id === "creator" ? 5 : plan.id === "studio" ? 20 : 0;
          const perUnitYearly  = plan.id === "creator" ? 50 : plan.id === "studio" ? 200 : 0;
          const perUnit = interval === "yearly" ? perUnitYearly : perUnitMonthly;
          const intervalSuffix = interval === "yearly" ? "/yr" : "/mo";
          const perPackCredits = limits?.creditsPerMonth ?? 0;

          const packOptions: PackOption[] = perPackCredits > 0 ? [
            { credits: perPackCredits,      multiplier: 1,  priceHint: "included" },
            { credits: perPackCredits * 2,  multiplier: 2,  priceHint: `+$${perUnit}${intervalSuffix}` },
            { credits: perPackCredits * 4,  multiplier: 4,  priceHint: `+$${perUnit * 3}${intervalSuffix}` },
            { credits: perPackCredits * 10, multiplier: 10, priceHint: `+$${perUnit * 9}${intervalSuffix}` },
          ] : [];

          return (
            <div
              key={plan.id}
              className={"plan" + (isCur ? " cur" : "") + (isFeatured ? " feat" : "")}
            >
              {isCur ? <span className="ribbon cur">YOUR PLAN · {plan.name.toUpperCase()}</span> : null}
              <h4>{plan.name}</h4>
              <p className="tag">{plan.tag}</p>
              <div className="price">
                <span className="n">
                  <em>{displayPrice}</em>
                </span>
                <span className="p">/{interval === "yearly" ? "month, billed annually" : "month"}</span>
              </div>
              <div className="billed">
                {plan.id === "free" ? "No card required" :
                  interval === "yearly" ? `Billed annually` : `Billed monthly`}
              </div>

              {packOptions.length > 0 ? (
                <PackSelect
                  options={packOptions}
                  value={isCur ? packQty : 1}
                  onChange={(m) => handlePackChange(plan.id as "creator" | "studio", m)}
                  disabled={!isCur}
                />
              ) : null}

              <div className="cta">
                <button
                  type="button"
                  onClick={() => handleCta(plan.id)}
                  disabled={isCur || pendingPlan === plan.id}
                >
                  {isCur ? `Current ${plan.name.toLowerCase()} plan` :
                    plan.id === "free" ? "Free tier" :
                    pendingPlan === plan.id ? "Opening checkout…" : `Choose ${plan.name}`}
                  <span className="sub">
                    {isCur ? "Manage above" :
                      plan.id === "free" ? "Always free" : "Switch in one click"}
                  </span>
                </button>
              </div>

              <ul className="feats">
                {plan.id !== "free" ? <li className="head">Everything in {plan.id === "studio" ? "Creator" : "Free"}, plus:</li> : null}
                {plan.id === "free" ? (
                  <>
                    <Feat>
                      <span><b>900 signup credits</b><br /><span className="muted tiny">+ 200 free daily credits</span></span>
                    </Feat>
                    <Feat>Full editor access</Feat>
                    <Feat>720p exports with watermark</Feat>
                    <Feat>Basic voices, English only</Feat>
                  </>
                ) : plan.id === "creator" ? (
                  <>
                    <Feat>
                      <span><b>{num(limits.creditsPerMonth)} credits / month</b></span>
                    </Feat>
                    <Feat>{num(limits.dailyFreeCredits)} free daily credits</Feat>
                    <Feat>Watermark removal</Feat>
                    <Feat>1080p exports</Feat>
                    <Feat>{limits.voiceClones} voice clone slot</Feat>
                  </>
                ) : (
                  <>
                    <Feat>
                      <span><b>{num(limits.creditsPerMonth)} credits / month</b></span>
                    </Feat>
                    <Feat>4K exports + AutoPost Lab</Feat>
                    <Feat>{limits.voiceClones} voice clone slots</Feat>
                    <Feat>Priority rendering · 24h SLA</Feat>
                    <Feat>Brand kits + character consistency</Feat>
                  </>
                )}
              </ul>
            </div>
          );
        })}
      </div>

      <p style={{ textAlign: "center", marginTop: 24, fontSize: 13, color: "var(--ink-mute)" }}>
        All plans include a 7-day money-back guarantee. Switch or cancel anytime.
      </p>
    </section>
  );
}

function Feat({ children }: { children: React.ReactNode }) {
  return (
    <li>
      <span className="ck">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
          <path d="M4 12l5 5 11-11" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}
