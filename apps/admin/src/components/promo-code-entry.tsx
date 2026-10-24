"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { billingPlanName, type BillingCodeView, type BillingInterval, type PlanChangeRefusal, type ResolvedBillingDiscount } from "@lobbystack/shared";
import { Check, LoaderCircle } from "lucide-react";

import { formatMoney, includedLines, PLAN_CHANGE_SYNC_MS } from "@/lib/billing-plans";
import { requestJson } from "@/lib/request-json";
import { capturePromoCodeFromUrl, clearStoredPromoCode, getStoredPromoCode } from "@/lib/promo-code";
import { setUpgradeInProgress } from "@/lib/upgrade-in-progress";
import { BillingEmailForm, isBillingEmailRefusal, type BillingEmailRefusal } from "./billing-email-form";
import { Button } from "./ui/button";
import { FieldError } from "./ui/field";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Translate = ReturnType<typeof useTranslation>["t"];
type CheckoutStatus = { status: string; checkoutUrl: string | null; error: string | null; synced: boolean; refusal: PlanChangeRefusal | null };
type Checkout = { requestId: string; interval: BillingInterval; billingEmail: string | null };

const errorKeys: Record<string, string> = {
  promo_invalid: "billing.promo.errors.invalid",
  promo_current: "billing.promo.errors.current",
  promo_interval: "billing.promo.errors.interval",
  promo_rate_limited: "billing.promo.errors.rateLimited",
};

function errorMessage(error: unknown, t: Translate, fallback: string): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
  return code && errorKeys[code] ? t(errorKeys[code]) : fallback;
}

/** What the discount takes off and for how long, such as "20% off for 3 months". */
export function promoDiscountText(discount: ResolvedBillingDiscount, currency: string | null, locale: string, t: Translate): string {
  const amount = discount.type === "percentage"
    ? t("billing.promo.discount.percentage", { percent: (discount.basis_points ?? 0) / 100 })
    : t("billing.promo.discount.fixed", { amount: formatMoney(discount.amount_cents ?? 0, currency ?? "usd", locale) });
  if (discount.duration === "repeating") return t("billing.promo.discount.repeating", { discount: amount, count: discount.duration_in_months ?? 1 });
  return t(`billing.promo.discount.${discount.duration}`, { discount: amount });
}

/**
 * "Have a promo code?": a link that opens a code field, shows the plan the code
 * unlocks with its discount, and buys it at the interval chosen. A code from a
 * promo link (?promo=, kept through sign-up) is filled in and checked at once.
 * A business that already pays has its subscription moved instead of a checkout.
 */
