/**
 * TabSupport — admin Support tickets tab.
 *
 * Wires the new `support_tickets` backend (migration 20260506170000):
 *   - admin_list_support_tickets(p_status, p_limit) → list rows
 *   - admin_update_ticket_status(p_id, p_status, p_assigned_to, p_admin_notes)
 *
 * URL state: `?tab=support&status=<filter>&ticket=<uuid>`. The drawer
 * mounts when `ticket` is set and lets an admin change status, claim
 * the ticket (assign to me), and edit admin notes.
 *
 * Colour discipline: aqua + gold only — see docs/feedback_motionmax_theme_colors.md.
 */

import { useEffect, useMemo, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Pill, type PillVariant } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── RPC shim: typed wrapper over `supabase.rpc` so new RPCs are
 *  callable before the generated types catch up.  See TabUsers for the
 *  established pattern. */
type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

/* ── Types ──────────────────────────────────────────────────────────── */

type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
type TicketTopic = "billing" | "render" | "voice" | "account" | "api" | "other";

interface TicketRow {
  id: string;
  user_id: string | null;
  email: string;
  name: string;
  subject: string;
  body: string;
  topic: TicketTopic;
  status: TicketStatus;
  assigned_to: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  total_count: number;
}

type StatusFilter = "all" | TicketStatus;

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "in_progress", label: "In progress" },
  { id: "resolved", label: "Resolved" },
  { id: "closed", label: "Closed" },
];

const STATUS_OPTIONS: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];

function statusVariant(s: TicketStatus): PillVariant {
  // Aqua = active work, gold = waiting/finished. No red, no green.
  switch (s) {
    case "open":
      return "cyan";
    case "in_progress":
      return "cyan";
    case "resolved":
      return "gold";
    case "closed":
      return "default";
  }
}

