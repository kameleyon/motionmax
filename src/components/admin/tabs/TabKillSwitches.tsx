/**
 * TabKillSwitches — Phase 17. Master kill switch + 8 subsystem switches +
 * the feature flags table. Wires the live RPC surface
 * (`admin_kill_switches_kpis`, `admin_set_master_kill_switch`,
 * `admin_set_feature_flag`, `admin_feature_flags_list`) plus a direct
 * admin SELECT on `app_settings` for the `master_kill_switch` row.
 *
 * Both `feature_flags` and `app_settings` carry realtime publications so
 * a co-admin engaging the master kill in another tab/browser surfaces
 * here within the realtime channel's roundtrip — the worker observes the
 * same flips for free.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Pill } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { Toggle } from "@/components/admin/_shared/Toggle";
import { formatRel } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

interface KillSwitchKpis {
  master_engaged: boolean;
  flags_total: number;
  flags_disabled: number;
  last_flag_flip: string | null;
}

interface FeatureFlag {
  flag_name: string;
  enabled: boolean;
  description: string | null;
  rollout_pct: number | null;
  audience: Record<string, unknown> | null;
  active_users: number | null;
  updated_at: string;
  updated_by: string | null;
}

interface MasterKillRow {
  enabled: boolean;
  message: string | null;
  set_by: string | null;
  set_at: string | null;
}

type RpcFn = <T>(
  fn: string, args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

/* ── Subsystem catalog ─────────────────────────────────────────────── */

interface SubsystemSpec {
  flag: string;
  title: string;
  desc: string;
  icon: () => JSX.Element;
  /** Toggling ON (=disable) is destructive enough to require a typed confirm. */
  destructive: boolean;
}

// Renamed 2026-05-08 — the prior flag names (image_generation,
// video_generation, voice_generation, etc.) collided with legacy
// positive-semantic flags of the same name. The new pause_* /
// maintenance_mode names are unambiguously kill-switches: enabled=true
// means subsystem BLOCKED. See migration 20260508240000.
const SUBSYSTEMS: ReadonlyArray<SubsystemSpec> = [
  { flag: "maintenance_mode", title: "Site maintenance mode",
    desc: "Show maintenance page to all non-admin users. Admins keep full access.",
    icon: I.power, destructive: true },
  { flag: "pause_signups", title: "Disable new sign-ups",
    desc: "Existing users sign in normally. New registrations are blocked at the auth layer.",
    icon: I.users, destructive: false },
  { flag: "pause_video", title: "Pause video generation",
    desc: "Hypereal Seedance/Kling stop accepting jobs. In-flight jobs finish; refunds queue automatically.",
    icon: I.film, destructive: false },
  { flag: "pause_image", title: "Pause image generation",
    desc: "Cinematic image handler entry blocks. Editor falls back to placeholders.",
    icon: I.spark, destructive: false },
  { flag: "pause_voice", title: "Pause voice (TTS + clone)",
    desc: "Gemini / LemonFox / Fish stop dispatching. Clone training also pauses.",
    icon: I.voice, destructive: false },
  { flag: "pause_payments", title: "Disable purchases",
    desc: "Stripe checkout returns 'temporarily unavailable'. Subscriptions still renew.",
    icon: I.credit, destructive: true },
  { flag: "pause_autopost", title: "Pause autopost",
    desc: "Stop publishing to TikTok / IG / YouTube on user behalf.",
    icon: I.send, destructive: false },
  { flag: "pause_newsletter", title: "Pause outbound email",
    desc: "Block transactional + marketing email at the Resend layer.",
    icon: I.mail, destructive: false },
];

/** Convention: kill-switch flags are *enabled = system armed = OFF for users*.
 *  i.e. `feature_flags.enabled = true` → subsystem is killed. We mirror this
 *  in the worker / edge-fn checkpoints so the UI stays unambiguous. */
const isArmed = (f: FeatureFlag | undefined): boolean => Boolean(f?.enabled);