export function PromoCodeEntry({ businessId, changesPlan = false }: { businessId: string; changesPlan?: boolean }) {
  const { i18n, t } = useTranslation("settings");
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [view, setView] = useState<BillingCodeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  // A checkout Polar couldn't make this business's customer for starts again with a billing email.
  const [emailPrompt, setEmailPrompt] = useState<{ refusal: BillingEmailRefusal; email: string | null; interval: BillingInterval } | null>(null);
  const redirected = useRef<string | null>(null);
  const announced = useRef<string | null>(null);

  const lookup = useMutation({
    mutationFn: (code: string) => requestJson<BillingCodeView>(`/api/billing/promo?businessId=${encodeURIComponent(businessId)}`, { method: "POST", body: JSON.stringify({ code }) }),
    onMutate: () => { setError(null); setView(null); setEmailPrompt(null); },
    onSuccess: (result) => {
      setView(result);
      setValue(result.code);
      // Nor should one for the plan the business already has: each check spends one of its tries.
      if (result.current) clearStoredPromoCode();
    },
    onError: (cause) => {
      setError(errorMessage(cause, t, t("billing.promo.errors.failed")));
      // A link's code that doesn't work shouldn't come back on every visit.
      if ((cause as { code?: string }).code === "promo_invalid") clearStoredPromoCode();
    },
  });
  const start = useMutation({
    mutationFn: (input: { code: BillingCodeView; interval: BillingInterval; billingEmail?: string }) => requestJson<{ requestId: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ businessId, target: input.code.tier, billingInterval: input.interval, promoCode: input.code.code, ...(input.billingEmail ? { billingEmail: input.billingEmail } : {}) }) }),
    onMutate: () => setError(null),
    onSuccess: (result, input) => setCheckout({ requestId: result.requestId, interval: input.interval, billingEmail: input.billingEmail ?? null }),
    onError: (cause) => setError(errorMessage(cause, t, t(changesPlan ? "billing.toast.planChangeFailed" : "billing.toast.checkoutFailed"))),
  });
  const status = useQuery({
    queryKey: ["billing-promo-checkout", businessId, checkout?.requestId],
    enabled: Boolean(checkout),
    queryFn: () => requestJson<CheckoutStatus>(`/api/billing/checkout?businessId=${encodeURIComponent(businessId)}&requestId=${encodeURIComponent(checkout!.requestId)}`),
    refetchInterval: (query) => ["ready", "error"].includes(query.state.data?.status ?? "") || (query.state.data?.status === "changed" && query.state.data.synced) ? false : 1500,
  });

  // A code from a promo link, or one kept from sign-up, is checked as soon as the screen opens.
  const checkLinkCode = lookup.mutate;
  useEffect(() => {
    const code = capturePromoCodeFromUrl(new URL(window.location.href)) ?? getStoredPromoCode();
    if (!code) return;
    setOpen(true);
    setValue(code);
    checkLinkCode(code);
  }, [businessId, checkLinkCode]);

  useEffect(() => {
    if (!checkout) return;
    const result = status.data;
    if (result?.status === "ready" && result.checkoutUrl && redirected.current !== checkout.requestId) {
      redirected.current = checkout.requestId;
      clearStoredPromoCode();
      setUpgradeInProgress(true, "promo");
      window.location.assign(result.checkoutUrl);
    }
    if (result?.status === "error" || status.isError) {
      const refusal = result?.refusal;
      if (isBillingEmailRefusal(refusal)) setEmailPrompt({ refusal, email: checkout.billingEmail, interval: checkout.interval });
      else setError(refusal ? t(`billing.toast.planChangeRefused.${refusal}`) : t(changesPlan ? "billing.toast.planChangeFailed" : "billing.toast.checkoutFailed"));
      setCheckout(null);
    }
  }, [changesPlan, checkout, status.data, status.isError, t]);
  useEffect(() => {
    // A business that already pays has its subscription moved, with no checkout page to visit.
    if (!checkout || status.data?.status !== "changed") return;
    if (announced.current !== checkout.requestId) {
      announced.current = checkout.requestId;
      clearStoredPromoCode();
      toast.success(t("billing.toast.planChanged"));
    }
    const finish = () => {
      void client.invalidateQueries({ queryKey: ["billing", businessId] });
      setCheckout(null);
      setView(null);
      setOpen(false);
      setValue("");
    };
    if (status.data.synced) { finish(); return; }
    const timer = window.setTimeout(finish, PLAN_CHANGE_SYNC_MS);
    return () => window.clearTimeout(timer);
  }, [businessId, checkout, client, status.data, t]);
  useEffect(() => {
    // The back button from checkout can restore this page from the browser's cache, still waiting on it.
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) { setCheckout(null); setUpgradeInProgress(false, "promo"); } };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim() || lookup.isPending) return;
    lookup.mutate(value);
  }

  function close() {
    setOpen(false);
    setValue("");
    setView(null);
    setError(null);
    setEmailPrompt(null);
    clearStoredPromoCode();
  }

  const busy = start.isPending || Boolean(checkout);
  useEffect(() => {
    // Buying the code's plan, or waiting for the change to it, is not leaving.
    if (!busy) return;
    setUpgradeInProgress(true, "promo");
    return () => setUpgradeInProgress(false, "promo");
  }, [busy]);
  const locale = i18n.language;
  if (!open) {
    return <button className="self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => setOpen(true)} type="button">{t("billing.promo.link")}</button>;
  }
  return <div className="flex w-full max-w-xl flex-col gap-3">
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <Label htmlFor={`promo-code-${businessId}`}>{t("billing.promo.label")}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input aria-invalid={error ? true : undefined} autoCapitalize="characters" autoComplete="off" disabled={busy} id={`promo-code-${businessId}`} maxLength={64} onChange={(event) => setValue(event.target.value)} placeholder={t("billing.promo.placeholder")} spellCheck={false} value={value} />
        <div className="flex gap-2">
          <Button disabled={!value.trim() || lookup.isPending || busy} size="sm" type="submit">{lookup.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{lookup.isPending ? t("billing.promo.applying") : t("billing.promo.apply")}</Button>
          <Button disabled={busy} onClick={close} size="sm" type="button" variant="ghost">{t("billing.promo.cancel")}</Button>
        </div>
      </div>
    </form>
    {error ? <FieldError>{error}</FieldError> : null}
    {view ? <PromoOffer busy={busy} changesPlan={changesPlan} locale={locale} onChoose={(interval) => { setEmailPrompt(null); start.mutate({ code: view, interval }); }} pendingInterval={start.isPending ? start.variables.interval : checkout?.interval ?? null} t={t} view={view} /> : null}
    {view && emailPrompt ? <BillingEmailForm key={emailPrompt.interval} onCancel={() => setEmailPrompt(null)} onSubmit={(billingEmail) => start.mutate({ code: view, interval: emailPrompt.interval, billingEmail })} pending={busy} refusal={emailPrompt.refusal} refusedEmail={emailPrompt.email} /> : null}
  </div>;
}

