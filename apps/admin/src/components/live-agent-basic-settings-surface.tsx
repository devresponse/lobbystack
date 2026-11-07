"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { requestJson } from "@/lib/request-json";
import { normalizeBookingMode, normalizeRuntimeLocale, type BookingMode, type RuntimeLocale } from "@lobbystack/shared";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Surface } from "@/components/ui/surface";
import { useTelemetry } from "@/components/product-analytics";
import { BookingWithoutHoursAlert, BusinessHoursSection, needsHoursForBooking, useBusinessHours } from "@/components/business-hours-section";
import { AppointmentChangesSection, BusinessLanguageItem, RecordingNoticeItem, SummaryItem, TimezoneItem } from "@/components/agent-settings/business-settings";
import { BookingModeItem, GreetingItem, OwnLanguageItem, TransferNumberItem } from "@/components/agent-settings/receptionist-settings";
import type { AgentSettings, SaveSetting, SavedSetting, SettingsChange } from "@/components/agent-settings/settings-kit";
import { receptionistQuery, receptionistsQueryKey, useReceptionistChoices, useReceptionistFilter } from "@/components/receptionists/receptionist-choices";
import { ReceptionistSelect } from "@/components/receptionists/receptionist-select";

// AI settings. With one receptionist the page looks as it did before
// receptionists. With several, the settings every receptionist shares come
// first (the summary, the AI notice, the business's language and time zone,
// opening hours and appointment changes), then a dropdown picks the
// receptionist whose own settings follow: its greeting, language, transfer
// number and booking. The dropdown keeps its choice in the address
// (?receptionist=<id>), so the Receptionists page links to one, and the
// default receptionist has no id there.
//
// The settings themselves live in agent-settings/: business-settings.tsx for
// the shared ones and receptionist-settings.tsx for each receptionist's own.
// This page loads them, saves each change, and lays them out.

type AgentBasicSettingsPageProps = {
  businessId: string;
  canManageTenant: boolean;
};

/**
 * Where the page keeps a receptionist's settings: the default receptionist's
 * under the business alone, as before receptionists, another one's under its
 * id too. Every save refreshes them all, since the shared settings show on
 * each.
 */
export function agentSettingsQueryKey(businessId: string, receptionistId: string | null) {
  return receptionistId ? ["agent-settings", businessId, receptionistId] as const : ["agent-settings", businessId] as const;
}

