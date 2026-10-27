// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { billingPlanPrice, builtInBillingPlanList, perMonthCents, type BillingPlanList } from "@lobbystack/shared";
import { UpgradePlanDialog } from "./upgrade-plan-dialog";

type Props = ComponentProps<typeof UpgradePlanDialog>;
const translate = vi.fn((key: string) => key);
afterEach(() => { cleanup(); translate.mockClear(); });
function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["monthly", "annual"], pro: ["monthly", "annual"] },
    billingInterval: "annual", currentPlan: "free_cloud", loading: null, loadingPlan: null, locale: "en",
    onBillingIntervalChange: vi.fn(), onContactEnterprise: vi.fn(), onOpenChange: vi.fn(), onStartCheckout: vi.fn(), open: true,
    plans: builtInBillingPlanList(), t: translate as unknown as Props["t"], ...overrides,
  };
  render(<UpgradePlanDialog {...props} />);
  return props;
}
describe("main upgrade dialog", () => {
  it("renders all four original plans and annual checkout pricing", async () => {
    const props = setup();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);
    expect(screen.getByText("$24")).toBeTruthy();
    expect(screen.getByText("$80")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.starter" }));
    expect(props.onStartCheckout).toHaveBeenCalledWith("starter", "annual");
  });
  it("falls back to an available interval without offering an unconfigured checkout", async () => {
    const props = setup({ availableCheckoutPlans: ["pro"], availableCheckoutIntervals: { starter: [], pro: ["monthly"] } });
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    const unavailable = screen.getByRole("button", { name: "billing.upgradeDialog.actions.starter" });
    expect(unavailable.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    expect(props.onStartCheckout).toHaveBeenCalledWith("pro", "monthly");
  });
  it("keeps the current plan and pending checkout controls disabled", () => {
    setup({ currentPlan: "starter", loading: "checkout", loadingPlan: "pro" });
    for (const button of screen.getAllByRole("button").filter(button => !button.getAttribute("data-slot")?.includes("close"))) {
      if (button.textContent?.includes("billing.upgradeDialog.actions")) expect(button.hasAttribute("disabled")).toBe(true);
    }
  });
  it("for a business that already pays, says the subscription changes and offers only an upgrade", async () => {
    const props = setup({ changesPlan: true, currentPlan: "pro" });
    expect(screen.getByText("billing.upgradeDialog.changesSubscription")).toBeTruthy();
    expect(screen.getByRole("button", { name: "billing.upgradeDialog.actions.starter" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    setup({ changesPlan: true, currentPlan: "starter", loading: "checkout", loadingPlan: "pro" });
    expect(screen.getByText("billing.actions.changingPlan")).toBeTruthy();
    expect(props.onStartCheckout).not.toHaveBeenCalled();
  });
  it("warns that changing plan ends the promo plan and its discount", () => {
    setup({ changesPlan: true, currentPlan: "starter", leavesPromoPlan: "Salons half off" });
    expect(translate).toHaveBeenCalledWith("billing.upgradeDialog.leavesPromo", { plan: "Salons half off" });
    cleanup();
    translate.mockClear();
    setup({ changesPlan: true, currentPlan: "starter" });
    expect(translate).not.toHaveBeenCalledWith("billing.upgradeDialog.leavesPromo", expect.anything());
  });
  it("prices the cards and fills their allowances from the deployment's plans, in its currency", async () => {
    const plans: BillingPlanList = builtInBillingPlanList();
    plans.currency = "cad";
    const starter = plans.plans.find(plan => plan.slug === "starter")!;
    starter.included = { ...starter.included, voiceSeconds: 12_000, businessNumbers: 2, alertSmsSegments: 75 };
    starter.overageRates = { ...starter.overageRates, voiceMinuteCents: 25 };
    starter.prices = [{ interval: "monthly", currency: "cad", amountCents: 3500, monthlyAmountCents: 3500, checkoutAvailable: true }, { interval: "annual", currency: "cad", amountCents: 31_500, monthlyAmountCents: 2600, checkoutAvailable: true }];
    setup({ plans, billingInterval: "monthly" });
    expect(screen.getByText("CA$35")).toBeTruthy();
    expect(screen.getByText("CA$0")).toBeTruthy();
    expect(screen.getByText("billing.upgradeDialog.customPrice")).toBeTruthy();
    expect(screen.getAllByText("billing.upgradeDialog.perMonth")).toHaveLength(2);
    expect(translate).toHaveBeenCalledWith("billing.upgradeDialog.plans.starter.highlights.voiceMinutes", { count: 200, rate: "CA$0.25" });
    expect(translate).toHaveBeenCalledWith("billing.upgradeDialog.plans.starter.highlights.dedicatedNumber", { count: 2 });
    expect(translate).toHaveBeenCalledWith("billing.upgradeDialog.plans.starter.highlights.phoneNumber", { count: 75 });
    // Starter saves 25% a year and Pro 20%, so the badge promises the 20% every plan gets.
    expect(translate).toHaveBeenCalledWith("billing.upgradeDialog.annualDiscount", { percent: 20 });
    cleanup();
    setup({ plans, billingInterval: "annual" });
    // CA$315 a year comes to CA$26.25 a month, which the plan list rounds to whole dollars.
    expect(screen.getByText("CA$26")).toBeTruthy();
  });
  it("says the months a year leaves free when every plan's year costs whole months", () => {
    const plans = builtInBillingPlanList();
    for (const plan of plans.plans) {
      const monthly = billingPlanPrice(plan, "monthly");
      if (monthly) plan.prices = [monthly, { ...monthly, interval: "annual", amountCents: monthly.amountCents * 10, monthlyAmountCents: perMonthCents("annual", monthly.amountCents * 10) }];
    }
    setup({ plans, billingInterval: "annual" });
    expect(translate).toHaveBeenCalledWith("billing.upgradeDialog.annualFreeMonths", { count: 2 });
    expect(screen.getByText("billing.upgradeDialog.annualFreeMonths")).toBeTruthy();
    expect(translate).not.toHaveBeenCalledWith("billing.upgradeDialog.annualDiscount", expect.anything());
    // $300 and $1,000 a year come to $25 and $83 a month.
    expect(screen.getByText("$25")).toBeTruthy();
    expect(screen.getByText("$83")).toBeTruthy();
  });
  it("leaves out the saving badge when paying yearly saves nothing", () => {
    const plans = builtInBillingPlanList();
    for (const plan of plans.plans) plan.prices = plan.prices.filter(price => price.interval === "monthly");
    setup({ plans });
    expect(translate).not.toHaveBeenCalledWith("billing.upgradeDialog.annualDiscount", expect.anything());
  });
  it("opens enterprise contact without creating a checkout", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.enterprise" }));
    expect(props.onContactEnterprise).toHaveBeenCalledOnce();
    expect(props.onStartCheckout).not.toHaveBeenCalled();
  });
  it("changes the billing interval through the original tabs", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("tab", { name: "billing.upgradeDialog.billingIntervals.monthly" }));
    expect(props.onBillingIntervalChange).toHaveBeenCalledWith("monthly");
  });
});