function PromoOffer({ view, locale, t, busy, changesPlan, pendingInterval, onChoose }: { view: BillingCodeView; locale: string; t: Translate; busy: boolean; changesPlan: boolean; pendingInterval: BillingInterval | null; onChoose: (interval: BillingInterval) => void }) {
  const name = billingPlanName(view.names, locale) ?? t(`billing.planLabels.${view.tier}`);
  const tier = t(`billing.planLabels.${view.tier}`);
  // The plan's own allowances, each one it has more of than its tier marked.
  const included = includedLines(view.included, (key, options) => options ? t(key, options) : t(key), locale);
  return <section aria-label={name} className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-background p-5">
    <div className="flex flex-col gap-1">
      <span className="text-base font-medium text-foreground">{t("billing.promo.unlocks", { plan: name })}</span>
      {view.discount ? <span className="text-sm text-emerald-700 dark:text-emerald-400">{promoDiscountText(view.discount, view.currency, locale, t)}</span> : null}
      <span className="text-sm text-muted-foreground">{t("billing.promo.features", { tier })}</span>
      <ul className="mt-1 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {included.map((line) => <li className="flex items-start gap-2 text-sm text-foreground" key={line.key}>
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <span>{line.text}{view.moreThanTier.includes(line.key) ? <span className="ml-1.5 text-emerald-700 dark:text-emerald-400">{t("billing.promo.moreThanTier", { tier })}</span> : null}</span>
        </li>)}
      </ul>
    </div>
    {view.current ? <p className="text-sm text-muted-foreground">{t("billing.promo.errors.current")}</p> : <div className="flex flex-col gap-3 sm:flex-row">
      {view.prices.map((price) => {
        const discounted = price.discountedCents !== price.cents;
        return <div className="flex flex-1 flex-col gap-2 rounded-xl border border-border/60 p-4" key={price.interval}>
          <span className="text-sm text-muted-foreground">{t(`billing.promo.interval.${price.interval}`)}</span>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight text-foreground">{formatMoney(price.discountedCents, view.currency, locale)}</span>
            {discounted ? <span className="text-sm text-muted-foreground line-through">{formatMoney(price.cents, view.currency, locale)}</span> : null}
            <span className="text-sm text-muted-foreground">{t(`billing.promo.per.${price.interval}`)}</span>
          </div>
          <Button disabled={busy || !price.checkoutAvailable} onClick={() => onChoose(price.interval)} size="sm" type="button">
            {pendingInterval === price.interval ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
            {!price.checkoutAvailable ? t("billing.promo.unavailable") : pendingInterval === price.interval ? t(changesPlan ? "billing.actions.changingPlan" : "billing.actions.openingCheckout") : t(`billing.promo.${changesPlan ? "change" : "subscribe"}.${price.interval}`)}
          </Button>
        </div>;
      })}
    </div>}
  </section>;
}
