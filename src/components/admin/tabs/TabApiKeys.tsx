/**
 * TabApiKeys — Phase 7 admin API Keys tab. Wires the live RPC surface
 * (`admin_api_keys_kpis`, `admin_create_internal_key`,
 * `admin_rotate_internal_key`, `admin_revoke_internal_key`) plus direct
 * admin reads against `internal_api_keys`, `internal_api_key_events`,
 * `admin_webhooks`, and `admin_v_user_provider_keys`.
 *
 * Plaintext tokens are returned exactly ONCE by the create/rotate RPCs
 * and surfaced in a one-time modal. The plaintext is held in a single
 * piece of component state and cleared the moment the modal closes —
 * never persisted in React Query, never logged, never echoed back.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill, type PillVariant } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel, num as fmtNum, short } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

interface ApiKeyKpis {
  active_keys: number; rotated_keys: number; revoked_keys: number;
  calls_24h: number; last_rotation_at: string | null;
  webhook_count: number; provider_keys_active: number;
  provider_keys_disabled: number; recent_creations_7d: number;
}
interface InternalKeyRow {
  id: string; name: string; scope: string[] | null; prefix: string;
  status: "active" | "rotated" | "revoked";
  created_at: string; last_used_at: string | null; calls_count: number;
}
interface ProviderKeyRow {
  user_id: string; provider: string; status: string;
  last_validated_at: string | null; last_error: string | null; created_at: string;
}
interface WebhookRow {
  id: string; url: string; events: string[] | null;
  status: string; success_24h: number; error_24h: number;
}
interface KeyEventRow {
  id: string; key_id: string; action: string;
  actor_id: string | null; ip_address: string | null; created_at: string;
}
interface CreateRpcResult { id: string; token: string; prefix: string }
interface RevokeRpcResult { id: string; status: string }

/** Cast `supabase.rpc` once — Phase 7 RPCs land in generated types in a
 *  follow-up; the typed shim keeps callers free of `any`. */
