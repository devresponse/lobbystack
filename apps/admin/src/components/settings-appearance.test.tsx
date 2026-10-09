// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppearancePage from "../../app/(dashboard)/settings/appearance/page";
const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./appearance-provider", () => ({ useAppearancePreference: () => ({ timeFormatPreference: "24h", setTimeFormatPreference: vi.fn() }) }));
vi.mock("./replacement-locale-provider", () => ({ useLocalePreference: () => ({ locale: "en", setLocale: vi.fn(), isSaving: false }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); mocks.toast.mockReset(); });
describe("appearance workspace mutation isolation", () => {
  it.each([true, false])("keeps the new workspace unchanged when the old request succeeds=%s", async succeeds => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business-a", active: true }] });
    for (const id of ["business-a", "business-b"]) client.setQueryData(["appearance-preferences", id], { telemetryEnabled: false, canManageTenant: true });
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><AppearancePage /></QueryClientProvider>);
    await userEvent.click(screen.getByRole("switch", { name: "appearance.telemetry.label" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]).toEqual(expect.arrayContaining(["/api/preferences/appearance?businessId=business-a"]));
    await act(async () => client.setQueryData(["businesses"], { businesses: [{ businessId: "business-b", active: true }] }));
    await act(async () => resolve(Response.json(succeeds ? { telemetryEnabled: true } : { error: "Failed" }, { status: succeeds ? 200 : 500 })));
    await waitFor(() => expect(screen.getByRole("switch", { name: "appearance.telemetry.label" }).getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByRole("switch", { name: "appearance.telemetry.label" }).hasAttribute("disabled")).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(client.getQueryData(["appearance-preferences", "business-b"])).toEqual({ telemetryEnabled: false, canManageTenant: true });
  });
});
describe("business timezone", () => {
  type Preference = { telemetryEnabled: boolean; timezone: string; canManageTenant: boolean };
  // A server that keeps what the PATCH saved, so the refetch after it reads the saved zone.
  function renderWith(preference: Preference, respond: (saved: Preference, change: Partial<Preference>) => Response) {
    const saved = { ...preference };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business-a", active: true }] });
    client.setQueryData(["appearance-preferences", "business-a"], preference);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH" ? respond(saved, JSON.parse(String(init.body))) : Response.json(saved));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><AppearancePage /></QueryClientProvider>);
    return { fetchMock, select: screen.getByRole("combobox", { name: "appearance.timezone.label" }) as HTMLSelectElement };
  }

  it("lists zones worldwide by region and saves the one picked", async () => {
    const { fetchMock, select } = renderWith({ telemetryEnabled: true, timezone: "America/Toronto", canManageTenant: true }, (saved, change) => { Object.assign(saved, change); return Response.json(change); });
    expect(select.value).toBe("America/Toronto");
    expect(select.querySelector('optgroup[label="appearance.timezone.regions.europe"] option[value="Europe/Belgrade"]')).not.toBeNull();
    expect(select.querySelector('optgroup[label="appearance.timezone.regions.asia"] option[value="Asia/Tokyo"]')).not.toBeNull();
    expect(select.querySelector(':scope > option[value="UTC"]')).not.toBeNull();
    await userEvent.selectOptions(select, "Europe/Belgrade");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/preferences/appearance?businessId=business-a", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ timezone: "Europe/Belgrade" }) })));
    expect(select.value).toBe("Europe/Belgrade");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("puts the old zone back and says so when the save fails", async () => {
    const { select } = renderWith({ telemetryEnabled: true, timezone: "America/Toronto", canManageTenant: true }, () => Response.json({ error: "Failed" }, { status: 500 }));
    await userEvent.selectOptions(select, "America/Vancouver");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("appearance.timezone.saveFailed"));
    await waitFor(() => expect(select.value).toBe("America/Toronto"));
  });

  it("is read-only for members who can't manage the business", () => {
    const { select } = renderWith({ telemetryEnabled: true, timezone: "America/Toronto", canManageTenant: false }, () => Response.json({}));
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("America/Toronto");
  });
});
