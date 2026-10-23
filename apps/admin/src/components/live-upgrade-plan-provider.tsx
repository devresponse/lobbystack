"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { billingPlanName, brandLinks, contactEmailFor, isPaidSubscription, type BillingInterval, type BillingPlanList, type BillingPlanSlug, type BillingPromoPlanView, type HostedCheckoutPlanIntervals, type PlanChangeRefusal } from "@lobbystack/shared";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { requestJson } from "@/lib/request-json";
import { selectActiveBusiness } from "@/lib/active-business";
import { setUpgradeInProgress } from "@/lib/upgrade-in-progress";
import type { WorkspaceViewModel } from "@/lib/page-view-models";
import { UpgradePlanDialog, type HostedUpgradePlan } from "./upgrade-plan-dialog";
import { UpgradePlanDialogProvider } from "./upgrade-plan-dialog-context";

type WorkspaceResponse = { businesses: WorkspaceViewModel[] };
type Billing = {
  account: { plan: string | null; billingInterval: string | null; subscriptionState: string | null } | null;
  availableCheckoutPlans: HostedUpgradePlan[];
  availableCheckoutIntervals: HostedCheckoutPlanIntervals;
  plans: BillingPlanList;
  promoPlan?: BillingPromoPlanView | null;
};
type Checkout = { businessId: string; requestId: string; target: HostedUpgradePlan };
type CheckoutStatus = { status: string; checkoutUrl: string | null; error: string | null; synced: boolean; refusal: PlanChangeRefusal | null };

// How long a plan change waits for Polar's webhook before it stops checking. The plan page shows it whenever it lands.
const PLAN_CHANGE_SYNC_MS = 90_000;

