// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en", resolvedLanguage: "en" },
    t: (key: string, options?: Record<string, unknown>) => (options && Object.keys(options).length ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));

import { LivePublicProfileSettingsSurface, type PublicProfileSettingsResponse } from "./live-public-profile-settings-surface";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";

const clients: QueryClient[] = [];
const KEY_ONE = "0b8f5f8e-3c55-4a43-9d6a-2f4f3f1c9a01";
const KEY_TWO = "7d2e4c61-91b8-4f0e-8a3e-5b6c7d8e9f02";

function view(overrides: Partial<PublicProfileSettingsResponse> = {}, settings: Partial<PublicProfileSettingsResponse["settings"]> = {}): PublicProfileSettingsResponse {
  return {
    saved: false,
    slug: "acme-dental",
    businessName: "Acme Dental",
    publishedAt: null,
    settings: {
      published: false,
      category: null,
      description: "Family dentistry.",
      address: { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null },
      publicEmail: null,
      showPhone: true,
      showHours: true,
      showServices: true,
      showMap: true,
      widgetKeyId: KEY_ONE,
      ...settings,
    },
    widgetKeys: [
      { id: KEY_ONE, label: "Main website", lastUsedAt: "2026-10-01T12:00:00.000Z", createdAt: "2026-09-01T12:00:00.000Z" },
      { id: KEY_TWO, label: null, lastUsedAt: null, createdAt: "2026-09-02T12:00:00.000Z" },
    ],
    url: "https://app.example.com/profile/acme-dental",
    canEdit: true,
    ...overrides,
  };
}

function setup(initial: PublicProfileSettingsResponse, onSave: (body: Record<string, unknown>) => Response = (body) => Response.json({ ...initial, saved: true, publishedAt: body.published ? "2026-10-16T20:00:00.000Z" : null, settings: body })) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Acme Dental", active: true }] });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/business-profile") && init?.method === "PUT") return onSave(JSON.parse(String(init.body)));
    if (url.startsWith("/api/business-profile")) return Response.json(initial);
    return Response.json({ businesses: [{ businessId: "business", name: "Acme Dental", active: true }] });
  });
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={client}><LivePublicProfileSettingsSurface /></QueryClientProvider>);
  return fetch;
}

const saves = (fetch: ReturnType<typeof setup>) => fetch.mock.calls.filter(([, init]) => init?.method === "PUT").map(([url, init]) => ({ url, body: JSON.parse(String(init!.body)) }));

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