export function AgentBasicSettingsPage({
  businessId,
  canManageTenant,
}: AgentBasicSettingsPageProps) {
  const { t } = useTranslation(["agent", "common", "settings"]);
  const telemetry = useTelemetry();
  const queryClient = useQueryClient();
  const choices = useReceptionistChoices(businessId || undefined);
  const receptionists = choices.receptionists;
  const defaultReceptionist = receptionists.find((receptionist) => receptionist.isDefault);
  const [receptionistParam, setReceptionistParam] = useReceptionistFilter();
  const named = receptionistParam ? receptionists.find((receptionist) => receptionist.id === receptionistParam) : undefined;
  // The list in hand can be older than the address: a receptionist added a
  // moment ago is missing from it until it refetches. Until then the address
  // is taken at its word, and the server answers 404 for one the business
  // doesn't have.
  const choicesSettled = choices.isSuccess && !choices.isFetching;
  const receptionistId = !receptionistParam ? null : !choicesSettled ? receptionistParam : named && !named.isDefault ? named.id : null;
  // The default receptionist has no id in the address, nor has one the business doesn't list.
  useEffect(() => {
    if (receptionistParam && choicesSettled && (!named || named.isDefault)) setReceptionistParam(null);
  }, [choicesSettled, named, receptionistParam, setReceptionistParam]);

  const query = useQuery({
    queryKey: agentSettingsQueryKey(businessId, receptionistId),
    queryFn: () => requestJson<AgentSettings>(`/api/agent?businessId=${encodeURIComponent(businessId)}${receptionistQuery(receptionistId)}`),
    enabled: Boolean(businessId),
  });
  const configuration = query.data;
  const hours = useBusinessHours(businessId);
  const settingsOf = `${businessId}/${receptionistId ?? ""}`;
  // Whose settings the fields hold. The fields fill themselves once the
  // settings arrive, so until they have for the business and receptionist
  // chosen, they wait rather than show the last one's values.
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const loading = !businessId || query.isLoading || choices.isLoading || (configuration !== undefined && filledFor !== settingsOf);
  const profile = configuration?.profile;
  // Settings read before receptionists are the default receptionist's.
  const isDefaultReceptionist = profile ? profile.isDefault !== false : receptionistId === null;
  // A list that didn't load still splits the page for a receptionist other than the default.
  const split = receptionists.length > 1 || profile?.isDefault === false;

  // Two settings show beyond their own fields: the AI notice quotes what
  // callers hear in the business's language, which other receptionists'
  // language fields offer too, and instant booking without opening hours
  // shows a warning below the booking settings. So the page keeps these two,
  // and their fields change them as they save.
  const [businessLocale, setBusinessLocale] = useState<RuntimeLocale>("en");
  const [bookingMode, setBookingMode] = useState<BookingMode>("instant");
  useEffect(() => {
    if (!configuration) return;
    if (configuration.profile) {
      setBusinessLocale(normalizeRuntimeLocale(configuration.business?.defaultLocale) ?? "en");
      setBookingMode(normalizeBookingMode(configuration.profile.bookingMode));
    }
    setFilledFor(settingsOf);
  }, [settingsOf, configuration]);

  /**
   * Saves a change and refreshes the settings. The settings every
   * receptionist shares go to the business, by way of the default
   * receptionist, so they save even while the receptionist being looked at
   * is archived elsewhere; a receptionist's own go to it.
   */
  async function saveProfile(scope: "shared" | "own", { defaultLocale, receptionistLocale, ...patch }: SettingsChange, setting: SavedSetting, { refetchType = "active" }: { refetchType?: "active" | "none" } = {}): Promise<boolean> {
    const locale = defaultLocale ?? receptionistLocale;
    const target = scope === "own" ? receptionistId : null;
    try {
      await requestJson(`/api/agent?businessId=${encodeURIComponent(businessId)}${receptionistQuery(target)}`, { method: "PATCH", body: JSON.stringify({ businessId, ...patch, ...(locale !== undefined ? { locale } : {}) }) });
      // A language shows in the receptionist dropdowns and on the Receptionists page too.
      if (locale !== undefined) void queryClient.invalidateQueries({ queryKey: receptionistsQueryKey(businessId) });
      await queryClient.invalidateQueries({ queryKey: agentSettingsQueryKey(businessId, null), refetchType });
    } catch {
      toast.error(t("agent:actions.saveFailed"));
      return false;
    }
    telemetry.track("web.agent.settings_saved", { businessId, setting });
    return true;
  }
  const saveShared: SaveSetting = (change, setting, options) => saveProfile("shared", change, setting, options);
  const saveOwn: SaveSetting = (change, setting, options) => saveProfile("own", change, setting, options);
  const shared = { profile, canManage: canManageTenant, loading, save: saveShared };
  const own = { profile, canManage: canManageTenant, loading, save: saveOwn };

  // Switching business or receptionist keeps the page mounted. The keys
  // start each shared setting afresh for another business, and each
  // receptionist's own for another receptionist, so nothing typed or saved
  // for one carries over to the next.
  const greetingItem = <GreetingItem key={`greeting:${settingsOf}`} {...own} />;
  const ownLanguageItem = <OwnLanguageItem key={`language:${settingsOf}`} {...own} businessLocale={businessLocale} isDefault={isDefaultReceptionist} />;
  const transferItem = <TransferNumberItem key={`transfer:${settingsOf}`} {...own} />;
  const bookingItem = <BookingModeItem key={`booking:${settingsOf}`} {...own} onChange={setBookingMode} value={bookingMode} />;
  const summaryItem = <SummaryItem key={`summary:${businessId}`} {...shared} />;
  const recordingNoticeItem = <RecordingNoticeItem key={`notice:${businessId}`} {...shared} locale={businessLocale} />;
  const businessLanguageItem = <BusinessLanguageItem key={`business-language:${businessId}`} {...shared} onChange={setBusinessLocale} split={split} value={businessLocale} />;
  const timezoneItem = <TimezoneItem key={`timezone:${businessId}`} canManage={canManageTenant} loading={loading} save={saveShared} saved={configuration?.business?.timezone ?? ""} />;
  const appointmentChangesSection = <AppointmentChangesSection key={`appointment-changes:${businessId}`} {...shared} />;
  const bookingWithoutHours = !loading && hours.data && needsHoursForBooking({ ...hours.data, bookingMode }) ? <BookingWithoutHoursAlert /> : null;

  if (!split) {
    return (
      <div className="w-full overflow-y-auto pb-12">
        <div className="flex w-full flex-col gap-8">
          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-sm leading-snug font-medium">
              {t("agent:fields.defaults.title")}
            </h2>
            <Surface className="flex flex-col">
              {greetingItem}
              {recordingNoticeItem}
              {summaryItem}
              {businessLanguageItem}
              {timezoneItem}
              {transferItem}
            </Surface>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-sm leading-snug font-medium">
              {t("agent:booking.title")}
            </h2>
            <Surface className="flex flex-col">
              {bookingItem}
            </Surface>
            {bookingWithoutHours}
          </section>

          <BusinessHoursSection businessId={businessId} canManage={canManageTenant} />

          {appointmentChangesSection}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full overflow-y-auto pb-12">
      <div className="flex w-full flex-col gap-8">
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-sm leading-snug font-medium">{t("agent:receptionists.shared.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("agent:receptionists.shared.description")}</p>
          </div>
          <Surface className="flex flex-col">
            {summaryItem}
            {recordingNoticeItem}
            {businessLanguageItem}
            {timezoneItem}
          </Surface>
        </section>

        <BusinessHoursSection businessId={businessId} canManage={canManageTenant} />

        {appointmentChangesSection}

        <section aria-labelledby="agent-receptionist-settings" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-sm leading-snug font-medium" id="agent-receptionist-settings">{t("agent:receptionists.own.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("agent:receptionists.own.description")}</p>
          </div>
          <ReceptionistSelect
            className="w-full sm:w-80"
            label={t("agent:receptionists.picker")}
            onChange={(next) => setReceptionistParam(next && next !== defaultReceptionist?.id ? next : null)}
            receptionists={receptionists}
            showManage={canManageTenant}
            value={receptionistId ?? defaultReceptionist?.id ?? null}
          />
          <Surface className="flex flex-col">
            {greetingItem}
            {ownLanguageItem}
            {transferItem}
            {bookingItem}
          </Surface>
          {bookingWithoutHours}
        </section>
      </div>
    </div>
  );
}

export function LiveAgentBasicSettingsSurface() {
  const { business } = useActiveBusiness();
  return <AgentBasicSettingsPage businessId={business?.businessId ?? ""} canManageTenant={Boolean(business && ["business_owner", "business_admin"].includes(business.role))} />;
}
