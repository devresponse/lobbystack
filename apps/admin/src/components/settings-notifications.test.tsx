// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveNotificationSettingsSurface } from "./live-notification-settings-surface";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en", resolvedLanguage: "en" }, t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const clients: QueryClient[] = [];
beforeEach(() => { Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null }); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(async () => {
  cleanup();
  // input-otp schedules short timers that can fire after jsdom tears down.
  await new Promise(resolve => setTimeout(resolve, 60));
  clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals();
});
type CallTranscriptState = { available: boolean; unavailableReason: "turned_off" | "owners_and_admins_only" | null; recipients: "nobody" | "owners_and_admins" | "team"; content: "summary" | "transcript"; canEdit: boolean };
function setup(reason: "phone_unverified" | "sender_missing" | null = null, widgetOnly = false, smsConsent = false, callTranscript?: CallTranscriptState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business-1", active: true }] });
  let preferences = { emailEnabled: true, smsEnabled: false, smsConsent, canUseSms: reason === null, smsUnavailableReason: reason, eventPreferences: { ...Object.fromEntries(["voiceMessage", "pausedSms", "widgetChat", "liveChatRequest", "smsFailed", "calendarSync", "transferFailed", "aiReplyFailed", "webhookDisabled"].map(key => [key, { email: true, sms: false }])), callTranscript: { email: false, sms: false } }, dailySummaryEnabled: false, dailySummarySendTime: null, ...(callTranscript ? { callTranscript } : {}) };
  client.setQueryData(["notification-preferences", "business-1"], preferences);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    // The server records consent and turns SMS on when it approves the code.
    if (url.startsWith("/api/account/phone-verification/check")) { preferences = { ...preferences, smsEnabled: true, smsConsent: true, canUseSms: true, smsUnavailableReason: null }; return Response.json({ approved: true, status: "approved" }); }
    if (url.startsWith("/api/account/phone-verification") && init?.method === "POST") return Response.json({ attemptId: "attempt-1", phoneE164: "+14165550123" }, { status: 202 });
    if (url.startsWith("/api/account/phone-verification")) return Response.json({ attempt: { id: "attempt-1", status: "sent" } });
    if (url.startsWith("/api/call-transcript-settings") && init?.method === "PUT") { preferences = { ...preferences, callTranscript: { ...preferences.callTranscript!, ...JSON.parse(String(init.body)) } }; return Response.json({ ...preferences.callTranscript, canEdit: true }); }
    if (init?.method === "PUT") { preferences = { ...preferences, ...JSON.parse(String(init.body)) }; return Response.json({ ok: true }); }
    return Response.json(preferences);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={client}><LiveNotificationSettingsSurface widgetOnly={widgetOnly} /></QueryClientProvider>);
  return fetchMock;
}
describe("original notification controls", () => {
  it("preserves the original channels and keeps widget controls in widget settings", async () => {
    setup();
    expect(await screen.findByRole("switch", { name: "notifications.sources.email.title" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "notifications.sources.sms.title" })).toBeTruthy();
    expect(screen.queryByText("notifications.events.widgetChat.title")).toBeNull();
    expect(screen.queryByText("notifications.events.liveChatRequest.title")).toBeNull();
    expect(screen.queryByText(/browser/i)).toBeNull();
  });
  it("exposes widget notification controls in the excluded widget view", async () => {
    setup(null, true);
    expect(await screen.findByText("notifications.events.widgetChat.title")).toBeTruthy();
    expect(screen.getByText("notifications.events.liveChatRequest.title")).toBeTruthy();
    expect(screen.queryByText("notifications.events.voiceMessage.title")).toBeNull();
  });
  it("disables SMS when the workspace has no alert sender", async () => {
    const fetchMock = setup("sender_missing");
    const sms = await screen.findByRole("switch", { name: "notifications.sources.sms.title" });
    expect(sms.hasAttribute("data-disabled")).toBe(true);
    await userEvent.click(sms);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("verifies an unverified phone, then turns SMS on with the consent shown at the phone step", async () => {
    const fetchMock = setup("phone_unverified");
    const sms = await screen.findByRole("switch", { name: "notifications.sources.sms.title" });
    expect(sms.hasAttribute("data-disabled")).toBe(false);
    expect(screen.getByText("notifications.sources.sms.description")).toBeTruthy();
    await userEvent.click(sms);
    expect(await screen.findByText("notifications.phoneVerification.phone.title")).toBeTruthy();
    expect(screen.getByText("notifications.phoneVerification.phone.consent")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("notifications.phoneVerification.fields.mobileNumber"), "+14165550123");
    await userEvent.click(screen.getByRole("button", { name: "notifications.phoneVerification.sendCode" }));
    expect(await screen.findByText("notifications.phoneVerification.code.title")).toBeTruthy();
    const start = fetchMock.mock.calls.find(([url, init]) => url.startsWith("/api/account/phone-verification?") && init?.method === "POST");
    expect(start?.[0]).toBe("/api/account/phone-verification?businessId=business-1");
    expect(JSON.parse(String(start?.[1]?.body))).toEqual({ phoneNumber: "+14165550123", locale: "en" });
    await userEvent.type(screen.getByRole("textbox"), "123456");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/account/phone-verification/check"))).toBe(true));
    const check = fetchMock.mock.calls.find(([url]) => url.startsWith("/api/account/phone-verification/check"));
    expect(JSON.parse(String(check?.[1]?.body))).toEqual({ attemptId: "attempt-1", code: "123456" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "notifications.sources.sms.title" }).getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url.startsWith("/api/notification-preferences") && !init?.method).length).toBeGreaterThan(0));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(screen.getByRole("switch", { name: "notifications.sources.sms.title" }).getAttribute("aria-checked")).toBe("true");
  });
  it("leaves SMS off when the operator closes the phone dialog", async () => {
    const fetchMock = setup("phone_unverified");
    await userEvent.click(await screen.findByRole("switch", { name: "notifications.sources.sms.title" }));
    await userEvent.click(await screen.findByRole("button", { name: "notifications.phoneVerification.cancel" }));
    await waitFor(() => expect(screen.queryByText("notifications.phoneVerification.phone.title")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "notifications.sources.sms.title" }).getAttribute("aria-checked")).toBe("false");
  });
  it("asks a verified operator without consent on record to confirm it, without a new code", async () => {
    const fetchMock = setup();
    await userEvent.click(await screen.findByRole("switch", { name: "notifications.sources.sms.title" }));
    expect(await screen.findByText("notifications.phoneVerification.confirm.consent")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "notifications.phoneVerification.confirm.turnOn" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/account/phone-verification"))).toBe(false);
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(mutation?.[1]?.body))).toMatchObject({ smsEnabled: true, smsConsent: true });
  });
  it("turns SMS on with no extra step when consent is already on record", async () => {
    const fetchMock = setup(null, false, true);
    await userEvent.click(await screen.findByRole("switch", { name: "notifications.sources.sms.title" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(mutation?.[1]?.body))).toMatchObject({ smsEnabled: true, smsConsent: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "notifications.sources.sms.title" }).getAttribute("aria-checked")).toBe("true"));
  });
});
describe("the email after each call", () => {
  const owner: CallTranscriptState = { available: true, unavailableReason: null, recipients: "owners_and_admins", content: "summary", canEdit: true };
  it("is off until the person turns it on, by email only", async () => {
    const fetchMock = setup(null, false, true, owner);
    const email = await screen.findByRole("checkbox", { name: "notifications.sources.email.title - notifications.events.callTranscript.summary.title" });
    expect(email.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("notifications.events.callTranscript.summary.description")).toBeTruthy();
    await userEvent.click(email);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.startsWith("/api/notification-preferences") && init?.method === "PUT")).toBe(true));
    const save = fetchMock.mock.calls.find(([url, init]) => url.startsWith("/api/notification-preferences") && init?.method === "PUT");
    expect(JSON.parse(String(save?.[1]?.body)).eventPreferences.callTranscript).toEqual({ email: true, sms: false });
  });
  it("lets an owner choose who gets it and what it holds", async () => {
    const fetchMock = setup(null, false, false, owner);
    expect(await screen.findByText("notifications.callTranscripts.title")).toBeTruthy();
    expect(screen.getByText("notifications.callTranscripts.content.summaryDescription")).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "notifications.callTranscripts.content.title" }), "transcript");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.startsWith("/api/call-transcript-settings") && init?.method === "PUT")).toBe(true));
    const change = fetchMock.mock.calls.find(([url, init]) => url.startsWith("/api/call-transcript-settings") && init?.method === "PUT");
    expect(change?.[0]).toBe("/api/call-transcript-settings?businessId=business-1");
    expect(JSON.parse(String(change?.[1]?.body))).toEqual({ content: "transcript" });
    // The row above is named again for what the email now holds.
    expect(await screen.findByText("notifications.events.callTranscript.transcript.title")).toBeTruthy();
    expect(screen.getByText("notifications.callTranscripts.content.transcriptDescription")).toBeTruthy();
  });
  it("tells someone the business leaves out why, and shows them no choices", async () => {
    setup(null, false, false, { available: false, unavailableReason: "owners_and_admins_only", recipients: "owners_and_admins", content: "summary", canEdit: false });
    const email = await screen.findByRole("checkbox", { name: "notifications.sources.email.title - notifications.events.callTranscript.summary.title" });
    expect(email.hasAttribute("disabled") || email.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByText("notifications.events.callTranscript.unavailable.owners_and_admins_only")).toBeTruthy();
    expect(screen.queryByText("notifications.callTranscripts.title")).toBeNull();
  });
  it("stays out of the website widget's notification settings", async () => {
    setup(null, true, false, owner);
    expect(await screen.findByText("notifications.events.widgetChat.title")).toBeTruthy();
    expect(screen.queryByText("notifications.events.callTranscript.summary.title")).toBeNull();
    expect(screen.queryByText("notifications.callTranscripts.title")).toBeNull();
  });
});
