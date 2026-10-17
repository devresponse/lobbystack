// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton, ShareButton } from "./profile-buttons";

const URL = "https://app.example.com/profile/acme-dental";

function stubNavigator(values: { share?: unknown; clipboard?: unknown }) {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(navigator, name, { value, configurable: true, writable: true });
  }
}

afterEach(() => {
  cleanup();
  stubNavigator({ share: undefined, clipboard: undefined });
});

describe("ShareButton", () => {
  it("opens the device's share sheet with the page", async () => {
    const share = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ share, clipboard: { writeText } });
    render(<ShareButton url={URL} title="Acme Dental" label="Share" copiedLabel="Link copied" />);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(share).toHaveBeenCalledWith({ title: "Acme Dental", url: URL });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the link where there's no share sheet, and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ clipboard: { writeText } });
    render(<ShareButton url={URL} title="Acme Dental" label="Share" copiedLabel="Link copied" />);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(writeText).toHaveBeenCalledWith(URL);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Link copied"));
  });

  it("does nothing more when the visitor closes the share sheet", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ share: vi.fn(async () => { throw new DOMException("Share canceled", "AbortError"); }), clipboard: { writeText } });
    render(<ShareButton url={URL} title="Acme Dental" label="Share" copiedLabel="Link copied" />);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("CopyButton", () => {
  it("copies the text and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ clipboard: { writeText } });
    render(<CopyButton text={"123 Main St\nToronto"} label="Copy address" copiedLabel="Address copied" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith("123 Main St\nToronto");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Address copied"));
  });

  it("falls back to a selection when the clipboard refuses", async () => {
    stubNavigator({ clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<CopyButton text="123 Main St" label="Copy address" copiedLabel="Address copied" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Address copied"));
    // The temporary field is gone.
    expect(document.querySelector("textarea")).toBeNull();
  });
});
