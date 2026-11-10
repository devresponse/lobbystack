"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { billingPlanIncluded, billingPlanName, type BillingPlanLimits, type BillingPlanList, type BillingPlanSlug, type BillingPromoPlanView, type BillingSubscriptionAction, type PlanChangeRefusal } from "@lobbystack/shared";
import { ArrowUpRight, Check } from "lucide-react";
import { toast } from "sonner";
import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { paidPackToastKey, usePackCheckoutReturn } from "@/hooks/use-pack-checkout";
import type { BillingPermissions } from "./billing-past-due-banner";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";

import { PageSurface } from "./page-surface";
import { SectionBlock } from "./section-block";
import { Button } from "./ui/button";
import { useOpenUpgradePlanDialog } from "./upgrade-plan-dialog-context";
import { SpendingCapSection } from "./billing-spending-cap";
import { findPlan, formatMoney, includedLines, isBillingRateLimited, isPlanChangePending, monthlyPriceCents, PLAN_CHANGE_SYNC_MS } from "@/lib/billing-plans";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { Skeleton } from "./ui/skeleton";
import { Surface } from "./ui/surface";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { formatDateTime, intlLocale } from "@/lib/locale";
import type { BillingPackOfferViewModel, BillingPackViewModel, PackCheckoutViewModel, PackUsageViewModel } from "@/lib/page-view-models";
import { setUpgradeInProgress } from "@/lib/upgrade-in-progress";
import { PromoCodeEntry, promoDiscountText } from "./promo-code-entry";
import { formatPackDate, PacksSection } from "./billing-packs";

type Billing = {
  /** The deployment's billing provider, and its name. */
  provider?: string;
  providerName: string;
  /** Cancel plan, Resume and Keep my plan here, where the provider lets the app do them (Stripe). */
  planActions?: boolean;
  /** When the live plan ends unless resumed; null when it renews. */
  cancelsAt: string | null;
  /** A change waiting for the renewal: the plan's code, and its tier and names when the business can read them. */
  nextChange: { plan: string; tier: string | null; names: Record<string, string> | null; interval: string; at: string } | null;
  /** The page where the customer confirms an upgrade's payment, as their bank asks; null when none waits. */
  paymentActionUrl?: string | null;
  availableCheckoutPlans: Array<"starter" | "pro">;
  availableCheckoutIntervals: { starter: string[]; pro: string[] };
  plans: BillingPlanList;
  promoPlan: BillingPromoPlanView | null;
  permissions: BillingPermissions;
  effectivePlan: BillingPlanSlug;
  /** The limits the server enforces now: a promo plan's own, else its tier's. */
  limits: BillingPlanLimits;
  account: { plan: string | null; billingKey: string; billingInterval: string | null; subscriptionState: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; overageSpendingCapCents: number | null } | null;
  usage: Array<{ periodKey: string; usageKind: string; quantity: number; syncStatus: string }>;
  transactions: Array<{ kind: string; sourceId: string; status: string; amountCents: number; refundedAmountCents: number; currency: string; description: string | null; invoiceUrl: string | null; occurredAt: string }>;
  usageStatus: { usageComplete: boolean; voiceBlocked: boolean; alertSmsBlocked: boolean; outboundCallAttemptsBlocked: boolean; overageSpendingCapReached: boolean; overageSpendCents: number; overageSpendingCapCents: number | null; pack?: PackUsageViewModel | null } | null;
  /** The prepaid packs on sale, those the business holds, and whether it may buy one now; absent from answers before packs. */
  packOffers?: BillingPackOfferViewModel[];
  packs?: BillingPackViewModel[];
  packCheckout?: PackCheckoutViewModel | null;
};

/** The plan a waiting change moves to: its own name, its tier's, or its code when the business can't read it. */
function nextPlanName(next: NonNullable<Billing["nextChange"]>, locale: string, t: Translate): string {
  const tierKey = next.tier === "free_cloud" ? "freeCloud" : next.tier === "starter" || next.tier === "pro" || next.tier === "enterprise" ? next.tier : null;
  return (next.names ? billingPlanName(next.names, locale) : null) ?? (tierKey ? t(`billing.planLabels.${tierKey}`) : next.plan);
}

/** What each plan action's success says. */
const planActionToasts: Record<BillingSubscriptionAction, string> = { cancel: "billing.toast.planCanceled", resume: "billing.toast.planResumed", keep: "billing.toast.planKept" };

