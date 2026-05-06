import { lazy, Suspense, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell from "@/components/dashboard/AppShell";
import { useAuth } from "@/hooks/useAuth";
import { fetchBillingOverview } from "@/components/billing/_shared/billingApi";
import "@/styles/billing-tokens.css";

/* Lazy-load each tab so a user that only views Overview doesn't pay
   the bundle cost of the chart-heavy Usage tab. */
const TabOverview  = lazy(() => import("@/components/billing/tabs/TabOverview"));
const TabPlans     = lazy(() => import("@/components/billing/tabs/TabPlans"));
const TabTopup     = lazy(() => import("@/components/billing/tabs/TabTopup"));
const TabUsage     = lazy(() => import("@/components/billing/tabs/TabUsage"));
const TabInvoices  = lazy(() => import("@/components/billing/tabs/TabInvoices"));
const TabReferrals = lazy(() => import("@/components/billing/tabs/TabReferrals"));

type TabKey = "overview" | "plans" | "topup" | "usage" | "invoices" | "referrals";
const TAB_KEYS: TabKey[] = ["overview", "plans", "topup", "usage", "invoices", "referrals"];

function parseTab(raw: string | null): TabKey {
  return TAB_KEYS.includes((raw as TabKey)) ? (raw as TabKey) : "overview";
}

export default function Billing() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const activeTab = parseTab(params.get("tab"));

  // Toast on returning from Stripe checkout
  useEffect(() => {
    if (params.get("success") === "true") {
      toast.success("Payment received — credits will appear shortly.");
      const next = new URLSearchParams(params);
      next.delete("success");
      setParams(next, { replace: true });
    } else if (params.get("canceled") === "true") {
      toast("Checkout cancelled.", { description: "Nothing was charged." });
      const next = new URLSearchParams(params);
      next.delete("canceled");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  // Top-level overview is shared with the Overview tab — prefetch it
  // here so KPI tiles don't flash empty when first switching to Plans.
  const overviewQ = useQuery({
    queryKey: ["billing", "overview"],
    queryFn: fetchBillingOverview,
    enabled: !!user,
    staleTime: 30_000,
  });

  function goTab(t: string) {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: false });
  }

  const planLabel = overviewQ.data?.plan
    ? overviewQ.data.plan.charAt(0).toUpperCase() + overviewQ.data.plan.slice(1)
    : "Free";

  return (
    <AppShell breadcrumb="Billing & plans">
      <Helmet><title>Billing &amp; Plans · MotionMax</title></Helmet>
      <div className="billing-shell">
        <div className="bill-wrap">
          <div className="bill-head">
            <div>
              <h1>Billing &amp; <em>plans</em></h1>
              <p className="lede">
                Track what you spend, what you have, and where it goes. Top up, switch plans, or invite a friend — every credit, every receipt, in one place.
              </p>
            </div>
            <div className="who">
              <span className="pl">{planLabel.toUpperCase()} PLAN</span>
            </div>
          </div>

          <div className="bill-tabs" id="billTabs" role="tablist">
            <TabBtn id="overview" active={activeTab} onClick={goTab} ariaLabel="Overview">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span className="t-label">Overview</span>
            </TabBtn>
            <TabBtn id="plans" active={activeTab} onClick={goTab} ariaLabel="Plans">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><path d="M12 2l3 7h7l-5.5 4.5L18 22l-6-4-6 4 1.5-8.5L2 9h7z" /></svg>
              <span className="t-label">Plans</span>
            </TabBtn>
            <TabBtn id="topup" active={activeTab} onClick={goTab} ariaLabel="Top-up packs">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
              <span className="t-label">Top-up <span className="pill">PACKS</span></span>
            </TabBtn>
            <TabBtn id="usage" active={activeTab} onClick={goTab} ariaLabel="Usage">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></svg>
              <span className="t-label">Usage</span>
            </TabBtn>
            <TabBtn id="invoices" active={activeTab} onClick={goTab} ariaLabel="Invoices">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6M9 13h6M9 17h6" />
              </svg>
              <span className="t-label">Invoices</span>
            </TabBtn>
            <TabBtn id="referrals" active={activeTab} onClick={goTab} ariaLabel="Referrals">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M16 11a4 4 0 1 0-8 0M3 21v-1a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v1" />
              </svg>
              <span className="t-label">Referrals <span className="pill">EARN</span></span>
            </TabBtn>
          </div>

          <Suspense fallback={
            <div style={{ padding: "60px 0", textAlign: "center", color: "var(--ink-mute)", fontSize: 13 }}>
              Loading…
            </div>
          }>
            {activeTab === "overview"  ? <TabOverview onGoTab={goTab} /> : null}
            {activeTab === "plans"     ? <TabPlans /> : null}
            {activeTab === "topup"     ? <TabTopup /> : null}
            {activeTab === "usage"     ? <TabUsage /> : null}
            {activeTab === "invoices"  ? <TabInvoices /> : null}
            {activeTab === "referrals" ? <TabReferrals /> : null}
          </Suspense>
        </div>
      </div>
    </AppShell>
  );
}

function TabBtn({
  id, active, onClick, children, ariaLabel,
}: {
  id: TabKey;
  active: TabKey;
  onClick: (t: string) => void;
  children: React.ReactNode;
  /** Accessible label exposed when the visual `.t-label` is hidden at narrow widths. */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={active === id ? "on" : ""}
      onClick={() => onClick(id)}
      role="tab"
      aria-selected={active === id}
      aria-label={ariaLabel}
      data-t={id}
    >
      {children}
    </button>
  );
}