function topicVariant(t: TicketTopic): PillVariant {
  // Subtle differentiation while staying inside the aqua/gold/neutral palette.
  switch (t) {
    case "billing":
      return "gold";
    case "render":
    case "voice":
    case "api":
      return "cyan";
    case "account":
    case "other":
    default:
      return "default";
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/* ── Fetcher ────────────────────────────────────────────────────────── */

async function fetchTickets(filter: StatusFilter): Promise<TicketRow[]> {
  const { data, error } = await rpc<TicketRow[]>("admin_list_support_tickets", {
    p_status: filter === "all" ? null : filter,
    p_limit: 200,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* ── Drawer ─────────────────────────────────────────────────────────── */

interface TicketDrawerProps {
  ticket: TicketRow;
  onClose: () => void;
}

function TicketDrawer({ ticket, onClose }: TicketDrawerProps): JSX.Element {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [status, setStatus] = useState<TicketStatus>(ticket.status);
  const [notes, setNotes] = useState<string>(ticket.admin_notes ?? "");
  const [assignedTo, setAssignedTo] = useState<string | null>(ticket.assigned_to);
  const [saving, setSaving] = useState(false);

  const dirty =
    status !== ticket.status ||
    (notes ?? "") !== (ticket.admin_notes ?? "") ||
    assignedTo !== ticket.assigned_to;

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const { error } = await rpc<TicketRow>("admin_update_ticket_status", {
        p_id: ticket.id,
        p_status: status,
        p_assigned_to: assignedTo,
        p_admin_notes: notes,
      });
      if (error) throw new Error(error.message);
      toast.success("Ticket updated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "support"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update ticket");
    } finally {
      setSaving(false);
    }
  }

  function assignToMe(): void {
    if (!user?.id) {
      toast.error("Not signed in");
      return;
    }
    setAssignedTo(user.id);
  }

  function unassign(): void {
    setAssignedTo(null);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(6,12,16,.55)",
        backdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          height: "100%",
          background: "var(--panel-1, #0d1418)",
          borderLeft: "1px solid var(--line, rgba(255,255,255,.08))",
          padding: 20,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-mute)" }}>
              #{shortId(ticket.id)}
            </span>
            <Pill variant={statusVariant(ticket.status)} dot>{ticket.status}</Pill>
            <Pill variant={topicVariant(ticket.topic)}>{ticket.topic}</Pill>
          </div>
          <button type="button" className="btn-mini" onClick={onClose} aria-label="Close drawer">
            <I.x />
          </button>
        </div>

        <div>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 20, color: "var(--ink, #ECEAE4)", letterSpacing: "-.01em" }}>
            {ticket.subject}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 4 }}>
            From {ticket.name} &lt;{ticket.email}&gt; · {formatRel(ticket.created_at)}
          </div>
        </div>

        <div
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
            color: "var(--ink)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.55,
          }}
        >
          {ticket.body}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11.5, color: "var(--ink-dim)", letterSpacing: ".06em", textTransform: "uppercase" }}>
            Status
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TicketStatus)}
            style={{
              padding: 8,
              background: "var(--panel-3)",
              border: "1px solid var(--line)",
              color: "var(--ink)",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11.5, color: "var(--ink-dim)", letterSpacing: ".06em", textTransform: "uppercase" }}>
            Assigned to
          </label>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {assignedTo ?? "Unassigned"}
            </span>
            <button type="button" className="btn-mini" onClick={assignToMe}>
              Assign to me
            </button>
            {assignedTo ? (
              <button type="button" className="btn-mini" onClick={unassign}>
                Unassign
              </button>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="ticket-notes" style={{ fontSize: 11.5, color: "var(--ink-dim)", letterSpacing: ".06em", textTransform: "uppercase" }}>
            Admin notes
          </label>
          <textarea
            id="ticket-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes — not shown to the user."
            rows={5}
            style={{
              padding: 10,
              background: "var(--panel-3)",
              border: "1px solid var(--line)",
              color: "var(--ink)",
              borderRadius: 6,
              fontSize: 13,
              resize: "vertical",
              minHeight: 100,
            }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button type="button" className="btn-mini" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-cyan"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Tab body ───────────────────────────────────────────────────────── */

export function TabSupport(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = (searchParams.get("status") ?? "all") as StatusFilter;
  const ticketId = searchParams.get("ticket");

  const setParam = (key: string, value: string | null): void => {
    const params = new URLSearchParams(searchParams);
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
    setSearchParams(params, { replace: true });
  };

  const list = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("support", "list", filter),
    queryFn: () => fetchTickets(filter),
  });

  useEffect(() => {
    if (list.error) toast.error("Support tickets failed to load", { id: "support-list" });
  }, [list.error]);

  const rows = list.data ?? [];
  const totalCount = rows[0]?.total_count ?? 0;

  const activeTicket = useMemo<TicketRow | null>(() => {
    if (!ticketId) return null;
    return rows.find((r) => r.id === ticketId) ?? null;
  }, [rows, ticketId]);

  return (
    <div>
      <SectionHeader
        title="Support tickets"
        right={
          <div style={{ display: "flex", gap: 6 }}>
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setParam("status", s.id === "all" ? null : s.id)}
                className={"btn-mini" + (filter === s.id ? " active" : "")}
                style={
                  filter === s.id
                    ? { color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)", background: "var(--cyan-dim)" }
                    : undefined
                }
              >
                {s.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="tbl-wrap">
        <div className="scroll" style={{ maxHeight: 640 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th>
                <th>Subject</th>
                <th>From</th>
                <th style={{ width: 100 }}>Topic</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 110 }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading ? (
                <tr><td colSpan={6}><AdminLoading /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6}><AdminEmpty title="No tickets in this view" hint="Try a different status filter." /></td></tr>
              ) : (
                rows.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setParam("ticket", t.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="mono" style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>#{shortId(t.id)}</td>
                    <td>
                      <div style={{ color: "var(--ink)", fontSize: 13, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.subject}
                      </div>
                    </td>
                    <td>
                      <div className="meta" style={{ minWidth: 0 }}>
                        <div className="n" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.name}
                        </div>
                        <div className="e">{t.email}</div>
                      </div>
                    </td>
                    <td><Pill variant={topicVariant(t.topic)}>{t.topic}</Pill></td>
                    <td><Pill variant={statusVariant(t.status)} dot>{t.status}</Pill></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{formatRel(t.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 4px",
          color: "var(--ink-dim)",
          fontSize: 12,
        }}
      >
        <span className="mono">
          {totalCount > 0 ? `${rows.length} of ${totalCount}` : ""}
        </span>
      </div>

      {activeTicket ? (
        <TicketDrawer ticket={activeTicket} onClose={() => setParam("ticket", null)} />
      ) : null}
    </div>
  );
}
