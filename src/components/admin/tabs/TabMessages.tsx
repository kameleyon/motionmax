/**
 * TabMessages — Phase 13 admin Messages tab.
 *
 * Wires `admin_messages_kpis()`, direct reads on `admin_message_threads` +
 * `admin_messages` (with `profiles` join for sender display name), and the
 * write RPCs `admin_post_reply`, `admin_close_thread`, `admin_mark_message_read`.
 *
 * Two-pane 340px / 1fr inbox grid (height 640, stacks vertically below
 * ~720px). Realtime: every `admin_messages` INSERT invalidates the inbox
 * list, current thread, and KPIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Avatar } from "@/components/admin/_shared/Avatar";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

interface MessagesKpis { open_threads: number; unread: number; avg_first_reply_min: number; closed_30d: number }
interface ThreadAttachment { name: string; size?: string | number; url?: string }
type SenderRole = "user" | "admin" | "system";
type ThreadStatus = "open" | "answered" | "closed";
interface ThreadRow {
  id: string; user_id: string; subject: string; status: ThreadStatus;
  last_message_at: string; created_at: string; closed_at: string | null; closed_by: string | null;
  user_name: string | null; user_avatar: string | null;
  last_body: string | null; last_sender_role: SenderRole | null;
  last_read_at: string | null; last_created_at: string | null;
}
interface MessageRow {
  id: string; thread_id: string; sender_id: string; sender_role: SenderRole;
  body: string; attachments: ThreadAttachment[]; read_at: string | null; created_at: string;
}
interface ProfileLite { user_id: string; display_name: string | null; avatar_url: string | null }
interface RawThread {
  id: string; user_id: string; subject: string; status: ThreadStatus;
  last_message_at: string; created_at: string; closed_at: string | null; closed_by: string | null;
}
interface RawMessage {
  id: string; thread_id: string; body: string;
  sender_role: SenderRole; read_at: string | null; created_at: string;
}

type FilterChip = "all" | "unread" | "billing" | "bugs" | "sales" | "churn";
const FILTER_CHIPS: ReadonlyArray<{ key: FilterChip; label: string }> = [
  { key: "all", label: "All" }, { key: "unread", label: "Unread" }, { key: "billing", label: "Billing" },
  { key: "bugs", label: "Bugs" }, { key: "sales", label: "Sales" }, { key: "churn", label: "Churn" },
];

/** Cast `supabase.rpc` once — Phase 13 RPCs aren't in the generated DB
 *  types yet. Mirrors the pattern from `TabApiKeys.tsx`. */
type RpcFn = <T>(fn: string, args?: Record<string, unknown>) =>
  Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

