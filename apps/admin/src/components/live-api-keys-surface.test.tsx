// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveApiKeysSurface } from "./live-api-keys-surface";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", resolvedLanguage: "en" } }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/api-keys", useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => ({ replace: navigation.replace }) }));

const BUSINESS_ID = "75795511-9ee2-4cb2-a89d-f173ec1dd82d";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); navigation.search = ""; navigation.replace.mockReset(); });

const ZAPIER_SCOPES = ["business:read", "calls:read", "contacts:read", "contacts:write", "appointments:read", "appointments:write", "messages:read", "knowledge:write", "webhooks:manage"];
// Make's triggers subscribe to message.taken, which needs messages:read, though no module reads messages.
const MAKE_SCOPES = ZAPIER_SCOPES;

const postedBody = (fetchMock: ReturnType<typeof setup>) => JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));

function setup(role: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: BUSINESS_ID, name: "Salon", active: true, role }] });
  let keys: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; scopes: string[] };
      const apiKey = { id: "k1", name: body.name, prefix: "lsk_1a2b3c4d", scopes: body.scopes, createdAt: "2026-09-27T12:00:00.000Z", createdBy: null, lastUsedAt: null, revokedAt: null };
      keys = [apiKey];
      return Response.json({ key: "lsk_1a2b3c4d_secretsecretsecretsecretsecret12", apiKey }, { status: 201 });
    }
    if (url.startsWith("/api/api-keys")) return Response.json({ keys });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={client}><LiveApiKeysSurface /></QueryClientProvider>);
  return fetchMock;
}

describe("API keys settings", () => {
  it("tells viewers that only owners and admins manage keys", async () => {
    const fetchMock = setup("viewer");
    expect(await screen.findByText("apiKeys.restricted.title")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/api/api-keys"), expect.anything());
    expect(screen.queryByTestId("business-id")).toBeNull();
  });

  it("shows the business's id with a button that copies it", async () => {
    const user = userEvent.setup();
    setup("business_owner");
    expect((await screen.findByTestId("business-id")).textContent).toBe(BUSINESS_ID);
    expect(screen.getByText("apiKeys.businessId.description")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "apiKeys.businessId.copy" }));
    expect(await navigator.clipboard.readText()).toBe(BUSINESS_ID);
    expect(await screen.findByRole("button", { name: "apiKeys.businessId.copied" })).toBeTruthy();
  });

  it("creates a key with the chosen scopes and shows it once", async () => {
    const user = userEvent.setup();
    const fetchMock = setup("business_owner");
    expect(await screen.findByText("apiKeys.empty")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /apiKeys.create.action/ }));
    await user.type(screen.getByLabelText("apiKeys.create.nameLabel"), "Zapier");
    await user.click(screen.getByRole("button", { name: "apiKeys.create.submit" }));
    expect((await screen.findByTestId("secret-value")).textContent).toBe("lsk_1a2b3c4d_secretsecretsecretsecretsecret12");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: "Zapier", scopes: ["calls:read", "contacts:read", "appointments:read", "messages:read", "business:read"] });
    await user.click(screen.getByRole("button", { name: "apiKeys.created.done" }));
    await waitFor(() => expect(screen.queryByTestId("secret-value")).toBeNull());
    expect(await screen.findByText("lsk_1a2b3c4d…")).toBeTruthy();
  });

  it("sets a key up for Zapier, with the access every Zapier step needs, including webhooks", async () => {
    const user = userEvent.setup();
    const fetchMock = setup("business_owner");
    await user.click(await screen.findByRole("button", { name: /apiKeys.create.action/ }));
    await user.click(screen.getByRole("button", { name: /apiKeys.create.zapier$/ }));
    expect((screen.getByLabelText("apiKeys.create.nameLabel") as HTMLInputElement).value).toBe("Zapier");
    expect(screen.getByText("apiKeys.create.zapierHint")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "apiKeys.create.submit" }));
    await screen.findByTestId("secret-value");
    expect(postedBody(fetchMock)).toEqual({ name: "Zapier", scopes: ZAPIER_SCOPES });
  });

  it("keeps a name already typed when the key is set up for Zapier", async () => {
    const user = userEvent.setup();
    const fetchMock = setup("business_owner");
    await user.click(await screen.findByRole("button", { name: /apiKeys.create.action/ }));
    await user.type(screen.getByLabelText("apiKeys.create.nameLabel"), "Zapier (front desk)");
    await user.click(screen.getByRole("button", { name: /apiKeys.create.zapier$/ }));
    await user.click(screen.getByRole("button", { name: "apiKeys.create.submit" }));
    await screen.findByTestId("secret-value");
    expect(postedBody(fetchMock)).toEqual({ name: "Zapier (front desk)", scopes: ZAPIER_SCOPES });
  });

  it("opens the dialog set up for Zapier from the Integrations page's link and consumes the setup parameter", async () => {
    navigation.search = "setup=zapier";
    setup("business_owner");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("apiKeys.create.nameLabel") as HTMLInputElement).value).toBe("Zapier");
    expect(screen.getByRole("checkbox", { name: /webhooks:manage/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /business:write/ }).getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/settings/api-keys", { scroll: false }));
  });

  it("ignores the Zapier link for a member who can't manage keys", async () => {
    navigation.search = "setup=zapier";
    setup("viewer");
    expect(await screen.findByText("apiKeys.restricted.title")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("sets a key up for Make, with the access every Make module and trigger needs", async () => {
    const user = userEvent.setup();
    const fetchMock = setup("business_owner");
    await user.click(await screen.findByRole("button", { name: /apiKeys.create.action/ }));
    await user.click(screen.getByRole("button", { name: /apiKeys.create.make$/ }));
    expect((screen.getByLabelText("apiKeys.create.nameLabel") as HTMLInputElement).value).toBe("Make");
    expect(screen.getByText("apiKeys.create.makeHint")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "apiKeys.create.submit" }));
    await screen.findByTestId("secret-value");
    expect(postedBody(fetchMock)).toEqual({ name: "Make", scopes: MAKE_SCOPES });
  });

  it("opens the dialog set up for Make from the Integrations page's link", async () => {
    navigation.search = "setup=make";
    setup("business_owner");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("apiKeys.create.nameLabel") as HTMLInputElement).value).toBe("Make");
    expect(screen.getByRole("checkbox", { name: /messages:read/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /webhooks:manage/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /business:write/ }).getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/settings/api-keys", { scroll: false }));
  });

  it("leaves the dialog closed for a setup link it doesn't know", async () => {
    navigation.search = "setup=n8n";
    setup("business_owner");
    expect(await screen.findByText("apiKeys.title")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