/* ── Fetchers ──────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<KillSwitchKpis> {
  const { data, error } = await rpc<KillSwitchKpis>("admin_kill_switches_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_kill_switches_kpis returned no data");
  return data;
}

async function fetchFlags(): Promise<FeatureFlag[]> {
  // admin_v_feature_flags adds rollout_pct, audience, and active_users
  // beyond the original admin_feature_flags_list RPC. View has admin
  // SELECT — no RPC wrapper needed. Falls back to the RPC if the view
  // hasn't been deployed yet (older envs).
  const { data: viewData, error: viewErr } = await supabase
    .from("admin_v_feature_flags")
    .select("flag_name, enabled, description, rollout_pct, audience, active_users, updated_at, updated_by")
    .order("flag_name", { ascending: true });
  if (!viewErr && viewData) return viewData as FeatureFlag[];
  // View missing — fall back to the RPC. Pad with defaults for the
  // newer columns so the table still renders.
  const { data, error } = await rpc<Array<Omit<FeatureFlag, "rollout_pct" | "audience" | "active_users">>>("admin_feature_flags_list");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, rollout_pct: 100, audience: { all: true }, active_users: null }));
}

async function fetchMasterKill(): Promise<MasterKillRow> {
  const { data, error } = await supabase.from("app_settings")
    .select("value").eq("key", "master_kill_switch").maybeSingle();
  if (error) throw new Error(error.message);
  const v = (data?.value ?? {}) as Partial<MasterKillRow>;
  return {
    enabled: Boolean(v.enabled),
    message: v.message ?? null,
    set_by: v.set_by ?? null,
    set_at: v.set_at ?? null,
  };
}

/* ── Component ─────────────────────────────────────────────────────── */