/* ── Fetchers ──────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<MessagesKpis> {
  const { data, error } = await rpc<MessagesKpis>("admin_messages_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_messages_kpis returned no data");
  return data;
}

async function fetchThreads(): Promise<ThreadRow[]> {
  const tRes = await supabase
    .from("admin_message_threads" as never)
    .select("id, user_id, subject, status, last_message_at, created_at, closed_at, closed_by")
    .order("last_message_at", { ascending: false }) as unknown as {
      data: RawThread[] | null; error: { message: string } | null;
    };
  if (tRes.error) throw new Error(tRes.error.message);
  const threads = tRes.data ?? [];
  if (threads.length === 0) return [];

  const threadIds = threads.map((t) => t.id);
  const userIds = Array.from(new Set(threads.map((t) => t.user_id)));

  const [msgRes, profRes] = await Promise.all([
    supabase
      .from("admin_messages" as never)
      .select("id, thread_id, body, sender_role, read_at, created_at")
      .in("thread_id", threadIds)
      .order("created_at", { ascending: false }) as unknown as Promise<{
        data: RawMessage[] | null; error: { message: string } | null;
      }>,
    supabase
      .from("profiles")
      .select("user_id, display_name, avatar_url")
      .in("user_id", userIds) as unknown as Promise<{
        data: ProfileLite[] | null; error: { message: string } | null;
      }>,
  ]);
  if (msgRes.error) throw new Error(msgRes.error.message);
  if (profRes.error) throw new Error(profRes.error.message);

  const lastByThread = new Map<string, RawMessage>();
  for (const m of msgRes.data ?? []) if (!lastByThread.has(m.thread_id)) lastByThread.set(m.thread_id, m);
  const profByUser = new Map<string, ProfileLite>();
  for (const p of profRes.data ?? []) profByUser.set(p.user_id, p);

  return threads.map<ThreadRow>((t) => {
    const last = lastByThread.get(t.id) ?? null;
    const prof = profByUser.get(t.user_id) ?? null;
    return {
      id: t.id, user_id: t.user_id, subject: t.subject, status: t.status,
      last_message_at: t.last_message_at, created_at: t.created_at,
      closed_at: t.closed_at, closed_by: t.closed_by,
      user_name: prof?.display_name ?? null, user_avatar: prof?.avatar_url ?? null,
      last_body: last?.body ?? null, last_sender_role: last?.sender_role ?? null,
      last_read_at: last?.read_at ?? null, last_created_at: last?.created_at ?? null,
    };
  });
}

async function fetchThreadMessages(threadId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from("admin_messages" as never)
    .select("id, thread_id, sender_id, sender_role, body, attachments, read_at, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true }) as unknown as {
      data: MessageRow[] | null; error: { message: string } | null;
    };
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* ── Component ─────────────────────────────────────────────────────── */
export function TabMessages(): JSX.Element {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterChip>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [reply, setReply] = useState<string>("");
  const [showFullThread, setShowFullThread] = useState<boolean>(false);
  const [markResolved, setMarkResolved] = useState<boolean>(false);

  const kpisQ = useQuery({ queryKey: adminKey("messages", "kpis"), queryFn: fetchKpis, ...ADMIN_DEFAULT_QUERY_OPTIONS });
  const threadsQ = useQuery({ queryKey: adminKey("messages", "threads"), queryFn: fetchThreads, ...ADMIN_DEFAULT_QUERY_OPTIONS });
  const threadQ = useQuery({
    queryKey: adminKey("messages", "thread", sel ?? ""),
    queryFn: () => fetchThreadMessages(sel as string),
    enabled: sel !== null, ...ADMIN_DEFAULT_QUERY_OPTIONS,
  });

  // Default selection: first thread once the list lands.
  useEffect(() => {
    if (sel || !threadsQ.data || threadsQ.data.length === 0) return;
    setSel(threadsQ.data[0].id);
  }, [threadsQ.data, sel]);

  // Reset reply state when selection changes.
  useEffect(() => { setReply(""); setShowFullThread(false); setMarkResolved(false); }, [sel]);

  // Realtime: any new admin_messages row invalidates list + open thread.
  useEffect(() => {
    const channel = supabase.channel("admin-messages:admin_messages").on(
      "postgres_changes", { event: "INSERT", schema: "public", table: "admin_messages" },
      (payload) => {
        const r = payload.new as { thread_id?: string };
        void queryClient.invalidateQueries({ queryKey: adminKey("messages", "threads") });
        void queryClient.invalidateQueries({ queryKey: adminKey("messages", "kpis") });
        if (r.thread_id && r.thread_id === sel) {
          void queryClient.invalidateQueries({ queryKey: adminKey("messages", "thread", sel) });
        }
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient, sel]);

  // Auto-mark unread user messages as read when admin opens the thread.
  const lastMarkedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sel || !threadQ.data || lastMarkedRef.current === sel) return;
    const unread = threadQ.data.filter((m) => m.sender_role === "user" && m.read_at === null);
    lastMarkedRef.current = sel;
    if (unread.length === 0) return;
    void Promise.all(unread.map((m) =>
      rpc<{ message_id: string; read_at: string }>("admin_mark_message_read", { p_message_id: m.id }),
    )).then(() => {
      void queryClient.invalidateQueries({ queryKey: adminKey("messages", "kpis") });
      void queryClient.invalidateQueries({ queryKey: adminKey("messages", "threads") });
    });
  }, [sel, threadQ.data, queryClient]);

  const replyMut = useMutation({
    mutationFn: async (body: string) => {
      if (!sel) throw new Error("No thread selected");
      const { data, error } = await rpc<{ message_id: string }>("admin_post_reply",
        { p_thread_id: sel, p_body: body, p_attachments: [] });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      setReply("");
      void queryClient.invalidateQueries({ queryKey: adminKey("messages", "threads") });
      if (sel) void queryClient.invalidateQueries({ queryKey: adminKey("messages", "thread", sel) });
      void queryClient.invalidateQueries({ queryKey: adminKey("messages", "kpis") });
      toast.success("Reply sent");
    },
    onError: (e: Error) => { toast.error(e.message); },
  });

  const closeMut = useMutation({
    mutationFn: async () => {
      if (!sel) throw new Error("No thread selected");
      const { data, error } = await rpc<{ thread_id: string; status: string }>("admin_close_thread",
        { p_thread_id: sel, p_notes: null });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKey("messages", "threads") });
      void queryClient.invalidateQueries({ queryKey: adminKey("messages", "kpis") });
      toast.success("Thread marked resolved");
    },
    onError: (e: Error) => { toast.error(e.message); },
  });

  const handleSend = useCallback(() => {
    const body = reply.trim();
    if (!body || replyMut.isPending) return;
    replyMut.mutate(body, {
      onSuccess: () => { if (markResolved && sel) closeMut.mutate(); },
    });
  }, [reply, replyMut, markResolved, sel, closeMut]);

  // Non-"all"/"unread" chips are visual placeholders for Phase 18 backend tagging.
  const filteredThreads = useMemo(() => {
    const all = threadsQ.data ?? [];
    if (filter === "unread") return all.filter((t) => t.last_sender_role === "user" && t.last_read_at === null);
    return all;
  }, [threadsQ.data, filter]);

  const selectedThread = useMemo(
    () => (sel ? (threadsQ.data ?? []).find((t) => t.id === sel) ?? null : null),
    [threadsQ.data, sel],
  );
  const messages = threadQ.data ?? [];
  const latestAdminOrUser = messages.length > 0 ? messages[messages.length - 1] : null;
  const k = kpisQ.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <Kpi label="Open tickets" value={k ? String(k.open_threads) : "—"}
          delta={k && k.open_threads > 0 ? `${k.open_threads} active` : "all clear"}
          deltaDir={k && k.open_threads > 0 ? "down" : "neutral"} tone={k && k.open_threads > 0 ? "danger" : undefined} />
        <Kpi label="Unread" value={k ? String(k.unread) : "—"}
          delta={k && k.unread > 0 ? "awaiting reply" : "inbox zero"}
          deltaDir={k && k.unread > 0 ? "down" : "up"} />
        <Kpi label="Avg first reply" value={k ? String(k.avg_first_reply_min) : "—"} unit="min" delta="rolling 30d" deltaDir="neutral" />
        <Kpi label="Closed · 30d" value={k ? String(k.closed_30d) : "—"} delta="resolved" deltaDir="up" />
      </div>

      <SectionHeader title="Inbox" right={
        <div className="flex flex-wrap items-center gap-1">
          {FILTER_CHIPS.map((c) => (
            <button key={c.key} type="button" aria-pressed={filter === c.key}
              className={"btn-ghost" + (filter === c.key ? " active" : "")}
              onClick={() => setFilter(c.key)}>{c.label}</button>
          ))}
        </div>
      } />

      <div className="adm-inbox" style={{ display: "grid",
        gridTemplateColumns: "minmax(0, 340px) minmax(0, 1fr)",
        gap: 0, height: 640, background: "var(--panel-2)",
        border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "var(--panel)", borderRight: "1px solid var(--line)",
          overflowY: "auto", minHeight: 0 }}>
          {threadsQ.isLoading ? (
            <div style={{ padding: 16, color: "var(--ink-mute)", fontSize: 12 }}>Loading threads…</div>
          ) : filteredThreads.length === 0 ? (
            <div style={{ padding: 16, color: "var(--ink-mute)", fontSize: 12 }}>No threads in this view.</div>
          ) : filteredThreads.map((t) => (
            <InboxRow key={t.id} thread={t} selected={t.id === sel} onSelect={() => setSel(t.id)} />
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
          {selectedThread === null ? <EmptyDetail /> : (
            <ThreadDetail thread={selectedThread} messages={messages} latest={latestAdminOrUser}
              showFullThread={showFullThread} onToggleFullThread={() => setShowFullThread((p) => !p)}
              reply={reply} onChangeReply={setReply} onSend={handleSend}
              sending={replyMut.isPending}
              markResolved={markResolved} onChangeMarkResolved={setMarkResolved} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Inbox row ─────────────────────────────────────────────────────── */

function InboxRow({ thread, selected, onSelect }: {
  thread: ThreadRow; selected: boolean; onSelect: () => void;
}): JSX.Element {
  const unread = thread.last_sender_role === "user" && thread.last_read_at === null;
  const displayName = thread.user_name ?? thread.user_id.slice(0, 8);
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "14px 16px",
        background: selected ? "var(--panel-2)" : "transparent",
        boxShadow: selected ? "inset 3px 0 0 var(--cyan)" : undefined,
        borderBottom: "1px solid var(--line)", cursor: "pointer",
        color: "var(--ink)", font: "inherit", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {unread && (
            <span aria-label="Unread"
              style={{ width: 7, height: 7, borderRadius: 999, background: "var(--cyan)",
                flexShrink: 0, boxShadow: "0 0 0 3px rgba(20,200,204,.18)" }} />
          )}
          <Avatar user={{ name: displayName, avatar: thread.user_avatar ?? undefined }} size="sm" />
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {displayName}
          </span>
        </div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".04em",
          color: "var(--ink-mute)", flexShrink: 0 }}>
          {formatRel(thread.last_created_at ?? thread.last_message_at)}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 5,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {thread.subject}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-mute)", marginTop: 3,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {thread.last_body ?? "(no messages yet)"}
      </div>
      <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
        {thread.status === "closed" && <Pill variant="default" dot>resolved</Pill>}
        {thread.status === "answered" && <Pill variant="ok" dot>answered</Pill>}
        {thread.status === "open" && <Pill variant="cyan" dot>open</Pill>}
      </div>
    </button>
  );
}

/* ── Thread detail ─────────────────────────────────────────────────── */

function EmptyDetail(): JSX.Element {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", color: "var(--ink-mute)", padding: 32, textAlign: "center", gap: 10 }}>
      <div style={{ color: "var(--ink-mute)", display: "grid", placeItems: "center" }}><I.mail /></div>
      <div style={{ fontFamily: "var(--serif)", fontSize: 18, color: "var(--ink-dim)" }}>
        Select a thread to view
      </div>
    </div>
  );
}

