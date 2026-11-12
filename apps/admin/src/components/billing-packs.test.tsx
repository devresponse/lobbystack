// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BillingPackViewModel } from "@/lib/page-view-models";
import { HeldPacks, PackEndsPlanDialog } from "./billing-packs";

// What the plan screens share about prepaid packs: the question before a
// pack's payment ends a Starter or Pro subscription, and the list of the packs
// a business holds when they aren't its plan by themselves. Buying a pack from
// its card is in use-pack-checkout.test.tsx and the screens' own tests.

// Each string shows its key, then the values it was given, so a test can tell them apart.
const translate = vi.hoisted(() => vi.fn((key: string, options?: Record<string, unknown>) => options ? `${key} ${Object.values(options).join(" ")}` : key));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: translate }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const held = (patch: Partial<BillingPackViewModel> = {}): BillingPackViewModel => ({ id: "held", code: "pack-500-180", names: { en: "500 minutes" }, status: "active", days: 180, amountCents: 9_900, currency: "cad", secondsTotal: 30_000, secondsLeft: 12_030, paidAt: "2026-10-01T00:00:00.000Z", endsAt: "2027-03-30T00:00:00.000Z", ...patch });

describe("the question before a pack's payment ends a plan", () => {
  it("says a Pro plan with a promo code ends at once, unrefunded, with its code lost and its receptionists but one paused, and buys once confirmed", async () => {
    const onConfirm = vi.fn();
    render(<PackEndsPlanDialog ends={{ plan: "pro", promo: true, periodEnd: "2026-12-01T12:00:00.000Z" }} onConfirm={onConfirm} onOpenChange={vi.fn()} open />);
    expect(screen.getByText("billing.packs.endsPlanDialog.title billing.planLabels.pro")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.planEnds billing.planLabels.pro")).toBeTruthy();
    expect(screen.getByText(/^billing\.packs\.endsPlanDialog\.noRefund .*2026/)).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.promoLost")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.receptionistsPaused")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.packStarts")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.endsPlanDialog.confirm" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });

  it("says nothing of a promo code or receptionists for a plain Starter plan, and buys nothing when they go back", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<PackEndsPlanDialog ends={{ plan: "starter", promo: false, periodEnd: null }} onConfirm={onConfirm} onOpenChange={onOpenChange} open />);
    expect(screen.getByText("billing.packs.endsPlanDialog.title billing.planLabels.starter")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.noRefundUndated")).toBeTruthy();
    expect(screen.queryByText("billing.packs.endsPlanDialog.promoLost")).toBeNull();
    expect(screen.queryByText("billing.packs.endsPlanDialog.receptionistsPaused")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "billing.cancelDialog.back" }));
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("the packs a business holds", () => {
  it("lists each as a plan, by its name and its price for its length, with its minutes left of its total, its end, and a hold while a dispute is open", () => {
    render(<HeldPacks locale="en" packs={[held(), held({ id: "frozen", code: "pack-1000-ever", names: { en: "1000 minutes" }, status: "frozen", days: null, amountCents: 29_900, secondsTotal: 60_000, secondsLeft: 60_000, endsAt: null })]} />);
    expect(screen.getByText("billing.packs.heldTitle")).toBeTruthy();
    expect(screen.getByText("500 minutes")).toBeTruthy();
    expect(screen.getByText("CA$99 common:planDisplay.perDays 180 180")).toBeTruthy();
    expect(screen.getByText("CA$299 common:planDisplay.paidOnce")).toBeTruthy();
    expect(translate).toHaveBeenCalledWith("billing.packs.left", { count: 200, left: "200", total: "500" });
    expect(screen.getByText(/^billing\.packs\.endsOn .*2027/)).toBeTruthy();
    expect(screen.getByText("billing.packs.neverEnds")).toBeTruthy();
    expect(screen.getAllByText("billing.packs.frozen")).toHaveLength(1);
  });
});
