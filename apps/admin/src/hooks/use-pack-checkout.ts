"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { topUpCheckoutRefusalCodes, type BillingPackStatus, type BillingTopUpStatus, type PlanChangeRefusal } from "@lobbystack/shared";

import { isBillingEmailRefusal, type BillingEmailRefusal } from "@/components/billing-email-form";
import { isBillingRateLimited, PLAN_CHANGE_SYNC_MS } from "@/lib/billing-plans";
import { requestJson } from "@/lib/request-json";
import { setUpgradeInProgress } from "@/lib/upgrade-in-progress";

// A prepaid pack's checkout, as Settings > Plan and onboarding run it, and a
// top-up's (kind top_up), as Settings > Plan runs it. POST
// /api/billing/packs/checkout queues a pack's, /api/billing/top-ups/checkout
// a top-up's; the page polls its GET until the
// provider's payment page is ready and goes there once. A refusal, a page
// that failed or expired, or too many tries says why in a toast. When the
// provider wouldn't make the business's customer with the person's email, a
// form asks for a billing email and the checkout starts again with it. After
// paying, the provider sends the person back with ?pack=success and
// packCheckoutId, where usePackCheckoutReturn waits for the payment. A paid
// checkout whose pack ended as it arrived, because a plan the business bought
// started first or the payment went back first, says so instead of added.

/** What a checkout sells: a prepaid pack, or a top-up on sale. */
export type PackCheckoutKind = "pack" | "top_up";

/** A pack checkout as GET /api/billing/packs/checkout answers it, or a top-up's as GET /api/billing/top-ups/checkout does. */
export type PackCheckoutStatus = {
  status: "pending" | "processing" | "ready" | "paid" | "failed" | "expired";
  /** Where the business pays, only while the page is ready. */
  checkoutUrl: string | null;
  error: string | null;
  /** What became of the pack once the payment arrived; null before it did, or for a checkout paid before LobbyStack kept the link. A top-up's checkout has none. */
  packStatus?: BillingPackStatus | null;
  /** What became of a top-up once its payment arrived; null before it did. A pack's checkout has none. */
  topUpStatus?: BillingTopUpStatus | null;
  /** The payment arrived and the business has the pack or the top-up. */
  synced: boolean;
  /** A plan the business bought started while the checkout was open, which closed it. Only a pack's checkout closes. */
  closedForPlan?: boolean;
  refusal: PlanChangeRefusal | null;
  providerName: string;
};

/** Where each kind's checkout is asked for and read, the field its code goes in, and its words. */
const kinds = {
  pack: { url: "/api/billing/packs/checkout", field: "pack", words: "billing.packs" },
  top_up: { url: "/api/billing/top-ups/checkout", field: "topUp", words: "billing.topUps.buy" },
} as const satisfies Record<PackCheckoutKind, { url: string; field: string; words: string }>;

/** The toast for a paid checkout: added, or why its pack ended as it arrived. */
export function paidPackToastKey(packStatus: BillingPackStatus | null | undefined): string {
  if (packStatus === "replaced") return "billing.packs.toast.gaveWay";
  if (packStatus === "refunded") return "billing.packs.toast.refundedFirst";
  return "billing.packs.toast.added";
}

/** The toast for a paid top-up checkout: added, or its payment went back before it arrived. */
export function paidTopUpToastKey(topUpStatus: BillingTopUpStatus | null | undefined): string {
  return topUpStatus === "refunded" ? "billing.topUps.buy.toast.refundedFirst" : "billing.topUps.buy.toast.added";
}

/** The toast for a paid checkout of either kind. */
function paidToastKey(kind: PackCheckoutKind, data: PackCheckoutStatus | undefined): string {
  return kind === "top_up" ? paidTopUpToastKey(data?.topUpStatus) : paidPackToastKey(data?.packStatus);
}

/** A checkout the provider couldn't make the business's customer for, which starts again with a billing email. */
export type PackEmailPrompt = { refusal: BillingEmailRefusal; email: string | null; pack: string };

/** The refusals each kind's POST answers with a 409 and a code, each said in its own words. */
const startRefusals: Record<PackCheckoutKind, ReadonlySet<string>> = {
  pack: new Set(["managed_plan", "pack_not_sold_on_plan", "pack_yearly_plan", "pack_past_due", "plan_change_payment_waiting", "pack_not_on_sale", "plan_change_pending"]),
  top_up: new Set(topUpCheckoutRefusalCodes),
};

