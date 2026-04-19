/// <reference types="vitest/globals" />
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";

// ── vi.hoisted ensures these refs are available inside the hoisted vi.mock factories ──
const {
  mockGetSession,
  mockOnAuthStateChange,
  mockSignUp,
  mockSignInWithPassword,
  mockSignOut,
  mockResetPasswordForEmail,
  mockUpdateUser,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockOnAuthStateChange: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignInWithPassword: vi.fn(),
  mockSignOut: vi.fn(),
  mockResetPasswordForEmail: vi.fn(),
  mockUpdateUser: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
      signUp: mockSignUp,
      signInWithPassword: mockSignInWithPassword,
      signOut: mockSignOut,
      resetPasswordForEmail: mockResetPasswordForEmail,
      updateUser: mockUpdateUser,
    },
  },
}));

vi.mock("@/hooks/useAnalytics", () => ({
  trackEvent: vi.fn(),
  getStoredUtm: vi.fn(() => ({})),
}));

import { AuthProvider, useAuth } from "@/hooks/useAuth";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUnsubscribe() {
  const unsubscribe = vi.fn();
  return { data: { subscription: { unsubscribe } } };
}

function makeSession(overrides?: object) {
  return {
    user: { id: "user-123", email: "test@example.com" },
    access_token: "tok_abc",
    ...overrides,
  };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no session, one-time auth state listener
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockOnAuthStateChange.mockReturnValue(makeUnsubscribe());
  });

  it("starts in loading state then resolves unauthenticated", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("reflects an existing session on mount", async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.user).toEqual(session.user);
    expect(result.current.session).toEqual(session);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("updates state when onAuthStateChange fires with a session", async () => {
    let authCallback: (event: string, session: unknown) => void = () => {};
    mockOnAuthStateChange.mockImplementation((cb) => {
      authCallback = cb;
      return makeUnsubscribe();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const session = makeSession();
    act(() => authCallback("SIGNED_IN", session));

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.id).toBe("user-123");
  });

  it("clears state when onAuthStateChange fires SIGNED_OUT", async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    let authCallback: (event: string, session: unknown) => void = () => {};
    mockOnAuthStateChange.mockImplementation((cb) => {
      authCallback = cb;
      return makeUnsubscribe();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    act(() => authCallback("SIGNED_OUT", null));

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("signIn delegates to supabase and returns data/error", async () => {
    const session = makeSession();
    mockSignInWithPassword.mockResolvedValue({ data: { session }, error: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let response: { data: unknown; error: unknown };
    await act(async () => {
      response = await result.current.signIn("test@example.com", "pw");
    });

    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "pw",
    });
    expect(response!.error).toBeNull();
  });

  it("signOut removes session-storage keys then calls supabase", async () => {
    sessionStorage.setItem("upgradeModalDismissed", "true");
    mockSignOut.mockResolvedValue({ error: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.signOut();
    });

    expect(sessionStorage.getItem("upgradeModalDismissed")).toBeNull();
    expect(mockSignOut).toHaveBeenCalledOnce();
  });

  it("signUp returns an error when supabase rejects", async () => {
    const authError = { message: "Email already registered", status: 422 };
    mockSignUp.mockResolvedValue({ data: null, error: authError });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let response: { data: unknown; error: unknown };
    await act(async () => {
      response = await result.current.signUp("taken@example.com", "pw");
    });

    expect(response!.error).toEqual(authError);
  });

  it("cleans up the onAuthStateChange subscription on unmount", async () => {
    const unsubscribe = vi.fn();
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe } },
    });

    const { unmount } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