interface ThreadDetailProps {
  thread: ThreadRow; messages: MessageRow[]; latest: MessageRow | null;
  showFullThread: boolean; onToggleFullThread: () => void;
  reply: string; onChangeReply: (v: string) => void;
  onSend: () => void; sending: boolean;
  markResolved: boolean; onChangeMarkResolved: (v: boolean) => void;
}

function ThreadDetail(props: ThreadDetailProps): JSX.Element {
  const { thread, messages, latest, showFullThread, onToggleFullThread,
    reply, onChangeReply, onSend, sending, markResolved, onChangeMarkResolved } = props;
  const displayName = thread.user_name ?? thread.user_id.slice(0, 8);
  const firstName = displayName.split(/\s+/)[0];
  const allAttachments: ThreadAttachment[] = useMemo(() => {
    const out: ThreadAttachment[] = [];
    for (const m of messages) for (const a of m.attachments ?? []) out.push(a);
    return out;
  }, [messages]);

  return (
    <>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line)", background: "var(--panel-2)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 20, fontWeight: 400,
            color: "var(--ink)", letterSpacing: "-0.01em",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {thread.subject}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".04em",
            color: "var(--ink-mute)", marginTop: 4 }}>
            <b style={{ color: "var(--ink-dim)", fontWeight: 500 }}>{displayName}</b>
            <span> · {formatRel(thread.last_message_at)} · </span>
            <span>{thread.status}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button type="button" className="btn-mini" title="Reply"><I.reply /> Reply</button>
          <button type="button" className="btn-mini" title="Flag"><I.flag /> Flag</button>
          <button type="button" className="btn-mini" title="Trash"><I.trash /></button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px",
        fontSize: 13.5, lineHeight: 1.65, color: "var(--ink-dim)",
        background: "var(--panel-2)", minHeight: 0 }}>
        {messages.length === 0 ? (
          <div style={{ color: "var(--ink-mute)" }}>(empty thread)</div>
        ) : !showFullThread && latest ? (
          <>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em",
              textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 8 }}>
              Latest · {latest.sender_role} · {formatRel(latest.created_at)}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{latest.body}</div>
            {messages.length > 1 && (
              <button type="button" onClick={onToggleFullThread} className="btn-ghost"
                style={{ marginTop: 12 }}>
                Show full thread ({messages.length} messages)
              </button>
            )}
          </>
        ) : (
          <>
            {messages.map((m) => (
              <div key={m.id} style={{ marginBottom: 18 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em",
                  textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 6 }}>
                  {m.sender_role} · {formatRel(m.created_at)}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
              </div>
            ))}
            <button type="button" onClick={onToggleFullThread} className="btn-ghost" style={{ marginTop: 4 }}>
              Collapse to latest
            </button>
          </>
        )}

        {allAttachments.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".14em",
              color: "var(--ink-mute)", textTransform: "uppercase", marginBottom: 8 }}>
              Attachments · {allAttachments.length}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {allAttachments.map((a, i) => (
                <div key={`${a.name}-${i}`} style={{ background: "var(--panel-3)",
                  border: "1px solid var(--line)", padding: "6px 10px", borderRadius: 6,
                  fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)",
                  display: "flex", alignItems: "center", gap: 6 }}>
                  <I.paperclip /> {a.name}
                  {a.size !== undefined && (
                    <span style={{ color: "var(--ink-mute)", fontSize: 10 }}>{String(a.size)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reply footer */}
      <div style={{ borderTop: "1px solid var(--line)", padding: 12, background: "var(--panel)" }}>
        <textarea value={reply} onChange={(e) => onChangeReply(e.target.value)}
          placeholder={`Reply to ${firstName}…`}
          style={{ width: "100%", minHeight: 80, resize: "vertical", padding: "10px 12px",
            background: "var(--panel-3)", border: "1px solid var(--line)", borderRadius: 8,
            fontSize: 13, lineHeight: 1.55, color: "var(--ink)", fontFamily: "inherit" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 10, gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn-mini" title="Attach file"><I.paperclip /></button>
            <button type="button" className="btn-mini">Templates</button>
            <button type="button" className="btn-mini"><I.credit /> Add credits</button>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
              fontSize: 11.5, color: "var(--ink-dim)" }}>
              <input type="checkbox" checked={markResolved}
                onChange={(e) => onChangeMarkResolved(e.target.checked)}
                style={{ accentColor: "var(--cyan)" }} />
              Mark resolved
            </label>
            <button type="button" className="btn-cyan sm" onClick={onSend}
              disabled={sending || reply.trim().length === 0}
              style={{ opacity: sending || reply.trim().length === 0 ? 0.55 : 1 }}>
              <I.send /> {sending ? "Sending…" : "Send reply"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
