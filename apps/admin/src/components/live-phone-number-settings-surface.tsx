"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { PhoneNumberChooser, phoneNumberChooserApi, type ClaimResult } from "./phone-number-chooser";
import { EntryPointReceptionist } from "./receptionists/entry-point-receptionist";
import { useReceptionistChoices, type ReceptionistOption } from "./receptionists/receptionist-choices";
import { entryPointErrorMessage } from "./receptionists/receptionist-errors";
import { useOpenUpgradePlanDialog } from "./upgrade-plan-dialog-context";
import { formatPhoneNumberDisplay } from "@/lib/phone";
import { phoneNumberErrorMessage } from "@/lib/phone-number-errors";
import { requestJson } from "@/lib/request-json";
import type { BillingUsageViewModel, PhoneNumberViewModel } from "@/lib/page-view-models";
import { formatDateTime } from "@/lib/locale";

type NumbersResponse = { phoneNumbers: PhoneNumberViewModel[]; activeClaim?: { id: string; status: string } | null; replacement: { usedAt: string | null; activeClaim?: { id: string; status: string } | null } };
function getSettingsPhoneNumberErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return fallback;
}

function formatReclaimDate(value: number, locale: string): string {
  return formatDateTime(value, locale, { year: "numeric", month: "long", day: "numeric" });
}

/** Who answers one number's calls and texts: a dropdown for owners and admins, the name for everyone else. */
function PhoneNumberReceptionist({ number, receptionists, canManage, pending, onChange }: { number: PhoneNumberViewModel; receptionists: ReceptionistOption[]; canManage: boolean; pending: boolean; onChange: (receptionistId: string) => void }) {
  const { t } = useTranslation(["settings", "receptionists"]);
  const defaultName = receptionists.find((receptionist) => receptionist.isDefault)?.name ?? "";
  return (
    <EntryPointReceptionist
      className="w-full sm:w-80"
      disabled={pending}
      hint={t("settings:phoneNumber.answeredBy.hint", { name: defaultName })}
      label={t("settings:phoneNumber.answeredBy.label")}
      onChange={onChange}
      readOnly={!canManage}
      receptionists={receptionists}
      value={number.receptionistId}
    />
  );
}

