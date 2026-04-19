import { useState, useEffect, useCallback, createContext, useContext, ReactNode, createElement } from "react";
import { User, Session, AuthError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { trackEvent, getStoredUtm } from "@/hooks/useAnalytics";

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
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const redirectUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const { data, error } = await supabase.auth.signUp({
      options: { emailRedirectTo: `${redirectUrl}/app` },
      email,
      password,
    });
    if (!error) {
      try { trackEvent("signup", { method: "email", ...getStoredUtm() }); } catch {}
    }
    return { data, error };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (!error) {
      try { trackEvent("login", { method: "email" }); } catch {}
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
