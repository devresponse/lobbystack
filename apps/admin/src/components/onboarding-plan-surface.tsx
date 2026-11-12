"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { useStepNavigation } from "@/lib/use-step-navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { brandLinks, contactEmailFor, type BillingDisplay, type BillingPlanList, type PlanChangeRefusal, type PlanDisplayCard, type PlanDisplayPackCard } from "@lobbystack/shared";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BillingEmailForm, isBillingEmailRefusal, type BillingEmailRefusal } from "@/components/billing-email-form";
import { PackEndsPlanDialog } from "@/components/billing-packs";
import { useBranding } from "@/components/branding-provider";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { OnboardingPlanComparison } from "@/components/onboarding-plan-comparison";
import { PromoCodeEntry } from "@/components/promo-code-entry";
import { useTelemetry } from "@/components/product-analytics";
import { paidPackToastKey, usePackCheckout, usePackCheckoutReturn } from "@/hooks/use-pack-checkout";
import { annualBadge, findPlan, formatMoney, monthlyPriceCents, planStringValues, planValues } from "@/lib/billing-plans";
import { intlLocale } from "@/lib/locale";
import { cardBullets, cardText, displayText, hasPackCards, openingInterval, packCardBullets, packLengthKey, packLengthName, packLengths, packName, packPrice, packPriceSuffix, packSectionText, packTextValues, pageTextValues, planCardColumns, planCards, planTextValues, pricedIntervals, screenCards, shownInterval, type PlanCardView, type PlanDisplayTranslate } from "@/lib/plan-display";
import type { BillingPackOfferViewModel, PackCheckoutViewModel } from "@/lib/page-view-models";
import { cn } from "@/lib/utils";

type BillingInterval = "monthly" | "annual";
type Plan = "free_cloud" | "starter" | "pro" | "enterprise";
type Checkout = { id: string; status: string; checkoutUrl: string | null; error: string | null; refusal: PlanChangeRefusal | null };
type CheckoutInput = { target: "starter" | "pro"; billingEmail?: string };
type BillingStatus = { checkoutAvailable: boolean; effectivePlan?: string; availableCheckoutPlans?: Array<"starter" | "pro">; availableCheckoutIntervals?: { starter: BillingInterval[]; pro: BillingInterval[] }; plans: BillingPlanList; planDisplay?: BillingDisplay | null; packOffers?: BillingPackOfferViewModel[]; packCheckout?: PackCheckoutViewModel | null; limits?: { includedBusinessNumbers: number | null } };

// The built-in bullets, which a card shows when billing.json's display section gives it none.
const builtInFeatures: Record<Plan, string[]> = {
  free_cloud: ["voiceMinutes", "receptionists", "bookingContacts", "support"],
  starter: ["voiceMinutes", "receptionists", "dedicatedNumber", "alertSms", "support"],
  pro: ["voiceMinutes", "receptionists", "dedicatedNumber", "alertSms", "support"],
  enterprise: ["phoneNumbers", "customReceptionists", "selfHosted", "support"],
};

const REPORTED_CHECKOUT_KEY = "lobbystack.onboarding.checkoutReported";

const billingUrl = (businessId: string) => `/api/billing?businessId=${encodeURIComponent(businessId)}`;

/**
 * The funnel should count checkouts, not visits to the return URL. A ref only
 * lasts one mount, so a reload of that URL would report the same checkout again.
 */
function hasReportedCheckout(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(REPORTED_CHECKOUT_KEY);
    return raw ? (JSON.parse(raw) as string[]).includes(key) : false;
  } catch {
    return false;
  }
}

function markCheckoutReported(key: string): void {
  try {
    const raw = window.localStorage.getItem(REPORTED_CHECKOUT_KEY);
    const current = raw ? JSON.parse(raw) as string[] : [];
    if (current.includes(key)) return;
    window.localStorage.setItem(REPORTED_CHECKOUT_KEY, JSON.stringify([...current.slice(-19), key]));
  } catch {
    // Storage is unavailable, so the per-mount ref is the only guard left.
  }
}

