// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInBillingPlanLimits } from "@lobbystack/shared";
import { LiveUsageSurface } from "./live-usage-surface";

const language = vi.hoisted(() => ({ value: "en" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: language.value }, t: (key: string, options?: Record<string, unknown>) => key === "billing.usage.description" || key === "billing.usage.topUpLeft" ? `${key} ${JSON.stringify(options)}` : key }) }));
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
  const allowance = (total: number, used: number) => ({ total, used, left: Math.max(0, total - used) });
  function setupPack(pack: { secondsTotal: number; secondsUsed: number; secondsLeft: number }, allowances = { alertSmsSegments: allowance(300, 12), outboundCallAttempts: allowance(120, 3), chatAiUnits: allowance(300, 40) }) {
    language.value = "en";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
    client.setQueryData(["billing", "business"], {
      effectivePlan: "prepaid",
      limits: builtInBillingPlanLimits.prepaid,
      account: null,
      usageStatus: { voiceSecondsUsed: 90, outboundCallAttemptsUsed: 1, alertSmsSegmentsUsed: 0, voiceBlocked: pack.secondsLeft <= 0, pack: { ...pack, ...allowances, nextEndsAt: "2027-01-30T00:00:00.000Z", lastEndsAt: "2027-03-30T00:00:00.000Z" } },
      knowledgeStorageBytesUsed: 0,
    });
    render(<QueryClientProvider client={client}><LiveUsageSurface /></QueryClientProvider>);
  }

  it("meters voice, transfers and texts against what the live packs hold for their whole length, with no monthly reset", () => {
    setupPack({ secondsTotal: 60_000, secondsUsed: 15_030, secondsLeft: 44_970 });
    expect(screen.getByText((text) => text.startsWith("250.5 /") && text.includes("1,000"))).toBeTruthy();
    // The packs' transfers and texts, not the month's.
    expect(screen.getByText((text) => text.startsWith("3 /") && text.includes("120"))).toBeTruthy();
    expect(screen.getByText((text) => text.startsWith("12 /") && text.includes("300"))).toBeTruthy();
    expect(screen.queryByText((text) => text.startsWith("billing.usage.customAllowance"))).toBeNull();
    expect(screen.getByText("billing.usage.packDescription")).toBeTruthy();
    expect(screen.queryByText((text) => text.startsWith("billing.usage.description"))).toBeNull();
    expect(screen.queryByText("billing.usage.packBlockedDescription")).toBeNull();
    expect(screen.queryByText("billing.usage.packAllowanceBlockedDescription")).toBeNull();
  });

  it("says calls get a busy signal once the packs have no minutes left", () => {
    setupPack({ secondsTotal: 30_000, secondsUsed: 30_000, secondsLeft: 0 });
    expect(screen.getByText("billing.usage.packBlockedDescription")).toBeTruthy();
    expect(screen.queryByText("billing.usage.blockedDescription")).toBeNull();
  });

  it("says what stops once the packs have no texts or transfers left, rather than until next month", () => {
    setupPack({ secondsTotal: 30_000, secondsUsed: 100, secondsLeft: 29_900 }, { alertSmsSegments: allowance(300, 300), outboundCallAttempts: allowance(120, 120), chatAiUnits: allowance(300, 0) });
    expect(screen.getAllByText("billing.usage.packAllowanceBlockedDescription")).toHaveLength(2);
    expect(screen.queryByText("billing.usage.blockedDescription")).toBeNull();
  });
});

describe("top-ups on the usage page", () => {
  const allowance = (total: number, used: number) => ({ total, used, left: Math.max(0, total - used) });
  const topUp = { voiceSeconds: allowance(3_600, 900), alertSmsSegments: allowance(0, 0), outboundCallAttempts: allowance(10, 0), chatAiUnits: allowance(0, 0), nextEndsAt: "2026-12-31T00:00:00.000Z", lastEndsAt: "2026-12-31T00:00:00.000Z" };
  function setupTopUp(plan: "free_cloud" | "prepaid" | "enterprise", usageStatus: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    language.value = "en";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
    client.setQueryData(["billing", "business"], { effectivePlan: plan, limits: builtInBillingPlanLimits[plan], account: null, usageStatus: { voiceSecondsUsed: 600, outboundCallAttemptsUsed: 0, alertSmsSegmentsUsed: 0, voiceBlocked: false, ...usageStatus }, knowledgeStorageBytesUsed: 0, ...extra });
    render(<QueryClientProvider client={client}><LiveUsageSurface /></QueryClientProvider>);
  }
  const topUpLines = () => screen.queryAllByText((text) => text.startsWith("billing.usage.topUpLeft"));

  it("says under each meter what the top-ups have left on top of the plan, only for what they give", () => {
    setupTopUp("free_cloud", { topUp });
    expect(screen.getByText('billing.usage.topUpLeft {"left":"45","total":"60","unit":"billing.usage.units.voice"}')).toBeTruthy();
    expect(screen.getByText('billing.usage.topUpLeft {"left":"10","total":"10","unit":"billing.usage.units.outboundAttempts"}')).toBeTruthy();
    // They give no texts, so the texts' meter says nothing about them.
    expect(topUpLines()).toHaveLength(2);
  });

  it("keeps a pack's calls going while a top-up still has minutes, and says they stop once neither has any", () => {
    const pack = { secondsTotal: 30_000, secondsUsed: 30_000, secondsLeft: 0, alertSmsSegments: allowance(300, 0), outboundCallAttempts: allowance(120, 0), chatAiUnits: allowance(300, 0), nextEndsAt: "2027-01-30T00:00:00.000Z", lastEndsAt: "2027-01-30T00:00:00.000Z" };
    setupTopUp("prepaid", { pack, topUp });
    expect(screen.queryByText("billing.usage.packBlockedDescription")).toBeNull();
    cleanup();
    setupTopUp("prepaid", { pack, topUp: { ...topUp, voiceSeconds: allowance(3_600, 3_600) } });
    expect(screen.getByText("billing.usage.packBlockedDescription")).toBeTruthy();
  });

  it("says nothing about top-ups on Enterprise, where nothing draws on them", () => {
    setupTopUp("enterprise", { topUp });
    expect(topUpLines()).toHaveLength(0);
  });

  it("links to Settings > Plan's top-ups when the business may buy one now, and not otherwise", () => {
    const offer = { code: "topup_100_90", names: { en: "100 extra minutes" }, gives: { voiceSeconds: 6_000, alertSmsSegments: 0, outboundCallAttempts: 0, chatAiUnits: 0 }, days: 90, amountCents: 2_500, currency: "cad", checkoutAvailable: true };
    setupTopUp("free_cloud", {}, { topUpOffers: [offer] });
    // A link drawn as a button.
    expect(screen.getByText("billing.usage.buyTopUp").closest("a")?.getAttribute("href")).toBe("/settings/plan#top-ups");
    cleanup();
    setupTopUp("free_cloud", {}, { topUpOffers: [{ ...offer, checkoutAvailable: false }] });
    expect(screen.queryByText("billing.usage.buyTopUp")).toBeNull();
    cleanup();
    setupTopUp("free_cloud", {});
    expect(screen.queryByText("billing.usage.buyTopUp")).toBeNull();
  });
});
