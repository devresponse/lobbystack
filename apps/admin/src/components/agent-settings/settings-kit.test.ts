// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFlashStatus, useSavedDraft } from "./settings-kit";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useFlashStatus", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("clears a status 3 seconds after it shows", () => {
    const { result } = renderHook(() => useFlashStatus<string>());
    act(() => result.current[1]("Saved"));
    act(() => vi.advanceTimersByTime(2999));
    expect(result.current[0]).toBe("Saved");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeNull();
  });

  it("gives a new status its own 3 seconds", () => {
    const { result } = renderHook(() => useFlashStatus<{ text: string }>());
    act(() => result.current[1]({ text: "Enter a full number." }));
    act(() => vi.advanceTimersByTime(2000));
    act(() => result.current[1]({ text: "Saved" }));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current[0]).toEqual({ text: "Saved" });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current[0]).toBeNull();
  });
});

describe("useSavedDraft", () => {
  it("starts empty until the settings load, then takes the saved value", () => {
    const { result, rerender } = renderHook(({ saved }: { saved: string | undefined }) => useSavedDraft(saved), { initialProps: { saved: undefined as string | undefined } });
    expect(result.current[0]).toBe("");
    rerender({ saved: "Thanks for calling." });
    expect(result.current[0]).toBe("Thanks for calling.");
  });

  it("follows the saved value while untouched, and keeps an edit when another value is saved", () => {
    const { result, rerender } = renderHook(({ saved }: { saved: string | undefined }) => useSavedDraft(saved), { initialProps: { saved: "Thanks for calling." as string | undefined } });
    rerender({ saved: "Hello, Kitsilano clinic." });
    expect(result.current[0]).toBe("Hello, Kitsilano clinic.");

    act(() => result.current[1]("Hello, Kitsilano clinic. Ask away."));
    // A refetch brings a value saved elsewhere meanwhile; the edit stays.
    rerender({ saved: "Hi there." });
    expect(result.current[0]).toBe("Hello, Kitsilano clinic. Ask away.");
    // The settings reloading changes nothing either.
    rerender({ saved: undefined });
    expect(result.current[0]).toBe("Hello, Kitsilano clinic. Ask away.");
  });

  it("takes the saved value again once the field holds the last saved one", () => {
    const { result, rerender } = renderHook(({ saved }: { saved: string | undefined }) => useSavedDraft(saved), { initialProps: { saved: "Thanks for calling." as string | undefined } });
    act(() => result.current[1]("Thanks for calling!"));
    act(() => result.current[1]("Thanks for calling."));
    rerender({ saved: "Hi there." });
    expect(result.current[0]).toBe("Hi there.");
  });
});
