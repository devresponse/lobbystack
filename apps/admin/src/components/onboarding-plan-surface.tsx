"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { useStepNavigation } from "@/lib/use-step-navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { brandLinks, contactEmailFor, type BillingPlanList, type PlanChangeRefusal } from "@lobbystack/shared";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { BillingEmailForm, isBillingEmailRefusal, type BillingEmailRefusal } from "@/components/billing-email-form";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { OnboardingPlanComparison } from "@/components/onboarding-plan-comparison";
import { PromoCodeEntry } from "@/components/promo-code-entry";
import { useTelemetry } from "@/components/product-analytics";
import { annualBadge, findPlan, formatMoney, monthlyPriceCents, planStringValues, planValues } from "@/lib/billing-plans";
import { cn } from "@/lib/utils";

type BillingInterval = "monthly" | "annual";
type Plan = "free_cloud" | "starter" | "pro" | "enterprise";
type Checkout = { id: string; status: string; checkoutUrl: string | null; error: string | null; refusal: PlanChangeRefusal | null };
type CheckoutInput = { target: "starter" | "pro"; billingEmail?: string };
type BillingStatus = { checkoutAvailable: boolean; effectivePlan?: string; availableCheckoutPlans?: Array<"starter" | "pro">; availableCheckoutIntervals?: { starter: BillingInterval[]; pro: BillingInterval[] }; plans: BillingPlanList };

const tiers: Array<{ slug: Plan; highlight?: boolean; features: string[] }> = [
  { slug: "free_cloud", features: ["voiceMinutes", "bookingContacts", "support"] },
  { slug: "starter", features: ["voiceMinutes", "dedicatedNumber", "alertSms", "support"] },
  { slug: "pro", highlight: true, features: ["voiceMinutes", "dedicatedNumber", "alertSms", "support"] },
  { slug: "enterprise", features: ["phoneNumbers", "selfHosted", "support"] },
];