function formatBillingDate(value: string | null, locale = "en"): string { return value ? formatDateTime(value, locale, { month: "short", day: "numeric", year: "numeric" }) : "—"; }


export function LivePlanSurface() {
  const { i18n, t } = useTranslation("settings");
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const openUpgradePlanDialog = useOpenUpgradePlanDialog();
  const [portalPending, setPortalPending] = useState(false);
  // A cancel, resume or keep the provider is making, which the page follows as it follows a checkout.
  const [planAction, setPlanAction] = useState<{ businessId: string; requestId: string; action: BillingSubscriptionAction } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const { businesses, business } = useActiveBusiness();
  const billing = useQuery({ queryKey: ["billing", business?.businessId], queryFn: () => requestJson<Billing>(`/api/billing?businessId=${encodeURIComponent(business!.businessId)}`), enabled: Boolean(business?.businessId) });


  const returnRequestId = searchParams.get("checkout") === "success" ? searchParams.get("requestId") : null;
  const returnedCheckout = useQuery({
    queryKey: ["billing-checkout-return", business?.businessId, returnRequestId],
    enabled: Boolean(business && returnRequestId),
    queryFn: () => requestJson<{ synced: boolean }>(`/api/billing/checkout?businessId=${encodeURIComponent(business!.businessId)}&requestId=${encodeURIComponent(returnRequestId!)}`),
    refetchInterval: query => query.state.data?.synced ? false : 1500,
  });
  useEffect(() => {
    if (!business || !returnRequestId || !returnedCheckout.data?.synced) return;
    void queryClient.invalidateQueries({ queryKey: ["billing", business.businessId] });
    router.replace("/settings/plan");
  }, [business, returnRequestId, returnedCheckout.data?.synced, queryClient, router]);

  useEffect(() => { if (searchParams.get("checkout") && business?.businessId) void queryClient.invalidateQueries({ queryKey: ["billing", business.businessId] }); }, [business?.businessId, queryClient, searchParams]);

  // Back from a pack's payment page: wait for the payment, then show the pack and say how it went, once.
  const packReturnId = searchParams.get("pack") === "success" ? searchParams.get("packCheckoutId") : null;
  const packReturn = usePackCheckoutReturn(business?.businessId, packReturnId);
  const announcedPackReturn = useRef<string | null>(null);
  useEffect(() => {
    const outcome = packReturn.outcome;
    if (!business || !packReturnId || !outcome || outcome === "waiting") return;
    const key = `${business.businessId}:${packReturnId}`;
    if (announcedPackReturn.current === key) return;
    announcedPackReturn.current = key;
    if (outcome === "paid") toast.success(t("billing.packs.toast.added"));
    else if (outcome === "failed") toast.error(t("billing.packs.toast.failed"));
    else if (outcome === "replaced" || outcome === "refunded") toast.error(t(paidPackToastKey(outcome)));
    else toast(t("billing.packs.toast.processing"));
    void queryClient.invalidateQueries({ queryKey: ["billing", business.businessId] });
    router.replace("/settings/plan");
  }, [business, packReturnId, packReturn.outcome, queryClient, router, t]);

  const planActionMutation = useMutation({
    mutationFn: (input: { businessId: string; action: BillingSubscriptionAction }) => requestJson<{ requestId: string }>("/api/billing/subscription", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result, input) => setPlanAction({ businessId: input.businessId, requestId: result.requestId, action: input.action }),
    onError: (error) => { toast.error(t(isBillingRateLimited(error) ? "billing.toast.rateLimited" : isPlanChangePending(error) ? "billing.toast.planChangeRefused.change_pending" : "billing.toast.planActionFailed")); },
  });
  const planActionStatus = useQuery({
    queryKey: ["billing-subscription-change", planAction?.businessId, planAction?.requestId],
    enabled: Boolean(planAction && planAction.businessId === business?.businessId),
    queryFn: () => requestJson<{ status: string; synced: boolean; refusal: PlanChangeRefusal | null }>(`/api/billing/checkout?businessId=${encodeURIComponent(planAction!.businessId)}&requestId=${encodeURIComponent(planAction!.requestId)}`),
    // Until the provider's webhook shows the change on the plan, or it failed.
    refetchInterval: (query) => query.state.data?.status === "error" || (query.state.data?.status === "changed" && query.state.data.synced) ? false : 1500,
  });
  useEffect(() => {
    const data = planActionStatus.data;
    if (!planAction || !data) return;
    if (data.status === "error") {
      toast.error(data.refusal ? t(`billing.toast.planChangeRefused.${data.refusal}`) : t("billing.toast.planActionFailed"));
      setPlanAction(null);
      return;
    }
    if (data.status !== "changed") return;
    const finish = () => {
      toast.success(t(planActionToasts[planAction.action]));
      void queryClient.invalidateQueries({ queryKey: ["billing", planAction.businessId] });
      setPlanAction(null);
    };
    if (data.synced) { finish(); return; }
    const timer = window.setTimeout(finish, PLAN_CHANGE_SYNC_MS);
    return () => window.clearTimeout(timer);
  }, [planAction, planActionStatus.data, queryClient, t]);

  // The bank wants the upgrade's payment confirmed: its page opens as a checkout does.
  function openPaymentPage(url: string) { setUpgradeInProgress(true); window.location.assign(url); }

  async function openPortal() { if (!business) return; setPortalPending(true); try { const result = await requestJson<{ url: string }>(`/api/billing/portal?businessId=${encodeURIComponent(business.businessId)}`, { method: "POST", body: JSON.stringify({}) }); window.location.assign(result.url); } catch (error) { toast.error(t(isBillingRateLimited(error) ? "billing.toast.rateLimited" : "billing.toast.portalFailed")); } finally { setPortalPending(false); } }

  if (businesses.isLoading || billing.isLoading) return <PageSurface title={t("sections.billing")}><BillingSkeleton t={t} /></PageSurface>;
  if (businesses.isError || billing.isError || !business || !billing.data) return <PageSurface title={t("sections.billing")}><Surface className="flex flex-col items-start gap-4 p-6"><p role="alert">{t("billing.usage.unavailable")}</p><Button variant="outline" onClick={() => { if (businesses.isError || !business) void businesses.refetch(); else void billing.refetch(); }}>{t("billing.actions.retry")}</Button></Surface></PageSurface>;

  const account = billing.data?.account;
  const plan = billing.data.effectivePlan;
  const currency = billing.data.plans.currency;
  // A promo plan the business took with a code, shown by its own name and price while it has the plan's tier.
  const promoPlan = billing.data.promoPlan?.tier === plan ? billing.data.promoPlan : null;
  const money = (cents: number) => formatMoney(cents, promoPlan?.currency ?? currency, i18n.language);
  // The plan's row in the deployment's plan list; self-host has none and no allowances, and a prepaid pack isn't a plan.
  const offer = plan === "self_host" || plan === "prepaid" ? undefined : findPlan(billing.data.plans, plan);
  // Only Starter and Pro are billed by interval: a lapsed annual plan keeps its interval on Free.
  const annual = (plan === "starter" || plan === "pro") && account?.billingInterval === "annual";
  const promoPrice = promoPlan?.prices.find((price) => price.interval === (annual ? "annual" : "monthly"));
  // Free costs nothing, a custom plan has no fixed price (null), and a paid plan shows a month of its
  // interval, or nothing once the plan list no longer sells that price (undefined).
  const monthlyPrice = plan === "free_cloud" ? 0 : promoPrice ? promoPrice.perMonth : offer?.custom ? null : monthlyPriceCents(offer, annual ? "annual" : "monthly");
  // What the plan includes as the server enforces it, so a promo plan shows its own allowances. A pack's
  // minutes show as minutes left instead, since they last the whole pack.
  const included = includedLines(billingPlanIncluded(billing.data.limits), (key, options) => options ? t(key, options) : t(key), i18n.language).filter((line) => plan !== "prepaid" || line.key !== "voiceSeconds").map((line) => line.text);
  const permissions = billing.data?.permissions;
  // A business on a pack can buy Starter or Pro, which ends its packs.
  const canUpgrade = permissions?.hasCheckoutAccess && billing.data?.availableCheckoutPlans.some(target =>
    (plan === "free_cloud" || plan === "prepaid" || (plan === "starter" && target === "pro")) && billing.data.availableCheckoutIntervals[target].length > 0);
  const canManage = permissions?.hasCustomerPortalAccess === true;
  const paymentActionUrl = billing.data.paymentActionUrl ?? null;
  // Cancel, resume and keep a paid plan here on a provider that lets the app do them.
  const paid = plan === "starter" || plan === "pro";
  const planActions = billing.data.planActions === true && paid;
  const planActionPending = planActionMutation.isPending || planAction?.businessId === business.businessId;
  const changeWaits = Boolean(billing.data.nextChange && !billing.data.cancelsAt && !promoPlan?.ends);
  // Anyone who could buy a plan here can enter a code, a business on a pack too, except on a plan billed outside the provider.
  const canEnterCode = permissions?.hasCheckoutAccess === true && (plan === "free_cloud" || plan === "prepaid" || plan === "starter" || plan === "pro");
  const packOffers = billing.data.packOffers ?? [];
  const packs = billing.data.packs ?? [];
  // A code's plan bought from Free or a pack starts a subscription, which ends every pack held, frozen ones too, as the plan dialog warns.
  const packMinutesLeft = plan === "free_cloud" || plan === "prepaid" ? Math.floor(packs.reduce((seconds, pack) => seconds + pack.secondsLeft, 0) / 60) : 0;
  // On the prepaid tier the usage status says what the live packs hold: their minutes left, and when the last of them ends.
  const packUsage = plan === "prepaid" ? billing.data.usageStatus?.pack ?? null : null;
  const prepaidMinutesLeft = Math.floor((packUsage?.secondsLeft ?? 0) / 60);

  return <PageSurface title={t("sections.billing")}>
    <div className="flex w-full flex-col gap-10">
    <SectionBlock title={t("billing.currentPlan.title")}>
      <Surface className="px-6 py-5">
        <div className="flex flex-col gap-6">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <span className="text-xl font-medium leading-7 text-foreground">
                {promoPlan ? billingPlanName(promoPlan.names, i18n.language) ?? t(`billing.planLabels.${promoPlan.tier}Card`) : t(`billing.planLabels.${plan === "free_cloud" ? "freeCloudCard" : plan === "self_host" ? "selfHost" : plan === "starter" ? "starterCard" : plan === "pro" ? "proCard" : plan === "prepaid" ? "prepaidCard" : "enterpriseCard"}`)}
              </span>
              <div className="flex flex-col items-start gap-0.5">
                {plan === "self_host" ? (
                  <span className="text-[15px] leading-6 text-muted-foreground">
                    {t("billing.currentPlan.selfHostNotice")}
                  </span>
                ) : plan === "prepaid" ? packUsage ? <>
                  <div className="flex flex-wrap items-end gap-2">
                    <span className="text-4xl font-semibold tracking-tight text-foreground">
                      {prepaidMinutesLeft.toLocaleString(intlLocale(i18n.language))}
                    </span>
                    <span className="pb-1 text-base text-muted-foreground">
                      {t("billing.currentPlan.prepaidMinutesLeft", { count: prepaidMinutesLeft })}
                    </span>
                  </div>
                  <span className="text-base text-muted-foreground">
                    {packUsage.lastEndsAt ? t("billing.currentPlan.prepaidUntil", { date: formatPackDate(packUsage.lastEndsAt, i18n.language) }) : t("billing.currentPlan.prepaidNeverEnds")}
                  </span>
                </> : null : <div className="flex flex-wrap items-end gap-2">
                  {typeof monthlyPrice === "number" ? (
                    <span className="text-4xl font-semibold tracking-tight text-foreground">
                      {money(monthlyPrice)}
                    </span>
                  ) : monthlyPrice === null ? (
                    <span className="text-base text-muted-foreground">
                      {t("billing.currentPlan.customPricing")}
                    </span>
                  ) : null}
                  {typeof monthlyPrice === "number" ? (
                    <span className="pb-1 text-base text-muted-foreground">
                      {annual
                        ? t("billing.currentPlan.annualEffectiveSuffix")
                        : t("billing.currentPlan.monthlySuffix")}
                    </span>
                  ) : null}
                </div>}
                {(plan === "starter" || plan === "pro") && (
                  <span className="text-base text-muted-foreground">
                    {t("billing.currentPlan.paygMonthlySuffix")}
                  </span>
                )}
                {promoPlan?.discount ? (
                  <span className="text-sm text-emerald-700 dark:text-emerald-400">
                    {promoDiscountText(promoPlan.discount, promoPlan.currency ?? currency, i18n.language, t)}
                  </span>
                ) : null}
                {promoPlan?.ends ? (
                  <span className="text-sm text-muted-foreground">
                    {t(promoPlan.endsWith === "cancel" ? "billing.promo.endsCancel" : "billing.promo.endsTier", { date: formatBillingDate(promoPlan.ends, i18n.language), tier: t(`billing.planLabels.${promoPlan.tier}`) })}
                  </span>
                ) : plan === "prepaid" ? null : billing.data.cancelsAt ? (
                  <span className="text-sm text-muted-foreground">
                    {t("billing.currentPlan.planEndsOn", { date: formatBillingDate(billing.data.cancelsAt, i18n.language) })}
                  </span>
                ) : billing.data.nextChange ? (
                  <span className="text-sm text-muted-foreground">
                    {t("billing.currentPlan.planChangesOn", { plan: nextPlanName(billing.data.nextChange, i18n.language, t), date: formatBillingDate(billing.data.nextChange.at, i18n.language) })}
                  </span>
                ) : null}
                {paymentActionUrl ? (
                  <span className="text-sm text-muted-foreground">
                    {t("billing.currentPlan.completePaymentHint")}
                  </span>
                ) : null}
                {billing.data.provider === "stripe" && paid ? (
                  <span className="text-sm text-muted-foreground">
                    {t("billing.currentPlan.overageNote")}
                  </span>
                ) : null}
              </div>
            </div>

            {plan === "self_host" ? null : <div className="flex flex-col gap-4">
              <span className="text-base font-medium leading-6 text-foreground">
                {t("billing.currentPlan.includedTitle")}
              </span>
              <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {included.map((item) => (
                  <div key={item} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 size-4 text-emerald-500" />
                    <span className="text-[15px] leading-6 text-foreground">{item}</span>
                  </div>
                ))}
              </div>
            </div>}
          </div>
          {canEnterCode ? <PromoCodeEntry key={business.businessId} businessId={business.businessId} changesPlan={plan === "starter" || plan === "pro"} leavesPacks={packMinutesLeft > 0 ? { minutesLeft: packMinutesLeft } : null} /> : null}
          {(canUpgrade || canManage || paymentActionUrl || planActions) && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {paymentActionUrl && (
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  onClick={() => openPaymentPage(paymentActionUrl)}
                >
                  {t("billing.actions.completePayment")}
                  <ArrowUpRight className="size-3.5" />
                </Button>
              )}
              {canUpgrade && (
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  variant="outline"
                  onClick={openUpgradePlanDialog}
                >
                  {t("billing.actions.upgradeToPro")}
                </Button>
              )}
              {/* A promo plan that ends cancelled stays that way: its ending isn't the business's to undo. */}
              {planActions && billing.data.cancelsAt && !promoPlan?.ends ? (
                <Button className="w-full sm:w-auto" size="sm" disabled={planActionPending} onClick={() => planActionMutation.mutate({ businessId: business.businessId, action: "resume" })}>
                  {t("billing.actions.resume")}
                </Button>
              ) : null}
              {planActions && changeWaits ? (
                <Button className="w-full sm:w-auto" size="sm" variant="outline" disabled={planActionPending} onClick={() => planActionMutation.mutate({ businessId: business.businessId, action: "keep" })}>
                  {t("billing.actions.keepPlan")}
                </Button>
              ) : null}
              {canManage && (
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  variant="outline"
                  disabled={portalPending}
                  onClick={() => void openPortal()}
                >
                  {portalPending
                    ? t("billing.actions.openingPortal")
                    : t("billing.actions.manageSubscription")}
                  <ArrowUpRight className="size-3.5" />
                </Button>
              )}
              {planActions && !billing.data.cancelsAt ? (
                <Button className="w-full sm:w-auto" size="sm" variant="outline" disabled={planActionPending} onClick={() => setCancelOpen(true)}>
                  {t("billing.actions.cancelPlan")}
                </Button>
              ) : null}
              <ConfirmActionDialog
                cancelLabel={t("billing.cancelDialog.back")}
                confirmLabel={t("billing.actions.cancelPlan")}
                confirmVariant="destructive"
                description={t("billing.cancelDialog.description", { date: formatBillingDate(account?.currentPeriodEnd ?? null, i18n.language) })}
                onConfirm={async () => { await planActionMutation.mutateAsync({ businessId: business.businessId, action: "cancel" }); }}
                onOpenChange={setCancelOpen}
                open={cancelOpen}
                pending={planActionMutation.isPending}
                title={t("billing.cancelDialog.title")}
              />
            </div>
          )}
        </div>
      </Surface>
    </SectionBlock>
    {plan !== "self_host" ? <>{plan !== "enterprise" ? <PacksSection key={`packs:${business.businessId}`} businessId={business.businessId} eligibility={billing.data.packCheckout ?? { refusal: null, endsSubscription: null }} managesBilling={permissions?.hasBillingManagementAccess === true} offers={packOffers} packs={packs} /> : null}<SpendingCapSection key={business.businessId} businessId={business.businessId} locale={i18n.language} t={(key, options) => t(key, options ?? {})} status={{ plan, currency, overageSpendingCapCents: account?.overageSpendingCapCents ?? null, overageSpendCents: billing.data?.usageStatus?.overageSpendCents ?? 0, overageSpendCentsComplete: billing.data?.usageStatus?.usageComplete ?? true, overageSpendingCapReached: billing.data?.usageStatus?.overageSpendingCapReached ?? false, hasBillingManagementAccess: permissions?.hasBillingManagementAccess === true }} /><Transactions locale={i18n.language} transactions={billing.data?.transactions ?? []} t={t} providerName={billing.data?.providerName ?? ""} /></> : null}
    </div>
  </PageSurface>;
}