describe("public profile settings", () => {
  it("publishes and unpublishes the page at once with its button, saving what the owner typed with it", async () => {
    const fetch = setup(view());
    expect(await screen.findByText("publicPage.publish.labelOff")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("publicPage.details.category"), { target: { value: "Dental clinic" } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.publish.publishAction" }));

    await waitFor(() => expect(saves(fetch)).toHaveLength(1));
    // The category the owner typed goes out with it.
    expect(saves(fetch)[0]!.body).toEqual({
      published: true,
      category: "Dental clinic",
      description: "Family dentistry.",
      publicEmail: null,
      address: { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null },
      showPhone: true,
      showHours: true,
      showServices: true,
      showMap: true,
      widgetKeyId: KEY_ONE,
    });
    expect(await screen.findByRole("button", { name: "publicPage.publish.unpublishAction" })).toBeTruthy();
    expect(screen.getByText("publicPage.publish.label")).toBeTruthy();
    expect(screen.getByRole("link", { name: "publicPage.publish.open" })).toBeTruthy();
    expect((screen.getByLabelText("publicPage.details.category") as HTMLInputElement).value).toBe("Dental clinic");
    // Nothing is left to save.
    expect((screen.getByRole("button", { name: "publicPage.save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "publicPage.publish.unpublishAction" }));
    await waitFor(() => expect(saves(fetch)).toHaveLength(2));
    expect(saves(fetch)[1]!.body).toMatchObject({ published: false, category: "Dental clinic" });
    expect(await screen.findByRole("button", { name: "publicPage.publish.publishAction" })).toBeTruthy();
    expect(screen.getByText("publicPage.publish.labelOff")).toBeTruthy();
  });

  it("doesn't publish while an edit is invalid, and says which", async () => {
    const fetch = setup(view());
    expect(await screen.findByText("publicPage.publish.labelOff")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("publicPage.details.email"), { target: { value: "not an email" } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.publish.publishAction" }));
    expect((await screen.findByRole("alert")).textContent).toBe("publicPage.errors.email");
    expect(saves(fetch)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "publicPage.publish.publishAction" })).toBeTruthy();
  });

  it("saves the details the owner typed", async () => {
    const fetch = setup(view());
    expect(await screen.findByText("https://app.example.com/profile/acme-dental")).toBeTruthy();
    expect(screen.getByRole("link", { name: "publicPage.publish.preview" }).getAttribute("href")).toBe("https://app.example.com/profile/acme-dental");
    expect((screen.getByRole("button", { name: "publicPage.save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("publicPage.details.category"), { target: { value: "Dental clinic" } });
    fireEvent.change(screen.getByLabelText("publicPage.details.line1"), { target: { value: "123 Main St" } });
    fireEvent.change(screen.getByLabelText("publicPage.details.city"), { target: { value: "Toronto" } });
    fireEvent.change(screen.getByLabelText("publicPage.details.country"), { target: { value: "CA" } });
    fireEvent.click(screen.getByRole("switch", { name: "publicPage.sections.map" }));
    fireEvent.change(screen.getByLabelText("publicPage.chat.widget"), { target: { value: KEY_TWO } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.save" }));

    await waitFor(() => expect(saves(fetch)).toHaveLength(1));
    expect(saves(fetch)[0]).toEqual({
      url: "/api/business-profile?businessId=business",
      body: {
        published: false,
        category: "Dental clinic",
        description: "Family dentistry.",
        publicEmail: null,
        address: { line1: "123 Main St", line2: null, city: "Toronto", region: null, postalCode: null, countryCode: "CA" },
        showPhone: true,
        showHours: true,
        showServices: true,
        showMap: false,
        widgetKeyId: KEY_TWO,
      },
    });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("link", { name: "publicPage.publish.preview" })).toBeTruthy();
  });

  it("checks the email before saving", async () => {
    const fetch = setup(view());
    fireEvent.change(await screen.findByLabelText("publicPage.details.email"), { target: { value: "not an email" } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("publicPage.errors.email");
    expect(saves(fetch)).toHaveLength(0);
  });

  it("marks a field whose text hides or reorders what's around it, and keeps emoji", async () => {
    const fetch = setup(view());
    const city = await screen.findByLabelText("publicPage.details.city");
    fireEvent.change(city, { target: { value: "Toronto\u202E" } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("publicPage.errors.plainText");
    expect(city.getAttribute("aria-invalid")).toBe("true");
    expect(saves(fetch)).toHaveLength(0);

    fireEvent.change(city, { target: { value: "Toronto" } });
    expect(city.getAttribute("aria-invalid")).toBeNull();
    // A soft hyphen pasted along is dropped; the joiners inside emoji stay.
    fireEvent.change(screen.getByLabelText("publicPage.details.about"), { target: { value: "Family den\u00ADtistry \u{1F469}\u200D\u2695\uFE0F \u{1F3F3}\uFE0F\u200D\u{1F308}" } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.save" }));
    await waitFor(() => expect(saves(fetch)).toHaveLength(1));
    expect(saves(fetch)[0]!.body).toMatchObject({ description: "Family dentistry \u{1F469}\u200D\u2695\uFE0F \u{1F3F3}\uFE0F\u200D\u{1F308}", address: expect.objectContaining({ city: "Toronto" }) });
  });

  it("says when the chosen widget can't be used any more", async () => {
    setup(view(), () => Response.json({ error: "Choose one of this business's active website widgets.", code: "widget_key_unavailable" }, { status: 400 }));
    fireEvent.change(await screen.findByLabelText("publicPage.details.category"), { target: { value: "Dental clinic" } });
    fireEvent.click(screen.getByRole("button", { name: "publicPage.save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("publicPage.errors.widgetUnavailable");
  });

  it("starts without a widget that was paused, and says so", async () => {
    setup(view({ saved: true }, { widgetKeyId: "6c1f6a52-6c3e-4f8e-9c55-0d3c1a4e9b10" }));
    expect(await screen.findByText("publicPage.chat.unavailable")).toBeTruthy();
    expect((screen.getByLabelText("publicPage.chat.widget") as HTMLSelectElement).value).toBe("");
  });

  it("points to the widget settings when there's no widget", async () => {
    setup(view({ widgetKeys: [] }, { widgetKeyId: null }));
    expect(await screen.findByText("publicPage.chat.empty")).toBeTruthy();
    expect(screen.getByRole("link", { name: "publicPage.chat.manage" }).getAttribute("href")).toBe("/settings/widget");
    expect(screen.queryByLabelText("publicPage.chat.widget")).toBeNull();
  });

  it("shows schedulers and viewers the settings without letting them change them", async () => {
    setup(view({ canEdit: false }));
    expect(await screen.findByText("publicPage.readOnly")).toBeTruthy();
    expect((screen.getByLabelText("publicPage.details.category") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "publicPage.publish.publishAction" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "publicPage.save" })).toBeNull();
  });

  it("shows the receptionists on the page apart from the form, once the business has several", async () => {
    const receptionist = (id: string, name: string, isDefault = false): ReceptionistOption => ({ id, name, description: "", handle: isDefault ? null : name.toLowerCase(), isDefault, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: isDefault ? "all" : "audience" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Acme Dental", active: true }] });
    client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists: [receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", true), receptionist("00000000-0000-4000-8000-0000000000a2", "Hygiene")] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(view())));
    render(<QueryClientProvider client={client}><LivePublicProfileSettingsSurface /></QueryClientProvider>);
    const title = await screen.findByText("pageList.title");
    // Outside the form, so its changes never wait for the form's Save.
    expect(title.closest("form")).toBeNull();
    // Listed in the box and on the page's list.
    expect(screen.getAllByText("Hygiene").length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "pageList.onPage" }).textContent).toContain("Hygiene");
  });

  it("leaves the receptionists out while the business has one", async () => {
    setup(view());
    await screen.findByText("publicPage.save");
    expect(screen.queryByText("pageList.title")).toBeNull();
  });
});