export function OnboardingPlanSurface() {
  const { i18n, t } = useTranslation("onboarding");
  const { t: billingT } = useTranslation("settings");
  const { navigate, navigating, router } = useStepNavigation();
  const telemetry = useTelemetry();
  const { appName } = useBranding();
  const searchParams = useSearchParams();
  // The tab the person picked; until then the plan step opens on billing.json's choice, else Annual.
  const [chosenInterval, setChosenInterval] = useState<BillingInterval | null>(null);
  const [checkoutRequestId, setCheckoutRequestId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // A checkout Polar couldn't make this business's customer for starts again with a billing email.
  const [emailPrompt, setEmailPrompt] = useState<{ refusal: BillingEmailRefusal; email: string | null; target: "starter" | "pro" } | null>(null);
  const returnAttempt = useRef<{ key: string; promise: Promise<unknown> } | null>(null);
  const packReturnAttempt = useRef<{ key: string; promise: Promise<"attribution" | "phone_number"> } | null>(null);
  // The length of the prepaid plans the person picked, as the plans' interval, while the packs show under a heading of their own.
  const [chosenLength, setChosenLength] = useState<string | null>(null);
  // The pack whose purchase, which ends the business's Starter or Pro plan, waits for the person to confirm.
  const [confirmingPack, setConfirmingPack] = useState<string | null>(null);
  // A pack's payment that came back failed, or refunded before it arrived: the plans to choose from again, with why.
  const [packReturnFailed, setPackReturnFailed] = useState<"failed" | "refunded" | null>(null);
  const { business } = useActiveBusiness();
  const queryClient = useQueryClient();
  const billing = useQuery({ queryKey: ["billing", business?.businessId], queryFn: () => requestJson<BillingStatus>(billingUrl(business!.businessId)), enabled: Boolean(business) });
  // The cards and their words: billing.json's display section, else the built-in four.
  const display = billing.data?.planDisplay ?? null;
  const cards = planCards(display);
  const configuredIntervals = billing.data?.availableCheckoutIntervals;
  // A tab for each interval a plan has a price for; where some tab can be bought, the one shown can.
  const tabs = billing.data?.plans ? pricedIntervals(billing.data.plans, cards) : [];
  const availableIntervals = tabs.filter(value => !configuredIntervals || configuredIntervals.starter.includes(value) || configuredIntervals.pro.includes(value));
  const interval = shownInterval(chosenInterval ?? openingInterval(display), tabs, availableIntervals);
  const checkout = useQuery({
    queryKey: ["onboarding-checkout", business?.businessId, checkoutRequestId],
    queryFn: () => requestJson<Checkout>(`/api/billing/checkout?businessId=${encodeURIComponent(business!.businessId)}&requestId=${encodeURIComponent(checkoutRequestId!)}`),
    enabled: Boolean(checkoutRequestId),
    refetchInterval: (query) => query.state.data?.status === "ready" || query.state.data?.status === "error" ? false : 1_500,
  });
  const selectFree = useMutation({
    mutationFn: () => requestJson(`/api/onboarding/stage?businessId=${encodeURIComponent(business!.businessId)}`, { method: "POST", body: JSON.stringify({ to: "attribution" }) }),
    onSuccess: () => navigate("/onboarding/attribution"),
    meta: { inlineError: true },
  });
  // A plan in force without a number, such as a promo plan or a pack the operator gave none, has no number step: the
  // server sends that step back here, so Continue goes on past it.
  const keepPlanSkipsNumber = billing.data?.limits?.includedBusinessNumbers === 0;
  const keepPlan = useMutation({
    mutationFn: () => requestJson(`/api/onboarding/stage?businessId=${encodeURIComponent(business!.businessId)}`, { method: "POST", body: JSON.stringify({ to: keepPlanSkipsNumber ? "attribution" : "phone_number" }) }),
    onSuccess: () => navigate(keepPlanSkipsNumber ? "/onboarding/attribution" : "/onboarding/number"),
    meta: { inlineError: true },
  });
  const startCheckout = useMutation({
    mutationFn: (input: CheckoutInput) => requestJson<{ requestId: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ businessId: business!.businessId, target: input.target, billingInterval: interval, ...(input.billingEmail ? { billingEmail: input.billingEmail } : {}) }) }),
    onSuccess: ({ requestId }) => setCheckoutRequestId(requestId),
    meta: { inlineError: true },
  });

  const returnRequestId = searchParams.get("checkout") === "success" ? searchParams.get("requestId") : null;
  const returnedCheckout = useQuery({
    queryKey: ["onboarding-checkout-return", business?.businessId, returnRequestId],
    enabled: Boolean(business && returnRequestId),
    queryFn: () => requestJson<{ synced: boolean; target: string | null }>(`/api/billing/checkout?businessId=${encodeURIComponent(business!.businessId)}&requestId=${encodeURIComponent(returnRequestId!)}`),
    refetchInterval: query => query.state.data?.synced ? false : 1500,
  });
  useEffect(() => {
    const key = `${business?.businessId}:${returnRequestId}`;
    if (!business || !returnRequestId || !returnedCheckout.data?.synced) return;
    if (returnAttempt.current?.key !== key) {
      if (!hasReportedCheckout(key)) {
        markCheckoutReported(key);
        telemetry.track("web.onboarding.plan_checkout_completed", { businessId: business.businessId, plan: returnedCheckout.data.target ?? "unknown" });
      }
      returnAttempt.current = { key, promise: requestJson(`/api/onboarding/stage?businessId=${encodeURIComponent(business.businessId)}`, { method: "POST", body: JSON.stringify({ to: "phone_number" }) }) };
    }
    let cancelled = false;
    void returnAttempt.current.promise.then(() => {
      if (!cancelled) router.replace("/onboarding/number");
    }).catch(() => { if (!cancelled) returnAttempt.current = null; });
    return () => { cancelled = true; };
  }, [business, returnRequestId, returnedCheckout.data?.synced, returnedCheckout.data?.target, router, telemetry]);
  // A prepaid pack bought here: its checkout, then the return from its payment page, which waits for the
  // payment, counts the checkout once, and moves on to the number step as a paid plan does, or past it for
  // a plan in force without a number, as Continue does.
  const packCheckout = usePackCheckout(business?.businessId);
  const packReturnId = searchParams.get("pack") === "success" ? searchParams.get("packCheckoutId") : null;
  const packReturn = usePackCheckoutReturn(business?.businessId, packReturnId);
  useEffect(() => {
    const key = `${business?.businessId}:pack:${packReturnId}`;
    // A pack that gave way to a plan the business bought meanwhile leaves it on that plan, which moves on as a paid one does.
    if (!business || !packReturnId || (packReturn.outcome !== "paid" && packReturn.outcome !== "replaced")) return;
    if (packReturnAttempt.current?.key !== key) {
      if (packReturn.outcome === "replaced") toast.error(billingT(paidPackToastKey("replaced")));
      else if (!hasReportedCheckout(key)) {
        markCheckoutReported(key);
        telemetry.track("web.onboarding.plan_checkout_completed", { businessId: business.businessId, plan: "prepaid" });
      }
      const businessId = business.businessId;
      const billingKey = ["billing", businessId];
      // The next step depends on whether the plan in force now, the pack or the plan it gave way to, includes a
      // number. Billing is read again for it, since the answer from before the payment shows the plan the business
      // had then: a read still in flight, which may have begun before the payment, is cancelled rather than joined.
      // If the new read fails, the number step is the guess, as before.
      const next = queryClient.cancelQueries({ queryKey: billingKey, exact: true })
        .then(() => queryClient.fetchQuery({ queryKey: billingKey, queryFn: () => requestJson<BillingStatus>(billingUrl(businessId)), staleTime: 0 }))
        .then((latest) => latest.limits?.includedBusinessNumbers === 0 ? "attribution" as const : "phone_number" as const, () => "phone_number" as const);
      packReturnAttempt.current = { key, promise: next.then(async (to) => {
        await requestJson(`/api/onboarding/stage?businessId=${encodeURIComponent(businessId)}`, { method: "POST", body: JSON.stringify({ to }) });
        return to;
      }) };
    }
    let cancelled = false;
    void packReturnAttempt.current.promise.then((to) => {
      if (!cancelled) router.replace(to === "attribution" ? "/onboarding/attribution" : "/onboarding/number");
    }).catch(() => { if (!cancelled) packReturnAttempt.current = null; });
    return () => { cancelled = true; };
  }, [billingT, business, packReturnId, packReturn.outcome, queryClient, router, telemetry]);
  useEffect(() => {
    // A payment that failed, or went back before it arrived, leaves the plans to choose from again, under a clean address.
    if (packReturn.outcome !== "failed" && packReturn.outcome !== "refunded") return;
    setPackReturnFailed(packReturn.outcome);
    router.replace("/onboarding/plan");
  }, [packReturn.outcome, router]);
  const lastCheckout = startCheckout.variables;
  useEffect(() => {
    if (checkout.data?.status === "error" || checkout.isError) {
      const refusal = checkout.data?.refusal;
      if (lastCheckout && isBillingEmailRefusal(refusal)) setEmailPrompt({ refusal, email: lastCheckout.billingEmail ?? null, target: lastCheckout.target });
      // The worker's own error is for operators, in English; the screen says it in the person's language.
      else setCheckoutError(t("plan.continueFailed"));
      setCheckoutRequestId(null);
    }
  }, [checkout.data, checkout.isError, lastCheckout, t]);
  useEffect(() => {
    if (checkout.data?.status === "ready" && checkout.data.checkoutUrl) window.location.assign(checkout.data.checkoutUrl);
  }, [checkout.data]);
  useEffect(() => {
    // The back button from checkout can restore this page from the browser's cache, still
    // waiting on a checkout that already opened. Let them pick a plan again.
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) setCheckoutRequestId(null); };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const pendingPlan = selectFree.isPending || navigating ? "free_cloud" : startCheckout.isPending || checkoutRequestId ? "paid" : packCheckout.pending ? "pack" : null;

  function act(plan: Plan) {
    if (!business || pendingPlan) return;
    setCheckoutError(null);
    setEmailPrompt(null);
    packCheckout.dismissEmailPrompt();
    setPackReturnFailed(null);
    telemetry.track("web.onboarding.plan_selected", { businessId: business.businessId, plan });
    if (plan === "free_cloud") selectFree.mutate();
    else if (plan === "starter" || plan === "pro") {
      telemetry.track("web.onboarding.plan_checkout_started", { businessId: business.businessId, plan });
      startCheckout.mutate({ target: plan });
    }
    else window.location.assign(`mailto:${contactEmailFor(brandLinks(), "sales")}?subject=${encodeURIComponent(t("plan.enterpriseSubject"))}`);
  }

  // The packs on sale, unless the business's plan sells none, such as an operator-managed one.
  const packRefusal = billing.data?.packCheckout?.refusal ?? null;
  const packOffers = packRefusal === "managed_plan" || packRefusal === "pack_not_sold_on_plan" ? [] : billing.data?.packOffers ?? [];
  // billing.json can give packs cards of their own among the plans'; otherwise they follow the plans under a heading of their own.
  const packSection = !hasPackCards(display) && packOffers.length > 0;
  const packEndsSubscription = billing.data?.packCheckout?.endsSubscription ?? null;
  const packPrompt = packCheckout.emailPrompt;
  const packUnavailable = packRefusal ? billingT(`billing.packs.refusals.${packRefusal}`) : billingT("billing.packs.unavailable");
  function startPack(code: string) {
    if (!business) return;
    telemetry.track("web.onboarding.plan_checkout_started", { businessId: business.businessId, plan: "prepaid" });
    packCheckout.start(code);
  }
  function buyPack(code: string) {
    if (!business || pendingPlan || !packOffers.find((offer) => offer.code === code)?.checkoutAvailable) return;
    setCheckoutError(null);
    setEmailPrompt(null);
    setPackReturnFailed(null);
    telemetry.track("web.onboarding.plan_selected", { businessId: business.businessId, plan: "prepaid" });
    if (packEndsSubscription) setConfirmingPack(code);
    else startPack(code);
  }

  // A business that already has a paid plan, such as one LobbyStack bills directly, has nothing to buy here.
  const effectivePlan = billing.data?.effectivePlan;
  // A business on a pack has its minutes already, unless it is back from paying for one, which moves on by itself.
  const currentPlan = (effectivePlan === "starter" || effectivePlan === "pro" || effectivePlan === "enterprise" || effectivePlan === "prepaid") && !returnRequestId && !packReturnId ? effectivePlan : null;
  if (currentPlan) {
    return <section className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border/60 bg-background p-8 text-center">
      <h3 className="font-heading text-lg font-semibold tracking-tight">{currentPlan === "prepaid" ? t("plan.current.prepaidTitle") : t("plan.current.title", { plan: t(`plan.tiers.${currentPlan}.name`) })}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{t(currentPlan === "prepaid" ? "plan.current.prepaidDescription" : "plan.current.description")}</p>
      <Button className="w-full rounded-full" disabled={!business || keepPlan.isPending || navigating} onClick={() => keepPlan.mutate()} type="button">{keepPlan.isPending || navigating ? <LoaderCircle className="size-4 animate-spin" /> : <>{t("plan.continue")}<ArrowRight className="ml-1 size-4" /></>}</Button>
      {keepPlan.isError ? <FieldError>{keepPlan.error?.message ?? t("plan.continueFailed")}</FieldError> : null}
    </section>;
  }

  // Prices and allowances come from the deployment's plan list, so the cards wait for it.
  const plans = billing.data?.plans;
  if (!plans) {
    if (!billing.isError) return <div className="flex justify-center py-16"><LoaderCircle aria-hidden="true" className="size-6 animate-spin text-muted-foreground" /></div>;
    return <section className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border/60 bg-background p-8 text-center">
      <p className="text-sm leading-relaxed text-muted-foreground">{t("plan.loadFailed")}</p>
      <Button className="w-full rounded-full" onClick={() => void billing.refetch()} type="button">{t("plan.retry")}</Button>
      {/* Free needs no plan list, so onboarding can still go on without it. */}
      <Button className="w-full rounded-full" disabled={!business || Boolean(pendingPlan)} onClick={() => act("free_cloud")} type="button" variant="outline">{pendingPlan === "free_cloud" ? <LoaderCircle className="size-4 animate-spin" /> : t("plan.tiers.free_cloud.cta")}</Button>
      {selectFree.isError ? <FieldError>{selectFree.error?.message ?? t("plan.continueFailed")}</FieldError> : null}
    </section>;
  }
  const locale = i18n.language;
  const translate: PlanDisplayTranslate = (key, options) => t(key, options ?? {});
  const annualBadgeText = annualBadge(plans, (key, options) => t(key, options), "plan.billingInterval.freeMonths", "plan.billingInterval.save");
  // The page's own words from billing.json print any plan's values, such as {{free_cloud.voiceMinutes}}.
  const pageValues = display ? pageTextValues(plans, locale, translate, appName) : {};
  // The cards in billing.json's order: the plans', and the packs' that are on sale.
  const shownCards = screenCards(display, packOffers);
  // Without cards of their own, the packs follow the plans under a heading, a tab for each length, as the plans' intervals.
  const lengths = packLengths(packOffers);
  // A pack that never ends has no days, so the tab picked is found by its place rather than by a value that may be null.
  const chosenIndex = lengths.findIndex((days) => packLengthKey(days) === chosenLength);
  const length = chosenIndex >= 0 ? lengths[chosenIndex] : lengths[0];
  const sectionPacks = packSection ? packOffers.filter((offer) => offer.days === length) : [];

  // A plan's card, from the plan list and billing.json's words for it, else the built-in ones.
  const planCard = (slug: Plan, popular: boolean, card: PlanDisplayCard | null): PlanCardView => {
    const paid = slug === "starter" || slug === "pro";
    const busy = slug === "free_cloud" ? pendingPlan === "free_cloud" : paid && pendingPlan === "paid";
    const offer = findPlan(plans, slug);
    const values = planValues(offer, plans.currency, locale);
    // Free costs nothing and Enterprise is priced by agreement; a paid plan shows a month of the selected interval.
    const monthly = paid ? monthlyPriceCents(offer, interval) : undefined;
    const price = slug === "free_cloud" ? formatMoney(0, plans.currency, locale) : paid && !offer?.custom ? (monthly === undefined ? "—" : formatMoney(monthly, plans.currency, locale)) : t("plan.tiers.enterprise.price");
    // billing.json's words for the card where it gives them, with this plan's values; the built-in words for the rest.
    const textValues = card ? planTextValues(offer, plans.currency, locale, translate, appName) : {};
    return {
      key: slug,
      name: t(`plan.tiers.${slug}.name`),
      price,
      priceSuffix: t(`plan.tiers.${slug}.period`),
      description: card?.description ? cardText(card.description, interval, locale, textValues) : paid ? t(`plan.tiers.${slug}.description.${interval}`, { minutes: values.minutes }) : t(`plan.tiers.${slug}.description`),
      bullets: card?.bullets ? cardBullets(card.bullets, offer, plans.currency, locale, translate, textValues) : builtInFeatures[slug].map((feature) => t(`plan.tiers.${slug}.highlights.${feature}`, planStringValues(feature, values))),
      popular,
      badge: popular ? (card?.badge ? displayText(card.badge, locale, textValues) : t("plan.popular")) : null,
      action: { label: card?.button ? cardText(card.button, interval, locale, textValues) : paid ? t(`plan.tiers.${slug}.cta.${interval}`) : t(`plan.tiers.${slug}.cta`), disabled: !business || Boolean(pendingPlan) || (paid && (!billing.data?.checkoutAvailable || Boolean(configuredIntervals && !configuredIntervals[slug].includes(interval)))), busy, onClick: () => act(slug) },
      note: null,
    };
  };
  // A pack's card, a plan's card in every part: its price for its length, its words from billing.json where it gives
  // them, else the built-in ones, and its allowances for that length.
  const packCard = (offer: BillingPackOfferViewModel, popular: boolean, card: PlanDisplayPackCard | null): PlanCardView => {
    const textValues = packTextValues(offer, locale, translate, appName);
    const days = offer.days === null ? null : packLengthName(offer.days, locale, translate);
    const minutes = offer.minutes.toLocaleString(intlLocale(locale));
    const button = card?.button ? displayText(card.button, locale, textValues) : packSectionText(display, "button", locale, pageValues) ?? (days === null ? t("plan.packs.ctaNoEnd") : t("plan.packs.cta", { days }));
    return {
      key: `pack:${offer.code}`,
      name: packName(offer, locale),
      price: packPrice(offer, locale),
      priceSuffix: packPriceSuffix(offer.days, locale, translate),
      description: card?.description ? displayText(card.description, locale, textValues) : days === null ? t("plan.packs.cardDescriptionNoEnd", { minutes }) : t("plan.packs.cardDescription", { minutes, days }),
      bullets: packCardBullets(card, offer, locale, translate, textValues),
      popular,
      badge: popular ? (card?.badge ? displayText(card.badge, locale, textValues) : t("plan.popular")) : null,
      action: { label: button, disabled: !business || Boolean(pendingPlan) || !offer.checkoutAvailable, busy: pendingPlan === "pack" && packCheckout.pendingPack === offer.code, onClick: () => buyPack(offer.code) },
      note: offer.checkoutAvailable ? null : packUnavailable,
    };
  };

  return (
    <div className="flex flex-col gap-12">
      {packReturnId && packReturn.outcome === "waiting" ? <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />{t("plan.packs.waiting")}</p> : null}
      {packReturnId && packReturn.outcome === "processing" ? <div className="flex flex-col items-center gap-3 text-center" role="status"><p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t("plan.packs.processing")}</p><Button className="rounded-full" onClick={packReturn.checkAgain} size="sm" type="button" variant="outline">{t("plan.packs.checkAgain")}</Button></div> : null}
      {packReturnFailed ? <FieldError className="text-center">{t(packReturnFailed === "refunded" ? "plan.packs.refunded" : "plan.packs.failed")}</FieldError> : null}

      {/* No tab for an interval no plan has a price for, such as Annual where plans sell monthly only. */}
      {tabs.length > 0 ? <div className="flex justify-center">
        {/* On a narrow phone the Annual tab puts its badge under its name, and wraps it if need be, rather than overflow the screen. */}
        <div aria-label={t("plan.billingInterval.label")} className="inline-flex max-w-full rounded-full border border-border bg-input/30 p-1" role="tablist">
          {tabs.map((value) => <Button aria-selected={interval === value} className={cn("h-auto min-h-9 shrink flex-wrap gap-x-2 gap-y-0.5 whitespace-normal rounded-full px-3 py-1 sm:px-4", interval === value ? "bg-background text-foreground shadow-sm hover:bg-background" : "border-transparent bg-transparent text-muted-foreground hover:bg-muted")} disabled={Boolean(pendingPlan) || (availableIntervals.length > 0 && !availableIntervals.includes(value))} key={value} onClick={() => setChosenInterval(value)} role="tab" size="sm" type="button" variant="outline">{t(`plan.billingInterval.${value}`)}{value === "annual" && annualBadgeText !== null ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-center text-xs font-medium text-emerald-700">{annualBadgeText}</span> : null}</Button>)}
        </div>
      </div> : null}
      {/* A promo link's code waits here from sign-up, filled in and checked. */}
      {business && billing.data?.checkoutAvailable ? <div className="-mt-6 flex justify-center"><PromoCodeEntry businessId={business.businessId} /></div> : null}
      <div className={cn("grid gap-6", planCardColumns(shownCards.length))}>
        {shownCards.map((shown) => <PlanStepCard card={shown.kind === "pack" ? packCard(packOffers.find((entry) => entry.code === shown.pack)!, shown.popular, shown.display) : planCard(shown.plan, shown.popular, shown.display)} key={shown.kind === "pack" ? `pack:${shown.pack}` : shown.plan} />)}
      </div>
      {packSection ? <section className="flex flex-col gap-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-2 text-center"><h2 className="font-heading text-xl font-semibold tracking-tight">{packSectionText(display, "title", locale, pageValues) ?? t("plan.packs.title")}</h2><p className="text-sm leading-relaxed text-muted-foreground">{packSectionText(display, "description", locale, pageValues) ?? t("plan.packs.description")}</p></div>
        {lengths.length > 1 ? <div className="flex justify-center">
          <div aria-label={t("plan.packs.lengthLabel")} className="inline-flex max-w-full flex-wrap justify-center rounded-full border border-border bg-input/30 p-1" role="tablist">
            {lengths.map((days) => <Button aria-selected={days === length} className={cn("h-auto min-h-9 shrink whitespace-normal rounded-full px-3 py-1 sm:px-4", days === length ? "bg-background text-foreground shadow-sm hover:bg-background" : "border-transparent bg-transparent text-muted-foreground hover:bg-muted")} disabled={Boolean(pendingPlan)} key={packLengthKey(days)} onClick={() => setChosenLength(packLengthKey(days))} role="tab" size="sm" type="button" variant="outline">{packLengthName(days, locale, translate)}</Button>)}
          </div>
        </div> : null}
        <div className={cn("grid gap-6", planCardColumns(sectionPacks.length))}>
          {sectionPacks.map((offer) => <PlanStepCard card={packCard(offer, false, null)} key={`pack:${offer.code}`} />)}
        </div>
      </section> : null}
      {packPrompt ? <div className="flex justify-center"><BillingEmailForm key={packPrompt.pack} onCancel={packCheckout.dismissEmailPrompt} onSubmit={(billingEmail) => packCheckout.start(packPrompt.pack, billingEmail)} pending={pendingPlan === "pack"} refusal={packPrompt.refusal} refusedEmail={packPrompt.email} /></div> : null}
      {packEndsSubscription ? <PackEndsPlanDialog ends={packEndsSubscription} onConfirm={() => { if (confirmingPack) startPack(confirmingPack); }} onOpenChange={(open) => { if (!open) setConfirmingPack(null); }} open={confirmingPack !== null} pending={pendingPlan === "pack"} /> : null}
      {emailPrompt ? <div className="flex justify-center"><BillingEmailForm key={emailPrompt.target} onCancel={() => setEmailPrompt(null)} onSubmit={(billingEmail) => startCheckout.mutate({ target: emailPrompt.target, billingEmail })} pending={pendingPlan === "paid"} refusal={emailPrompt.refusal} refusedEmail={emailPrompt.email} /></div> : null}
      {selectFree.isError || startCheckout.isError || checkoutError ? <FieldError>{selectFree.error?.message ?? startCheckout.error?.message ?? checkoutError ?? t("plan.continueFailed")}</FieldError> : null}
      <OnboardingPlanComparison display={display} locale={locale} plans={plans} t={t} />
    </div>
  );
}

/**
 * A card on the plan step in its original design, the same for a plan and a
 * pack: its name, its price and what follows it, its description, its button,
 * why the button can't be used where it can't, and its bullets.
 */
function PlanStepCard({ card }: { card: PlanCardView }) {
  return <section className={cn("relative flex flex-col rounded-2xl border bg-background p-8", card.popular ? "border-foreground/30 shadow-sm" : "border-border/60")}>
    {card.badge !== null ? <div className="absolute -top-3 left-8 rounded-full bg-foreground px-3 py-0.5 text-xs font-medium text-background">{card.badge}</div> : null}
    <div className="mb-6"><h3 className="font-heading text-lg font-semibold tracking-tight">{card.name}</h3><div className="mt-3 flex items-baseline gap-1"><span className="font-heading text-4xl font-semibold tracking-tighter">{card.price}</span>{card.priceSuffix !== null ? <span className="text-sm text-muted-foreground">{card.priceSuffix}</span> : null}</div><p className="mt-3 text-sm leading-relaxed text-muted-foreground">{card.description}</p></div>
    <Button className="mb-6 w-full rounded-full" disabled={card.action.disabled} onClick={card.action.onClick} type="button" variant={card.popular ? "default" : "outline"}>{card.action.busy ? <LoaderCircle className="size-4 animate-spin" /> : <>{card.action.label}<ArrowRight className="ml-1 size-4" /></>}</Button>
    {card.note !== null ? <p className="-mt-3 mb-6 text-sm text-muted-foreground">{card.note}</p> : null}
    <div className="flex-1 border-t border-border/50 pt-5"><ul className="space-y-2.5">{card.bullets.map((bullet, index) => <li className="flex items-start gap-2.5 text-sm" key={index}><Check className="mt-0.5 size-3.5 shrink-0 text-foreground/60" /><span className="whitespace-pre-line">{bullet}</span></li>)}</ul></div>
  </section>;
}
