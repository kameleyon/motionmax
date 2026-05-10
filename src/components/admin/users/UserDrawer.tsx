/**
 * UserDrawer — Phase 8.6 right-side admin user drawer. Opened from
 * `<TabUsers>` when `?user=<uuid>` is set. Aggregates everything via
 * `admin_user_full_detail(p_user_id)` (single round-trip), and routes
 * each sub-tab through its dedicated RPC / edge fn:
 *
 *   - Overview     — KPI tiles + 14d BarChart from full_detail.gen_history
 *   - Activity     — `admin_activity_feed({ p_user_id })`
 *   - Billing      — credit_transactions list + `admin_grant_credits`
 *   - Communicate  — `admin_open_thread(...)` (toast-only TODO if missing)
 *   - Danger       — `admin_set_user_status`, `admin-force-signout` edge
 *                    fn, `admin-hard-delete-user` edge fn
 *
 * Closes on ESC or backdrop click. Width 640 px / max 100vw with a
 * 250 ms slide-in. Focus trapped to the drawer while open.
 */

import { lazy, Suspense, useEffect, useState, type JSX, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ActivityFeed, type FeedItem, type IconKey } from "@/components/admin/_shared/ActivityFeed";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { Avatar } from "@/components/admin/_shared/Avatar";
import { BarChart } from "@/components/admin/_shared/BarChart";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Pill } from "@/components/admin/_shared/Pill";
import { formatRel, num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

// Wave D §C-7 (UserDrawer chunk audit): RichEditor pulls in tiptap +
// StarterKit + extensions (~200 KB). Lazy-load the whole Communicate
// panel so admins who only open Overview/Activity/Billing/Danger never
// pay that cost. Comms tab is opened in <10% of drawer sessions.
const CommunicatePanel = lazy(() => import("./CommunicatePanel"));

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

interface UserFullDetail {
  profile: {
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
    last_active_at: string | null;
  } | null;
  auth: {
    email: string | null;
    created_at: string | null;
    last_sign_in_at: string | null;
    country: string | null;
  } | null;
  subscription: { plan_name: string | null; status: string | null } | null;
  credits: { credits_balance: number | null; total_purchased: number | null } | null;
  total_generations: number | null;
  errors_24h: number | null;
  usage_14d: { day: string; daily: number }[] | null;
  recent_transactions: {
    id: string;
    created_at: string;
    description: string | null;
    amount: number;
    transaction_type: string | null;
  }[] | null;
}
interface ActivityFeedRow {
  created_at: string;
  event_type: string | null;
  category: string | null;
  message: string | null;
}

type DrawerTab = "overview" | "activity" | "billing" | "communicate" | "danger";

const TABS: { key: DrawerTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "activity", label: "Activity" },
  { key: "billing", label: "Billing" },
  { key: "communicate", label: "Communicate" },
  { key: "danger", label: "Danger" },
];

async function fetchDetail(userId: string): Promise<UserFullDetail> {
  const { data, error } = await rpc<UserFullDetail>("admin_user_full_detail", { p_user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_user_full_detail returned no data");
  return data;
}

async function fetchActivity(userId: string): Promise<ActivityFeedRow[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await rpc<ActivityFeedRow[]>("admin_activity_feed", {
    p_since: since, p_user_id: userId, p_event_types: null, p_limit: 50,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function glyphFor(e: string | null): IconKey {
  if (!e) return "spark";
  if (e.startsWith("pay.")) return "credit";
  if (e.endsWith(".failed")) return "alert";
  if (e.startsWith("auth.") || e.startsWith("admin.")) return "shield";
  if (e.startsWith("message.")) return "mail";
  if (e.startsWith("flag.")) return "flag";
  return "spark";
}

export interface UserDrawerProps {
  userId: string;
  onClose: () => void;
}

export function UserDrawer({ userId, onClose }: UserDrawerProps): JSX.Element {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DrawerTab>("overview");

  const detail = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("users", "detail", userId),
    queryFn: () => fetchDetail(userId),
  });
  const activity = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("users", "activity", userId),
    queryFn: () => fetchActivity(userId),
    enabled: tab === "activity",
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  if (detail.isLoading) {
    return <DrawerShell onClose={onClose}><AdminLoading /></DrawerShell>;
  }
  if (detail.error || !detail.data) {
    return (
      <DrawerShell onClose={onClose}>
        <AdminEmpty title="Failed to load user" hint={detail.error instanceof Error ? detail.error.message : ""} />
      </DrawerShell>
    );
  }

  const d = detail.data;
  const p = d.profile;
  const a = d.auth;
  const name = p?.display_name ?? "Unknown";
  const planLabel = d.subscription?.plan_name ?? "Free";
  const email = a?.email ?? "—";

  return (
    <DrawerShell onClose={onClose}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "20px 22px", borderBottom: "1px solid var(--line)" }}>
        <Avatar user={{ name, avatar: p?.avatar_url ?? undefined }} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 20, color: "var(--ink)" }}>{name}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-dim)", marginTop: 4 }}>
            {email} · {userId.slice(0, 8)}
          </div>
        </div>
        <button type="button" className="btn-mini" onClick={onClose} aria-label="Close drawer"><I.x /></button>
      </div>

      <div style={{ display: "flex", gap: 4, padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={"btn-ghost" + (tab === t.key ? " active" : "")}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>
        {tab === "overview" && <OverviewPanel d={d} planLabel={planLabel} />}
        {tab === "activity" && <ActivityPanel rows={activity.data ?? []} loading={activity.isLoading} />}
        {tab === "billing" && <BillingPanel userId={userId} d={d} onChanged={invalidate} />}
        {tab === "communicate" && (
          <Suspense fallback={<AdminLoading />}>
            <CommunicatePanel userId={userId} />
          </Suspense>
        )}
        {tab === "danger" && <DangerPanel userId={userId} email={a?.email ?? ""} onChanged={() => { invalidate(); onClose(); }} />}
      </div>
    </DrawerShell>
  );
}

