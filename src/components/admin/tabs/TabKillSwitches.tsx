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
const rpc = (supabase.rpc as unknown) as RpcFn;

/* ── Subsystem catalog ─────────────────────────────────────────────── */

interface SubsystemSpec {
  flag: string;
  title: string;
  desc: string;
  icon: () => JSX.Element;
  /** Toggling ON (=disable) is destructive enough to require a typed confirm. */
  destructive: boolean;
}

const SUBSYSTEMS: ReadonlyArray<SubsystemSpec> = [
  { flag: "maint", title: "Site maintenance mode",
    desc: "Show maintenance page to all non-admin users. Admins keep full access.",
    icon: I.power, destructive: true },
  { flag: "signups_disabled", title: "Disable new sign-ups",
    desc: "Existing users sign in normally. New registrations are blocked at the auth layer.",
    icon: I.users, destructive: false },
  { flag: "video_generation", title: "Pause video generation",
    desc: "Hailuo + Veo workers stop accepting jobs. In-flight jobs finish; refunds queue automatically.",
    icon: I.film, destructive: false },
  { flag: "image_generation", title: "Pause image generation",
    desc: "Flux + SDXL endpoints disabled. Editor falls back to placeholders.",
    icon: I.spark, destructive: false },
  { flag: "voice_generation", title: "Pause voice (TTS + clone)",
    desc: "ElevenLabs + Fish Speech disabled. Clone training also pauses.",
    icon: I.voice, destructive: false },
  { flag: "payments", title: "Disable purchases",
    desc: "Stripe checkout returns 'temporarily unavailable'. Subscriptions still renew.",
    icon: I.credit, destructive: true },
  { flag: "autopost", title: "Pause autopost",
    desc: "Stop publishing to TikTok / IG / YouTube on user behalf.",
    icon: I.send, destructive: false },
  { flag: "newsletter", title: "Pause outbound email",
    desc: "Block transactional + marketing email at the SendGrid layer.",
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
  const { data, error } = await rpc<FeatureFlag[]>("admin_feature_flags_list");
  if (error) throw new Error(error.message);
  return data ?? [];
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
          borderColor: "rgba(245,176,73,.6)",
          background: "linear-gradient(135deg,rgba(245,176,73,.16),rgba(245,176,73,.04))",
        } : {
          background: "linear-gradient(135deg,rgba(245,176,73,.05),rgba(245,176,73,.01))",
          borderColor: "rgba(245,176,73,.18)",
        }}>
        <div className="ico" style={{
          width: 54, height: 54, borderRadius: 12,
          background: "rgba(245,176,73,.15)", color: "var(--warn)",
          display: "grid", placeItems: "center",
          border: "1px solid rgba(245,176,73,.3)",
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
          borderColor: "rgba(245,176,73,.4)",
          background: "linear-gradient(180deg,rgba(245,176,73,.04),transparent),var(--panel-2)",
          marginBottom: 18,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 10,
              background: "rgba(245,176,73,.15)", color: "var(--warn)",
              display: "grid", placeItems: "center", flexShrink: 0,
              border: "1px solid rgba(245,176,73,.3)",
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
                border: "1px solid " + (armed ? "rgba(245,176,73,.4)" : "var(--line)"),
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
                    background: armed ? "rgba(245,176,73,.15)" : "var(--panel-3)",
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
                    <button type="button" className="btn-mini"
                      onClick={() => toast.info("Flag editor coming Phase 18")}>
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
    </div>
  );
}