export function LiveUpgradePlanProvider({ children }: { children: ReactNode }) {
  const { i18n, t } = useTranslation("settings");
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Redirect once per checkout. A page restored from the browser's cache can rerun the
  // effect with the old ready checkout and send them straight back to it.
  const redirectedRequestId = useRef<string | null>(null);
  const announcedRequestId = useRef<string | null>(null);
  const businessId = useActiveBusiness().business?.businessId;
  const billing = useQuery({ queryKey: ["billing", businessId], enabled: Boolean(businessId && open), queryFn: () => requestJson<Billing>(`/api/billing?businessId=${encodeURIComponent(businessId!)}`) });
  const rawPlan = billing.data?.account?.plan;
  // A cancelled or lapsed tier is not the plan someone is on, and marking its
  // card as current leaves them unable to start the tier they just lost.
  const plan: BillingPlanSlug = rawPlan === "self_hosted_standard" || rawPlan === "self_host" ? "self_host" : isPaidSubscription(rawPlan, billing.data?.account?.subscriptionState) ? rawPlan as BillingPlanSlug : "free_cloud";
  // Starter or Pro already paid through Polar: picking another plan changes that subscription.
  const changesPlan = plan === "starter" || plan === "pro";
  // Moving off a promo plan drops it, its discount and its allowances.
  const promoPlan = changesPlan && billing.data?.promoPlan?.tier === plan ? billing.data.promoPlan : null;
  const activeBusinessId = () => selectActiveBusiness(client.getQueryData<WorkspaceResponse>(["businesses"])?.businesses)?.businessId;
  const mutation = useMutation({
    mutationFn: (input: { businessId: string; target: HostedUpgradePlan; billingInterval: BillingInterval }) => requestJson<{ requestId: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result, input) => { if (activeBusinessId() === input.businessId) setCheckout({ businessId: input.businessId, requestId: result.requestId, target: input.target }); },
    onError: (_error, input) => { if (activeBusinessId() === input.businessId) toast.error(t(changesPlan ? "billing.toast.planChangeFailed" : "billing.toast.checkoutFailed")); },
  });
  const result = useQuery({
    queryKey: ["billing-checkout", checkout?.businessId, checkout?.requestId],
    enabled: Boolean(checkout && checkout.businessId === businessId),
    queryFn: () => requestJson<CheckoutStatus>(`/api/billing/checkout?businessId=${encodeURIComponent(checkout!.businessId)}&requestId=${encodeURIComponent(checkout!.requestId)}`),
    // A plan change keeps checking until Polar's webhook has moved the business onto the plan.
    refetchInterval: query => ["ready", "error"].includes(query.state.data?.status ?? "") || (query.state.data?.status === "changed" && query.state.data.synced) ? false : 1500,
  });
  useEffect(() => { setOpen(false); setCheckout(null); }, [businessId]);
  const resetCheckoutRequest = mutation.reset;
  useEffect(() => {
    // The back button from checkout can restore this page from the browser's cache, still
    // waiting on a checkout that already opened. Let them pick a plan again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setLeaving(false);
      setCheckout(null);
      resetCheckoutRequest();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [resetCheckoutRequest]);
  useEffect(() => {
    if (checkout?.businessId !== businessId) return;
    if (result.data?.status === "ready" && result.data.checkoutUrl && checkout && redirectedRequestId.current !== checkout.requestId) {
      redirectedRequestId.current = checkout.requestId;
      // Heading to checkout is leaving on purpose. Say so before the page
      // starts to unload, not after the next render.
      setUpgradeInProgress(true);
      setLeaving(true);
      window.location.assign(result.data.checkoutUrl);
    }
    if (result.data?.status === "error" || result.isError) {
      const refusal = result.data?.refusal;
      toast.error(refusal ? t(`billing.toast.planChangeRefused.${refusal}`) : t(changesPlan ? "billing.toast.planChangeFailed" : "billing.toast.checkoutFailed"));
      setCheckout(null);
    }
  }, [businessId, changesPlan, checkout, result.data, result.isError, t]);
  useEffect(() => {
    // A business that already pays has its subscription changed in place, with no checkout page to visit.
    if (!checkout || checkout.businessId !== businessId || result.data?.status !== "changed") return;
    if (announcedRequestId.current !== checkout.requestId) {
      announcedRequestId.current = checkout.requestId;
      setOpen(false);
      toast.success(t("billing.toast.planChanged"));
    }
    const finish = () => {
      void client.invalidateQueries({ queryKey: ["billing", checkout.businessId] });
      setCheckout(null);
    };
    if (result.data.synced) { finish(); return; }
    const timer = window.setTimeout(finish, PLAN_CHANGE_SYNC_MS);
    return () => window.clearTimeout(timer);
  }, [businessId, checkout, client, result.data, t]);
  const pending = mutation.isPending && mutation.variables.businessId === businessId || checkout?.businessId === businessId;
  // The picker only renders once billing loads. If that request fails, an open flag alone
  // would hold the survey off for the rest of the visit.
  const pickerShown = open && Boolean(businessId && billing.data);
  const upgrading = pickerShown || pending || leaving;
  useEffect(() => {
    setUpgradeInProgress(upgrading);
    return () => setUpgradeInProgress(false);
  }, [upgrading]);
  return <UpgradePlanDialogProvider onOpen={() => setOpen(true)}>
    {children}
    {businessId && billing.data ? <UpgradePlanDialog
      availableCheckoutPlans={billing.data.availableCheckoutPlans ?? []}
      availableCheckoutIntervals={billing.data.availableCheckoutIntervals ?? { starter: [], pro: [] }}
      billingInterval={interval}
      changesPlan={changesPlan}
      currentPlan={plan}
      leavesPromoPlan={promoPlan ? billingPlanName(promoPlan.names, i18n.language) ?? promoPlan.plan : null}
      loading={pending ? "checkout" : null}
      loadingPlan={checkout?.target ?? (mutation.isPending ? mutation.variables.target : null)}
      locale={i18n.language}
      onBillingIntervalChange={setInterval}
      onContactEnterprise={() => window.location.assign(`mailto:${contactEmailFor(brandLinks(), "sales")}?subject=${encodeURIComponent(t("billing.upgradeDialog.enterpriseSubject"))}`)}
      onOpenChange={setOpen}
      onStartCheckout={(target, billingInterval) => mutation.mutate({ businessId, target, billingInterval })}
      open={open}
      plans={billing.data.plans}
      t={t}
    /> : null}
  </UpgradePlanDialogProvider>;
}
