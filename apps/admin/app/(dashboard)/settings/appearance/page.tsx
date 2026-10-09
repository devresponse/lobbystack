"use client";

import { selectActiveBusiness } from "@/lib/active-business";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { toast } from "sonner";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppearancePreference } from "@/components/appearance-provider";
import { useLocalePreference } from "@/components/replacement-locale-provider";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { requestJson } from "@/lib/request-json";
import { LOCALE_LABEL_KEYS, SUPPORTED_LOCALES, localeTag, type SupportedLocale, type TimeFormatPreference } from "@/lib/locale";
import { availableTimeZones, groupTimeZones, isTimeZoneRegion, type TimeZoneOption } from "@/lib/time-zones";

type Preference = { telemetryEnabled: boolean; timezone: string; canManageTenant: boolean };
type PreferenceChange = Partial<Pick<Preference, "telemetryEnabled" | "timezone">>;

export default function AppearancePage() {
  const { t } = useTranslation(["settings", "common"]);
  const { locale, setLocale, isSaving: isLocaleSaving } = useLocalePreference();
  const { timeFormatPreference, setTimeFormatPreference } = useAppearancePreference();
  const queryClient = useQueryClient();
  const businessId = useActiveBusiness().business?.businessId;
  const appearance = useQuery({ queryKey: ["appearance-preferences", businessId], enabled: Boolean(businessId), queryFn: () => requestJson<Preference>(`/api/preferences/appearance?businessId=${encodeURIComponent(businessId!)}`) });
  const updateAppearance = useMutation({
    mutationFn: ({ businessId: id, ...change }: PreferenceChange & { businessId: string }) => requestJson<PreferenceChange>(`/api/preferences/appearance?businessId=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) }),
    onMutate: async ({ businessId: id, ...change }) => {
      const key = ["appearance-preferences", id];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Preference>(key);
      if (previous) queryClient.setQueryData(key, { ...previous, ...change });
      return { previous };
    },
    onError: (_error, input, context) => {
      if (context?.previous) queryClient.setQueryData(["appearance-preferences", input.businessId], context.previous);
      const current = queryClient.getQueryData<{ businesses: Array<{ businessId: string; active: boolean }> }>(["businesses"]);
      if (selectActiveBusiness(current?.businesses)?.businessId === input.businessId) toast.error(t(input.timezone === undefined ? "appearance.telemetry.saveFailed" : "appearance.timezone.saveFailed"));
    },
    onSettled: async (_result, _error, input) => { await queryClient.invalidateQueries({ queryKey: ["appearance-preferences", input.businessId] }); },
  });
  const saving = (field: keyof PreferenceChange) => updateAppearance.isPending && updateAppearance.variables?.businessId === businessId && updateAppearance.variables?.[field] !== undefined;
  const timezone = appearance.data?.timezone;
  // Built once the business's zone loads, so the server render and hydration agree.
  const timeZoneGroups = useMemo(() => timezone ? groupTimeZones(availableTimeZones(timezone), localeTag(locale)) : [], [timezone, locale]);
  const timeZoneOptions = (zones: TimeZoneOption[]) => zones.map((zone) => <NativeSelectOption key={zone.id} value={zone.id}>{zone.label}</NativeSelectOption>);
  return (
    <div className="w-full overflow-y-auto pb-12">
      <div className="flex w-full flex-col gap-8">
        <Surface className="flex flex-col">
          <Item className="rounded-none border-x-0 border-t-0 border-b border-border last:border-b-0" variant="default">
            <ItemContent><ItemTitle>{t("appearance.language.label")}</ItemTitle><ItemDescription>{t("appearance.language.description")}</ItemDescription></ItemContent>
            <ItemActions className="w-full sm:w-auto"><NativeSelect aria-label={t("common:language.ariaLabel")} disabled={isLocaleSaving} className="w-full sm:w-28" onChange={(event) => void setLocale(event.target.value as SupportedLocale)} value={locale}>{SUPPORTED_LOCALES.map((option) => <NativeSelectOption key={option} lang={localeTag(option)} value={option}>{t(LOCALE_LABEL_KEYS[option])}</NativeSelectOption>)}</NativeSelect></ItemActions>
          </Item>
          <Item className="rounded-none border-x-0 border-t-0 border-b border-border last:border-b-0" variant="default">
            <ItemContent><ItemTitle>{t("appearance.timeFormat.label")}</ItemTitle><ItemDescription>{t("appearance.timeFormat.description")}</ItemDescription></ItemContent>
            <ItemActions className="w-full sm:w-auto"><NativeSelect aria-label={t("appearance.timeFormat.label")} className="w-full sm:w-28" onChange={(event) => setTimeFormatPreference(event.target.value as TimeFormatPreference)} value={timeFormatPreference}><NativeSelectOption value="24h">{t("appearance.timeFormat.twentyFourHour")}</NativeSelectOption><NativeSelectOption value="ampm">{t("appearance.timeFormat.ampm")}</NativeSelectOption></NativeSelect></ItemActions>
          </Item>
          <Item className="rounded-none border-x-0 border-t-0 border-b border-border last:border-b-0" variant="default">
            <ItemContent><ItemTitle>{t("appearance.timezone.label")}</ItemTitle><ItemDescription>{t("appearance.timezone.description")}</ItemDescription></ItemContent>
            <ItemActions className="w-full sm:w-auto"><NativeSelect aria-label={t("appearance.timezone.label")} className="w-full sm:w-72" disabled={!timezone || appearance.data?.canManageTenant !== true || saving("timezone")} onChange={(event) => { if (businessId) updateAppearance.mutate({ businessId, timezone: event.target.value }); }} value={timezone ?? ""}>{timeZoneGroups.flatMap((group) => group.region === null ? timeZoneOptions(group.zones) : [<NativeSelectOptGroup key={group.region} label={isTimeZoneRegion(group.region) ? t(`appearance.timezone.regions.${group.region.toLowerCase()}`) : group.region}>{timeZoneOptions(group.zones)}</NativeSelectOptGroup>])}</NativeSelect></ItemActions>
          </Item>
          <Item className="rounded-none border-0" variant="default">
            <ItemContent><ItemTitle>{t("appearance.telemetry.label")}</ItemTitle><ItemDescription>{t("appearance.telemetry.description")}</ItemDescription></ItemContent>
            <ItemActions className="w-full sm:w-auto"><Switch aria-label={t("appearance.telemetry.label")} checked={appearance.data?.telemetryEnabled ?? true} disabled={appearance.data?.canManageTenant !== true || saving("telemetryEnabled")} onCheckedChange={(checked) => { if (businessId) updateAppearance.mutate({ businessId, telemetryEnabled: checked }); }} /></ItemActions>
          </Item>
        </Surface>
      </div>
    </div>
  );
}
