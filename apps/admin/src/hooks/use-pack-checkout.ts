"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PlanChangeRefusal } from "@lobbystack/shared";

import { isBillingEmailRefusal, type BillingEmailRefusal } from "@/components/billing-email-form";
import { isBillingRateLimited, PLAN_CHANGE_SYNC_MS } from "@/lib/billing-plans";
import { requestJson } from "@/lib/request-json";
import { setUpgradeInProgress } from "@/lib/upgrade-in-progress";

// A prepaid pack's checkout, as Settings > Plan and onboarding run it. POST
// /api/billing/packs/checkout queues one; the page polls its GET until the
// provider's payment page is ready and goes there once. A refusal, a page
// that failed or expired, or too many tries says why in a toast. When the
// provider wouldn't make the business's customer with the person's email, a
// form asks for a billing email and the checkout starts again with it. After
// paying, the provider sends the person back with ?pack=success and
// packCheckoutId, where usePackCheckoutReturn waits for the payment.

/** A pack checkout as GET /api/billing/packs/checkout answers it. */
export type PackCheckoutStatus = {
  status: "pending" | "processing" | "ready" | "paid" | "failed" | "expired";
  /** Where the business pays, only while the page is ready. */
  checkoutUrl: string | null;
  error: string | null;
  /** The payment arrived and the business has the pack. */
  synced: boolean;
  refusal: PlanChangeRefusal | null;
  providerName: string;
};

/** A checkout the provider couldn't make the business's customer for, which starts again with a billing email. */
export type PackEmailPrompt = { refusal: BillingEmailRefusal; email: string | null; pack: string };

/** The refusals POST /api/billing/packs/checkout answers with a 409 and a code, each said in its own words. */
const startRefusals = new Set(["managed_plan", "pack_not_sold_on_plan", "pack_yearly_plan", "pack_past_due", "plan_change_payment_waiting", "pack_not_on_sale", "plan_change_pending"]);

/** What a start that was refused or failed says. */
function startFailureKey(error: unknown): string {
  if (isBillingRateLimited(error)) return "billing.toast.rateLimited";
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && startRefusals.has(code) ? `billing.packs.refusals.${code}` : "billing.packs.toast.checkoutFailed";
}

const statusUrl = (businessId: string, checkoutId: string) => `/api/billing/packs/checkout?checkoutId=${encodeURIComponent(checkoutId)}&businessId=${encodeURIComponent(businessId)}`;

/** attempt tells two clicks apart that come back with the same open checkout. */
type Checkout = { businessId: string; checkoutId: string; pack: string; billingEmail: string | null; attempt: number };

/**
 * Starts and follows a pack checkout for the business. pending holds from the
 * click until the page leaves for the provider or the checkout fails.
 */
export function usePackCheckout(businessId: string | undefined) {
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
    mutationFn: (input: { businessId: string; pack: string; billingEmail?: string }) => requestJson<{ checkoutId: string }>("/api/billing/packs/checkout", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result, input) => {
      if (activeBusiness.current !== input.businessId) return;
      attempts.current += 1;
      setCheckout({ businessId: input.businessId, checkoutId: result.checkoutId, pack: input.pack, billingEmail: input.billingEmail ?? null, attempt: attempts.current });
    },
    onError: (error, input) => { if (activeBusiness.current === input.businessId) toast.error(t(startFailureKey(error))); },
  });
  const status = useQuery({
    queryKey: ["billing-pack-checkout", checkout?.businessId, checkout?.checkoutId, checkout?.attempt],
    enabled: Boolean(checkout && checkout.businessId === businessId),
    queryFn: () => requestJson<PackCheckoutStatus>(statusUrl(checkout!.businessId, checkout!.checkoutId)),
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
      setUpgradeInProgress(true, "pack");
      setLeaving(true);
      window.location.assign(data.checkoutUrl);
      return;
    }
    if (data?.status === "paid") {
      // Paid already, in another tab: the business has the pack.
      toast.success(t("billing.packs.toast.added"));
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
      toast.error(t(data?.status === "expired" ? "billing.packs.toast.checkoutExpired" : "billing.packs.toast.checkoutFailed"));
    }
    setCheckout(null);
  }, [businessId, checkout, data, queryClient, status.isError, t]);
  const pending = (mutation.isPending && mutation.variables?.businessId === businessId) || checkout?.businessId === businessId || leaving;
  useEffect(() => {
    setUpgradeInProgress(pending, "pack");
    return () => setUpgradeInProgress(false, "pack");
  }, [pending]);
  return {
    /** Starts a checkout for the pack, with a billing email when the provider asked for one. */
    start(pack: string, billingEmail?: string) {
      if (!businessId || pending) return;
      setEmailPrompt(null);
      mutation.mutate({ businessId, pack, ...(billingEmail ? { billingEmail } : {}) });
    },
    pending,
    /** The pack whose checkout is starting or open; null when none is. */
    pendingPack: checkout?.businessId === businessId ? checkout?.pack ?? null : mutation.isPending ? mutation.variables?.pack ?? null : null,
    emailPrompt,
    dismissEmailPrompt() { setEmailPrompt(null); },
  };
}

/** What a return from the provider's payment page comes to: still waiting, paid, failed, or paid but not arrived yet. */
export type PackCheckoutReturn = "waiting" | "paid" | "failed" | "processing";

/**
 * Waits for the payment of the checkout the provider sent the person back
 * from, for PLAN_CHANGE_SYNC_MS at most: a bank debit settles later, so the
 * page then says the payment is processing. A page that expired reads as
 * processing too, since the provider sends the person back only once they
 * paid, and a payment can land after its page expired. checkAgain waits once
 * more. The outcome is null without a checkout.
 */
export function usePackCheckoutReturn(businessId: string | undefined, checkoutId: string | null): { outcome: PackCheckoutReturn | null; checkAgain: () => void } {
  const [round, setRound] = useState(0);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  const wait = businessId && checkoutId ? `${businessId}:${checkoutId}:${round}` : null;
  const status = useQuery({
    queryKey: ["billing-pack-checkout-return", businessId, checkoutId, round],
    enabled: Boolean(wait) && timedOut !== wait,
    queryFn: () => requestJson<PackCheckoutStatus>(statusUrl(businessId!, checkoutId!)),
    refetchInterval: (query) => ["paid", "failed", "expired"].includes(query.state.data?.status ?? "") ? false : 1_500,
  });
  useEffect(() => {
    if (!wait) return;
    const timer = window.setTimeout(() => setTimedOut(wait), PLAN_CHANGE_SYNC_MS);
    return () => window.clearTimeout(timer);
  }, [wait]);
  const current = status.data?.status;
  const outcome: PackCheckoutReturn | null = !wait ? null : current === "paid" ? "paid" : current === "failed" ? "failed" : current === "expired" || timedOut === wait ? "processing" : "waiting";
  return { outcome, checkAgain: () => setRound((value) => value + 1) };
}
