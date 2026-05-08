/**
 * Public unsubscribe page (Phase 15.1).
 *
 * Reached from the `?t=<token>` link in newsletter footers. Calls the
 * SECURITY DEFINER RPC `unsubscribe_with_token` (granted to anon) so
 * the user doesn't need to be signed in. Shows a confirmation with
 * the email that was unsubscribed (or a neutral fallback when the
 * token is unknown — we never disclose whether a token would have
 * been valid).
 */
import { useEffect, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

type State = "loading" | "ok" | "error";

export default function Unsubscribe(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get("t") ?? "";
  const [state, setState] = useState<State>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setErrorMessage("This link is missing the token. Open the most recent newsletter and click Unsubscribe again.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // RPC is granted to anon. Returns the email (string) on
        // success or null when the token doesn't match.
        const { data, error } = await supabase.rpc("unsubscribe_with_token" as never, { p_token: token });
        if (cancelled) return;
        if (error) {
          setState("error");
          setErrorMessage(error.message);
          return;
        }
        if (typeof data === "string" && data.length > 0) {
          setEmail(data);
        }
        setState("ok");
      } catch (err) {
        if (cancelled) return;
        setState("error");
        setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg, #0d1416, #0a0e10)",
      color: "#ECEAE4",
      fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "24px",
    }}>
      <div style={{
        width: "min(520px, 100%)",
        background: "rgba(21,27,32,.85)",
        border: "1px solid rgba(255,255,255,.08)",
        borderRadius: 16,
        padding: "32px 36px",
        textAlign: "center",
      }}>
        <div style={{ fontFamily: "Georgia, 'Playfair Display', serif", fontSize: 28, marginBottom: 8 }}>
          MotionMax
        </div>
        {state === "loading" && (
          <p style={{ color: "#8A9198", fontSize: 14, margin: "24px 0" }}>Updating your subscription…</p>
        )}
        {state === "ok" && (
          <>
            <h1 style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 600, margin: "20px 0 12px" }}>
              You're unsubscribed
            </h1>
            <p style={{ color: "#C8CCCE", fontSize: 14.5, lineHeight: 1.6 }}>
              {email
                ? <>We've removed <b style={{ color: "#E4C875" }}>{email}</b> from MotionMax marketing emails.</>
                : <>If this token matched an active subscription, it's now removed. You won't receive any more newsletters.</>}
            </p>
            <p style={{ color: "#8A9198", fontSize: 12.5, marginTop: 18 }}>
              You'll still get account &amp; billing emails. Account holders can re-subscribe anytime in Settings.
            </p>
          </>
        )}
        {state === "error" && (
          <>
            <h1 style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 600, margin: "20px 0 12px", color: "#F5DCAA" }}>
              Couldn't process the request
            </h1>
            <p style={{ color: "#C8CCCE", fontSize: 14.5, lineHeight: 1.6 }}>
              {errorMessage}
            </p>
            <p style={{ color: "#8A9198", fontSize: 12.5, marginTop: 18 }}>
              If you keep seeing this, email <a href="mailto:support@motionmax.io" style={{ color: "#14C8CC" }}>support@motionmax.io</a> and we'll remove you manually.
            </p>
          </>
        )}
        <div style={{ marginTop: 28, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,.06)" }}>
          <a href="https://motionmax.io" style={{ color: "#14C8CC", textDecoration: "none", fontSize: 12.5 }}>
            ← Back to motionmax.io
          </a>
        </div>
      </div>
    </div>
  );
}
