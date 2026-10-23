"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { billingPlanName, type BillingPlanList, type BillingPlanSlug, type BillingPromoPlanView } from "@lobbystack/shared";
import { ArrowUpRight, Check } from "lucide-react";
import { toast } from "sonner";
import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import type { BillingPermissions } from "./billing-past-due-banner";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";

import { PageSurface } from "./page-surface";
import { SectionBlock } from "./section-block";
import { Button } from "./ui/button";
import { useOpenUpgradePlanDialog } from "./upgrade-plan-dialog-context";
import { SpendingCapSection } from "./billing-spending-cap";
import { findPlan, formatMoney, monthlyPriceCents, storageSize } from "@/lib/billing-plans";
import { Skeleton } from "./ui/skeleton";
import { Surface } from "./ui/surface";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { formatDateTime } from "@/lib/locale";
import { PromoCodeEntry, promoDiscountText } from "./promo-code-entry";

type Billing = {
  availableCheckoutPlans: Array<"starter" | "pro">;
  availableCheckoutIntervals: { starter: string[]; pro: string[] };
  plans: BillingPlanList;
  promoPlan: BillingPromoPlanView | null;
  permissions: BillingPermissions;
  effectivePlan: BillingPlanSlug;
  account: { plan: string | null; billingKey: string; billingInterval: string | null; subscriptionState: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; overageSpendingCapCents: number | null } | null;
  usage: Array<{ periodKey: string; usageKind: string; quantity: number; syncStatus: string }>;
  transactions: Array<{ kind: string; sourceId: string; status: string; amountCents: number; refundedAmountCents: number; currency: string; description: string | null; invoiceUrl: string | null; occurredAt: string }>;
  usageStatus: { usageComplete: boolean; voiceBlocked: boolean; alertSmsBlocked: boolean; outboundCallAttemptsBlocked: boolean; overageSpendingCapReached: boolean; overageSpendCents: number; overageSpendingCapCents: number | null } | null;
};

function formatBillingDate(value: string | null, locale = "en"): string { return value ? formatDateTime(value, locale, { month: "short", day: "numeric", year: "numeric" }) : "—"; }


