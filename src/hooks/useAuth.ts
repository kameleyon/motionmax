import { useState, useEffect, useCallback, createContext, useContext, ReactNode, createElement } from "react";
import { User, Session, AuthError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { trackEvent, getStoredUtm } from "@/hooks/useAnalytics";
import { CURRENT_POLICY_VERSION } from "@/lib/policyVersion";
import { LEGAL_VERSIONS } from "@/config/legal-versions";

// ---------------------------------------------------------------------------
// Auth context shape — mirrors the original useAuth() return value exactly so
// every existing consumer continues to work without any changes.
// ---------------------------------------------------------------------------

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAuthenticated: boolean;
  signUp: (email: string, password: string) => Promise<{ data: unknown; error: AuthError | null }>;
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

  const signUp = useCallback(async (email: string, password: string) => {
    const redirectUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const utmParams = getStoredUtm();
    const acceptedAtIso = new Date().toISOString();
    const { data, error } = await supabase.auth.signUp({
      options: {
        emailRedirectTo: `${redirectUrl}/app`,
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
    }
    return { data, error };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
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
