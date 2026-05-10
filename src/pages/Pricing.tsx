import { useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import { Check, X, Loader2, Coins, Sparkles } from "lucide-react";
import AppShell from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSubscription } from "@/hooks/useSubscription";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  isLikelyEUUser,
  EU_COOLING_OFF_CONSENT_COPY,
} from "@/lib/euCoolingOff";
import {
  PLANS,
  TOP_UP_PACKS,
  isPromoActive,
  PROMO_BANNER_COPY,
  multipackLadder,
  formatUsd,
  monthlyPromoPercentOff,
  yearlySavingsPercent,
  MULTIPACK_MAX,
  type PlanId,
} from "@/config/pricing";
import { TopUpPacksModal } from "@/components/credits/TopUpPacksModal";
// B-NEW-7 (Lens B) — paid_plan_selected funnel event. Fires BEFORE the
// EU cooling-off block so we measure intent ("user wants to pay")
// independently of compliance gating ("user clicked away because the
// waiver checkbox surprised them").
import { trackEvent } from "@/hooks/useAnalytics";
import { getStoredUtms } from "@/lib/utm";

/** Pricing — B-NEW-21 mirror of Agent Opus structure with motionmax's
 *  Creator + Studio tier names. Yearly/Monthly toggle drives both the
 *  headline price + the multi-pack credit-allotment dropdown. The
 *  EU cooling-off waiver from B-V1-5 still gates checkout. */

type CycleKey = "monthly" | "yearly";
type PaidPlanId = Exclude<PlanId, "free">;