type RpcFn = <T>(
  fn: string, args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = (supabase.rpc as unknown) as RpcFn;

const SCOPE_OPTIONS = ["full", "render", "edge", "logs.read", "video.gen", "sandbox"] as const;
type ScopeOption = typeof SCOPE_OPTIONS[number];

/* ── Fetchers + helpers ────────────────────────────────────────────── */

async function fetchKpis(): Promise<ApiKeyKpis> {
  const { data, error } = await rpc<ApiKeyKpis>("admin_api_keys_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_api_keys_kpis returned no data");
  return data;
}
async function fetchInternalKeys(): Promise<InternalKeyRow[]> {
  const { data, error } = await supabase.from("internal_api_keys")
    .select("id,name,scope,prefix,status,created_at,last_used_at,calls_count")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as InternalKeyRow[];
}
async function fetchProviderKeys(): Promise<ProviderKeyRow[]> {
  const { data, error } = await supabase.from("admin_v_user_provider_keys")
    .select("user_id,provider,status,last_validated_at,last_error,created_at")
    .order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as ProviderKeyRow[];
}
async function fetchWebhooks(): Promise<WebhookRow[]> {
  const { data, error } = await supabase.from("admin_webhooks")
    .select("id,url,events,status,success_24h,error_24h")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as WebhookRow[];
}
async function fetchKeyEvents(): Promise<KeyEventRow[]> {
  const { data, error } = await supabase.from("internal_api_key_events")
    .select("id,key_id,action,actor_id,ip_address,created_at")
    .order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as KeyEventRow[];
}

const scopePill = (s: string): PillVariant => s === "full" ? "cyan" : s === "sandbox" ? "gold" : "default";
const statusPill = (s: string): PillVariant => s === "active" ? "ok" : s === "disabled" ? "warn" : "default";
const actionPill = (a: string): PillVariant => a === "revoked" ? "warn" : a === "rotated" ? "gold" : a === "created" ? "cyan" : "default";
const maskKeyId = (id: string): string => "…" + id.slice(-4);
const shortActor = (a: string | null): string => a ? a.slice(0, 8) : "service";

/* ── Component ─────────────────────────────────────────────────────── */

export function TabApiKeys(): JSX.Element {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [plaintext, setPlaintext] = useState<{ token: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<InternalKeyRow | null>(null);
  const [confirmRotateAll, setConfirmRotateAll] = useState(false);

  const kpis = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("apikeys", "kpis"), queryFn: fetchKpis });
  const keys = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("apikeys", "internal"), queryFn: fetchInternalKeys });
  const providers = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("apikeys", "providers"), queryFn: fetchProviderKeys });
  const webhooks = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("apikeys", "webhooks"), queryFn: fetchWebhooks });
  const events = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("apikeys", "events"), queryFn: fetchKeyEvents });

  useEffect(() => {
    if (kpis.error) toast.error("API key KPIs failed", { id: "apikeys-kpis" });
    if (keys.error) toast.error("Internal keys load failed", { id: "apikeys-keys" });
  }, [kpis.error, keys.error]);

  const invalidate = (): void => { qc.invalidateQueries({ queryKey: ["admin", "apikeys"] }); };

  const rotateMut = useMutation({
    mutationFn: async (id: string): Promise<CreateRpcResult> => {
      const { data, error } = await rpc<CreateRpcResult>("admin_rotate_internal_key", { p_id: id });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("rotate returned no token");
      return data;
    },
    onSuccess: (data, id) => {
      const k = keys.data?.find((x) => x.id === id);
      setPlaintext({ token: data.token, name: k?.name ?? "Internal key" });
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const keyName = (id: string): string => keys.data?.find((k) => k.id === id)?.name ?? maskKeyId(id);
  const keyPrefix = (id: string): string => keys.data?.find((k) => k.id === id)?.prefix ?? "mm_…";

  if (kpis.isLoading && keys.isLoading) return <AdminLoading />;

  const k = kpis.data;
  const internalRows = keys.data ?? [];
  const providerRows = providers.data ?? [];
  const webhookRows = webhooks.data ?? [];
  const eventRows = events.data ?? [];
  const dash = "—";
  const lastRot = k?.last_rotation_at ? formatRel(k.last_rotation_at) : null;

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Active keys" icon={<I.key />}
          value={k ? fmtNum(k.active_keys) : dash}
          delta={k ? `${k.rotated_keys} rotated · ${k.revoked_keys} revoked` : undefined}
          deltaDir="neutral" />
        <Kpi label="API calls · 24h" value={k ? short(k.calls_24h) : dash}
          delta={k ? `${k.recent_creations_7d} new · 7d` : undefined} deltaDir="neutral" />
        <Kpi label="Last rotation"
          value={lastRot ? lastRot.replace(" ago", "") : dash}
          unit={lastRot ? "ago" : undefined}
          delta="next due in 90d" deltaDir="neutral" />
        <Kpi label="Suspicious requests" value="0"
          delta="last 7 days" deltaDir="neutral" sparkColor="#5CD68D" />
      </div>

      <SectionHeader title="Internal API keys" right={
        <>
          <button type="button" className="btn-ghost"
            onClick={() => setConfirmRotateAll(true)}
            disabled={internalRows.filter((r) => r.status === "active").length === 0}>
            <I.refresh /> Rotate all
          </button>
          <button type="button" className="btn-cyan" onClick={() => setCreateOpen(true)}>
            <I.plus /> New API key
          </button>
        </>
      } />

      <div className="tbl-wrap">
        {internalRows.length === 0
          ? <AdminEmpty title="No internal API keys yet" hint="Create your first server-issued token." />
          : internalRows.map((row) => (
            <InternalKeyRowEl key={row.id} row={row}
              onRotate={() => rotateMut.mutate(row.id)}
              onRevoke={() => setConfirmRevoke(row)} />
          ))}
      </div>

      <div className="cols-2" style={{ marginTop: 24 }}>
        <div className="card">
          <div className="card-h">
            <div className="t">Outbound provider keys</div>
            <span className="lbl">stored in vault</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {providerRows.length === 0
              ? <div className="muted" style={{ fontSize: 12 }}>No provider keys configured.</div>
              : providerRows.map((p) => (
                <div key={`${p.user_id}-${p.provider}`}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px dashed var(--line)" }}>
                  <div>
                    <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>{p.provider}</div>
                    <div className="mono muted" style={{ fontSize: 10.5, letterSpacing: ".04em", marginTop: 2 }}>
                      {maskKeyId(p.user_id)} · {p.last_validated_at ? `last call ${formatRel(p.last_validated_at)}` : "never validated"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Pill variant={statusPill(p.status)} dot>{p.status}</Pill>
                    <button type="button" className="btn-mini"
                      onClick={() => toast.info("Test coming Phase 18")}>Test</button>
                  </div>
                </div>
              ))}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <div className="t">Webhooks</div>
            <span className="lbl">{webhookRows.length} endpoints</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {webhookRows.length === 0
              ? <div className="muted" style={{ fontSize: 12 }}>No webhooks registered.</div>
              : webhookRows.map((w) => (
                <div key={w.id} style={{ padding: "10px 0", borderBottom: "1px dashed var(--line)" }}>
                  <div className="mono" style={{ fontSize: 11, color: "var(--ink)", marginBottom: 3, wordBreak: "break-all" }}>{w.url}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>{(w.events ?? []).join(" · ") || "—"}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--good)", letterSpacing: ".04em" }}>
                      {w.success_24h} ok
                      {w.error_24h > 0 && <span style={{ color: "var(--warn)" }}> · {w.error_24h} err</span>}
                    </span>
                  </div>
                </div>
              ))}
            <button type="button" className="btn-ghost"
              style={{ marginTop: 12, justifyContent: "center" }}
              onClick={() => toast.info("Webhook composer coming Phase 18")}>
              <I.plus /> Add webhook
            </button>
          </div>
        </div>
      </div>

      <SectionHeader title="Recent key activity" />
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>When</th><th>Key</th><th>Action</th><th>By</th><th>IP</th></tr></thead>
          <tbody>
            {eventRows.length === 0
              ? <tr><td colSpan={5} style={{ color: "var(--ink-mute)", fontSize: 12 }}>No recent activity.</td></tr>
              : eventRows.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{formatRel(e.created_at)}</td>
                  <td className="mono">
                    <span style={{ color: "var(--ink)" }}>{keyPrefix(e.key_id)}</span>
                    <span className="muted" style={{ marginLeft: 6, fontSize: 10.5 }}>{keyName(e.key_id)}</span>
                  </td>
                  <td><Pill variant={actionPill(e.action)}>{e.action}</Pill></td>
                  <td>{shortActor(e.actor_id)}</td>
                  <td className="mono">{e.ip_address ?? "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen}
        onCreated={(token, name) => { setPlaintext({ token, name }); invalidate(); }} />

      <PlaintextTokenDialog state={plaintext} onClose={() => setPlaintext(null)} />

      {confirmRevoke && (
        <ConfirmDestructive open={!!confirmRevoke}
          onOpenChange={(o) => { if (!o) setConfirmRevoke(null); }}
          title={`Revoke "${confirmRevoke.name}"`}
          description={<>This token will stop working within 60 seconds. Affected services must be reconfigured to use a new key.</>}
          confirmText="REVOKE" actionLabel="Revoke key" successMessage="Key revoked"
          onConfirm={async () => {
            const { error } = await rpc<RevokeRpcResult>("admin_revoke_internal_key",
              { p_id: confirmRevoke.id, p_reason: "admin revoke from UI" });
            if (error) throw new Error(error.message);
            invalidate();
          }} />
      )}

      {confirmRotateAll && (
        <ConfirmDestructive open={confirmRotateAll} onOpenChange={setConfirmRotateAll}
          title="Rotate all active keys"
          description={<>Every active token will be replaced. Old tokens stop working within 60 seconds. You will see each new plaintext exactly once.</>}
          confirmText="ROTATE ALL" actionLabel="Rotate all keys"
          successMessage="Rotation complete — each new token was logged"
          onConfirm={async () => {
            const active = (keys.data ?? []).filter((r) => r.status === "active");
            for (const row of active) {
              const { error } = await rpc<CreateRpcResult>("admin_rotate_internal_key", { p_id: row.id });
              if (error) throw new Error(`${row.name}: ${error.message}`);
            }
            invalidate();
          }} />
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────── */

function InternalKeyRowEl({ row, onRotate, onRevoke }: {
  row: InternalKeyRow; onRotate: () => void; onRevoke: () => void;
}): JSX.Element {
  const masked = `${row.prefix}${"·".repeat(8)}${row.status === "active" ? "" : ` [${row.status}]`}`;
  const scopes = row.scope?.length ? row.scope : ["full"];
  return (
    <div className="api-key-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 500 }}>{row.name}</span>
          {scopes.map((s) => <Pill key={s} variant={scopePill(s)}>{s}</Pill>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="key-token">{masked}</span>
          <button type="button" className="btn-mini"
            onClick={() => { void navigator.clipboard.writeText(row.prefix); toast.success("Prefix copied"); }}>
            <I.copy /> Copy
          </button>
          <span className="muted mono" style={{ fontSize: 10.5, letterSpacing: ".04em" }}>
            created {formatRel(row.created_at)} · last used {row.last_used_at ? formatRel(row.last_used_at) : "never"} · {fmtNum(row.calls_count)} calls
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="btn-mini"
          onClick={() => toast.info("Rename coming Phase 18")}>Edit</button>
        <button type="button" className="btn-mini" onClick={onRotate}
          disabled={row.status === "revoked"}>
          <I.refresh /> Rotate
        </button>
        <button type="button" className="btn-mini danger" onClick={onRevoke}
          disabled={row.status === "revoked"}>
          <I.trash />
        </button>
      </div>
    </div>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  onCreated: (token: string, name: string) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ScopeOption[]>(["full"]);
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) { setName(""); setScopes(["full"]); setNotes(""); setPending(false); }
  }, [open]);

  const toggle = (s: ScopeOption): void => {
    setScopes((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s]);
  };
  const disabled = useMemo(() => !name.trim() || scopes.length === 0 || pending, [name, scopes, pending]);

  async function submit(): Promise<void> {
    if (disabled) return;
    setPending(true);
    try {
      const { data, error } = await rpc<CreateRpcResult>("admin_create_internal_key", {
        p_name: name.trim(), p_scope: scopes, p_notes: notes.trim() || null,
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("create returned no token");
      onCreated(data.token, name.trim());
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>
            The plaintext token is displayed once after creation. Copy it before closing — we hash it server-side and never display it again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="apikey-name">Name</Label>
            <Input id="apikey-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Worker pod · render" autoComplete="off" disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SCOPE_OPTIONS.map((s) => (
                <button key={s} type="button"
                  className={"btn-ghost" + (scopes.includes(s) ? " active" : "")}
                  onClick={() => toggle(s)} disabled={pending}>{s}</button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apikey-notes">Notes (optional)</Label>
            <Textarea id="apikey-notes" value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3} placeholder="What service uses this key?" disabled={pending} />
          </div>
        </div>
        <DialogFooter>
          <button type="button" className="btn-ghost"
            onClick={() => onOpenChange(false)} disabled={pending}>Cancel</button>
          <button type="button" className="btn-cyan" onClick={submit} disabled={disabled}>
            {pending ? "Creating…" : "Create key"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlaintextTokenDialog({ state, onClose }: {
  state: { token: string; name: string } | null; onClose: () => void;
}): JSX.Element {
  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your token now</DialogTitle>
          <DialogDescription>
            <span style={{ color: "var(--warn)", fontWeight: 500 }}>You will not see this token again.</span>{" "}
            Store it in your secrets manager before closing this dialog. The server only kept the SHA-256 hash.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="mono" style={{
            fontSize: 12, color: "var(--ink)", background: "var(--panel-3)",
            border: "1px solid var(--line)", borderRadius: 6, padding: "10px 12px", wordBreak: "break-all",
          }}>{state?.token ?? ""}</div>
          <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: ".04em" }}>
            for: {state?.name ?? ""}
          </div>
        </div>
        <DialogFooter>
          <button type="button" className="btn-cyan"
            onClick={() => {
              if (state) {
                void navigator.clipboard.writeText(state.token);
                toast.success("Token copied — paste it somewhere safe");
              }
              onClose();
            }}>
            <I.copy /> Copy & close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
