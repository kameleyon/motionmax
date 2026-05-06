/**
 * TabConsole — Phase 12 admin Console / Logs tab.
 *
 * Live-tails `system_logs` via realtime INSERT (buffer 500 rows). Filters:
 * 6-level chip group + grep parser supporting `user:<uuid>`, `level:<lvl>`,
 * `src:<event_type_prefix>`, `"<phrase>"`. Pause/Resume toggles the channel
 * and surfaces "N new since paused". Click line → expand inline detail
 * (JSON.stringify + Copy + view-related links).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { supabase } from "@/integrations/supabase/client";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Pill } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";

/* ── Types ─────────────────────────────────────────────────────────── */

type LogLevel = "ok" | "info" | "debug" | "warn" | "error";
type LevelFilter = "all" | LogLevel;

interface SystemLogRow {
  id: string; user_id: string | null; generation_id: string | null; project_id: string | null;
  event_type: string; category: string; message: string;
  details: Record<string, unknown> | null; created_at: string;
  fingerprint: string | null; level: string | null; worker_id: string | null;
}

interface ParsedGrep { user: string | null; level: LogLevel | null; src: string | null; text: string | null }

const BUFFER_CAP = 500;
const LEVEL_KEYS: ReadonlyArray<{ key: LevelFilter; label: string }> = [
  { key: "all", label: "All" }, { key: "ok", label: "OK" }, { key: "info", label: "Info" },
  { key: "debug", label: "Debug" }, { key: "warn", label: "Warn" }, { key: "error", label: "Error" },
];
const LEVEL_COLORS: Record<LogLevel, { lvl: string; msg: string }> = {
  ok:    { lvl: "#5CD68D", msg: "var(--ink-dim)" },
  info:  { lvl: "#7ad6e6", msg: "var(--ink-dim)" },
  debug: { lvl: "#a78bfa", msg: "var(--ink-dim)" },
  warn:  { lvl: "#F5B049", msg: "var(--ink)" },
  error: { lvl: "#F5B049", msg: "#FFD18C" },
};

/* ── Helpers ───────────────────────────────────────────────────────── */

/** Coerce raw `level`/`category`/`event_type` into one of 5 UI buckets. */
function normalizeLevel(row: Pick<SystemLogRow, "level" | "category" | "event_type">): LogLevel {
  const raw = (row.level ?? "").toLowerCase();
  if (raw === "ok" || raw === "success") return "ok";
  if (raw === "error" || raw === "err" || raw === "fatal") return "error";
  if (raw === "warn" || raw === "warning") return "warn";
  if (raw === "debug" || raw === "trace") return "debug";
  if (raw === "info") return "info";
  if (row.category === "system_error") return "error";
  if (row.category === "system_warning") return "warn";
  if (row.event_type.endsWith(".completed") || row.event_type.endsWith(".succeeded")) return "ok";
  return "info";
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Parses `user:<id>`, `level:<lvl>`, `src:<prefix>`, `"<phrase>"`. */
function parseGrep(raw: string): ParsedGrep {
  const out: ParsedGrep = { user: null, level: null, src: null, text: null };
  if (!raw.trim()) return out;
  const phrase = raw.match(/"([^"]+)"/);
  let working = raw;
  if (phrase) { out.text = phrase[1].toLowerCase(); working = working.replace(phrase[0], " "); }
  const tokens = working.split(/\s+/).filter(Boolean);
  const leftovers: string[] = [];
  for (const tok of tokens) {
    const lc = tok.toLowerCase();
    if (lc.startsWith("user:")) { out.user = tok.slice(5); continue; }
    if (lc.startsWith("level:")) {
      const v = lc.slice(6);
      if (v === "err") out.level = "error";
      else if (v === "ok" || v === "info" || v === "debug" || v === "warn" || v === "error") out.level = v;
      continue;
    }
    if (lc.startsWith("src:")) { out.src = tok.slice(4); continue; }
    leftovers.push(tok);
  }
  if (!out.text && leftovers.length > 0) out.text = leftovers.join(" ").toLowerCase();
  return out;
}

function rowMatchesGrep(row: SystemLogRow, lvl: LogLevel, g: ParsedGrep): boolean {
  if (g.user && row.user_id !== g.user) return false;
  if (g.level && lvl !== g.level) return false;
  if (g.src && !row.event_type.toLowerCase().startsWith(g.src.toLowerCase())) return false;
  if (g.text) {
    const hay = (row.message + " " + row.event_type + " " + (row.user_id ?? "")).toLowerCase();
    if (!hay.includes(g.text)) return false;
  }
  return true;
}

async function copyToClipboard(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be denied */ }
}

/* ── Component ─────────────────────────────────────────────────────── */

