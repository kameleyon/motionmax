import { useState, useEffect, useCallback, createContext, useContext, ReactNode, createElement } from "react";
import { User, Session, AuthError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { trackEvent, getStoredUtm, identifyUser, clearIdentity } from "@/hooks/useAnalytics";
import { CURRENT_POLICY_VERSION } from "@/lib/policyVersion";
import { LEGAL_VERSIONS } from "@/config/legal-versions";
// B-NEW-7 (Lens B) — first-touch UTM blob captured on motionmax.io and
// rehydrated on app.motionmax.io via the .motionmax.io cookie. Written
// to profiles.acquisition at signup, then cleared so a second signup
// from the same browser doesn't reuse the same attribution.
import { getStoredUtms, clearStoredUtms } from "@/lib/utm";

// ---------------------------------------------------------------------------
// Auth context shape — mirrors the original useAuth() return value exactly so
// every existing consumer continues to work without any changes.
// ---------------------------------------------------------------------------

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAuthenticated: boolean;
  signUp: (email: string, password: string, postConfirmPath?: string) => Promise<{ data: unknown; error: AuthError | null }>;
  signIn: (email: string, password: string) => Promise<{ data: unknown; error: AuthError | null }>;
  signOut: () => Promise<{ error: AuthError | null }>;
  resetPassword: (email: string) => Promise<{ data: unknown; error: AuthError | null }>;
  updatePassword: (password: string) => Promise<{ data: unknown; error: AuthError | null }>;
  /**
   * B-NEW-13 (Comply L-B-02): true when the signed-in user's stored legal-doc
   * versions do not match the current LEGAL_VERSIONS constants. The
   * <TermsUpdateModal/> consumes this to prompt re-acceptance.
   */
  legalVersionMismatch: boolean;
  /** Persists current LEGAL_VERSIONS to profiles, then clears legalVersionMismatch. */
  acceptLegalVersions: () => Promise<{ error: Error | null }>;
}

// Sentinel — throws a helpful error if a consumer is rendered outside the provider.
const MISSING_PROVIDER_ERROR =
  "[AuthProvider] useAuth() was called outside of <AuthProvider>. " +
  "Make sure <AuthProvider> wraps your component tree above any auth consumer.";

export const AuthContext = createContext<AuthContextValue>({
  // These defaults are never used in practice — the provider always supplies real values.
  user: null,
  session: null,
  loading: true,
  isAuthenticated: false,
  signUp: () => { throw new Error(MISSING_PROVIDER_ERROR); },
  signIn: () => { throw new Error(MISSING_PROVIDER_ERROR); },
  signOut: () => { throw new Error(MISSING_PROVIDER_ERROR); },
  resetPassword: () => { throw new Error(MISSING_PROVIDER_ERROR); },
  updatePassword: () => { throw new Error(MISSING_PROVIDER_ERROR); },
  legalVersionMismatch: false,
  acceptLegalVersions: () => { throw new Error(MISSING_PROVIDER_ERROR); },
});