function DrawerShell({ children, onClose }: { children: ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div role="dialog" aria-modal="true"
      style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "relative", width: 640, maxWidth: "100vw", height: "100vh",
        background: "var(--panel-2)", borderLeft: "1px solid var(--line)",
        display: "flex", flexDirection: "column",
        animation: "drawerSlide 250ms cubic-bezier(.2,.8,.2,1)",
      }}>
        {children}
      </div>
      <style>{`@keyframes drawerSlide{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
    </div>
  );
}

function MiniKpi({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="kpi" style={{ padding: 12 }}>
      <div className="lbl" style={{ fontSize: 9 }}>{label}</div>
      <div className="v" style={{ fontSize: 22 }}>{value}</div>
    </div>
  );
}

function OverviewPanel({ d, planLabel }: { d: UserFullDetail; planLabel: string }): JSX.Element {
  const a = d.auth;
  const days = (d.usage_14d ?? []).map((g) => g.daily);
  const lifetimeSpent = d.credits?.total_purchased ?? 0;
  const creditsBalance = d.credits?.credits_balance ?? 0;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        <MiniKpi label="Plan" value={planLabel} />
        <MiniKpi label="Lifetime purchased" value={fmtNum(lifetimeSpent)} />
        <MiniKpi label="Credits remaining" value={fmtNum(creditsBalance)} />
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="card-h"><div className="t">Profile</div></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 18px", fontSize: 12.5, color: "var(--ink-dim)" }}>
          <div><span className="muted">Joined · </span><span className="mono" style={{ color: "var(--ink)" }}>{a?.created_at ? formatRel(a.created_at) : "—"}</span></div>
          <div><span className="muted">Last sign-in · </span><span className="mono" style={{ color: "var(--ink)" }}>{a?.last_sign_in_at ? formatRel(a.last_sign_in_at) : "—"}</span></div>
          <div><span className="muted">Location · </span><span style={{ color: "var(--ink)" }}>{a?.country || "—"}</span></div>
          <div><span className="muted">Generations · </span><span className="mono" style={{ color: "var(--ink)" }}>{fmtNum(d.total_generations ?? 0)} · {d.errors_24h ?? 0} err</span></div>
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="card-h"><div className="t">Usage · last 14 days</div></div>
        {days.length === 0
          ? <AdminEmpty title="No generations yet" />
          : <BarChart data={days} h={140} />}
      </div>
    </div>
  );
}

function ActivityPanel({ rows, loading }: { rows: ActivityFeedRow[]; loading: boolean }): JSX.Element {
  if (loading) return <AdminLoading />;
  if (rows.length === 0) return <AdminEmpty title="No activity in the last 30 days" />;
  const items: FeedItem[] = rows.map((r, i) => ({
    id: `${r.created_at}-${i}`,
    glyph: glyphFor(r.event_type),
    t: new Date(r.created_at),
    bodyText: r.message ?? r.event_type ?? "(no message)",
    metaTokens: [r.event_type ?? r.category ?? "event"],
  }));
  return <ActivityFeed items={items} />;
}

function BillingPanel({ userId, d, onChanged }: { userId: string; d: UserFullDetail; onChanged: () => void }): JSX.Element {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function apply(): Promise<void> {
    const amt = Number.parseInt(amount, 10);
    if (!Number.isFinite(amt) || amt === 0) {
      toast.error("Enter a non-zero amount"); return;
    }
    setPending(true);
    try {
      const { error } = await rpc<unknown>("admin_grant_credits", {
        target_user_id: userId, credits_amount: amt, reason: reason || "manual adjustment",
      });
      if (error) throw new Error(error.message);
      toast.success("Credits adjusted");
      setAmount(""); setReason(""); onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Adjust failed");
    } finally { setPending(false); }
  }

  return (
    <div>
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="card-h"><div className="t">Recent transactions</div><span className="lbl">{(d.recent_transactions ?? []).length}</span></div>
        {(d.recent_transactions ?? []).length === 0 ? <AdminEmpty title="No billing history" /> : (
          <table className="tbl"><thead><tr>
            <th>Date</th><th>Description</th><th style={{ textAlign: "right" }}>Amount</th><th>Type</th>
          </tr></thead><tbody>
            {(d.recent_transactions ?? []).map((t) => (
              <tr key={t.id}>
                <td className="mono">{formatRel(t.created_at)}</td>
                <td>{t.description ?? t.transaction_type ?? "—"}</td>
                <td className="num strong" style={{ textAlign: "right" }}>{fmtNum(t.amount)}</td>
                <td><Pill variant="default">{t.transaction_type ?? "—"}</Pill></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="card-h"><div className="t">Adjust credits</div></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 8 }}>
          <input type="number" placeholder="±amount" value={amount} onChange={(e) => setAmount(e.target.value)}
            aria-label="Credit adjustment amount"
            className="font-mono" style={{ padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
          <input type="text" placeholder="Reason (audit log)" value={reason} onChange={(e) => setReason(e.target.value)}
            aria-label="Reason for credit adjustment"
            style={{ padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
          <button type="button" className="btn-cyan sm" onClick={apply} disabled={pending}>Apply</button>
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="card-h">
          <div className="t">Refund</div>
          <Pill variant="default">Coming soon</Pill>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-dim)" }}>
          Stripe charge lookup ships in Phase 8.6.3 — refund button TODO(admin-phase8-stripe-refund).
        </div>
      </div>
    </div>
  );
}

// Wave D §C-7: CommunicatePanel + its channel send helpers (openThread,
// sendEmailCopy, sendPush) live in ./CommunicatePanel.tsx so the tiptap
// RichEditor only ships when the Communicate tab is actually opened.
// See that file for the implementation.

function DangerPanel({ userId, email, onChanged }: { userId: string; email: string; onChanged: () => void }): JSX.Element {
  const [pauseOpen, setPauseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function pauseUser(): Promise<void> {
    const { error } = await rpc<unknown>("admin_set_user_status", {
      p_user_id: userId, p_status: "paused", p_reason: reason || "paused by admin",
    });
    if (error) throw new Error(error.message);
  }
  async function forceSignOut(): Promise<void> {
    setPending(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/admin-force-signout`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token ?? ""}` },
        body: JSON.stringify({ user_id: userId, reason: "admin force sign-out" }),
      });
      if (!res.ok) throw new Error(`Force sign-out failed (${res.status})`);
      toast.success("User signed out");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setPending(false); }
  }
  async function sendResetLink(): Promise<void> {
    setPending(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/admin-send-reset-link`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token ?? ""}` },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Reset link failed (${res.status})`);
      }
      toast.success("Reset link emailed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setPending(false); }
  }
  async function hardDelete(): Promise<void> {
    const { data: sess } = await supabase.auth.getSession();
    const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/admin-hard-delete-user`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token ?? ""}` },
      body: JSON.stringify({ user_id: userId, confirm_email: email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Delete failed (${res.status})`);
    }
    onChanged();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DangerRow label="Pause account" hint="Blocks generations + sign-in, keeps data intact."
        action={<button type="button" className="btn-mini" onClick={() => setPauseOpen(true)}><I.pause /> Pause</button>} />
      <DangerRow label="Force sign-out" hint="Invalidates all current JWTs."
        action={<button type="button" className="btn-mini" onClick={forceSignOut} disabled={pending}>
          <I.power /> Sign out
        </button>} />
      <DangerRow label="Reset password" hint="Emails the user a Supabase password-recovery link."
        action={<button type="button" className="btn-mini" onClick={sendResetLink} disabled={pending}>
          <I.mail /> Send link
        </button>} />
      <DangerRow label="Delete account" hint="Hard-delete: profile + auth + all generations. Type-confirm by email."
        action={<button type="button" className="btn-mini danger" onClick={() => setDeleteOpen(true)}>
          <I.trash /> Delete
        </button>} />

      <div style={{ marginTop: 4 }}>
        <input type="text" placeholder="Reason (used by Pause)" value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Pause reason (audit log)"
          style={{ width: "100%", padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
      </div>

      <ConfirmDestructive
        open={pauseOpen} onOpenChange={setPauseOpen}
        title="Pause this account"
        description="Blocks generations and sign-in. Reversible."
        confirmText="PAUSE" actionLabel="Pause user"
        onConfirm={pauseUser} successMessage="User paused"
      />
      <ConfirmDestructive
        open={deleteOpen} onOpenChange={setDeleteOpen}
        title="Delete this account"
        description={<>Hard-delete is irreversible. Type the user's email <code>{email}</code> below to confirm.</>}
        confirmText={email} actionLabel="Delete user"
        onConfirm={hardDelete} successMessage="User deleted"
      />
    </div>
  );
}

function DangerRow({ label, hint, action }: { label: string; hint: string; action: ReactNode }): JSX.Element {
  return (
    <div className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--ink)" }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 2 }}>{hint}</div>
      </div>
      {action}
    </div>
  );
}
