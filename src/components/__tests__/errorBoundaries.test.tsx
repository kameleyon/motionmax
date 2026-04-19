import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlobalErrorBoundary } from "../GlobalErrorBoundary";
import { WorkspaceErrorBoundary } from "../workspace/WorkspaceErrorBoundary";

// Suppress console.error noise from React's error boundary machinery
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.restoreAllMocks();
});

vi.mock("@sentry/react", () => ({ captureException: vi.fn() }));

function Boom({ message = "test error" }: { message?: string }) {
  throw new Error(message);
}

describe("GlobalErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <GlobalErrorBoundary>
        <span>OK</span>
      </GlobalErrorBoundary>
    );
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("shows fallback UI when child throws", () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("test error")).toBeTruthy();
  });

  it("shows Try Again and Go Home buttons in fallback", () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>
    );
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /go home/i })).toBeTruthy();
  });

  it("calls Sentry.captureException on error", async () => {
    const { captureException } = await import("@sentry/react");
    render(
      <GlobalErrorBoundary>
        <Boom message="sentry test" />
      </GlobalErrorBoundary>
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sentry test" }),
      expect.any(Object)
    );
  });
});

describe("WorkspaceErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <WorkspaceErrorBoundary>
        <span>workspace OK</span>
      </WorkspaceErrorBoundary>
    );
    expect(screen.getByText("workspace OK")).toBeTruthy();
  });

  it("shows fallback UI when child throws", () => {
    render(
      <WorkspaceErrorBoundary>
        <Boom message="workspace fail" />
      </WorkspaceErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("workspace fail")).toBeTruthy();
  });

  it("Try Again button resets error state", () => {
    const { rerender } = render(
      <WorkspaceErrorBoundary>
        <Boom />
      </WorkspaceErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    // Swap to a non-throwing child before clicking Try Again so the boundary
    // can recover without immediately catching another error
    rerender(
      <WorkspaceErrorBoundary>
        <span>recovered</span>
      </WorkspaceErrorBoundary>
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.getByText("recovered")).toBeTruthy();
  });
});
