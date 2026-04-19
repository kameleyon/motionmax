/// <reference types="vitest/globals" />
import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

// ── mock hooks before importing components that use them ──────────────────────
vi.mock("@/hooks/useAuth", () => ({
  useAuth: vi.fn(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useAdminAuth", () => ({
  useAdminAuth: vi.fn(),
}));

import { useAuth } from "@/hooks/useAuth";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { ProtectedRoute } from "../ProtectedRoute";
import { AdminRoute } from "../AdminRoute";

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;
const mockUseAdminAuth = useAdminAuth as ReturnType<typeof vi.fn>;

// Helper — renders a route tree around the guard component
function renderProtected(child = <div data-testid="content">protected</div>) {
  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<ProtectedRoute>{child}</ProtectedRoute>} />
        <Route path="/auth" element={<div data-testid="auth-page">auth</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderAdmin(child = <div data-testid="content">admin</div>) {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminRoute>{child}</AdminRoute>} />
        <Route path="/auth" element={<div data-testid="auth-page">auth</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// ── ProtectedRoute ────────────────────────────────────────────────────────────

describe("ProtectedRoute", () => {
  it("shows spinner while auth is loading", () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, loading: true });
    renderProtected();
    // Loader renders an svg/icon rather than text; assert the protected content is NOT shown
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.queryByTestId("auth-page")).toBeNull();
  });

  it("redirects unauthenticated users to /auth with returnUrl", () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, loading: false });
    renderProtected();
    expect(screen.getByTestId("auth-page")).toBeDefined();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("renders children for authenticated users", () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, loading: false });
    renderProtected();
    expect(screen.getByTestId("content")).toBeDefined();
  });
});

// ── AdminRoute ────────────────────────────────────────────────────────────────

describe("AdminRoute", () => {
  it("shows spinner while admin check is loading", () => {
    mockUseAdminAuth.mockReturnValue({ isAdmin: false, loading: true, user: null });
    renderAdmin();
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.queryByTestId("auth-page")).toBeNull();
  });

  it("redirects unauthenticated visitors to /auth", () => {
    mockUseAdminAuth.mockReturnValue({ isAdmin: false, loading: false, user: null });
    renderAdmin();
    expect(screen.getByTestId("auth-page")).toBeDefined();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("shows Access Denied for authenticated non-admin users", () => {
    mockUseAdminAuth.mockReturnValue({
      isAdmin: false,
      loading: false,
      user: { id: "user-1" },
    });
    renderAdmin();
    expect(screen.getByText("Access Denied")).toBeDefined();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("renders children for admin users", () => {
    mockUseAdminAuth.mockReturnValue({
      isAdmin: true,
      loading: false,
      user: { id: "admin-1" },
    });
    renderAdmin();
    expect(screen.getByTestId("content")).toBeDefined();
  });
});
