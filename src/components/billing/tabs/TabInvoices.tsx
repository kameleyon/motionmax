import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { Toggle } from "../_shared/Toggle";
import { money, shortDate } from "../_shared/format";
import {
  fetchInvoices,
  fetchBillingPrefs,
  saveBillingPrefs,
  callCustomerPortal,
  type BillingNotificationPrefs,
} from "../_shared/billingApi";

export default function TabInvoices() {
  const { user, session } = useAuth();
  const qc = useQueryClient();

  const invoicesQ = useQuery({
    queryKey: ["billing", "invoices", user?.id],
    queryFn: () => fetchInvoices(session!.access_token),
    enabled: !!user && !!session?.access_token,
    staleTime: 60_000,
  });

  const prefsQ = useQuery({
    queryKey: ["billing", "prefs", user?.id],
    queryFn: () => fetchBillingPrefs(user!.id),
    enabled: !!user,
  });

  const [prefs, setPrefs] = useState<BillingNotificationPrefs>({
    email_receipts: true, include_vat: false, year_end_statement: false,
  });
  useEffect(() => { if (prefsQ.data) setPrefs(prefsQ.data); }, [prefsQ.data]);

  const prefsMut = useMutation({
    mutationFn: (next: BillingNotificationPrefs) => saveBillingPrefs(user!.id, next),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["billing", "prefs"] }); toast.success("Preferences saved"); },
    onError: (e) => toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) }),
  });

  const portalMut = useMutation({
    mutationFn: async () => { if (!session?.access_token) throw new Error("Sign in required"); return callCustomerPortal(session.access_token); },
    onSuccess: (url) => window.open(url, "_blank"),
    onError: (e) => toast.error("Could not open portal", { description: e instanceof Error ? e.message : String(e) }),
  });

  function update(next: Partial<BillingNotificationPrefs>) {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    prefsMut.mutate(merged);
  }

  const invoices = invoicesQ.data ?? [];

  return (
    <section className="bill-tab">
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="h-row" style={{ padding: "20px 24px 16px", margin: 0 }}>
          <div>
            <h3 style={{ margin: 0 }}>Invoices &amp; receipts</h3>
            <div className="tiny muted" style={{ marginTop: 4 }}>All charges include applicable taxes · downloadable as PDF</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-ghost" style={{ padding: "7px 12px", fontSize: 12 }} onClick={() => portalMut.mutate()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              Manage billing
            </button>
          </div>
        </div>

        {invoicesQ.isLoading ? (
          <div style={{ padding: "40px 24px", textAlign: "center", color: "var(--ink-mute)", fontSize: 13 }}>
            Loading invoices…
          </div>
        ) : invoices.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center", color: "var(--ink-mute)", fontSize: 13 }}>
            No invoices yet. Subscription invoices and top-up receipts appear here once charged.
          </div>
        ) : (
          <table className="tbl" style={{ margin: 0 }}>
            <thead>
              <tr>
                <th style={{ paddingLeft: 24 }}>Invoice</th>
                <th>Date</th>
                <th>Description</th>
                <th>Method</th>
                <th className="right">Amount</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="mono" style={{ paddingLeft: 24 }}>{inv.number ?? inv.id.slice(0, 12)}</td>
                  <td className="mono">{shortDate(new Date(inv.date * 1000).toISOString())}</td>
                  <td className="strong">{inv.description}</td>
                  <td className="mono">
                    {inv.payment_method_brand && inv.payment_method_last4
                      ? `${inv.payment_method_brand} •••• ${inv.payment_method_last4}`
                      : "—"}
                  </td>
                  <td className="right strong">{money(inv.amount / 100)}</td>
                  <td><span className={"pill" + (inv.paid ? " ok" : " warn")}>{inv.paid ? "Paid" : (inv.status ?? "open")}</span></td>
                  <td>
                    {inv.invoice_pdf ? (
                      <a
                        href={inv.invoice_pdf}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ico-btn"
                        style={{ display: "inline-grid", placeItems: "center" }}
                        title="Download PDF"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                        </svg>
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h3>Billing address</h3>
          <div style={{ fontSize: 13.5, color: "var(--ink-dim)", lineHeight: 1.7 }}>
            Manage your billing address and tax-ID in the Stripe Customer Portal.
          </div>
          <button type="button" className="btn-ghost" style={{ marginTop: 14, padding: "7px 12px", fontSize: 12 }} onClick={() => portalMut.mutate()}>
            Update address
          </button>
        </div>
        <div className="card">
          <h3>Tax &amp; receipts</h3>
          <div className="set-row" style={{ border: 0, padding: "0 0 12px" }}>
            <div className="info"><div className="t">Email receipts</div><div className="d">Send PDF on every charge</div></div>
            <Toggle on={prefs.email_receipts} ariaLabel="Email receipts" onChange={(v) => update({ email_receipts: v })} />
          </div>
          <div className="set-row">
            <div className="info"><div className="t">Include VAT on invoices</div><div className="d">For VAT-registered businesses</div></div>
            <Toggle on={prefs.include_vat} ariaLabel="Include VAT on invoices" onChange={(v) => update({ include_vat: v })} />
          </div>
          <div className="set-row">
            <div className="info"><div className="t">Year-end statement</div><div className="d">Auto-emailed each January</div></div>
            <Toggle on={prefs.year_end_statement} ariaLabel="Year-end statement" onChange={(v) => update({ year_end_statement: v })} />
          </div>
        </div>
      </div>
    </section>
  );
}