/** What a start that was refused or failed says. */
function startFailureKey(error: unknown, kind: PackCheckoutKind): string {
  if (isBillingRateLimited(error)) return "billing.toast.rateLimited";
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && startRefusals[kind].has(code) ? `${kinds[kind].words}.refusals.${code}` : `${kinds[kind].words}.toast.checkoutFailed`;
}

const statusUrl = (businessId: string, checkoutId: string, kind: PackCheckoutKind = "pack") => `${kinds[kind].url}?checkoutId=${encodeURIComponent(checkoutId)}&businessId=${encodeURIComponent(businessId)}`;

/** attempt tells two clicks apart that come back with the same open checkout. */
type Checkout = { businessId: string; checkoutId: string; pack: string; billingEmail: string | null; attempt: number };

/**
 * Starts and follows a pack checkout for the business, or a top-up's with
 * kind top_up. pending holds from the click until the page leaves for the
 * provider or the checkout fails. writer names it among those that say an
 * upgrade is in progress, so two screens that sell packs at once, such as
 * Settings > Plan and the Upgrade plan dialog over it, don't clear each
 * other's.
 */
export function usePackCheckout(businessId: string | undefined, writer = "pack", kind: PackCheckoutKind = "pack") {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [emailPrompt, setEmailPrompt] = useState<PackEmailPrompt | null>(null);
  const [leaving, setLeaving] = useState(false);
  const attempts = useRef(0);
  // Leave once per click: a page restored from the browser's cache can rerun the effect with the old ready checkout.
  const redirected = useRef<string | null>(null);
  // A start for a business the person has since switched away from shows nothing.
  const activeBusiness = useRef(businessId);
  activeBusiness.current = businessId;
  const mutation = useMutation({
    mutationFn: (input: { businessId: string; pack: string; billingEmail?: string }) => {
      const { pack, ...rest } = input;
      return requestJson<{ checkoutId: string }>(kinds[kind].url, { method: "POST", body: JSON.stringify({ ...rest, [kinds[kind].field]: pack }) });
    },
    onSuccess: (result, input) => {
      if (activeBusiness.current !== input.businessId) return;
      attempts.current += 1;
      setCheckout({ businessId: input.businessId, checkoutId: result.checkoutId, pack: input.pack, billingEmail: input.billingEmail ?? null, attempt: attempts.current });
    },
    onError: (error, input) => { if (activeBusiness.current === input.businessId) toast.error(t(startFailureKey(error, kind))); },
  });
  const status = useQuery({
    queryKey: ["billing-pack-checkout", kind, checkout?.businessId, checkout?.checkoutId, checkout?.attempt],
    enabled: Boolean(checkout && checkout.businessId === businessId),
    queryFn: () => requestJson<PackCheckoutStatus>(statusUrl(checkout!.businessId, checkout!.checkoutId, kind)),
    // Until the payment page is ready, or the checkout ended without one.
    refetchInterval: (query) => ["ready", "paid", "failed", "expired"].includes(query.state.data?.status ?? "") ? false : 1_500,
  });
  useEffect(() => { setCheckout(null); setEmailPrompt(null); }, [businessId]);
  const resetStart = mutation.reset;
  useEffect(() => {
    // The back button from the payment page can restore this page from the browser's cache,
    // still waiting on a checkout that already opened. Let them buy again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setLeaving(false);
      setCheckout(null);
      resetStart();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [resetStart]);
  const data = status.data;
  useEffect(() => {
    if (!checkout || checkout.businessId !== businessId) return;
    if (data?.status === "ready" && data.checkoutUrl) {
      const click = `${checkout.checkoutId}:${checkout.attempt}`;
      if (redirected.current === click) return;
      redirected.current = click;
      // Heading to the payment page is leaving on purpose: say so before the page starts to unload.
      setUpgradeInProgress(true, writer);
      setLeaving(true);
      window.location.assign(data.checkoutUrl);
      return;
    }
    if (data?.status === "paid") {
      // Paid already, in another tab: the business has the pack or top-up, unless it ended as it arrived.
      if (data.synced) toast.success(t(`${kinds[kind].words}.toast.added`));
      else toast.error(t(paidToastKey(kind, data)));
      void queryClient.invalidateQueries({ queryKey: ["billing", checkout.businessId] });
      setCheckout(null);
      return;
    }
    if (data?.status !== "failed" && data?.status !== "expired" && !status.isError) return;
    const refusal = data?.refusal;
    if (isBillingEmailRefusal(refusal)) {
      setEmailPrompt({ refusal, email: checkout.billingEmail, pack: checkout.pack });
    } else {
      setEmailPrompt(null);
      // The worker's own error is for operators, in English; the toast says it in the person's language.
      const words = kinds[kind].words;
      toast.error(t(data?.closedForPlan ? `${words}.toast.closedForPlan` : data?.status === "expired" ? `${words}.toast.checkoutExpired` : `${words}.toast.checkoutFailed`));
    }
    setCheckout(null);
  }, [businessId, checkout, data, kind, queryClient, status.isError, t, writer]);
  const pending = (mutation.isPending && mutation.variables?.businessId === businessId) || checkout?.businessId === businessId || leaving;
  useEffect(() => {
    setUpgradeInProgress(pending, writer);
    return () => setUpgradeInProgress(false, writer);
  }, [pending, writer]);
  return {
    /** Starts a checkout for the pack or top-up, with a billing email when the provider asked for one. */
    start(pack: string, billingEmail?: string) {
      if (!businessId || pending) return;
      setEmailPrompt(null);
      mutation.mutate({ businessId, pack, ...(billingEmail ? { billingEmail } : {}) });
    },
    pending,
    /** The pack or top-up whose checkout is starting or open; null when none is. */
    pendingPack: checkout?.businessId === businessId ? checkout?.pack ?? null : mutation.isPending ? mutation.variables?.pack ?? null : null,
    emailPrompt,
    dismissEmailPrompt() { setEmailPrompt(null); },
  };
}

/**
 * What a return from the provider's payment page comes to: still waiting,
 * paid, failed, or paid but not arrived yet; replaced or refunded when the
 * payment arrived but its pack ended at once, because a plan the business
 * bought started first, or the payment went back first. replaced also
 * covers a page that plan's start closed, whose payment hasn't arrived yet.
 */
export type PackCheckoutReturn = "waiting" | "paid" | "failed" | "processing" | "replaced" | "refunded";

/**
 * Waits for the payment of the checkout the provider sent the person back
 * from, for PLAN_CHANGE_SYNC_MS at most: a bank debit settles later, so the
 * page then says the payment is processing. A page that expired reads as
 * processing too, since the provider sends the person back only once they
 * paid, and a payment can land after its page expired. A page that a plan's
 * start closed is waited on as well, since Polar's page, or Stripe's before
 * its close, still takes the payment: it reads replaced once the payment
 * arrives, its pack giving way to that plan, or when the wait runs out, since
 * the same comes of it then. checkAgain waits once more. The outcome is null
 * without a checkout.
 */
export function usePackCheckoutReturn(businessId: string | undefined, checkoutId: string | null, kind: PackCheckoutKind = "pack"): { outcome: PackCheckoutReturn | null; checkAgain: () => void } {
  const [round, setRound] = useState(0);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  const wait = businessId && checkoutId ? `${businessId}:${checkoutId}:${round}` : null;
  const status = useQuery({
    queryKey: ["billing-pack-checkout-return", kind, businessId, checkoutId, round],
    enabled: Boolean(wait) && timedOut !== wait,
    queryFn: () => requestJson<PackCheckoutStatus>(statusUrl(businessId!, checkoutId!, kind)),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "paid" || data?.status === "failed" || (data?.status === "expired" && !data.closedForPlan) ? false : 1_500;
    },
  });
  useEffect(() => {
    if (!wait) return;
    const timer = window.setTimeout(() => setTimedOut(wait), PLAN_CHANGE_SYNC_MS);
    return () => window.clearTimeout(timer);
  }, [wait]);
  const current = status.data?.status;
  // A pack can end as its payment arrives; a top-up only when its payment went back first.
  const ended = status.data?.packStatus === "replaced" || status.data?.packStatus === "refunded" ? status.data.packStatus : status.data?.topUpStatus === "refunded" ? "refunded" : null;
  const closedForPlan = current === "expired" && status.data?.closedForPlan === true;
  const outcome: PackCheckoutReturn | null = !wait ? null
    : current === "paid" ? ended ?? "paid"
    : current === "failed" ? "failed"
    : closedForPlan ? (timedOut === wait ? "replaced" : "waiting")
    : current === "expired" || timedOut === wait ? "processing"
    : "waiting";
  return { outcome, checkAgain: () => setRound((value) => value + 1) };
}