export function LivePhoneNumberSettingsSurface() {
  const { i18n, t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const openUpgradePlanDialog = useOpenUpgradePlanDialog();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { business } = useActiveBusiness();
  const businessId = business?.businessId ?? "";
  const canManageTenant = Boolean(business && ["business_owner", "business_admin"].includes(business.role));
  const numbers = useQuery({ queryKey: ["phone-numbers", businessId], refetchInterval: query => query.state.data?.activeClaim || query.state.data?.replacement.activeClaim ? 1000 : false, enabled: Boolean(businessId), queryFn: () => requestJson<NumbersResponse>(`/api/phone-numbers?businessId=${encodeURIComponent(businessId)}`) });
  // With several receptionists each number names who answers its calls and texts.
  const { receptionists } = useReceptionistChoices(businessId || undefined);
  const answeredBy = useMutation({
    mutationFn: ({ phoneNumberId, receptionistId }: { phoneNumberId: string; receptionistId: string }) => requestJson<{ phoneNumber: { id: string; e164: string; receptionistId: string } }>(`/api/phone-numbers/${encodeURIComponent(phoneNumberId)}?businessId=${encodeURIComponent(businessId)}`, { method: "PATCH", body: JSON.stringify({ receptionistId }) }),
    onSuccess: async ({ phoneNumber }) => {
      queryClient.setQueryData<NumbersResponse>(["phone-numbers", businessId], (current) => current ? { ...current, phoneNumbers: current.phoneNumbers.map((number) => number.id === phoneNumber.id ? { ...number, receptionistId: phoneNumber.receptionistId } : number) } : current);
      const name = receptionists.find((receptionist) => receptionist.id === phoneNumber.receptionistId)?.name ?? "";
      toast.success(t("phoneNumber.answeredBy.saved", { number: formatPhoneNumberDisplay(phoneNumber.e164, i18n.language), name }));
      await queryClient.invalidateQueries({ queryKey: ["phone-numbers", businessId] });
    },
    onError: (error) => { toast.error(entryPointErrorMessage(error, t)); },
  });
  const billing = useQuery({ queryKey: ["billing", businessId], enabled: Boolean(businessId), queryFn: () => requestJson<BillingUsageViewModel>(`/api/billing?businessId=${encodeURIComponent(businessId)}`) });
  const primaryPhoneNumber = numbers.data ? numbers.data.phoneNumbers.find(number => number.status === "active" && !number.reclaimScheduledAt) ?? numbers.data.phoneNumbers[0] ?? null : undefined;
  const phoneNumberReplacementUsedAt = numbers.data?.replacement.usedAt;
  const billingStatus = billing.data ? { includedBusinessNumbers: billing.data.limits.includedBusinessNumbers, phoneNumberReclaimScheduledAt: null } : null;
  const isReplacement = Boolean(primaryPhoneNumber);
  const numberApi = useMemo(() => phoneNumberChooserApi(isReplacement), [isReplacement]);
  // The reason the server named, or a logged failure's error ID, before the server's own words.
  const getErrorMessage = useCallback((error: unknown, fallback: string) => phoneNumberErrorMessage(error, t, fallback) ?? getSettingsPhoneNumberErrorMessage(error, fallback), [t]);
  const displayPhoneNumber = primaryPhoneNumber
    ? formatPhoneNumberDisplay(primaryPhoneNumber.e164, i18n.language)
    : null;
  const hasPhoneNumber = Boolean(primaryPhoneNumber);
  const hasUsedPhoneNumberChange = Boolean(phoneNumberReplacementUsedAt);
  const canClaimDedicatedNumber =
    billingStatus != null &&
    (billingStatus.includedBusinessNumbers === null || billingStatus.includedBusinessNumbers > 0);
  const reclaimScheduledAt =
    (primaryPhoneNumber?.reclaimScheduledAt ? new Date(primaryPhoneNumber.reclaimScheduledAt).getTime() : null) ??
    billingStatus?.phoneNumberReclaimScheduledAt ??
    null;
  const showReclaimBanner = Boolean(hasPhoneNumber && reclaimScheduledAt);
  // The business's last pack ended: another pack keeps the number, as a plan does.
  const packEnded = primaryPhoneNumber?.reclaimReason === "pack_ended";
  const showPaidPlanRequired = !hasPhoneNumber && billingStatus != null && !canClaimDedicatedNumber;
  const several = receptionists.length > 1;
  // A plan with more than one number lists the others, each with who answers it.
  const otherNumbers = several && primaryPhoneNumber ? (numbers.data?.phoneNumbers ?? []).filter((number) => number.id !== primaryPhoneNumber.id && number.status === "active") : [];
  const answeringPending = (phoneNumberId: string) => answeredBy.isPending && answeredBy.variables?.phoneNumberId === phoneNumberId;

  function handleClaimed(result: Extract<ClaimResult, { status: "claimed" }>): void {
    toast.success(t(hasPhoneNumber ? "phoneNumber.toast.changed" : "phoneNumber.toast.added"));
    setIsDialogOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["phone-numbers", businessId] });
    void queryClient.invalidateQueries({ queryKey: ["onboarding-primary-number", businessId] });
    void result;
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="w-full space-y-4">
        {showReclaimBanner && reclaimScheduledAt ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-foreground">
              {t("phoneNumber.reclaim.title", {
                date: formatReclaimDate(reclaimScheduledAt, i18n.language),
              })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(packEnded ? "phoneNumber.reclaim.packDescription" : "phoneNumber.reclaim.description", {
                number: displayPhoneNumber ?? primaryPhoneNumber?.e164,
              })}
            </p>
            {canManageTenant && packEnded ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button nativeButton={false} render={<Link href="/settings/plan" />} role="link" size="sm" variant="outline">
                  {t("phoneNumber.reclaim.buyPackCta")}
                </Button>
                <Button onClick={openUpgradePlanDialog} size="sm" variant="outline">
                  {t("phoneNumber.reclaim.choosePlanCta")}
                </Button>
              </div>
            ) : canManageTenant ? (
              <Button
                className="mt-3"
                onClick={openUpgradePlanDialog}
                size="sm"
                variant="outline"
              >
                {t("phoneNumber.reclaim.upgradeCta")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <ItemGroup spacing="section">
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>{t("phoneNumber.current.label")}</ItemTitle>
              <ItemDescription>{t("phoneNumber.current.description")}</ItemDescription>
              {primaryPhoneNumber === undefined ? (
                <Skeleton className="h-6 w-48 max-w-full" />
              ) : displayPhoneNumber ? (
                <p className="text-[15px] leading-6 text-foreground">{displayPhoneNumber}</p>
              ) : (
                <p className="text-[15px] leading-6 text-muted-foreground">
                  {showPaidPlanRequired
                    ? t("phoneNumber.requiresPaidPlan.description")
                    : t("phoneNumber.current.empty")}
                </p>
              )}
              {several && primaryPhoneNumber ? (
                <div className="mt-3">
                  <PhoneNumberReceptionist canManage={canManageTenant} number={primaryPhoneNumber} onChange={(receptionistId) => answeredBy.mutate({ phoneNumberId: primaryPhoneNumber.id, receptionistId })} pending={answeringPending(primaryPhoneNumber.id)} receptionists={receptionists} />
                </div>
              ) : null}
            </ItemContent>
            {canManageTenant ? (
              <ItemActions>
                {showPaidPlanRequired ? (
                  <Button onClick={openUpgradePlanDialog} size="sm" variant="outline">
                    {t("phoneNumber.requiresPaidPlan.upgradeCta")}
                  </Button>
                ) : (
                  <Dialog onOpenChange={setIsDialogOpen} open={isDialogOpen}>
                    <DialogTrigger
                      render={
                        <Button
                          disabled={
                            primaryPhoneNumber === undefined ||
                            Boolean(numbers.data?.activeClaim || numbers.data?.replacement.activeClaim) ||
                            (hasPhoneNumber && hasUsedPhoneNumberChange) ||
                            !canClaimDedicatedNumber
                          }
                          size="sm"
                          variant="outline"
                        />
                      }
                    >
                      {t(
                        hasPhoneNumber
                          ? "phoneNumber.actions.requestChange"
                          : "phoneNumber.actions.getNumber",
                      )}
                    </DialogTrigger>
                    <DialogContent className="max-w-3xl">
                      <DialogHeader>
                        <DialogTitle>
                          {t(
                            hasPhoneNumber
                              ? "phoneNumber.dialog.title"
                              : "phoneNumber.dialog.getNumberTitle",
                          )}
                        </DialogTitle>
                        <DialogDescription>
                          {t(
                            hasPhoneNumber
                              ? "phoneNumber.dialog.description"
                              : "phoneNumber.dialog.getNumberDescription",
                          )}
                        </DialogDescription>
                      </DialogHeader>
                      {isDialogOpen ? (
                        <PhoneNumberChooser
                          businessId={businessId}
                          claimNumber={numberApi.claimNumber}
                          getErrorMessage={getErrorMessage}
                          getInitialNumberSuggestion={numberApi.getInitialNumberSuggestion}
                          labels={{
                            countryLabel: t("phoneNumber.picker.countryLabel"),
                            areaCodeLabel: t("phoneNumber.picker.areaCodeLabel"),
                            areaCodePlaceholder: t("phoneNumber.picker.areaCodePlaceholder"),
                            search: t("phoneNumber.picker.search"),
                            phoneNumberHeader: t("phoneNumber.picker.phoneNumberHeader"),
                            select: t("phoneNumber.picker.select"),
                            loadMore: t("phoneNumber.picker.loadMore"),
                            empty: t("phoneNumber.picker.empty"),
                            loadFailed: t("phoneNumber.picker.loadFailed"),
                            searchFailed: t("phoneNumber.picker.searchFailed"),
                            claimFailed: t(hasPhoneNumber ? "phoneNumber.picker.claimFailed" : "phoneNumber.picker.getNumberFailed"),
                            unavailable: t("phoneNumber.picker.unavailable"),
                          }}
                          onClaimed={handleClaimed}
                          searchAvailableNumbers={numberApi.searchAvailableNumbers}
                        />
                      ) : null}
                    </DialogContent>
                  </Dialog>
                )}
              </ItemActions>
            ) : null}
          </Item>
          {otherNumbers.length ? (
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>{t("phoneNumber.answeredBy.otherNumbers")}</ItemTitle>
                <ItemDescription>{t("phoneNumber.answeredBy.otherNumbersDescription")}</ItemDescription>
                <ul className="mt-2 flex flex-col divide-y">
                  {otherNumbers.map((number) => (
                    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between" key={number.id}>
                      <p className="text-[15px] leading-6 text-foreground">{formatPhoneNumberDisplay(number.e164, i18n.language)}</p>
                      <PhoneNumberReceptionist canManage={canManageTenant} number={number} onChange={(receptionistId) => answeredBy.mutate({ phoneNumberId: number.id, receptionistId })} pending={answeringPending(number.id)} receptionists={receptionists} />
                    </li>
                  ))}
                </ul>
              </ItemContent>
            </Item>
          ) : null}
        </ItemGroup>
      </div>
    </div>
  );
}