export function TabKillSwitches(): JSX.Element {
  const qc = useQueryClient();
  const [masterConfirm, setMasterConfirm] = useState<null | "engage" | "disengage">(null);
  const [pendingFlag, setPendingFlag] = useState<string | null>(null);
  const [confirmFlag, setConfirmFlag] = useState<{ spec: SubsystemSpec; nextEnabled: boolean } | null>(null);
  const [editFlag, setEditFlag] = useState<FeatureFlag | null>(null);

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("kill", "kpis"),
    queryFn: fetchKpis,
  });
  const flags = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("kill", "flags"),
    queryFn: fetchFlags,
  });
  const master = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("kill", "master"),
    queryFn: fetchMasterKill,
  });

  useEffect(() => {
    if (kpis.error) toast.error("Kill-switch KPIs failed", { id: "kill-kpis" });
    if (flags.error) toast.error("Feature flags load failed", { id: "kill-flags" });
    if (master.error) toast.error("Master kill state load failed", { id: "kill-master" });
  }, [kpis.error, flags.error, master.error]);

  // Realtime: feature_flags + app_settings invalidations
  useEffect(() => {
    const chFlags = supabase
      .channel("admin-kill:feature_flags")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "feature_flags" },
        () => { qc.invalidateQueries({ queryKey: ["admin", "kill"] }); },
      ).subscribe();
    const chSettings = supabase
      .channel("admin-kill:app_settings")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "app_settings" },
        () => { qc.invalidateQueries({ queryKey: ["admin", "kill"] }); },
      ).subscribe();
    return () => {
      void supabase.removeChannel(chFlags);
      void supabase.removeChannel(chSettings);
    };
  }, [qc]);

  const flagMap = useMemo(() => {
    const m = new Map<string, FeatureFlag>();
    for (const f of flags.data ?? []) m.set(f.flag_name, f);
    return m;
  }, [flags.data]);

  const setFlagMut = useMutation({
    mutationFn: async (vars: { flag: string; enabled: boolean; reason: string | null }) => {
      const { error } = await rpc("admin_set_feature_flag", {
        p_flag: vars.flag, p_enabled: vars.enabled, p_reason: vars.reason,
      });
      if (error) throw new Error(error.message);
    },
    onMutate: (vars) => { setPendingFlag(vars.flag); },
    onSuccess: (_d, vars) => {
      toast.success(`${vars.flag} ${vars.enabled ? "armed" : "disarmed"}`);
      qc.invalidateQueries({ queryKey: ["admin", "kill"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => { setPendingFlag(null); },
  });

  const handleSubsystemToggle = (spec: SubsystemSpec, currentArmed: boolean): void => {
    const nextEnabled = !currentArmed;
    if (spec.destructive && nextEnabled) {
      setConfirmFlag({ spec, nextEnabled });
      return;
    }
    setFlagMut.mutate({
      flag: spec.flag, enabled: nextEnabled,
      reason: nextEnabled ? "Armed from kill switches tab" : "Disarmed from kill switches tab",
    });
  };

  if (kpis.isLoading && flags.isLoading && master.isLoading) return <AdminLoading />;

  const killAll = master.data?.enabled ?? false;
  const flagRows = flags.data ?? [];

  return (
    <div>
      {/* Master kill panel (gold gradient when engaged) */}
      <div className={"master-kill" + (killAll ? " armed" : "")}
        style={killAll ? {
          borderColor: "rgba(228,200,117,.6)",
          background: "linear-gradient(135deg,rgba(228,200,117,.16),rgba(228,200,117,.04))",
        } : {
          background: "linear-gradient(135deg,rgba(228,200,117,.05),rgba(228,200,117,.01))",
          borderColor: "rgba(228,200,117,.18)",
        }}>
        <div className="ico" style={{
          width: 54, height: 54, borderRadius: 12,
          background: "rgba(228,200,117,.15)", color: "var(--warn)",
          display: "grid", placeItems: "center",
          border: "1px solid rgba(228,200,117,.3)",
        }}><I.power /></div>
        <div className="body" style={{ flex: 1 }}>
          <div className="t" style={{
            fontFamily: "var(--serif)", fontSize: 18, fontWeight: 500, color: "var(--ink)",
          }}>
            Master kill — emergency stop
          </div>
          <div className="d" style={{ color: "var(--ink-dim)", fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
            Immediately puts the entire app into <code>read-only maintenance</code>. All workers drain,
            generation queues pause, sign-ups close, payments freeze, outgoing emails halt. Admins retain
            full access. Use only during a serious incident — recoverable with one click.
          </div>
        </div>
        <Toggle danger checked={killAll}
          onChange={() => setMasterConfirm(killAll ? "disengage" : "engage")}
          ariaLabel="Master kill switch" />
      </div>

      {killAll && (
        <div className="card" style={{
          borderColor: "rgba(228,200,117,.4)",
          background: "linear-gradient(180deg,rgba(228,200,117,.04),transparent),var(--panel-2)",
          marginBottom: 18,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 10,
              background: "rgba(228,200,117,.15)", color: "var(--warn)",
              display: "grid", placeItems: "center", flexShrink: 0,
              border: "1px solid rgba(228,200,117,.3)",
            }}><I.alert /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, color: "var(--ink)", fontWeight: 600 }}>
                Site is in MAINTENANCE MODE
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                Public users see the maintenance page.
                {" "}{kpis.data?.flags_disabled ?? 0} subsystem(s) flagged.
                {master.data?.set_at && (
                  <span className="mono" style={{ color: "var(--ink-dim)", marginLeft: 8 }}>
                    armed_at: {formatRel(master.data.set_at)}
                  </span>
                )}
              </div>
            </div>
            <button type="button" className="btn-cyan sm"
              onClick={() => setMasterConfirm("disengage")}>
              Restore service
            </button>
          </div>
        </div>
      )}

      <SectionHeader title="Subsystem switches" right={
        <span className="muted mono" style={{ fontSize: 10.5, letterSpacing: ".06em" }}>
          Changes audit-logged · effective &lt;5s
        </span>
      } />

      <div className="kill-grid" style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14,
      }}>
        {SUBSYSTEMS.map((s) => {
          const f = flagMap.get(s.flag);
          const armed = isArmed(f);
          const pending = pendingFlag === s.flag;
          return (
            <div key={s.flag} className={"kill-card" + (armed ? " armed" : "")}
              style={{
                background: "var(--panel-2)",
                border: "1px solid " + (armed ? "rgba(228,200,117,.4)" : "var(--line)"),
                borderRadius: 12, padding: 14,
                opacity: pending ? 0.7 : 1,
                transition: "opacity 120ms",
              }}>
              <div className="h" style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "flex-start", gap: 10, marginBottom: 8,
              }}>
                <div className="t" style={{
                  display: "flex", alignItems: "center", gap: 8,
                  fontSize: 13.5, color: "var(--ink)", fontWeight: 500,
                }}>
                  <span className="ico" style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: armed ? "rgba(228,200,117,.15)" : "var(--panel-3)",
                    color: armed ? "var(--warn)" : "var(--ink-dim)",
                    display: "grid", placeItems: "center", flexShrink: 0,
                  }}><s.icon /></span>
                  {s.title}
                </div>
                <Toggle danger={s.destructive} checked={armed}
                  disabled={pending}
                  onChange={() => handleSubsystemToggle(s, armed)}
                  ariaLabel={`Toggle ${s.flag}`} />
              </div>
              <div className="desc" style={{ color: "var(--ink-dim)", fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
                {s.desc}
              </div>
              <div className="meta" style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: "1px dashed var(--line)", paddingTop: 8,
                fontSize: 11, fontFamily: "var(--mono)",
                letterSpacing: ".04em", color: "var(--ink-mute)",
              }}>
                <Pill variant={armed ? "warn" : "default"} dot>
                  {armed ? "ARMED" : "idle"}
                </Pill>
                <span>
                  {f?.updated_at ? `flipped ${formatRel(f.updated_at)}` : "never flipped"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <SectionHeader title="Feature flags" right={
        <button type="button" className="btn-ghost"
          onClick={() => toast.info("New-flag composer coming Phase 18")}>
          <I.plus /> New flag
        </button>
      } />

      <div className="tbl-wrap">
        {flagRows.length === 0 ? (
          <AdminEmpty title="No feature flags yet"
            hint="Subsystems above seed flags lazily on first flip." />
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Flag</th>
              <th>Description</th>
              <th>Enabled</th>
              <th>Updated</th>
              <th style={{ width: 80 }} />
            </tr></thead>
            <tbody>
              {flagRows.map((f) => (
                <tr key={f.flag_name}>
                  <td className="mono strong" style={{ color: "var(--cyan)" }}>{f.flag_name}</td>
                  <td>{f.description ?? <span className="muted">—</span>}</td>
                  <td>
                    <Toggle checked={f.enabled} disabled={pendingFlag === f.flag_name}
                      onChange={(next) => setFlagMut.mutate({
                        flag: f.flag_name, enabled: next,
                        reason: "Flipped from feature flags table",
                      })}
                      ariaLabel={`Toggle ${f.flag_name}`} />
                  </td>
                  <td className="mono">{formatRel(f.updated_at)}</td>
                  <td>
                    <button type="button" className="btn-mini" onClick={() => setEditFlag(f)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Master kill confirm */}
      {masterConfirm && (
        <ConfirmDestructive open={!!masterConfirm}
          onOpenChange={(o) => { if (!o) setMasterConfirm(null); }}
          title={masterConfirm === "engage" ? "Engage master kill switch" : "Disengage master kill switch"}
          description={
            masterConfirm === "engage" ? (
              <>This puts the site into maintenance mode globally. All non-admin users see a maintenance page within 5s. In-flight jobs are cancelled.</>
            ) : (
              <>This restores service for all users. Subsystem switches retain their independent state — flip those off separately if you want full restoration.</>
            )
          }
          confirmText={masterConfirm === "engage" ? "ENGAGE" : "DISENGAGE"}
          actionLabel={masterConfirm === "engage" ? "Engage master kill" : "Restore service"}
          successMessage={masterConfirm === "engage" ? "Master kill engaged" : "Service restored"}
          onConfirm={async () => {
            const { error } = await rpc("admin_set_master_kill_switch", {
              p_enabled: masterConfirm === "engage",
              p_message: masterConfirm === "engage"
                ? "Engaged from admin tab"
                : null,
            });
            if (error) throw new Error(error.message);
            qc.invalidateQueries({ queryKey: ["admin", "kill"] });
          }} />
      )}

      {/* Subsystem confirm (destructive subsystems only) */}
      {confirmFlag && (
        <ConfirmDestructive open={!!confirmFlag}
          onOpenChange={(o) => { if (!o) setConfirmFlag(null); }}
          title={`Arm "${confirmFlag.spec.title}"`}
          description={<>{confirmFlag.spec.desc}</>}
          confirmText="ARM"
          actionLabel={`Arm ${confirmFlag.spec.flag}`}
          successMessage={`${confirmFlag.spec.flag} armed`}
          onConfirm={async () => {
            const { error } = await rpc("admin_set_feature_flag", {
              p_flag: confirmFlag.spec.flag,
              p_enabled: confirmFlag.nextEnabled,
              p_reason: "Armed from kill switches tab (typed confirm)",
            });
            if (error) throw new Error(error.message);
            qc.invalidateQueries({ queryKey: ["admin", "kill"] });
          }} />
      )}

      {editFlag && (
        <FlagEditModal flag={editFlag} onClose={() => setEditFlag(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["admin", "kill"] }); setEditFlag(null); }} />
      )}
    </div>
  );
}

/* ── Flag editor modal (rollout slider + audience picker) ──────────── */
function FlagEditModal({
  flag, onClose, onSaved,
}: { flag: FeatureFlag; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [description, setDescription] = useState<string>(flag.description ?? "");
  const [rolloutPct, setRolloutPct] = useState<number>(flag.rollout_pct ?? 100);
  // Audience presets cover the common cases; "custom" lets the admin
  // edit the raw jsonb so rare segmentation isn't blocked by missing
  // UI affordances.
  const presets: Array<{ key: string; label: string; audience: Record<string, unknown> }> = [
    { key: "all",    label: "Everyone",       audience: { all: true } },
    { key: "studio", label: "Studio plan",    audience: { plan: "studio" } },
    { key: "pro",    label: "Pro plan",       audience: { plan: "pro" } },
    { key: "free",   label: "Free plan",      audience: { plan: "free" } },
  ];
  const initialPresetKey = (() => {
    const a = flag.audience ?? {};
    if (a.all === true) return "all";
    if (a.plan === "studio") return "studio";
    if (a.plan === "pro") return "pro";
    if (a.plan === "free") return "free";
    return "custom";
  })();
  const [presetKey, setPresetKey] = useState<string>(initialPresetKey);
  const [customJson, setCustomJson] = useState<string>(JSON.stringify(flag.audience ?? { all: true }, null, 2));
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    let audience: Record<string, unknown>;
    if (presetKey === "custom") {
      try { audience = JSON.parse(customJson); }
      catch (err) { toast.error(`Audience JSON invalid: ${(err as Error).message}`); return; }
    } else {
      audience = presets.find((p) => p.key === presetKey)?.audience ?? { all: true };
    }
    setSaving(true);
    try {
      const { error } = await rpc<unknown>("admin_update_flag_metadata", {
        p_flag: flag.flag_name,
        p_description: description.trim() || null,
        p_rollout_pct: rolloutPct,
        p_audience: audience,
      });
      if (error) throw new Error(error.message);
      toast.success("Flag updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally { setSaving(false); }
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={onClose}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)" }} />
      <div className="card" style={{ position: "relative", width: 480, maxWidth: "calc(100vw - 32px)", padding: 18 }}>
        <div className="card-h" style={{ marginBottom: 14 }}>
          <div className="t">Edit flag · <span className="mono" style={{ color: "var(--cyan)" }}>{flag.flag_name}</span></div>
          <button type="button" className="btn-mini" onClick={onClose}><I.x /></button>
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 4 }}>Description</div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={2}
              style={{ width: "100%", padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6, fontSize: 12, resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-mute)" }}>Rollout</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--cyan)" }}>{rolloutPct}%</span>
            </div>
            <input type="range" min={0} max={100} step={5} value={rolloutPct}
              onChange={(e) => setRolloutPct(Number(e.target.value))}
              style={{ width: "100%" }} />
          </div>
          <div>
            <div style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 4 }}>Audience</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {presets.map((p) => (
                <button key={p.key} type="button"
                  className={"btn-mini" + (presetKey === p.key ? " active" : "")}
                  style={presetKey === p.key ? { color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)", background: "var(--cyan-dim)" } : undefined}
                  onClick={() => setPresetKey(p.key)}>
                  {p.label}
                </button>
              ))}
              <button type="button"
                className={"btn-mini" + (presetKey === "custom" ? " active" : "")}
                style={presetKey === "custom" ? { color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)", background: "var(--cyan-dim)" } : undefined}
                onClick={() => setPresetKey("custom")}>
                Custom JSON
              </button>
            </div>
            {presetKey === "custom" && (
              <textarea value={customJson} onChange={(e) => setCustomJson(e.target.value)}
                rows={4} className="mono"
                style={{ width: "100%", padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6, fontSize: 11, resize: "vertical" }} />
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn-mini" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-cyan sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
