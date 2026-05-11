/// <reference types="vitest/globals" />
import { renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { useBeforeUnload } from "../useBeforeUnload";

// G-M8 (Ghost): basic unit tests for the beforeunload prompt hook.
// We can't actually trigger the browser dialog inside jsdom, but we
// can verify the listener is registered when `enabled=true` and
// removed when `enabled=false` or on unmount — that's the contract
// that matters for the export-in-flight + project-create-in-flight
// flows.

describe("useBeforeUnload", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addSpy = vi.spyOn(window, "addEventListener");
    removeSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("registers a beforeunload listener when enabled=true", () => {
    renderHook(() => useBeforeUnload(true, "Work in progress"));
    const calls = addSpy.mock.calls.filter((c) => c[0] === "beforeunload");
    expect(calls.length).toBe(1);
  });

  it("does NOT register a listener when enabled=false", () => {
    renderHook(() => useBeforeUnload(false, "Work in progress"));
    const calls = addSpy.mock.calls.filter((c) => c[0] === "beforeunload");
    expect(calls.length).toBe(0);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useBeforeUnload(true, "msg"));
    expect(
      addSpy.mock.calls.filter((c) => c[0] === "beforeunload").length,
    ).toBe(1);
    unmount();
    expect(
      removeSpy.mock.calls.filter((c) => c[0] === "beforeunload").length,
    ).toBe(1);
  });

  it("removes the previous listener when enabled flips from true to false", () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBeforeUnload(enabled, "msg"),
      { initialProps: { enabled: true } },
    );
    expect(
      addSpy.mock.calls.filter((c) => c[0] === "beforeunload").length,
    ).toBe(1);
    rerender({ enabled: false });
    // The previous listener should have been removed via the cleanup
    expect(
      removeSpy.mock.calls.filter((c) => c[0] === "beforeunload").length,
    ).toBe(1);
  });

  it("listener sets returnValue when fired (signals the browser to show the prompt)", () => {
    renderHook(() => useBeforeUnload(true, "Pending work"));
    // Grab the handler that was registered
    const listenerCall = addSpy.mock.calls.find(
      (c) => c[0] === "beforeunload",
    );
    expect(listenerCall).toBeDefined();
    const handler = listenerCall![1] as EventListener;

    // Fabricate a beforeunload event and confirm returnValue gets set.
    const event = new Event("beforeunload") as BeforeUnloadEvent;
    // jsdom doesn't expose preventDefault as a no-op spy; just confirm
    // the handler runs without throwing and the returnValue is set.
    event.preventDefault = vi.fn();
    Object.defineProperty(event, "returnValue", {
      writable: true,
      value: "",
    });
    handler(event);
    expect(event.returnValue).toBe("Pending work");
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