type Translate = ReturnType<typeof useTranslation>["t"];
function Transactions({ transactions, t, locale, providerName }: { transactions: Billing["transactions"]; t: Translate; locale: string; providerName: string }) {
  if (!transactions || transactions.length === 0) return null;

  return (
    <SectionBlock
      title={t("billing.transactions.title")}
      description={t("billing.transactions.description", { provider: providerName })}
    >
      <TableCard>
        <Table className="min-w-[42rem]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.date")}
              </TableHead>
              <TableHead className="text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.description")}
              </TableHead>
              <TableHead className="text-right text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.amount")}
              </TableHead>
              <TableHead className="text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.status")}
              </TableHead>
              <TableHead className="text-right text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.invoice")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((tx) => {
              const isRefund = tx.kind === "refund";
              return (
                <TableRow key={tx.sourceId}>
                  <TableCell className="text-sm tabular-nums text-muted-foreground">
                    {formatBillingDate(tx.occurredAt, locale)}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {tx.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums font-medium text-foreground">
                    {isRefund ? "−" : ""}
                    {formatMoney(tx.amountCents, tx.currency, locale)}
                    {tx.refundedAmountCents > 0 ? (
                      <div className="text-xs font-normal text-muted-foreground">
                        {t("billing.transactions.refundedAmount", { amount: formatMoney(tx.refundedAmountCents, tx.currency, locale) })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {t(`billing.transactions.statusLabels.${tx.status}`, { defaultValue: tx.status })}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {tx.invoiceUrl ? (
                      <Button
                        render={
                          <a
                            aria-label={t("billing.transactions.invoice")}
                            href={tx.invoiceUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                          />
                        }
                        variant="ghost"
                        size="sm"
                        className="h-auto gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t("billing.transactions.invoice")}
                        <ArrowUpRight className="size-3" />
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>
    </SectionBlock>
  );
}

function PlanSectionSkeleton({
  t,
}: {
  t: Translate;
}) {
  return (
    <SectionBlock title={t("billing.currentPlan.title")}>
      <Surface className="px-6 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="mt-3 flex gap-2">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-36 rounded-md" />
        </div>
      </Surface>
    </SectionBlock>
  );
}

function SpendingCapSectionSkeleton({
  t,
}: {
  t: Translate;
}) {
  return (
    <SectionBlock title={t("billing.spendingCap.title")}>
      <Surface className="px-6 py-5">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-12 w-full rounded-xl" />
          <div className="flex items-end gap-3">
            <Skeleton className="h-10 max-w-xs flex-1 rounded-xl" />
            <Skeleton className="h-8 w-24 rounded-xl" />
          </div>
        </div>
      </Surface>
    </SectionBlock>
  );
}

function TransactionsSectionSkeleton({
  t,
}: {
  t: Translate;
}) {
  // The provider's name arrives with the billing answer, so the loading state shows the title alone.
  return (
    <SectionBlock
      title={t("billing.transactions.title")}
    >
      <TableCard>
        <Table className="min-w-[42rem]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.date")}
              </TableHead>
              <TableHead className="text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.description")}
              </TableHead>
              <TableHead className="text-right text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.amount")}
              </TableHead>
              <TableHead className="text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.status")}
              </TableHead>
              <TableHead className="text-right text-[13px] font-medium text-muted-foreground">
                {t("billing.transactions.columns.invoice")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 3 }).map((_, index) => (
              <TableRow key={index}>
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-40" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-4 w-12" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>
    </SectionBlock>
  );
}

function BillingSkeleton({
  t,
}: {
  t: Translate;
}) {
  return (
    <div className="flex w-full flex-col gap-10">
      <PlanSectionSkeleton t={t} />
      <SpendingCapSectionSkeleton t={t} />
      <TransactionsSectionSkeleton t={t} />
    </div>
  );
}