export function LivePlanSurface() {
  const { i18n, t } = useTranslation("settings");
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const openUpgradePlanDialog = useOpenUpgradePlanDialog();
  const [portalPending, setPortalPending] = useState(false);
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

  async function openPortal() { if (!business) return; setPortalPending(true); try { const result = await requestJson<{ url: string }>(`/api/billing/portal?businessId=${encodeURIComponent(business.businessId)}`, { method: "POST", body: JSON.stringify({}) }); window.location.assign(result.url); } catch { toast.error(t("billing.toast.portalFailed")); } finally { setPortalPending(false); } }

  if (businesses.isLoading || billing.isLoading) return <PageSurface title={t("sections.billing")}><BillingSkeleton t={t} /></PageSurface>;
  if (businesses.isError || billing.isError || !business || !billing.data) return <PageSurface title={t("sections.billing")}><Surface className="flex flex-col items-start gap-4 p-6"><p role="alert">{t("billing.usage.unavailable")}</p><Button variant="outline" onClick={() => { if (businesses.isError || !business) void businesses.refetch(); else void billing.refetch(); }}>{t("billing.actions.retry")}</Button></Surface></PageSurface>;

  const account = billing.data?.account;
  const plan = billing.data.effectivePlan;
  const currency = billing.data.plans.currency;
  // A promo plan the business took with a code, shown by its own name and price while it has the plan's tier.
  const promoPlan = billing.data.promoPlan?.tier === plan ? billing.data.promoPlan : null;
  const money = (cents: number) => formatMoney(cents, promoPlan?.currency ?? currency, i18n.language);
  // The plan's row in the deployment's plan list; self-host has none and no allowances.
  const offer = plan === "self_host" ? undefined : findPlan(billing.data.plans, plan);
  const allowance = offer?.included;
  const promoPrice = promoPlan?.prices.find((price) => price.interval === (account?.billingInterval === "annual" ? "annual" : "monthly"));
  // Free and self-host cost nothing, a custom plan has no fixed price, and a paid plan shows a month of its interval.
  const monthlyPrice = plan === "self_host" || plan === "free_cloud" ? 0 : promoPrice ? promoPrice.perMonth : offer?.custom ? null : monthlyPriceCents(offer, account?.billingInterval === "annual" ? "annual" : "monthly") ?? null;
  const count = (value: number | null | undefined, key: string) => value === null || value === undefined ? t(`billing.currentPlan.${key}Custom`) : t(`billing.currentPlan.${key}`, { count: value });
  const storage = allowance?.knowledgeStorageBytes;
  const included = [count(allowance?.voiceSeconds === null || allowance?.voiceSeconds === undefined ? null : Math.floor(allowance.voiceSeconds / 60), "includedVoice"), count(allowance?.outboundCallAttempts, "includedOutbound"), count(allowance?.alertSmsSegments, "includedSms"), storage === null || storage === undefined ? t("billing.currentPlan.includedStorageCustom") : t("billing.currentPlan.includedStorage", storageSize(storage, i18n.language))];
  const permissions = billing.data?.permissions;
  const canUpgrade = permissions?.hasCheckoutAccess && billing.data?.availableCheckoutPlans.some(target =>
    (plan === "free_cloud" || (plan === "starter" && target === "pro")) && billing.data.availableCheckoutIntervals[target].length > 0);
  const canManage = permissions?.hasCustomerPortalAccess === true;
  // Anyone who could buy a plan here can enter a code, except on a plan billed outside Polar.
  const canEnterCode = permissions?.hasCheckoutAccess === true && (plan === "free_cloud" || plan === "starter" || plan === "pro");

  return <PageSurface title={t("sections.billing")}>
    <div className="flex w-full flex-col gap-10">
    <SectionBlock title={t("billing.currentPlan.title")}>
      <Surface className="px-6 py-5">
        <div className="flex flex-col gap-6">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <span className="text-xl font-medium leading-7 text-foreground">
                {promoPlan ? billingPlanName(promoPlan.names, i18n.language) ?? t(`billing.planLabels.${promoPlan.tier}Card`) : t(`billing.planLabels.${plan === "free_cloud" ? "freeCloudCard" : plan === "self_host" ? "selfHost" : plan === "starter" ? "starterCard" : plan === "pro" ? "proCard" : "enterpriseCard"}`)}
              </span>
              <div className="flex flex-col items-start gap-0.5">
                <div className="flex flex-wrap items-end gap-2">
                  {monthlyPrice !== null ? (
                    <span className="text-4xl font-semibold tracking-tight text-foreground">
                      {money(monthlyPrice)}
                    </span>
                  ) : (
                    <span className="text-base text-muted-foreground">
                      {t("billing.currentPlan.customPricing")}
                    </span>
                  )}
                  {monthlyPrice !== null ? (
                    <span className="pb-1 text-base text-muted-foreground">
                      {account?.billingInterval === "annual"
                        ? t("billing.currentPlan.annualEffectiveSuffix")
                        : t("billing.currentPlan.monthlySuffix")}
                    </span>
                  ) : null}
                </div>
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
                    {t("billing.promo.ends", { date: formatBillingDate(promoPlan.ends, i18n.language) })}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-4">
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
            </div>
          </div>
          {canEnterCode ? <PromoCodeEntry key={business.businessId} businessId={business.businessId} changesPlan={plan === "starter" || plan === "pro"} /> : null}
          {(canUpgrade || canManage) && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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
            </div>
          )}
        </div>
      </Surface>
    </SectionBlock>
    {plan !== "self_host" ? <><SpendingCapSection key={business.businessId} businessId={business.businessId} locale={i18n.language} t={(key, options) => t(key, options ?? {})} status={{ plan, currency, overageSpendingCapCents: account?.overageSpendingCapCents ?? null, overageSpendCents: billing.data?.usageStatus?.overageSpendCents ?? 0, overageSpendCentsComplete: billing.data?.usageStatus?.usageComplete ?? true, overageSpendingCapReached: billing.data?.usageStatus?.overageSpendingCapReached ?? false, hasBillingManagementAccess: permissions?.hasBillingManagementAccess === true }} /><Transactions locale={i18n.language} transactions={billing.data?.transactions ?? []} t={t} /></> : null}
    </div>
  </PageSurface>;
}

type Translate = ReturnType<typeof useTranslation>["t"];
function Transactions({ transactions, t, locale }: { transactions: Billing["transactions"]; t: Translate; locale: string }) {
  if (!transactions || transactions.length === 0) return null;

  return (
    <SectionBlock
      title={t("billing.transactions.title")}
      description={t("billing.transactions.description")}
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
                    <span className="text-sm text-muted-foreground capitalize">
                      {tx.status}
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
  return (
    <SectionBlock
      title={t("billing.transactions.title")}
      description={t("billing.transactions.description")}
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