export default function Pricing() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { createCheckout } = useSubscription();
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [cycle, setCycle] = useState<CycleKey>("yearly");
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);

  // Per-plan multi-pack multiplier (1×–6×). Default is 1× (the base
  // allotment); users bump it to grant more credits without changing tier.
  const [multipackByPlan, setMultipackByPlan] = useState<Record<PaidPlanId, number>>({
    creator: 1,
    studio: 1,
  });

  const promoActive = isPromoActive();

  // B-V1-5 / Comply L-B-05 — EU/EEA/UK cooling-off binding. Detection
  // runs post-mount so SSR/hydration matches.
  const [isEU, setIsEU] = useState(false);
  const [euWaived, setEuWaived] = useState(false);
  useEffect(() => {
    setIsEU(isLikelyEUUser());
  }, []);

  const handleSubscribe = async (planId: PaidPlanId, cycleOverride?: CycleKey) => {
    // C-2-1 (Hook B1): the autocheckout resumption path needs to pin
    // the cycle the user originally chose pre-auth — passing it in
    // explicitly avoids any race with `setCycle` state updates that
    // haven't flushed yet by the time the post-auth `setTimeout` fires.
    const effectiveCycle: CycleKey = cycleOverride ?? cycle;
    if (!user) {
      // C-2-1 fix (Hook B1): preserve plan + cycle across the auth
      // bounce so the most-expensive customer in the funnel doesn't
      // get dumped on /app empty-handed after signup. The `next` URL
      // points back at /pricing with an `autocheckout=<plan>_<cycle>`
      // flag — when the now-signed-in user lands here, the auto-resume
      // effect below picks it up. SessionStorage is a belt-and-
      // suspenders backup that survives the email-confirmation hop.
      try {
        sessionStorage.setItem(
          "mm_pending_checkout",
          JSON.stringify({ planId, cycle: effectiveCycle }),
        );
      } catch { /* sessionStorage may be unavailable — query params still carry it */ }
      const nextUrl = `/pricing?autocheckout=${encodeURIComponent(`${planId}_${effectiveCycle}`)}`;
      navigate(
        `/auth?mode=signup&next=${encodeURIComponent(nextUrl)}&plan=${encodeURIComponent(`${planId}_${effectiveCycle}`)}`,
      );
      return;
    }
    // B-NEW-7 (Lens B) — emit paid_plan_selected BEFORE the EU
    // cooling-off block so the event count reflects intent rather than
    // compliance pass-through.
    try {
      const utms = getStoredUtms();
      const utmEvt = utms
        ? {
            ...(utms.source   ? { utm_source: utms.source } : {}),
            ...(utms.medium   ? { utm_medium: utms.medium } : {}),
            ...(utms.campaign ? { utm_campaign: utms.campaign } : {}),
            ...(utms.term     ? { utm_term: utms.term } : {}),
            ...(utms.content  ? { utm_content: utms.content } : {}),
            ...(utms.gclid    ? { gclid: utms.gclid } : {}),
            ...(utms.fbclid   ? { fbclid: utms.fbclid } : {}),
          }
        : {};
      trackEvent("paid_plan_selected", {
        plan_id: planId,
        cycle: effectiveCycle,
        ...utmEvt,
      });
    } catch { /* analytics non-critical */ }
    if (isEU && !euWaived) {
      toast.error("Please confirm the EU/UK cooling-off waiver to continue.");
      return;
    }

    const plan = PLANS[planId];
    const priceId =
      effectiveCycle === "monthly" ? plan.getMonthlyPriceId() : plan.getYearlyPriceId();

    if (!priceId) {
      // The sync script hasn't been run yet — surface a clear message
      // rather than letting Stripe error opaquely.
      toast.error("Plan not configured", {
        description:
          "Run scripts/sync-stripe-products.mjs and add the printed STRIPE_PRICE_* env vars.",
      });
      return;
    }

    setPendingPlan(`${planId}-${effectiveCycle}`);
    try {
      const url = await createCheckout(priceId, "subscription", {
        euCoolingOffWaived: isEU ? euWaived : false,
      });
      if (url) window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start checkout", { description: msg });
    } finally {
      setPendingPlan(null);
    }
  };

  // C-2-1 fix (Hook B1) — auto-resume checkout when a freshly-authed
  // user lands on /pricing carrying an `?autocheckout=<plan>_<cycle>`
  // flag (set by the pre-auth CTA), or when sessionStorage has the
  // same intent (belt-and-suspenders for the email-confirmation hop).
  // Runs once per session — `autocheckoutFiredRef` guards against
  // double-fire on re-renders. Declared AFTER handleSubscribe so the
  // closure captures the bound function, not a TDZ reference.
  const autocheckoutFiredRef = useRef(false);
  useEffect(() => {
    if (!user || autocheckoutFiredRef.current) return;

    const params = new URLSearchParams(location.search);
    const queryFlag = params.get("autocheckout");
    let stashed: { planId: PaidPlanId; cycle: CycleKey } | null = null;
    try {
      const raw = sessionStorage.getItem("mm_pending_checkout");
      if (raw) stashed = JSON.parse(raw);
    } catch { /* ignore */ }

    let planId: PaidPlanId | null = null;
    let targetCycle: CycleKey | null = null;
    if (queryFlag) {
      const [p, c] = queryFlag.split("_");
      if ((p === "creator" || p === "studio") && (c === "monthly" || c === "yearly")) {
        planId = p;
        targetCycle = c;
      }
    } else if (stashed && (stashed.planId === "creator" || stashed.planId === "studio")) {
      planId = stashed.planId;
      targetCycle = stashed.cycle;
    }

    if (!planId || !targetCycle) return;

    autocheckoutFiredRef.current = true;
    try { sessionStorage.removeItem("mm_pending_checkout"); } catch { /* ignore */ }
    if (queryFlag) {
      window.history.replaceState({}, document.title, "/pricing");
    }
    if (targetCycle !== cycle) setCycle(targetCycle);

    // EU users must still tick the cooling-off waiver — handleSubscribe
    // will toast + return if needed. Pass the cycle explicitly so we
    // don't race the setCycle state update.
    const capturedPlan = planId;
    const capturedCycle = targetCycle;
    setTimeout(() => { void handleSubscribe(capturedPlan, capturedCycle); }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, location.search]);

  return (
    <AppShell breadcrumb="Pricing">
      <Helmet><title>Pricing · MotionMax</title></Helmet>

      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-8 sm:py-12 max-w-[1100px] mx-auto">
        {/* Promo banner — only renders inside the limited-time window. */}
        {promoActive && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="mx-auto max-w-[820px] mb-6 sm:mb-8 rounded-xl border border-[#E4C875]/40 bg-gradient-to-r from-[#E4C875]/10 to-[#14C8CC]/10 px-4 py-3 flex items-center gap-3"
            data-testid="promo-banner"
          >
            <Sparkles className="w-4 h-4 text-[#E4C875] shrink-0" />
            <p className="text-[12.5px] sm:text-[13px] text-[#ECEAE4] leading-snug">
              {PROMO_BANNER_COPY}
            </p>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="text-center"
        >
          <h1 className="font-serif text-[32px] sm:text-[40px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">
            Simple, transparent pricing
          </h1>
          <p className="text-[14px] sm:text-[15px] text-[#8A9198] mt-3">
            Start free. Upgrade when you're ready. No hidden fees.
          </p>

          {/* Billing-cycle toggle. Yearly is default-selected because it
              is the offer Jo wants visitors to anchor on. */}
          <div className="inline-flex items-center gap-1 mt-7 rounded-full bg-[#10151A] border border-white/10 p-1">
            <CycleButton active={cycle === "monthly"} onClick={() => setCycle("monthly")}>
              Monthly
            </CycleButton>
            <CycleButton active={cycle === "yearly"} onClick={() => setCycle("yearly")}>
              Yearly
              <span className="ml-1.5 text-[10px] font-semibold text-[#0A0D0F] bg-[#E4C875] px-1.5 py-0.5 rounded-full">
                Save {yearlySavingsPercent("creator")}%
              </span>
            </CycleButton>
          </div>
        </motion.div>

        {/* Plan grid — Free + Creator + Studio. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5 mt-10 sm:mt-12">
          <FreeCard onCta={() => (user ? toast.info("You're already on the platform — start creating!") : navigate("/auth"))} />
          <PaidPlanCard
            planId="creator"
            cycle={cycle}
            promoActive={promoActive}
            multipack={multipackByPlan.creator}
            onMultipackChange={(m) => setMultipackByPlan((s) => ({ ...s, creator: m }))}
            pending={pendingPlan === `creator-${cycle}`}
            blocked={isEU && !euWaived}
            onCta={() => handleSubscribe("creator")}
            accent="teal"
            popular
          />
          <PaidPlanCard
            planId="studio"
            cycle={cycle}
            promoActive={promoActive}
            multipack={multipackByPlan.studio}
            onMultipackChange={(m) => setMultipackByPlan((s) => ({ ...s, studio: m }))}
            pending={pendingPlan === `studio-${cycle}`}
            blocked={isEU && !euWaived}
            onCta={() => handleSubscribe("studio")}
            accent="gold"
          />
        </div>

        {/* EU cooling-off waiver — same component contract as before. */}
        {isEU && (
          <div
            className="mt-8 mx-auto max-w-[640px] rounded-xl border border-[#E4C875]/30 bg-[#10151A] p-4 sm:p-5"
            data-testid="eu-cooling-off-block"
          >
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={euWaived}
                onChange={(e) => setEuWaived(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#14C8CC]"
                aria-describedby="eu-cooling-off-copy"
              />
              <span
                id="eu-cooling-off-copy"
                className="text-[12.5px] leading-[1.55] text-[#ECEAE4]"
              >
                {EU_COOLING_OFF_CONSENT_COPY}
              </span>
            </label>
            {!euWaived && (
              <p className="text-[11px] text-[#8A9198] mt-2 ml-7">
                You must tick this box to continue to checkout.
              </p>
            )}
          </div>
        )}

        <p className="text-center text-[12px] text-[#5A6268] mt-8">
          All plans include a 7-day money-back guarantee. Annual billing saves up to {yearlySavingsPercent("studio")}%.
        </p>

        {/* Top-up packs — one-time, available to ALL tiers (incl. Free). */}
        <div className="mt-16 sm:mt-20">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#E4C875]/10 border border-[#E4C875]/30 font-mono text-[10px] tracking-[0.16em] uppercase text-[#E4C875]">
              <Coins className="w-3 h-3" />
              Top up
            </span>
            <h2 className="font-serif text-[24px] sm:text-[28px] font-medium tracking-tight text-[#ECEAE4] mt-3">
              One-time credit packs
            </h2>
            <p className="text-[13px] sm:text-[14px] text-[#8A9198] mt-2">
              Need more credits this cycle? Stack a pack on top of any plan — Free included. Top-up credits never expire.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4 mt-8">
            {TOP_UP_PACKS.map((p, i) => (
              <motion.div
                key={p.sku}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.04 }}
                className={cn(
                  "rounded-xl bg-[#10151A] border p-4 flex flex-col",
                  i === TOP_UP_PACKS.length - 1
                    ? "border-[#E4C875]/40"
                    : "border-white/8",
                )}
              >
                <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268]">
                  {p.label}
                </div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-serif text-[22px] text-[#ECEAE4] leading-none">
                    {p.credits.toLocaleString()}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-[#5A6268] mt-1.5 tracking-wide">
                  ${p.per_credit.toFixed(3)} / credit
                </div>
                <div className="font-serif text-[18px] text-[#ECEAE4] mt-3">
                  {formatUsd(p.price_usd)}
                </div>
              </motion.div>
            ))}
          </div>
          <div className="text-center mt-6">
            <Button
              type="button"
              onClick={() => setTopUpModalOpen(true)}
              className="h-10 px-6 rounded-full bg-[#E4C875] text-[#0A0D0F] hover:brightness-110 font-semibold text-[12.5px]"
            >
              Buy a credit pack
            </Button>
          </div>
        </div>
      </div>

      <TopUpPacksModal open={topUpModalOpen} onOpenChange={setTopUpModalOpen} />
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function CycleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "px-4 py-1.5 rounded-full text-[12.5px] font-semibold transition-colors inline-flex items-center",
        active
          ? "bg-[#14C8CC] text-[#0A0D0F]"
          : "text-[#8A9198] hover:text-[#ECEAE4]",
      )}
    >
      {children}
    </button>
  );
}

