/**
 * CommunicatePanel — admin "open a thread" / push-only surface lifted
 * out of UserDrawer.tsx for code-splitting.
 *
 * Wave D §C-7 (UserDrawer chunk audit): UserDrawer was ~394 KB because
 * the tiptap-based RichEditor (StarterKit + Underline + Link) was
 * statically imported here. Most admins use the drawer just for the
 * Overview/Activity/Billing/Danger tabs, never opening Communicate —
 * so we pay the 200+ KB tiptap import on every drawer open even
 * though it's used by maybe 10 % of sessions.
 *
 * The fix: extract the whole panel into its own module so React.lazy
 * in UserDrawer can defer the tiptap chunk until the user actually
 * clicks the Communicate tab. The functions inside this file (channel
 * orchestrator + helpers) are co-located so a future Comms-only admin
 * route can import this module directly without dragging UserDrawer.
 */
import { useState, type JSX } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { I } from "@/components/admin/_shared/AdminIcons";
import { RichEditor } from "@/components/admin/_shared/RichEditor";
import { Toggle } from "@/components/admin/_shared/Toggle";

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

// ── Channel send helpers (used by both the thread Send button and the
// push-only headline). Each one resolves to a typed result so the
// orchestrator can report partial success per channel.
type ChannelResult =
  | { channel: "thread" | "email" | "push"; ok: true }
  | { channel: "thread" | "email" | "push"; ok: false; reason: string };

async function openThread(userId: string, subject: string, body: string): Promise<ChannelResult> {
  const { error } = await rpc<unknown>("admin_open_thread", {
    p_user_id: userId, p_subject: subject, p_body: body,
  });
  if (error) {
    // Phase 13 may not be deployed yet — surface that distinctly so
    // the orchestrator can decide whether it's a hard or soft fail.
    const reason = /function .* does not exist|404/i.test(error.message)
      ? "Messaging RPC not yet deployed (Phase 13)"
      : error.message;
    return { channel: "thread", ok: false, reason };
  }
  return { channel: "thread", ok: true };
}

async function sendEmailCopy(userId: string, subject: string, body: string): Promise<ChannelResult> {
  // Edge fn `notify-user-of-message` is the SMTP relay. It hasn't shipped
  // yet (Phase 13.x), so this currently returns a soft-fail until then —
  // the orchestrator can choose whether to treat that as success-with-note
  // or surface it as a partial failure.
  try {
    const { data: sess } = await supabase.auth.getSession();
    const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/notify-user-of-message`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token ?? ""}` },
      body: JSON.stringify({ user_id: userId, subject, body }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return { channel: "email", ok: false, reason: errBody.error || `Email copy failed (${res.status})` };
    }
    return { channel: "email", ok: true };
  } catch (err) {
    return { channel: "email", ok: false, reason: err instanceof Error ? err.message : "Email copy failed" };
  }
}

async function sendPush(userId: string, title: string, body: string): Promise<ChannelResult> {
  const { error } = await rpc<unknown>("admin_send_notification", {
    p_user_ids: [userId], p_title: title, p_body: body, p_cta_url: null, p_severity: "info",
  });
  if (error) return { channel: "push", ok: false, reason: error.message };
  return { channel: "push", ok: true };
}

export default function CommunicatePanel({ userId }: { userId: string }): JSX.Element {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [emailCopy, setEmailCopy] = useState(true);
  const [pushAlong, setPushAlong] = useState(false);
  const [headline, setHeadline] = useState("");
  const [pending, setPending] = useState(false);

  async function sendThreadMessage(): Promise<void> {
    // body is HTML — strip tags before checking emptiness so an empty
    // editor (which still contains a stray <br>) counts as empty.
    const plain = body.replace(/<[^>]*>/g, "").trim();
    if (!subject.trim() || !plain) {
      toast.error("Subject and message are required"); return;
    }
    setPending(true);
    try {
      // Parallel-allSettled orchestration: fire every enabled channel
      // independently and report a single summary toast. Partial-success
      // failures don't block the others (e.g. push down ≠ thread down).
      // A rejected promise is normalised to a ChannelResult so the
      // summary line treats SDK throws and channel soft-fails uniformly.
      const tasks: Promise<ChannelResult>[] = [openThread(userId, subject, body)];
      if (emailCopy) tasks.push(sendEmailCopy(userId, subject, body));
      // Push notifications are plain-text only — strip tags so the user
      // doesn't see literal "<b>" markers on their lock screen.
      if (pushAlong) tasks.push(sendPush(userId, subject, plain));

      const results: ChannelResult[] = (await Promise.allSettled(tasks)).map((r) =>
        r.status === "fulfilled"
          ? r.value
          : ({ channel: "thread", ok: false, reason: String(r.reason) } as ChannelResult),
      );
      const okCount = results.filter((r) => r.ok).length;
      if (okCount === results.length) {
        toast.success(`Sent (${okCount}/${results.length})`);
      } else {
        const failed = results.filter((r): r is Extract<ChannelResult, { ok: false }> => !r.ok);
        toast.error(
          `Sent ${okCount}/${results.length} — ${failed.map((r) => r.channel).join(", ")} failed`,
          { description: failed.map((r) => `${r.channel}: ${r.reason}`).join(" · ") },
        );
      }
      setSubject(""); setBody("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally { setPending(false); }
  }

  async function sendPushOnly(): Promise<void> {
    if (!headline.trim()) { toast.error("Headline is required"); return; }
    setPending(true);
    try {
      const r = await sendPush(userId, headline, "");
      if (!r.ok) throw new Error(r.reason);
      toast.success("Push sent");
      setHeadline("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Push failed");
    } finally { setPending(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card" style={{ padding: 14 }}>
        <div className="card-h"><div className="t">Open a thread</div></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input type="text" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}
            aria-label="Thread subject"
            style={{ padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
          <RichEditor value={body} onChange={setBody} />

          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--ink-dim)" }}>
            <Toggle checked={emailCopy} onChange={setEmailCopy} ariaLabel="Email a copy" />
            <span>Email a copy to the user</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--ink-dim)" }}>
            <Toggle checked={pushAlong} onChange={setPushAlong} ariaLabel="Also push" />
            <span>Also send as push notification</span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn-cyan sm" onClick={sendThreadMessage} disabled={pending}>
              <I.send /> Send
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="card-h"><div className="t">Push-only headline</div></div>
        <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginBottom: 8 }}>
          Sends a one-line push notification without opening a thread. Useful for
          short alerts (e.g. "Your render is ready").
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <input type="text" placeholder="Headline" value={headline} onChange={(e) => setHeadline(e.target.value)}
            aria-label="Push notification headline"
            style={{ padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
          <button type="button" className="btn-cyan sm" onClick={sendPushOnly} disabled={pending}>
            <I.send /> Push
          </button>
        </div>
      </div>
    </div>
  );
}