// ---------------------------------------------------------------------------
// AuthProvider — owns the SINGLE onAuthStateChange subscription for the whole
// application. All consumers read from context instead of creating their own.
// ---------------------------------------------------------------------------

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // B-NEW-13 (Comply L-B-02): tracks whether the signed-in user's stored
  // legal-doc versions differ from the current LEGAL_VERSIONS. Drives
  // <TermsUpdateModal/>. Reset to false on signOut.
  const [legalVersionMismatch, setLegalVersionMismatch] = useState(false);

  useEffect(() => {
    // Restore session on mount — handles page refresh / deep links.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      // Compare legal versions on session restore so a refresh on an
      // already-signed-in tab still triggers the re-acceptance modal.
      if (session?.user) {
        void checkLegalVersionMismatch(session.user.id, setLegalVersionMismatch);
      }
    }).catch((err) => {
      console.error("[Auth] Failed to restore session:", err);
      setLoading(false);
    });

    // ONE subscription for the entire application.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);

        if (_event === "SIGNED_OUT") {
          setLegalVersionMismatch(false);
          // B-NEW-7 (Lens B): drop the GA user_id binding so post-logout
          // events on the same client_id aren't still attributed to the
          // previous user.
          try { clearIdentity(); } catch { /* analytics non-critical */ }
        }

        // Persist accepted_policy_version to profiles on first sign-in after sign-up.
        // The column is NULL for legacy accounts — only write if metadata carries the version.
        if (_event === "SIGNED_IN" && session?.user) {
          const metaVersion = session.user.user_metadata?.accepted_policy_version as string | undefined;
          if (metaVersion) {
            supabase
              .from("profiles")
              .update({
                accepted_policy_version: metaVersion,
                accepted_policy_at: session.user.user_metadata?.accepted_policy_at ?? new Date().toISOString(),
              } as unknown as Record<string, unknown>)
              .eq("user_id", session.user.id)
              .is("accepted_policy_version", null)
              .then(() => {});
          }

          // B-NEW-13 (Comply L-B-02): on first sign-in after signup the
          // signUp() call stamped user_metadata with the per-doc legal
          // versions. Persist them to the new profiles columns so the
          // server has authoritative proof of which version the user
          // was bound to. Idempotent: ON CONFLICT-style upsert on the
          // profile row that the signup trigger already created.
          const tos = session.user.user_metadata?.tos_version_accepted as string | undefined;
          const privacy = session.user.user_metadata?.privacy_version_accepted as string | undefined;
          const aup = session.user.user_metadata?.aup_version_accepted as string | undefined;
          const acceptedAt = (session.user.user_metadata?.legal_accepted_at as string | undefined)
            ?? new Date().toISOString();
          if (tos || privacy || aup) {
            supabase
              .from("profiles")
              .update({
                tos_version_accepted: tos ?? LEGAL_VERSIONS.tos,
                tos_version_accepted_at: acceptedAt,
                privacy_version_accepted: privacy ?? LEGAL_VERSIONS.privacy,
                privacy_version_accepted_at: acceptedAt,
                aup_version_accepted: aup ?? LEGAL_VERSIONS.aup,
                aup_version_accepted_at: acceptedAt,
              } as unknown as Record<string, unknown>)
              .eq("user_id", session.user.id)
              .then(({ error }) => {
                if (error) {
                  console.warn("[Auth] Failed to persist legal versions:", error.message);
                }
              });
          }

          // After persisting (or for returning users who just signed in),
          // run the version-mismatch check. Backfilled '2026.02-v0' rows
          // will mismatch and trigger the re-acceptance modal.
          void checkLegalVersionMismatch(session.user.id, setLegalVersionMismatch);

          // B-NEW-7 (Lens B) — stamp the GA user_id so anonymous-pageview
          // → authenticated-session can be stitched into one user journey
          // in GA. Hashed with SHA-256 before transmission so Google
          // never sees the raw Supabase UUID. Best-effort.
          void identifyUser(session.user.id);

          // B-NEW-7 (Lens B) — first-touch attribution write. The
          // marketing site dropped a .motionmax.io cookie; on the first
          // SIGNED_IN after signup we mirror it into profiles.acquisition
          // and CLEAR it so a second signup from the same browser
          // doesn't inherit the same ad-click. Idempotent: existing
          // rows with non-null acquisition are not overwritten — the
          // first signup wins.
          const utms = getStoredUtms();
          if (utms) {
            const acquisitionPayload = {
              utm_source: utms.source,
              utm_medium: utms.medium,
              utm_campaign: utms.campaign,
              utm_term: utms.term,
              utm_content: utms.content,
              gclid: utms.gclid,
              fbclid: utms.fbclid,
              captured_at: utms.captured_at,
              landing_url: utms.landing_url,
            };
            supabase
              .from("profiles")
              .update({ acquisition: acquisitionPayload } as unknown as Record<string, unknown>)
              .eq("user_id", session.user.id)
              .is("acquisition", null)
              .then(({ error }) => {
                if (!error) {
                  // Only clear after the write resolved without error;
                  // a transient failure shouldn't lose the attribution
                  // before retry on the next session restore.
                  try { clearStoredUtms(); } catch { /* ignore */ }
                }
              });
          }

          // Fire-and-forget welcome email on first sign-in. The edge fn
          // is idempotent (atomic claim on profiles.welcome_email_sent_at)
          // so calling it on every SIGNED_IN is safe — the second call
          // returns sent:false without re-emailing.
          const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/notify-signup-welcome`;
          void fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
          }).catch(() => { /* welcome email is best-effort */ });
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Phase 8.2 — last-active heartbeat. Live RPC keeps the admin
  // "active now" counter accurate to ~1 min without a nightly cron.
  // We fire on every transition to a signed-in user, on tab focus
  // (window.visibilitychange → 'visible'), and on a 60 s interval.
  // Errors are swallowed: this is best-effort telemetry, never block
  // the auth path on it.
  useEffect(() => {
    if (!user) return;
    const bump = (): void => {
      // Fire-and-forget; ignore failures (offline, expired token, etc.).
      void supabase.rpc("bump_my_last_active" as never).then(() => {}, () => {});
    };
    bump();
    const onVis = (): void => { if (document.visibilityState === "visible") bump(); };
    document.addEventListener("visibilitychange", onVis);
    const interval = window.setInterval(bump, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(interval);
    };
  }, [user]);

  const signUp = useCallback(async (
    email: string,
    password: string,
    /**
     * C-2-1 fix (Hook B1) — optional post-confirmation redirect path
     * (must start with `/`). Lets the Pricing CTA preserve plan + cycle
     * intent across the email confirmation hop so the user lands back
     * on /pricing with `?autocheckout=...` rather than /app empty-
     * handed. Falls back to `/app` when omitted or invalid.
     */
    postConfirmPath?: string,
  ) => {
    const redirectUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const safePostConfirm =
      postConfirmPath &&
      postConfirmPath.startsWith("/") &&
      !postConfirmPath.startsWith("//")
        ? postConfirmPath
        : "/app";
    const utmParams = getStoredUtm();
    const acceptedAtIso = new Date().toISOString();
    const { data, error } = await supabase.auth.signUp({
      options: {
        emailRedirectTo: `${redirectUrl}${safePostConfirm}`,
        data: {
          accepted_policy_version: CURRENT_POLICY_VERSION,
          accepted_policy_at: acceptedAtIso,
          // B-NEW-13 (Comply L-B-02): stamp the binding version of EACH
          // legal doc into user_metadata. The onAuthStateChange handler
          // above persists these to profiles.{tos,privacy,aup}_version_accepted
          // on first SIGNED_IN — that's the only point where we have an
          // authenticated session that satisfies the profiles RLS policy.
          tos_version_accepted: LEGAL_VERSIONS.tos,
          privacy_version_accepted: LEGAL_VERSIONS.privacy,
          aup_version_accepted: LEGAL_VERSIONS.aup,
          legal_accepted_at: acceptedAtIso,
          ...utmParams,
        },
      },
      email,
      password,
    });
    if (!error) {
      try { trackEvent("signup", { method: "email", ...utmParams }); } catch { /* analytics non-critical */ }
      // B-NEW-7 (Lens B) — explicit funnel event so dashboards can
      // distinguish "form submitted + API ok" from generic "signup".
      // Cross-subdomain UTMs (richer than the sessionStorage shape used
      // by user_metadata above) ride along so attribution survives even
      // if the user clears sessionStorage between landing and signup.
      try {
        const utms = getStoredUtms();
        const utmEvt = utms
          ? {
              ...(utms.source   ? { utm_source: utms.source } : {}),
              ...(utms.medium   ? { utm_medium: utms.medium } : {}),
              ...(utms.campaign ? { utm_campaign: utms.campaign } : {}),
              ...(utms.term     ? { utm_term: utms.term } : {}),
              ...(utms.content  ? { utm_content: utms.content } : {}),
              ...(utms.gclid    ? { gclid: utms.gclid } : {}),
              ...(utms.fbclid   ? { fbclid: utms.fbclid } : {}),
            }
          : {};
        trackEvent("signup_completed", { method: "email", ...utmEvt });
      } catch { /* analytics non-critical */ }
    }
    return { data, error };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    // C-6-3 / Shield S-007 — server-side throttle pre-check.
    //
    // BEFORE we hand the credentials to Supabase Auth, ask the
    // auth_throttle RPC whether this email is currently locked out.
    // The RPC also records the pre-attempt so each unsuccessful
    // round-trip burns one of the 5 allowed attempts even if the
    // attacker disconnects before seeing the Auth response.
    //
    // We intentionally DO NOT short-circuit on any RPC error here —
    // a momentarily-flaky DB shouldn't block legitimate users from
    // signing in. The RPC is fail-open at the network layer; the
    // database lockout itself is fail-closed (returns allowed=false
    // when locked).
    //
    // NOTE: the only enforcement layer for Supabase-hosted Auth is
    // this client-side gate (Supabase doesn't expose a pre-signin
    // hook). A hostile client can skip this call entirely. For
    // stronger protection, route signins through a custom Edge
    // Function that calls the throttle THEN supabase.auth.signInWithPassword
    // server-side. Documented as a follow-up in docs/admin-mfa.md.
    const throttleKey = `email:${email.trim().toLowerCase()}`;
    try {
      const { data: throttle, error: throttleErr } = await (supabase.rpc(
        "check_and_record_auth_attempt" as never,
        { p_key: throttleKey, p_success: false } as never,
      ) as unknown as Promise<{
        data: { allowed: boolean; attempts_remaining: number; locked_until: string | null } | null;
        error: { message: string } | null;
      }>);
      if (!throttleErr && throttle && throttle.allowed === false) {
        // Surface as an AuthError-shaped object so existing UI code
        // (LoginPage etc.) can render the message without branching
        // on a separate error type.
        const lockedUntilText = throttle.locked_until
          ? ` Try again at ${new Date(throttle.locked_until).toLocaleTimeString()}.`
          : "";
        const err = new Error(
          `Too many failed sign-in attempts.${lockedUntilText}`,
        ) as unknown as AuthError;
        return { data: null, error: err };
      }
    } catch {
      // Throttle RPC unreachable — fail open. The server is still
      // safer than no enforcement (subsequent successful attempts
      // will normalise the row).
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    // Record the outcome so the row reflects reality.
    //   • success → resets attempts to 0.
    //   • failure → increments; locks at attempt 5.
    try {
      await (supabase.rpc(
        "check_and_record_auth_attempt" as never,
        { p_key: throttleKey, p_success: !error } as never,
      ) as unknown as Promise<unknown>);
    } catch {
      // Best-effort; the previous pre-check is the authoritative gate.
    }

    if (!error) {
      try { trackEvent("login", { method: "email" }); } catch { /* analytics non-critical */ }
    }
    return { data, error };
  }, []);

  const signOut = useCallback(async () => {
    // Clear only auth-related session storage keys
    const authKeys = ['upgradeModalDismissed', 'subscriptionSuspendedDismissed'];
    authKeys.forEach(key => sessionStorage.removeItem(key));
    const { error } = await supabase.auth.signOut();
    return { error };
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const redirectUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${redirectUrl}/auth`,
    });
    return { data, error };
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    const { data, error } = await supabase.auth.updateUser({ password });
    return { data, error };
  }, []);

  // B-NEW-13 (Comply L-B-02): user clicked "I accept" in <TermsUpdateModal/>.
  // Persist the current LEGAL_VERSIONS as authoritative proof of binding,
  // then clear the mismatch flag so the modal closes.
  const acceptLegalVersions = useCallback(async (): Promise<{ error: Error | null }> => {
    if (!user?.id) return { error: new Error("Not signed in") };
    const acceptedAt = new Date().toISOString();
    const { error } = await supabase
      .from("profiles")
      .update({
        tos_version_accepted: LEGAL_VERSIONS.tos,
        tos_version_accepted_at: acceptedAt,
        privacy_version_accepted: LEGAL_VERSIONS.privacy,
        privacy_version_accepted_at: acceptedAt,
        aup_version_accepted: LEGAL_VERSIONS.aup,
        aup_version_accepted_at: acceptedAt,
      } as unknown as Record<string, unknown>)
      .eq("user_id", user.id);
    if (!error) {
      setLegalVersionMismatch(false);
      try { trackEvent("legal_versions_accepted", LEGAL_VERSIONS as unknown as Record<string, string>); } catch { /* analytics non-critical */ }
    }
    return { error: error ? new Error(error.message) : null };
  }, [user?.id]);

  const value: AuthContextValue = {
    user,
    session,
    loading,
    isAuthenticated: !!session,
    signUp,
    signIn,
    signOut,
    resetPassword,
    updatePassword,
    legalVersionMismatch,
    acceptLegalVersions,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

// ---------------------------------------------------------------------------
// B-NEW-13 (Comply L-B-02) — version-mismatch helper.
//
// Reads the user's stored legal-doc versions from profiles and compares to
// LEGAL_VERSIONS. Sets the mismatch flag when ANY of the three differ.
// Failures are swallowed (best-effort): a network blip should not falsely
// gate the user behind a re-acceptance modal.
// ---------------------------------------------------------------------------
async function checkLegalVersionMismatch(
  userId: string,
  setFlag: (v: boolean) => void,
): Promise<void> {
  try {
    const { data, error } = await (supabase
      .from("profiles")
      .select("tos_version_accepted, privacy_version_accepted, aup_version_accepted")
      .eq("user_id", userId)
      .maybeSingle() as unknown as Promise<{
        data: {
          tos_version_accepted: string | null;
          privacy_version_accepted: string | null;
          aup_version_accepted: string | null;
        } | null;
        error: { message: string } | null;
      }>);
    if (error || !data) return;
    const mismatch =
      data.tos_version_accepted !== LEGAL_VERSIONS.tos
      || data.privacy_version_accepted !== LEGAL_VERSIONS.privacy
      || data.aup_version_accepted !== LEGAL_VERSIONS.aup;
    setFlag(mismatch);
  } catch {
    // Best-effort. Do not gate the user on telemetry failures.
  }
}

// ---------------------------------------------------------------------------
// useAuth — drop-in replacement for the original hook.
// Returns the shared context value; no new subscriptions are created.
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