export function TabConsole(): JSX.Element {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [live, setLive] = useState<boolean>(true);
  const [grep, setGrep] = useState<string>("");
  const [logs, setLogs] = useState<SystemLogRow[]>([]);
  const [pausedSince, setPausedSince] = useState<number>(0);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState<boolean>(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initial backfill — most-recent BUFFER_CAP rows.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("system_logs")
        .select("id, user_id, generation_id, project_id, event_type, category, message, details, created_at, fingerprint, level, worker_id" as "*")
        .order("created_at", { ascending: false })
        .limit(BUFFER_CAP);
      if (cancelled) return;
      if (error || !data) { setInitialLoaded(true); return; }
      setLogs(data as unknown as SystemLogRow[]);
      setInitialLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Realtime subscription (toggled by `live`).
  useEffect(() => {
    if (!live) return;
    const channel = supabase.channel("admin-console:system_logs").on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "system_logs" },
      (payload) => {
        const r = payload.new as Partial<SystemLogRow> & { id?: string; created_at?: string };
        if (!r.id || !r.created_at) return;
        const row: SystemLogRow = {
          id: r.id, user_id: r.user_id ?? null,
          generation_id: r.generation_id ?? null, project_id: r.project_id ?? null,
          event_type: r.event_type ?? "", category: r.category ?? "", message: r.message ?? "",
          details: r.details ?? null, created_at: r.created_at,
          fingerprint: r.fingerprint ?? null, level: r.level ?? null, worker_id: r.worker_id ?? null,
        };
        setLogs((prev) => {
          const next = [row, ...prev];
          if (next.length > BUFFER_CAP) next.length = BUFFER_CAP;
          return next;
        });
      },
    ).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [live]);

  const pausedNew = useMemo(() => {
    if (live || pausedSince === 0) return 0;
    let n = 0;
    for (const r of logs) {
      const t = new Date(r.created_at).getTime();
      if (t >= pausedSince) n += 1; else break;
    }
    return n;
  }, [live, pausedSince, logs]);

  const togglePause = useCallback(() => {
    setLive((prev) => {
      const next = !prev;
      if (!next) setPausedSince(Date.now()); else setPausedSince(0);
      return next;
    });
  }, []);

  const parsed = useMemo(() => parseGrep(grep), [grep]);
  const filtered = useMemo<Array<{ row: SystemLogRow; lvl: LogLevel }>>(() => {
    const out: Array<{ row: SystemLogRow; lvl: LogLevel }> = [];
    for (const row of logs) {
      const lvl = normalizeLevel(row);
      if (level !== "all" && lvl !== level) continue;
      if (!rowMatchesGrep(row, lvl, parsed)) continue;
      out.push({ row, lvl });
    }
    return out;
  }, [logs, level, parsed]);

  // Auto-scroll: keep newest line visible while admin is at the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScroll) return;
    el.scrollTop = 0;
  }, [filtered, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop <= 8;
    if (atTop !== autoScroll) setAutoScroll(atTop);
  }, [autoScroll]);

  const summary = useMemo(() => {
    const byLevel: Record<LogLevel, number> = { ok: 0, info: 0, debug: 0, warn: 0, error: 0 };
    const sources = new Map<string, number>();
    for (const row of logs) {
      const lvl = normalizeLevel(row);
      byLevel[lvl] += 1;
      const src = row.event_type || "(unknown)";
      sources.set(src, (sources.get(src) ?? 0) + 1);
    }
    const top = Array.from(sources.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { byLevel, top, total: logs.length };
  }, [logs]);

  const toolbarRight = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {LEVEL_KEYS.map((k) => (
          <button key={k.key} type="button" aria-pressed={level === k.key}
            className={"btn-ghost" + (level === k.key ? " active" : "")}
            onClick={() => setLevel(k.key)}>{k.label}</button>
        ))}
      </div>
      <div style={{ width: 1, height: 28, background: "var(--line)" }} aria-hidden />
      <button type="button" className={"btn-ghost" + (live ? " active" : "")}
        onClick={togglePause} title={live ? "Pause stream" : "Resume stream"}>
        {live ? <I.pause /> : <I.play />} {live ? "Pause" : "Resume"}
      </button>
      <input type="text" value={grep} onChange={(e) => setGrep(e.target.value)}
        placeholder='grep · level:err src:gen "timeout"'
        aria-label="Filter logs by grep expression"
        className="rounded-md px-2 py-1.5 text-xs"
        style={{ fontFamily: "var(--mono)", background: "var(--panel-3)",
          border: "1px solid var(--line)", color: "var(--ink)", minWidth: 240 }} />
    </div>
  );

  return (
    <div className="space-y-4">
      <SectionHeader title="Live console" right={toolbarRight} />

      {!live && pausedNew > 0 && (
        <div className="rounded-md px-3 py-2 text-xs"
          style={{ background: "rgba(245,176,73,.10)", border: "1px solid rgba(245,176,73,.30)",
            color: "var(--warn)", fontFamily: "var(--mono)" }}>
          Stream paused — {pausedNew} new since paused
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} role="log"
        aria-live={live ? "polite" : "off"} aria-label="System logs console"
        style={{ background: "#06090b", border: "1px solid var(--line)", borderRadius: 10,
          padding: "14px 16px", height: 440, overflowY: "auto",
          fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.65, letterSpacing: "0.01em" }}>
        {!initialLoaded && filtered.length === 0 ? (
          <div style={{ color: "var(--ink-mute)", padding: "8px 0" }}>Loading logs…</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: "var(--ink-mute)", padding: "8px 0" }}>No logs match the current filters.</div>
        ) : (
          filtered.map(({ row, lvl }) => {
            const colors = LEVEL_COLORS[lvl];
            const expanded = expandedId === row.id;
            return (
              <div key={row.id}>
                <button type="button" aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                  style={{ background: "none", border: 0, padding: 0, width: "100%",
                    textAlign: "left", color: "inherit", cursor: "pointer", font: "inherit",
                    display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ width: 170, flexShrink: 0, color: "var(--ink-mute)" }}>{formatTs(row.created_at)}</span>
                  <span style={{ width: 48, flexShrink: 0, textTransform: "uppercase",
                    fontWeight: 500, fontSize: 10, letterSpacing: ".1em", color: colors.lvl }}>
                    {lvl === "error" ? "err" : lvl}
                  </span>
                  <span style={{ width: 160, flexShrink: 0, color: "var(--ink-mute)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    [{row.event_type}]
                  </span>
                  <span style={{ flex: 1, color: colors.msg, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {row.message}
                  </span>
                </button>
                {expanded && <ConsoleDetail row={row} onClose={() => setExpandedId(null)} />}
              </div>
            );
          })
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="card">
          <div className="card-h"><div className="t">By level</div><span className="lbl">{summary.total} buffered</span></div>
          <div className="legend">
            {(Object.keys(summary.byLevel) as LogLevel[]).map((lvl) => {
              const v = summary.byLevel[lvl];
              const pct = summary.total === 0 ? 0 : Math.round((v / summary.total) * 100);
              return (
                <div className="row" key={lvl}>
                  <span className="sw" style={{ background: LEVEL_COLORS[lvl].lvl }} aria-hidden />
                  <span className="lbl" style={{ textTransform: "capitalize" }}>{lvl}</span>
                  <span className="v">{v}</span><span className="pct">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><div className="t">Top sources</div></div>
          <div className="legend">
            {summary.top.length === 0 ? (
              <div style={{ color: "var(--ink-mute)", fontSize: 11.5 }}>No data yet.</div>
            ) : summary.top.map(([src, v]) => (
              <div className="row" key={src}>
                <span className="lbl" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{src}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><div className="t">Search · grep</div></div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5,
            color: "var(--ink-mute)", letterSpacing: ".04em", lineHeight: 1.6 }}>
            Tip: <code>level:err src:worker</code> · <code>user:&lt;uuid&gt;</code> · <code>"safety filter"</code>
            <div style={{ marginTop: 8 }}>
              Buffered: {summary.total} / {BUFFER_CAP} rows · {live ? "live" : "paused"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Inline detail row ─────────────────────────────────────────────── */

function ConsoleDetail({ row, onClose }: { row: SystemLogRow; onClose: () => void }): JSX.Element {
  const json = useMemo(() => JSON.stringify(row.details ?? {}, null, 2), [row.details]);
  const handleCopy = useCallback(() => { void copyToClipboard(json); }, [json]);
  return (
    <div style={{ margin: "6px 0 12px 0", padding: "10px 12px",
      background: "var(--panel-3)", border: "1px dashed var(--line)",
      borderRadius: 8, fontFamily: "var(--mono)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-mute)" }}>
          Event details · {row.event_type}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn-mini" onClick={handleCopy} title="Copy details JSON"><I.copy /> Copy</button>
          <button type="button" className="btn-mini" onClick={onClose} title="Collapse"><I.x /></button>
        </div>
      </div>
      <pre style={{ fontSize: 11.5, color: "var(--ink-dim)", whiteSpace: "pre-wrap",
        wordBreak: "break-word", maxHeight: 280, overflow: "auto", margin: 0 }}>
        {json}
      </pre>
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        {row.user_id && (
          <a className="text-xs underline" href={`/admin?tab=users&user_id=${row.user_id}`}>
            <Pill variant="cyan">user · {row.user_id.slice(0, 8)}…</Pill>
          </a>
        )}
        {row.generation_id && (
          <a className="text-xs underline" href={`/admin?tab=gens&generation_id=${row.generation_id}`}>
            <Pill variant="purple">generation · {row.generation_id.slice(0, 8)}…</Pill>
          </a>
        )}
        {row.project_id && (
          <a className="text-xs underline" href={`/admin?tab=gens&project_id=${row.project_id}`}>
            <Pill variant="default">project · {row.project_id.slice(0, 8)}…</Pill>
          </a>
        )}
        {row.fingerprint && (
          <span style={{ fontSize: 10.5, color: "var(--ink-mute)" }}>fp: <code>{row.fingerprint}</code></span>
        )}
        {row.worker_id && (
          <span style={{ fontSize: 10.5, color: "var(--ink-mute)" }}>worker: <code>{row.worker_id}</code></span>
        )}
      </div>
    </div>
  );
}
