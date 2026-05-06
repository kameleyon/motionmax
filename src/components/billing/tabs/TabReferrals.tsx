import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchReferralSummary,
  ensureReferralCode,
  fetchReferralSignups,
  applyPromoCode,
} from "../_shared/billingApi";
import { num, shortDate } from "../_shared/format";

export default function TabReferrals() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [promo, setPromo] = useState("");
  const [applying, setApplying] = useState(false);

  const summaryQ = useQuery({
    queryKey: ["billing", "referral-summary", user?.id],
    queryFn: fetchReferralSummary,
    enabled: !!user,
  });

  const codeMut = useMutation({
    mutationFn: ensureReferralCode,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing", "referral-summary"] }),
  });

  const signupsQ = useQuery({
    queryKey: ["billing", "referral-signups", user?.id],
    queryFn: fetchReferralSignups,
    enabled: !!user,
  });

  const summary = summaryQ.data;
  const code = summary?.code ?? "";
  const signups = signupsQ.data ?? [];
  const url = code
    ? `${typeof window !== "undefined" ? window.location.origin : "https://motionmax.io"}/r/${code}`
    : "";

  function copyLink() {
    if (!url) {
      codeMut.mutate(undefined, {
        onSuccess: () => { toast.success("Link generated"); },
      });
      return;
    }
    void navigator.clipboard?.writeText(url);
    toast.success("Link copied to clipboard");
  }

  function shareTo(platform: "twitter" | "linkedin" | "email" | "whatsapp") {
    if (!url) { toast.error("Generate your link first by clicking Copy."); return; }
    const text = encodeURIComponent(`Join me on MotionMax and we both get 1,000 free credits.`);
    const u = encodeURIComponent(url);
    const links: Record<string, string> = {
      twitter: `https://twitter.com/intent/tweet?text=${text}&url=${u}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
      email: `mailto:?subject=${encodeURIComponent("Join me on MotionMax")}&body=${text}%20${u}`,
      whatsapp: `https://api.whatsapp.com/send?text=${text}%20${u}`,
    };
    window.open(links[platform], "_blank", "noopener,noreferrer");
  }

  async function applyCode() {
    if (!promo.trim()) return;
    setApplying(true);
    try {
      const resp = await applyPromoCode(promo.trim());
      if (resp.ok) {
        toast.success(resp.message ?? "Code applied");
        setPromo("");
        qc.invalidateQueries({ queryKey: ["billing"] });
      } else {
        toast.error(resp.error ?? "Invalid code");
      }
    } catch (err) {
      toast.error("Could not apply code", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setApplying(false);
    }
  }

  return (
    <section className="bill-tab">
      <div className="ref-hero">
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".14em",
          textTransform: "uppercase", color: "var(--cyan)", marginBottom: 14,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cyan)", boxShadow: "0 0 8px var(--cyan)" }} />
          GIVE 1,000 · GET 1,000
        </div>
        <h2>Invite a friend, both get <em>1,000 credits</em>.</h2>
        <p className="lede">
          Share your link. When a friend signs up and creates their first video, you both get 1,000 free credits — instantly.
        </p>

        <div className="ref-link">
          <input
            className="url"
            readOnly
            value={url || (code ? `motionmax.io/r/${code}` : "Click 'Copy link' to generate")}
          />
          <button type="button" className="copy" onClick={copyLink}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy link
          </button>
        </div>

        <div className="ref-share">
          <button type="button" onClick={() => shareTo("twitter")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M22 5.8a8 8 0 0 1-2.4.7 4 4 0 0 0 1.8-2.3 8 8 0 0 1-2.6 1 4 4 0 0 0-7 3.6A11.4 11.4 0 0 1 3 4.7a4 4 0 0 0 1.2 5.4A4 4 0 0 1 2 9.5v.1a4 4 0 0 0 3.2 4 4 4 0 0 1-1.8.1 4 4 0 0 0 3.7 2.8A8 8 0 0 1 1 18a11.3 11.3 0 0 0 6.1 1.8c7.4 0 11.4-6.1 11.4-11.4v-.5A8 8 0 0 0 22 5.8z"/></svg>
            Twitter
          </button>
          <button type="button" onClick={() => shareTo("linkedin")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/></svg>
            LinkedIn
          </button>
          <button type="button" onClick={() => shareTo("email")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M4 4h16c1 0 2 1 2 2v12c0 1-1 2-2 2H4c-1 0-2-1-2-2V6c0-1 1-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
            Email
          </button>
          <button type="button" onClick={() => shareTo("whatsapp")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
            </svg>
            WhatsApp
          </button>
        </div>
      </div>

      <div className="grid-3" style={{ marginTop: 18 }}>
        <div className="kpi">
          <div className="lbl">Friends invited</div>
          <div className="v">{num(summary?.invited_count ?? 0)}</div>
          <div className="d">Lifetime</div>
        </div>
        <div className="kpi">
          <div className="lbl">Friends joined</div>
          <div className="v">{num(summary?.joined_count ?? 0)}</div>
          <div className="d">
            {summary && summary.invited_count > 0
              ? `${Math.round((summary.joined_count / summary.invited_count) * 100)}% conversion`
              : "—"}
          </div>
        </div>
        <div className="kpi">
          <div className="lbl">Credits earned</div>
          <div className="v">{num(summary?.credits_earned ?? 0)}</div>
          <div className="d up">≈ ${((summary?.credits_earned ?? 0) * 0.01).toFixed(2)} value</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18, padding: 0 }}>
        <div className="h-row" style={{ padding: "20px 24px 16px", margin: 0 }}>
          <h3 style={{ margin: 0 }}>Referral history</h3>
          <span className="lbl">Last 20 signups</span>
        </div>
        {signups.length === 0 ? (
          <div style={{ padding: "30px 24px", textAlign: "center", color: "var(--ink-mute)", fontSize: 13 }}>
            No referrals yet. Share your link above to start earning.
          </div>
        ) : (
          <table className="tbl" style={{ margin: 0 }}>
            <thead>
              <tr>
                <th style={{ paddingLeft: 24 }}>Friend</th>
                <th>Status</th>
                <th>Joined</th>
                <th>First render</th>
                <th className="right">Credits earned</th>
              </tr>
            </thead>
            <tbody>
              {signups.map((s) => (
                <tr key={s.id}>
                  <td className="strong" style={{ paddingLeft: 24 }}>{s.referred_id.slice(0, 8)}…</td>
                  <td>
                    <span className={"pill" + (s.credits_awarded ? " ok" : " warn")}>
                      {s.credits_awarded ? "Active" : "Signed up"}
                    </span>
                  </td>
                  <td className="mono">{shortDate(s.signed_up_at)}</td>
                  <td className="mono">{s.first_render_at ? shortDate(s.first_render_at) : "— pending —"}</td>
                  <td className="right strong">{s.credits_awarded ? "+1,000" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Have a promo code?</h3>
        <div style={{ fontSize: 13, color: "var(--ink-dim)", marginBottom: 14 }}>
          Apply a one-time discount or bonus credits to your account.
        </div>
        <div style={{ display: "flex", gap: 10, maxWidth: 420 }}>
          <input
            placeholder="Enter promo code"
            value={promo}
            onChange={(e) => setPromo(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") applyCode(); }}
            style={{
              flex: 1, padding: "10px 14px", background: "var(--panel-2)",
              border: "1px solid var(--line-2)", borderRadius: 8, color: "var(--ink)",
              fontFamily: "var(--mono)", fontSize: 13, letterSpacing: ".06em",
              textTransform: "uppercase", outline: 0,
            }}
          />
          <button type="button" className="btn-cyan" onClick={applyCode} disabled={applying || !promo.trim()}>
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </section>
  );
}