function FreeCard({ onCta }: { onCta: () => void }) {
  const p = PLANS.free;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="relative rounded-2xl bg-[#10151A] border border-white/8 p-6 sm:p-7 flex flex-col"
    >
      <h3 className="font-serif text-[20px] font-medium text-[#ECEAE4]">{p.name}</h3>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-serif text-[36px] font-medium text-[#ECEAE4] leading-none">$0</span>
        <span className="text-[13px] text-[#8A9198]">/month</span>
      </div>
      <p className="text-[13px] text-[#8A9198] mt-2.5">{p.blurb}</p>

      <ul className="mt-5 space-y-2 flex-1">
        <Feature on>{p.credits_monthly} credits / month</Feature>
        <Feature on>{p.daily_credits} daily refresh credits</Feature>
        <Feature on>Full editor access</Feature>
        <Feature off>Watermark removal</Feature>
        <Feature off>Voice cloning</Feature>
        <Feature off>Automation slots</Feature>
      </ul>

      <Button
        type="button"
        onClick={onCta}
        className="w-full mt-6 h-10 rounded-full font-semibold text-[12.5px] bg-transparent border border-white/15 text-[#ECEAE4] hover:bg-white/5"
      >
        Get started free
      </Button>
    </motion.div>
  );
}

function PaidPlanCard({
  planId,
  cycle,
  promoActive,
  multipack,
  onMultipackChange,
  pending,
  blocked,
  onCta,
  accent,
  popular = false,
}: {
  planId: PaidPlanId;
  cycle: CycleKey;
  promoActive: boolean;
  multipack: number;
  onMultipackChange: (n: number) => void;
  pending: boolean;
  blocked: boolean;
  onCta: () => void;
  accent: "teal" | "gold";
  popular?: boolean;
}) {
  const plan = PLANS[planId];

  // Compute the credit ladder for the chosen cycle.
  const ladder = useMemo(
    () =>
      multipackLadder(
        cycle === "monthly" ? plan.credits_monthly : plan.credits_yearly,
      ),
    [cycle, plan.credits_monthly, plan.credits_yearly],
  );

  const promoPct = monthlyPromoPercentOff(planId);
  const showStrikethrough = cycle === "monthly" && promoActive && promoPct > 0;

  // Headline price string for this cycle.
  const priceMain =
    cycle === "monthly"
      ? formatUsd(promoActive ? plan.price_monthly_first3 : plan.price_monthly_after)
      : formatUsd(plan.price_yearly_monthly);
  const priceStrike =
    cycle === "monthly" && promoActive ? formatUsd(plan.price_monthly_after) : null;
  const billedAs =
    cycle === "yearly"
      ? `${formatUsd(plan.price_yearly_total)} billed annually`
      : promoActive
        ? "for the first 3 months"
        : "billed monthly";

  const accentBorder =
    accent === "teal"
      ? "border-[#14C8CC]/40 shadow-[0_18px_50px_-22px_rgba(20,200,204,0.45)]"
      : "border-[#E4C875]/30";

  const ctaClass =
    accent === "teal"
      ? "bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] hover:brightness-110"
      : "bg-transparent border border-[#E4C875]/40 text-[#E4C875] hover:bg-[#E4C875]/10";

  const checkColor = accent === "gold" ? "text-[#E4C875]" : "text-[#14C8CC]";

  // The selected ladder allotment (what the user's about to be granted).
  const selectedCredits = ladder[multipack - 1];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.05 }}
      className={cn(
        "relative rounded-2xl bg-[#10151A] border p-6 sm:p-7 flex flex-col",
        accentBorder,
      )}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-[#14C8CC] text-[#0A0D0F] font-mono text-[10px] tracking-[0.12em] uppercase font-semibold">
          Most popular
        </div>
      )}

      <h3 className="font-serif text-[20px] font-medium text-[#ECEAE4]">{plan.name}</h3>

      <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
        {priceStrike && (
          <span className="text-[18px] font-serif text-[#5A6268] line-through">
            {priceStrike}
          </span>
        )}
        <span className="font-serif text-[36px] font-medium text-[#ECEAE4] leading-none">
          {priceMain}
        </span>
        <span className="text-[13px] text-[#8A9198]">/month</span>
      </div>

      <p className="text-[11.5px] font-mono uppercase tracking-[0.12em] text-[#8A9198] mt-1.5">
        {billedAs}
      </p>

      {showStrikethrough && (
        <p
          className="text-[11px] text-[#E4C875] mt-1"
          data-testid={`promo-caption-${planId}`}
        >
          Save {promoPct}% for the first 3 months — then {formatUsd(plan.price_monthly_after)}/mo.
        </p>
      )}

      <p className="text-[13px] text-[#8A9198] mt-3">{plan.blurb}</p>

      {/* Multi-pack ladder selector */}
      <div className="mt-4">
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] block mb-1.5">
          Credit allotment
        </label>
        <Select
          value={String(multipack)}
          onValueChange={(v) => onMultipackChange(Number(v))}
        >
          <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4] h-9 text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-[#10151A] border-white/10">
            {ladder.map((credits, idx) => {
              const mult = idx + 1;
              return (
                <SelectItem key={mult} value={String(mult)}>
                  {mult}× — {credits.toLocaleString()} credits
                  {cycle === "monthly" ? "/mo" : "/yr"}
                  {mult === 1 ? " (base)" : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {multipack > 1 && (
          <p className="text-[10.5px] text-[#5A6268] mt-1.5 leading-snug">
            Selected: {selectedCredits.toLocaleString()} credits {cycle === "monthly" ? "per month" : "per year"} ({multipack}× of base).
          </p>
        )}
      </div>

      <ul className="mt-5 space-y-2 flex-1">
        <Feature on color={checkColor}>
          {(cycle === "monthly" ? plan.credits_monthly : plan.credits_yearly).toLocaleString()} credits / {cycle === "monthly" ? "month" : "year"}
        </Feature>
        <Feature on color={checkColor}>+{plan.daily_credits} daily refresh credits</Feature>
        <Feature on color={checkColor}>
          {plan.voice_clones} voice clone slot{plan.voice_clones === 1 ? "" : "s"}
        </Feature>
        <Feature on color={checkColor}>
          {plan.automation_slots} automation slot{plan.automation_slots === 1 ? "" : "s"}
        </Feature>
        <Feature on={plan.watermark_removal} color={checkColor}>Watermark removal</Feature>
        <Feature on={plan.priority_queue} color={checkColor}>Priority queue</Feature>
        <Feature on color={checkColor}>Multi-pack ladder up to {MULTIPACK_MAX}×</Feature>
      </ul>

      <Button
        type="button"
        onClick={onCta}
        disabled={pending || blocked}
        aria-disabled={pending || blocked}
        title={blocked ? "Confirm the EU/UK cooling-off waiver above to continue." : undefined}
        className={cn(
          "w-full mt-6 h-10 rounded-full font-semibold text-[12.5px] disabled:opacity-50",
          ctaClass,
        )}
      >
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> : null}
        {pending
          ? "Opening checkout…"
          : blocked
            ? "Confirm EU/UK waiver above"
            : `Start with ${plan.name}`}
      </Button>
    </motion.div>
  );
}

function Feature({
  children,
  on = true,
  color = "text-[#14C8CC]",
}: {
  children: React.ReactNode;
  on?: boolean;
  color?: string;
}) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      {on ? (
        <Check className={cn("w-4 h-4 shrink-0 mt-[1px]", color)} />
      ) : (
        <X className="w-4 h-4 shrink-0 mt-[1px] text-[#5A6268]" />
      )}
      <span className={on ? "text-[#ECEAE4]" : "text-[#5A6268]"}>{children}</span>
    </li>
  );
}
