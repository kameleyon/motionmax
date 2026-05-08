import { useState, useEffect, useCallback, createContext, useContext, ReactNode, createElement } from "react";
import { User, Session, AuthError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { trackEvent, getStoredUtm } from "@/hooks/useAnalytics";
import { CURRENT_POLICY_VERSION } from "@/lib/policyVersion";

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

  useEffect(() => {
    // Restore session on mount — handles page refresh / deep links.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
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
    const { data, error } = await supabase.auth.signUp({
      options: {
        emailRedirectTo: `${redirectUrl}/app`,
        data: {
          accepted_policy_version: CURRENT_POLICY_VERSION,
          accepted_policy_at: new Date().toISOString(),
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
  };

  return createElement(AuthContext.Provider, { value }, children);
}

// ---------------------------------------------------------------------------
// useAuth — drop-in replacement for the original hook.
// Returns the shared context value; no new subscriptions are created.
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
