// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInBillingPlanLimits } from "@lobbystack/shared";
import { LiveUsageSurface } from "./live-usage-surface";

const language = vi.hoisted(() => ({ value: "en" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: language.value }, t: (key: string, options?: Record<string, unknown>) => key === "billing.usage.description" ? `${key} ${JSON.stringify(options)}` : key }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; });
function setup(locale: string, blocked = false) {
  language.value = locale;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
  client.setQueryData(["billing", "business"], {
    effectivePlan: "pro",
    limits: { ...builtInBillingPlanLimits.pro, outboundCallAttemptsIncluded: 120 },
    account: { plan: "pro", currentPeriodEnd: "2026-10-01T12:00:00Z" },
    usageStatus: { voiceSecondsUsed: 750, outboundCallAttemptsUsed: 4, alertSmsSegmentsUsed: 2, voiceBlocked: blocked },
    knowledgeStorageBytesUsed: 1024 * 1024,
  });
  render(<QueryClientProvider client={client}><LiveUsageSurface /></QueryClientProvider>);
}
describe("original dedicated billing usage page", () => {
  it.each([["en", "12.5"], ["fr", "12,5"]])("formats voice minutes in %s and preserves the four non-AI usage meters", (locale, minutes) => {
    setup(locale!);
    for (const name of ["voiceTitle", "outboundAttemptsTitle", "alertSmsTitle", "knowledgeTitle"]) expect(screen.getByText(`billing.usage.${name}`)).toBeTruthy();
    expect(screen.getByText(text => text.startsWith(`${minutes} /`))).toBeTruthy();
    expect(screen.queryByText("billing.usage.paygTitle")).toBeNull();
    expect(screen.queryByText("billing.currentPlan.title")).toBeNull();
  });
  it("shows the allowances the server sends, which follow the billing catalog", () => {
    setup("en");
    expect(screen.getByText(text => text.startsWith("4 /") && text.includes("120"))).toBeTruthy();
  });
  it("says allowances reset on the first of the next UTC month, not on the renewal", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-31T23:30:00Z") });
    try {
      setup("en");
      expect(screen.getByText('billing.usage.description {"resetAt":"November 1"}')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
  it("explains a blocked voice allowance alongside its meter", () => {
    setup("en", true);
    expect(screen.getByText("billing.usage.blockedDescription")).toBeTruthy();
  });
});

describe("the usage page on prepaid packs", () => {
  function setupPack(pack: { secondsTotal: number; secondsUsed: number; secondsLeft: number }) {
    language.value = "en";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
    client.setQueryData(["billing", "business"], {
      effectivePlan: "prepaid",
      limits: builtInBillingPlanLimits.prepaid,
      account: null,
      usageStatus: { voiceSecondsUsed: 90, outboundCallAttemptsUsed: 1, alertSmsSegmentsUsed: 0, voiceBlocked: pack.secondsLeft <= 0, pack: { ...pack, nextEndsAt: "2027-01-30T00:00:00.000Z", lastEndsAt: "2027-03-30T00:00:00.000Z" } },
      knowledgeStorageBytesUsed: 0,
    });
    render(<QueryClientProvider client={client}><LiveUsageSurface /></QueryClientProvider>);
  }

  it("meters voice against the minutes the live packs hold, with no monthly reset", () => {
    setupPack({ secondsTotal: 60_000, secondsUsed: 15_030, secondsLeft: 44_970 });
    expect(screen.getByText((text) => text.startsWith("250.5 /") && text.includes("1,000"))).toBeTruthy();
    expect(screen.queryByText("billing.usage.customAllowance")).toBeNull();
    expect(screen.getByText("billing.usage.packDescription")).toBeTruthy();
    expect(screen.queryByText((text) => text.startsWith("billing.usage.description"))).toBeNull();
    expect(screen.queryByText("billing.usage.packBlockedDescription")).toBeNull();
  });

  it("says calls get a busy signal once the packs have no minutes left", () => {
    setupPack({ secondsTotal: 30_000, secondsUsed: 30_000, secondsLeft: 0 });
    expect(screen.getByText("billing.usage.packBlockedDescription")).toBeTruthy();
    expect(screen.queryByText("billing.usage.blockedDescription")).toBeNull();
  });
});