const REPORTED_CHECKOUT_KEY = "lobbystack.onboarding.checkoutReported";

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
  const { navigate, navigating, router } = useStepNavigation();
  const telemetry = useTelemetry();
  const searchParams = useSearchParams();
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const [checkoutRequestId, setCheckoutRequestId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // A checkout Polar couldn't make this business's customer for starts again with a billing email.
  const [emailPrompt, setEmailPrompt] = useState<{ refusal: BillingEmailRefusal; email: string | null; target: "starter" | "pro" } | null>(null);
  const returnAttempt = useRef<{ key: string; promise: Promise<unknown> } | null>(null);
  const { business } = useActiveBusiness();
  const billing = useQuery({ queryKey: ["billing", business?.businessId], queryFn: () => requestJson<BillingStatus>(`/api/billing?businessId=${encodeURIComponent(business!.businessId)}`), enabled: Boolean(business) });
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
  const keepPlan = useMutation({
    mutationFn: () => requestJson(`/api/onboarding/stage?businessId=${encodeURIComponent(business!.businessId)}`, { method: "POST", body: JSON.stringify({ to: "phone_number" }) }),
    onSuccess: () => navigate("/onboarding/number"),
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

  const configuredIntervals = billing.data?.availableCheckoutIntervals;
  const availableIntervals = (["monthly", "annual"] as const).filter(value => !configuredIntervals || configuredIntervals.starter.includes(value) || configuredIntervals.pro.includes(value));
  useEffect(() => {
    if (availableIntervals.length && !availableIntervals.includes(interval)) setInterval(availableIntervals[0]!);
  }, [availableIntervals, interval]);

  const pendingPlan = selectFree.isPending || navigating ? "free_cloud" : startCheckout.isPending || checkoutRequestId ? "paid" : null;

  function act(plan: Plan) {
    if (!business || pendingPlan) return;
    setCheckoutError(null);
    setEmailPrompt(null);
    telemetry.track("web.onboarding.plan_selected", { businessId: business.businessId, plan });
    if (plan === "free_cloud") selectFree.mutate();
    else if (plan === "starter" || plan === "pro") {
      telemetry.track("web.onboarding.plan_checkout_started", { businessId: business.businessId, plan });
      startCheckout.mutate({ target: plan });
    }
    else window.location.assign(`mailto:${contactEmailFor(brandLinks(), "sales")}?subject=${encodeURIComponent(t("plan.enterpriseSubject"))}`);
  }

  // A business that already has a paid plan, such as one LobbyStack bills directly, has nothing to buy here.
  const effectivePlan = billing.data?.effectivePlan;
  const currentPlan = (effectivePlan === "starter" || effectivePlan === "pro" || effectivePlan === "enterprise") && !returnRequestId ? effectivePlan : null;
  if (currentPlan) {
    return <section className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border/60 bg-background p-8 text-center">
      <h3 className="font-heading text-lg font-semibold tracking-tight">{t("plan.current.title", { plan: t(`plan.tiers.${currentPlan}.name`) })}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("plan.current.description")}</p>
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
  const annualBadgeText = annualBadge(plans, (key, options) => t(key, options), "plan.billingInterval.freeMonths", "plan.billingInterval.save");

  return (
    <div className="flex flex-col gap-12">

      <div className="flex justify-center">
        {/* On a narrow phone the Annual tab puts its badge under its name, and wraps it if need be, rather than overflow the screen. */}
        <div aria-label={t("plan.billingInterval.label")} className="inline-flex max-w-full rounded-full border border-border bg-input/30 p-1" role="tablist">
          {(["monthly", "annual"] as const).map((value) => <Button aria-selected={interval === value} className={cn("h-auto min-h-9 shrink flex-wrap gap-x-2 gap-y-0.5 whitespace-normal rounded-full px-3 py-1 sm:px-4", interval === value ? "bg-background text-foreground shadow-sm hover:bg-background" : "border-transparent bg-transparent text-muted-foreground hover:bg-muted")} disabled={Boolean(pendingPlan) || (availableIntervals.length > 0 && !availableIntervals.includes(value))} key={value} onClick={() => setInterval(value)} role="tab" size="sm" type="button" variant="outline">{t(`plan.billingInterval.${value}`)}{value === "annual" && annualBadgeText !== null ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-center text-xs font-medium text-emerald-700">{annualBadgeText}</span> : null}</Button>)}
        </div>
      </div>
      {/* A promo link's code waits here from sign-up, filled in and checked. */}
      {business && billing.data?.checkoutAvailable ? <div className="-mt-6 flex justify-center"><PromoCodeEntry businessId={business.businessId} /></div> : null}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {tiers.map((tier) => {
          const paid = tier.slug === "starter" || tier.slug === "pro";
          const busy = tier.slug === "free_cloud" ? pendingPlan === "free_cloud" : paid && pendingPlan === "paid";
          const offer = findPlan(plans, tier.slug);
          const values = planValues(offer, plans.currency, locale);
          // Free costs nothing and Enterprise is priced by agreement; a paid plan shows a month of the selected interval.
          const monthly = paid ? monthlyPriceCents(offer, interval) : undefined;
          const price = tier.slug === "free_cloud" ? formatMoney(0, plans.currency, locale) : paid && !offer?.custom ? (monthly === undefined ? "—" : formatMoney(monthly, plans.currency, locale)) : t("plan.tiers.enterprise.price");
          const description = paid ? t(`plan.tiers.${tier.slug}.description.${interval}`, { minutes: values.minutes }) : t(`plan.tiers.${tier.slug}.description`);
          const cta = paid ? t(`plan.tiers.${tier.slug}.cta.${interval}`) : t(`plan.tiers.${tier.slug}.cta`);
          return <section className={cn("relative flex flex-col rounded-2xl border bg-background p-8", tier.highlight ? "border-foreground/30 shadow-sm" : "border-border/60")} key={tier.slug}>
            {tier.highlight ? <div className="absolute -top-3 left-8 rounded-full bg-foreground px-3 py-0.5 text-xs font-medium text-background">{t("plan.popular")}</div> : null}
            <div className="mb-6"><h3 className="font-heading text-lg font-semibold tracking-tight">{t(`plan.tiers.${tier.slug}.name`)}</h3><div className="mt-3 flex items-baseline gap-1"><span className="font-heading text-4xl font-semibold tracking-tighter">{price}</span><span className="text-sm text-muted-foreground">{t(`plan.tiers.${tier.slug}.period`)}</span></div><p className="mt-3 text-sm leading-relaxed text-muted-foreground">{description}</p></div>
            <Button className="mb-6 w-full rounded-full" disabled={!business || Boolean(pendingPlan) || (paid && (!billing.data?.checkoutAvailable || (configuredIntervals && !configuredIntervals[tier.slug as "starter" | "pro"].includes(interval))))} onClick={() => act(tier.slug)} type="button" variant={tier.highlight ? "default" : "outline"}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <>{cta}<ArrowRight className="ml-1 size-4" /></>}</Button>
            <div className="flex-1 border-t border-border/50 pt-5"><ul className="space-y-2.5">{tier.features.map((feature) => <li className="flex items-start gap-2.5 text-sm" key={feature}><Check className="mt-0.5 size-3.5 shrink-0 text-foreground/60" /><span className="whitespace-pre-line">{t(`plan.tiers.${tier.slug}.highlights.${feature}`, planStringValues(feature, values))}</span></li>)}</ul></div>
          </section>;
        })}
      </div>
      {emailPrompt ? <div className="flex justify-center"><BillingEmailForm key={emailPrompt.target} onCancel={() => setEmailPrompt(null)} onSubmit={(billingEmail) => startCheckout.mutate({ target: emailPrompt.target, billingEmail })} pending={pendingPlan === "paid"} refusal={emailPrompt.refusal} refusedEmail={emailPrompt.email} /></div> : null}
      {selectFree.isError || startCheckout.isError || checkoutError ? <FieldError>{selectFree.error?.message ?? startCheckout.error?.message ?? checkoutError ?? t("plan.continueFailed")}</FieldError> : null}
      <OnboardingPlanComparison locale={locale} plans={plans} t={t} />
    </div>
  );
}
