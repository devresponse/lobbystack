// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { billingIntervals, billingProfileSchema, brandBillingPlans, brandPlanDisplay, perMonthCents, resolveBillingPacks, resolveBillingPlans, type BillingDisplay, type BillingPlanList, type BrandBillingPlan, type CloudBillingPlanSlug } from "@lobbystack/shared";

import { createI18nInstance } from "@/i18n";
import { formatMoney } from "@/lib/billing-plans";
import { localeResources } from "@/lib/i18n-resources";
import type { SupportedLocale } from "@/lib/locale";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";
import exampleFile from "../../../../packages/shared/src/brands/testing/plans-and-packs.billing.json";
import realInfoBotFile from "../../../../brands/realinfobot/billing.json";
import { OnboardingPlanSurface } from "./onboarding-plan-surface";
import { UpgradePlanDialog } from "./upgrade-plan-dialog";

type DialogProps = ComponentProps<typeof UpgradePlanDialog>;

// The plan screens with billing.json's display section, in the real words of each language.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
const telemetryRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createRecordedBrowserTelemetry> | null }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => telemetryRef.current!.telemetry }));

const locales = ["en", "fr", "es", "sr"] as const satisfies readonly SupportedLocale[];
type Bundle = Record<string, any>;

beforeEach(() => {
  telemetryRef.current = createRecordedBrowserTelemetry();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { throw new Error(`Unexpected request ${url}`); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Plan rows as GET /api/billing lists them before an apply. */
function planList(rows: readonly BrandBillingPlan[]): BillingPlanList {
  return {
    currency: rows.flatMap((row) => row.prices)[0]?.currency ?? "usd",
    source: "built_in",
    plans: rows.map((row) => ({
      slug: row.code as CloudBillingPlanSlug,
      custom: row.custom,
      overagesBillable: row.overage,
      included: { voiceSeconds: row.voice_sec, alertSmsSegments: row.sms_seg, outboundCallAttempts: row.calls_out, chatAiUnits: row.chat_units, knowledgeStorageBytes: row.kb_bytes, businessNumbers: row.numbers, receptionists: row.receptionists },
      overageRates: { voiceMinuteCents: row.voice_rate, alertSmsSegmentCents: row.sms_rate, outboundCallAttemptCents: row.call_rate },
      sortOrder: row.sort,
      prices: billingIntervals.flatMap((interval) => row.prices.filter((price) => price.period === interval).map((price) => ({ interval, currency: price.currency, amountCents: price.cents, monthlyAmountCents: perMonthCents(interval, price.cents), checkoutAvailable: false }))),
    })),
  };
}

/** A brand's plans as GET /api/billing lists them before an apply: the ones its build carries. */
const brandPlanList = (brand: string): BillingPlanList => planList(brandBillingPlans(brand)!);

// The example file of plans and packs: RealInfoBot's file before it moved to listing packs on 2026-11-10,
// with Starter and Pro sold and a display section that copies the built-in words.
const example = billingProfileSchema.parse(exampleFile);
const examplePlans = (): BillingPlanList => planList(resolveBillingPlans(example).flatMap((plan) => (plan.code === plan.tier ? [{ ...plan, code: plan.tier }] : [])));
const exampleDisplay: BillingDisplay | null = example.display ?? null;

function i18nFor(locale: SupportedLocale) {
  const resources = localeResources[locale] as Record<string, Bundle>;
  return createI18nInstance({ locale, resources: { common: resources.common!, onboarding: resources.onboarding!, settings: resources.settings! } });
}

const onboardingWords = (locale: SupportedLocale) => (localeResources[locale] as Record<string, Bundle>).onboarding!.plan;

/** The onboarding plan step for a business on Free, with nothing to buy yet. */
function renderPlanStep(locale: SupportedLocale, billing: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
  client.setQueryData(["billing", "business"], { checkoutAvailable: false, effectivePlan: "free_cloud", availableCheckoutPlans: [], availableCheckoutIntervals: { starter: [], pro: [] }, ...billing });
  return render(<I18nextProvider i18n={i18nFor(locale)}><QueryClientProvider client={client}><OnboardingPlanSurface /></QueryClientProvider></I18nextProvider>);
}

function renderDialog(locale: SupportedLocale, plans: BillingPlanList, display: BillingDisplay | null, extra: Partial<DialogProps> = {}) {
  const i18n = i18nFor(locale);
  return render(<I18nextProvider i18n={i18n}><UpgradePlanDialog availableCheckoutIntervals={{ starter: [], pro: [] }} availableCheckoutPlans={[]} billingInterval={null} currentPlan="free_cloud" display={display} loading={null} loadingPlan={null} locale={locale} onBillingIntervalChange={vi.fn()} onContactEnterprise={vi.fn()} onOpenChange={vi.fn()} onStartCheckout={vi.fn()} open plans={plans} t={i18n.getFixedT(locale, "settings")} {...extra} /></I18nextProvider>);
}

/** Each card's name and bullets, in order. */
function cardBullets(root: HTMLElement): Array<[string, string[]]> {
  return within(root).getAllByRole("list").map((list) => [list.closest("section")!.querySelector("h3")!.textContent!, within(list).getAllByRole("listitem").map((item) => item.textContent!)]);
}

describe.each(locales)("a section that copies the built-in words, in %s", (locale) => {
  const plans = examplePlans();
  const display = exampleDisplay;

  it("shows the onboarding plan step word for word as the built-in page, on both tabs", async () => {
    expect(display?.plans).toHaveLength(4);
    const shown = async (planDisplay: BillingDisplay | null) => {
      const { container, unmount } = renderPlanStep(locale, { plans, planDisplay });
      const annual = container.innerHTML;
      await userEvent.click(screen.getByRole("tab", { name: onboardingWords(locale).billingInterval.monthly }));
      const monthly = container.innerHTML;
      unmount();
      return { annual, monthly };
    };
    const builtIn = await shown(null);
    const fromFile = await shown(display);
    expect(fromFile.annual).toBe(builtIn.annual);
    expect(fromFile.monthly).toBe(builtIn.monthly);
    expect(fromFile.monthly).not.toBe(fromFile.annual);
  });

  it("gives the upgrade dialog's cards the plan step's bullets, so a business reads the same words in both places", () => {
    const step = renderPlanStep(locale, { plans, planDisplay: display });
    const stepBullets = cardBullets(step.container);
    step.unmount();
    renderDialog(locale, plans, display);
    const names = (localeResources[locale] as Record<string, Bundle>).settings!.billing.upgradeDialog.plans;
    expect(cardBullets(screen.getByRole("dialog"))).toEqual(stepBullets.map(([, bullets], index) => [names[(["free_cloud", "starter", "pro", "enterprise"] as const)[index]!].name, bullets]));
  });
});

describe("a section that copies the built-in words, in English", () => {
  const plans = examplePlans();

  it("prints the plans' own numbers and the short-call rule from the code", () => {
    renderPlanStep("en", { plans, planDisplay: exampleDisplay });
    expect(cardBullets(document.body).slice(0, 2)).toEqual([
      ["Free", ["30 browser voice minutes included", "1 receptionist", "No telephone number", "Community support"]],
      ["Starter", ["150 voice minutes included\nThen CA$0.20/min", "1 receptionist", "1 dedicated business number", "50 alert SMS segments", "Email support"]],
    ]);
    expect(screen.getByText("Billed annually. Includes 150 voice minutes that reset monthly.")).toBeTruthy();
    expect(screen.getByText("Try LobbyStack with enough usage to see it work.")).toBeTruthy();
    expect(screen.getByText("Calls under 10s excluded from billing")).toBeTruthy();
    expect(screen.getByText(/^Test 30 browser voice minutes on Free/)).toBeTruthy();
  });

  it("leaves the upgrade dialog's English as it was", () => {
    const builtIn = renderDialog("en", plans, null);
    const before = screen.getByRole("dialog").textContent;
    builtIn.unmount();
    renderDialog("en", plans, exampleDisplay);
    expect(screen.getByRole("dialog").textContent).toBe(before);
  });
});

describe("a display section of a brand's own", () => {
  const plans = examplePlans();
  const words = (text: string) => ({ en: text, fr: `${text} (fr)`, es: `${text} (es)`, sr: `${text} (sr)` });
  const section: BillingDisplay = {
    defaultInterval: "monthly",
    plans: [
      { plan: "pro", popular: true, description: words("{{voiceMinutes}} minutes, then {{voiceMinuteRate}} each, on {{appName}}"), button: { monthly: words("Pro by the month"), annual: words("Pro by the year") }, bullets: ["voiceMinutes", "knowledgeStorage", "outboundCallAttempts", "chatAiUnits", words("Up to {{receptionists}} receptionists")] },
      { plan: "starter", bullets: ["receptionists", "businessNumbers"] },
    ],
    comparisonTitle: words("Pro or Starter"),
    comparisonIntro: words("Free gives {{free_cloud.voiceMinutes}} minutes; Pro {{pro.voiceMinutes}}."),
    comparison: [{
      group: words("What you get"),
      rows: ["voiceMinutes", { row: "businessNumbers", label: words("Lines"), values: { starter: "custom" } }, { label: words("Onboarding call"), values: { pro: true, starter: words("{{voiceMinuteRate}}/min") } }, "shortCalls"],
    }],
    packs: { title: words("Top up"), description: words("Minutes once, from {{starter.voiceMinuteRate}}."), button: words("Buy minutes") },
  };
  const pack = { code: "pack_500_180", names: { en: "500 minutes" }, minutes: 500, voiceSeconds: 30_000, days: 180, amountCents: 11_900, currency: "cad", smsSegments: 50, outboundCalls: 20, chatUnits: 50, knowledgeStorageBytes: 20_971_520, numbers: 1, receptionists: 1, checkoutAvailable: true };

  it("shows its cards in its order with its popular plan and words, the plans' numbers, and only its plans in the comparison", async () => {
    const { container } = renderPlanStep("en", { plans, planDisplay: section, packOffers: [pack], packCheckout: { refusal: null, endsSubscription: null } });
    expect(cardBullets(container)).toEqual([
      ["Pro", ["500 voice minutes included\nThen CA$0.18/min", "20 MB knowledge base", "100 transfer attempts", "200 website chats", "Up to 5 receptionists"]],
      ["Starter", ["1 receptionist", "1 dedicated business number"]],
    ]);
    // It opens on Monthly, and a card without words of its own keeps the built-in ones.
    expect(screen.getByRole("tab", { name: "Monthly" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("500 minutes, then CA$0.18 each, on LobbyStack")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pro by the month" })).toBeTruthy();
    expect(screen.getByText("Billed monthly. Includes 150 voice minutes that reset monthly.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start free" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Contact us" })).toBeNull();
    const proCard = screen.getByRole("button", { name: "Pro by the month" }).closest("section")!;
    expect(within(proCard).getByText("Popular")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: /^Annual/ }));
    expect(screen.getByRole("button", { name: "Pro by the year" })).toBeTruthy();
    // The packs' box takes its words, with any plan's values.
    expect(screen.getByText("Top up")).toBeTruthy();
    expect(screen.getByText("Minutes once, from CA$0.20.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy minutes" })).toBeTruthy();
    // The comparison: its title and intro, a column for each card, and its rows.
    expect(screen.getByRole("heading", { level: 2, name: "Pro or Starter" })).toBeTruthy();
    expect(screen.getByText("Free gives 30 minutes; Pro 500.")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Feature", "ProPopular", "Starter"]);
    const cells = (label: string) => within(within(table).getByText(label).closest("tr")!).getAllByRole("cell").slice(1).map((cell) => cell.textContent);
    expect(within(table).getByText("What you get")).toBeTruthy();
    expect(cells("Voice minutes")).toEqual(["500 includedthen CA$0.18/min", "150 includedthen CA$0.20/min"]);
    expect(cells("Lines")).toEqual(["1 dedicated", "Custom"]);
    expect(cells("Onboarding call")).toEqual(["Included", "CA$0.20/min"]);
    expect(cells("Calls under 10s excluded from billing")).toEqual(["Included", "Included"]);
  });

  it("speaks the visitor's language, with numbers and rates as it writes them", () => {
    renderPlanStep("fr", { plans, planDisplay: section });
    const rate = formatMoney(18, "cad", "fr");
    expect(cardBullets(document.body)[0]).toEqual(["Pro", [`500 minutes vocales incluses\nPuis ${rate}/min`, "20 Mo de stockage des connaissances", "100 tentatives de transfert", "200 conversations de clavardage du site", "Up to 5 receptionists (fr)"]]);
    const proCard = screen.getAllByRole("list")[0]!.closest("section")!;
    expect(proCard.querySelector("p")!.textContent).toBe(`500 minutes, then ${rate} each, on LobbyStack (fr)`);
  });

  it("shows no comparison when the section empties it", () => {
    renderPlanStep("en", { plans, planDisplay: { comparison: [] } });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Compare plans in detail")).toBeNull();
    // The cards stay the built-in four.
    expect(cardBullets(document.body).map(([plan]) => plan)).toEqual(["Free", "Starter", "Pro", "Enterprise"]);
  });

  it("gives the upgrade dialog the same cards and bullets, with its own price line and buttons", () => {
    renderDialog("en", plans, section);
    const dialog = screen.getByRole("dialog");
    expect(cardBullets(dialog)).toEqual([
      ["Pro", ["500 voice minutes included\nThen CA$0.18/min", "20 MB knowledge base", "100 transfer attempts", "200 website chats", "Up to 5 receptionists"]],
      ["Starter", ["1 receptionist", "1 dedicated business number"]],
    ]);
    expect(within(dialog).getByRole("tab", { name: "Monthly" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getAllByText("Per month, billed monthly")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  });
});

describe("plans sold monthly only, as on Stripe as merchant of record", () => {
  const monthlyOnly = () => {
    const plans = examplePlans();
    for (const plan of plans.plans) plan.prices = plan.prices.filter((price) => price.interval === "monthly");
    return plans;
  };

  it("shows no Annual tab on the plan step, and prices the month", () => {
    renderPlanStep("en", { plans: monthlyOnly(), planDisplay: null });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Monthly"]);
    expect(screen.getByRole("tab", { name: "Monthly" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("CA$37")).toBeTruthy();
    expect(screen.getByText("CA$87")).toBeTruthy();
  });

  it("shows no Annual tab in the upgrade dialog", () => {
    renderDialog("en", monthlyOnly(), null);
    expect(within(screen.getByRole("dialog")).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Monthly"]);
  });
});

describe("RealInfoBot's listing packs", () => {
  const plans = brandPlanList("realinfobot");
  const display = brandPlanDisplay("realinfobot");
  // The packs as GET /api/billing lists them once the brand's file is applied, in their order.
  const packOffers = resolveBillingPacks(billingProfileSchema.parse(realInfoBotFile)).map((pack) => ({ code: pack.code, names: pack.names, minutes: pack.voice_sec / 60, voiceSeconds: pack.voice_sec, days: pack.days, amountCents: pack.price.cents, currency: pack.price.currency, smsSegments: pack.sms_seg, outboundCalls: pack.calls_out, chatUnits: pack.chat_units, knowledgeStorageBytes: pack.kb_bytes, numbers: pack.numbers, receptionists: pack.receptionists, checkoutAvailable: true }));
  const onSale = { packOffers, packCheckout: { refusal: null, endsSubscription: null } };
  const packCards: Array<[string, string[]]> = [
    ["Try it: 1 listing, 180 days", ["Your sign answers every inquiry, day or night", "250 voice minutes over 180 days", "1 dedicated business number", "Active 180 days, then it expires"]],
    ["3 listings, 365 days", ["Everything in a single listing, times three", "Up to 3 listings at once", "750 voice minutes over 365 days"]],
    ["Pro: 6 listings, 365 days", ["Everything in a single listing, times six", "Up to 6 listings at once", "1,500 voice minutes over 365 days", "For agents who always have a sign up"]],
  ];
  /** The card a text is on, by its name. */
  const cardOf = (text: string) => screen.getByText(text).closest("section")!.querySelector("h3")!.textContent;

  it("shows Free and a card for each pack on the plan step, as on the brand's pricing table, with no tabs, comparison or packs' box", () => {
    renderPlanStep("en", { plans, planDisplay: display, ...onSale });
    expect(cardBullets(document.body)).toEqual([["Free", ["30 browser voice minutes included", "1 receptionist", "No telephone number", "Community support"]], ...packCards]);
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Upgrade with a listing pack")).toBeNull();
    // Each pack's price, paid once, and the middle pack the popular one under the brand's badge.
    expect(["CA$99", "CA$249", "CA$449"].map(cardOf)).toEqual(packCards.map(([name]) => name));
    expect(screen.getAllByText("paid once")).toHaveLength(3);
    expect(cardOf("Best value")).toBe("3 listings, 365 days");
    expect(cardOf("One payment for one listing, with no subscription.")).toBe("Try it: 1 listing, 180 days");
    expect(cardOf("CA$83 per listing (save CA$48)")).toBe("3 listings, 365 days");
    expect(cardOf("CA$75 per listing (save CA$145)")).toBe("Pro: 6 listings, 365 days");
    for (const name of ["Start free", "Add it to your listing", "Get 3 listings", "Get 6 listings"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("speaks the visitor's language on the pack cards", () => {
    renderPlanStep("fr", { plans, planDisplay: display, ...onSale });
    expect(cardBullets(document.body)[2]).toEqual(["3 inscriptions, 365 jours", ["Tout ce qu'offre une inscription, multiplié par trois", "Jusqu'à 3 inscriptions à la fois", "750 minutes vocales sur 365 jours"]]);
    expect(cardOf("Meilleure offre")).toBe("3 inscriptions, 365 jours");
    expect(screen.getAllByText("payé une fois")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Obtenir 3 inscriptions" })).toBeTruthy();
  });

  it("shows Free alone until the packs are on sale", () => {
    renderPlanStep("en", { plans, planDisplay: display });
    expect(cardBullets(document.body).map(([name]) => name)).toEqual(["Free"]);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("gives the upgrade dialog the same cards, each buying its pack", async () => {
    const onBuyPack = vi.fn();
    renderDialog("en", plans, display, { onBuyPack, packOffers });
    const dialog = screen.getByRole("dialog");
    expect(cardBullets(dialog)).toEqual([["Free", ["30 browser voice minutes included", "1 receptionist", "No telephone number", "Community support"]], ...packCards]);
    expect(within(dialog).getAllByText("paid once")).toHaveLength(3);
    expect(cardOf("Best value")).toBe("3 listings, 365 days");
    await userEvent.click(within(dialog).getByRole("button", { name: "Get 3 listings" }));
    expect(onBuyPack).toHaveBeenCalledWith("listings_3_365");
  });
});
