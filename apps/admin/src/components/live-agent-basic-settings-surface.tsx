"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { requestJson } from "@/lib/request-json";
import { appointmentChangeVerificationModes, callRecordingNotices, intlLocale, normalizeBookingMode, normalizeRuntimeLocale, runtimeLocaleEndonyms, runtimeLocales, type AppointmentChangePolicy, type AppointmentChangeVerificationMode, type BookingMode, type RuntimeLocale } from "@lobbystack/shared";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { PhoneInput } from "@/components/ui/phone-input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { useTelemetry } from "@/components/product-analytics";
import { BookingWithoutHoursAlert, BusinessHoursSection, needsHoursForBooking, useBusinessHours } from "@/components/business-hours-section";
import { receptionistQuery, receptionistsQueryKey, useReceptionistChoices, useReceptionistFilter } from "@/components/receptionists/receptionist-choices";
import { ReceptionistSelect } from "@/components/receptionists/receptionist-select";
import { availableTimeZones, groupTimeZones, isTimeZoneRegion, type TimeZoneOption } from "@/lib/time-zones";

// AI settings. With one receptionist the page looks as it did before
// receptionists. With several, the settings every receptionist shares come
// first (the summary, the AI notice, the business's language and time zone,
// opening hours and appointment changes), then a dropdown picks the
// receptionist whose own settings follow: its greeting, language, transfer
// number and booking. The dropdown keeps its choice in the address
// (?receptionist=<id>), so the Receptionists page links to one, and the
// default receptionist has no id there.

type AgentBasicSettingsPageProps = {
  businessId: string;
  canManageTenant: boolean;
};

type AgentSettingsProfile = {
  /** Which receptionist these settings are; settings read before receptionists have none. */
  id?: string;
  isDefault?: boolean;
  name?: string;
  /** Its own language; null speaks the business's. */
  locale?: string | null;
  greeting: string;
  recordingNotice?: boolean;
  summary: string;
  summarySource: "placeholder" | "generated" | "operator";
  transferNumber: string | null;
  transferMode: string;
  appointmentChangePolicy: AppointmentChangePolicy | null;
  bookingMode: BookingMode;
};

type AgentSettings = { business: { defaultLocale: RuntimeLocale; timezone: string } | null; profile: AgentSettingsProfile | null };

type SettingsChange = {
  businessId: string;
  /** The business's language, which the default receptionist speaks. */
  defaultLocale?: RuntimeLocale;
  /** Another receptionist's own language; null speaks the business's. */
  receptionistLocale?: RuntimeLocale | null;
  timezone?: string;
  greeting?: string;
  recordingNotice?: boolean;
  summary?: string;
  regenerateSummary?: true;
  transferNumber?: string | null;
  transferMode?: string;
  appointmentChangePolicy?: AppointmentChangePolicy;
  bookingMode?: BookingMode;
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

export function resolveTransferNumberForSave({
  rawInputValue,
  validTransferNumber,
}: {
  rawInputValue: string;
  validTransferNumber: string;
}):
  | { ok: true; value: string | null }
  | { ok: false; errorKey: "agent:fields.transferNumber.errors.invalid" } {
  const trimmedVisibleTransferNumber = rawInputValue.trim();
  if (trimmedVisibleTransferNumber.length === 0) {
    return { ok: true, value: null };
  }

  const trimmedTransferNumber = validTransferNumber.trim();
  if (trimmedTransferNumber.length > 0) {
    return { ok: true, value: trimmedTransferNumber };
  }

  return {
    ok: false,
    errorKey: "agent:fields.transferNumber.errors.invalid",
  };
}

export function buildAppointmentChangePolicyForSave({
  allowCancel,
  allowReschedule,
  verificationMode,
}: {
  allowCancel: boolean;
  allowReschedule: boolean;
  verificationMode: AppointmentChangeVerificationMode;
}): AppointmentChangePolicy {
  return {
    enabled: allowCancel || allowReschedule,
    allowCancel,
    allowReschedule,
    verificationMode,
  };
}

// The checks the dashboard offers. The v1 API can also set operator_only,
// which the select shows only while it's the saved mode.
const offeredVerificationModes: AppointmentChangeVerificationMode[] = ["phone_match_and_facts", "otp_required", "passcode_required"];

function savedVerificationMode(value: unknown): AppointmentChangeVerificationMode {
  return (appointmentChangeVerificationModes as readonly unknown[]).includes(value) ? value as AppointmentChangeVerificationMode : "phone_match_and_facts";
}

const itemClassName = "rounded-none border-x-0 border-t-0 border-b border-border last:border-b-0";

export function AgentBasicSettingsPage({
  businessId,
  canManageTenant,
}: AgentBasicSettingsPageProps) {
  const { i18n, t } = useTranslation(["agent", "common", "settings"]);
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
  // Whose settings the fields hold. The effect below fills them once the
  // settings arrive, so until it has for the business and receptionist
  // chosen, the fields wait rather than show the last one's values.
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const isLoadingConfiguration = !businessId || query.isLoading || choices.isLoading || (configuration !== undefined && filledFor !== settingsOf);
  const persistedProfile = configuration?.profile;
  // Settings read before receptionists are the default receptionist's.
  const isDefaultReceptionist = persistedProfile ? persistedProfile.isDefault !== false : receptionistId === null;
  // A list that didn't load still splits the page for a receptionist other than the default.
  const split = receptionists.length > 1 || persistedProfile?.isDefault === false;

  /**
   * Saves a change and refreshes the settings. The settings every
   * receptionist shares go to the business, by way of the default
   * receptionist, so they save even while the receptionist being looked at
   * is archived elsewhere; a receptionist's own go to it.
   */
  async function saveProfile({ defaultLocale, receptionistLocale, ...patch }: SettingsChange, { refetchType = "active", scope }: { refetchType?: "active" | "none"; scope: "shared" | "own" }) {
    const locale = defaultLocale ?? receptionistLocale;
    const target = scope === "own" ? receptionistId : null;
    await requestJson(`/api/agent?businessId=${encodeURIComponent(businessId)}${receptionistQuery(target)}`, { method: "PATCH", body: JSON.stringify({ ...patch, ...(locale !== undefined ? { locale } : {}) }) });
    // A language shows in the receptionist dropdowns and on the Receptionists page too.
    if (locale !== undefined) void queryClient.invalidateQueries({ queryKey: receptionistsQueryKey(businessId) });
    await queryClient.invalidateQueries({ queryKey: agentSettingsQueryKey(businessId, null), refetchType });
  }
  // The sign-up placeholder isn't a summary, so it shows as empty.
  const savedSummary = persistedProfile && persistedProfile.summarySource !== "placeholder" ? persistedProfile.summary : "";
  const savedTimezone = configuration?.business?.timezone ?? "";
  // Built once the business's zone loads, so the server render and hydration agree.
  const timeZoneGroups = useMemo(() => savedTimezone ? groupTimeZones(availableTimeZones(savedTimezone), intlLocale(i18n.language)) : [], [savedTimezone, i18n.language]);
  const timeZoneOptions = (zones: TimeZoneOption[]) => zones.map((zone) => <NativeSelectOption key={zone.id} value={zone.id}>{zone.label}</NativeSelectOption>);

  const [greeting, setGreeting] = useState("");
  const [summary, setSummary] = useState("");
  const [summaryStatus, setSummaryStatus] = useState<string | null>(null);
  const [isSummarySaving, setIsSummarySaving] = useState(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState<RuntimeLocale>("en");
  const [ownLocale, setOwnLocale] = useState<RuntimeLocale | null>(null);
  const [ownLocaleStatus, setOwnLocaleStatus] = useState<string | null>(null);
  const [isOwnLocaleSaving, setIsOwnLocaleSaving] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [timezoneStatus, setTimezoneStatus] = useState<string | null>(null);
  const [isTimezoneSaving, setIsTimezoneSaving] = useState(false);
  const [transferNumber, setTransferNumber] = useState("");
  const [transferNumberInputValue, setTransferNumberInputValue] = useState("");
  const [allowAppointmentCancel, setAllowAppointmentCancel] = useState(true);
  const [allowAppointmentReschedule, setAllowAppointmentReschedule] = useState(true);
  const [appointmentChangeVerification, setAppointmentChangeVerification] = useState<AppointmentChangeVerificationMode>("phone_match_and_facts");
  const [bookingMode, setBookingMode] = useState<BookingMode>("instant");
  const [bookingModeStatus, setBookingModeStatus] = useState<string | null>(null);
  const [isBookingModeSaving, setIsBookingModeSaving] = useState(false);
  const [greetingStatus, setGreetingStatus] = useState<string | null>(null);
  const [recordingNotice, setRecordingNotice] = useState(true);
  const [recordingNoticeStatus, setRecordingNoticeStatus] = useState<string | null>(null);
  const [isRecordingNoticeSaving, setIsRecordingNoticeSaving] = useState(false);
  const [localeStatus, setLocaleStatus] = useState<string | null>(null);
  const [transferStatus, setTransferStatus] = useState<string | null>(null);
  const [appointmentChangeStatus, setAppointmentChangeStatus] = useState<string | null>(null);
  const [isGreetingSaving, setIsGreetingSaving] = useState(false);
  const [isGreetingOpen, setIsGreetingOpen] = useState(false);
  const [isLocaleSaving, setIsLocaleSaving] = useState(false);
  const [isTransferSaving, setIsTransferSaving] = useState(false);
  const [isAppointmentChangeSaving, setIsAppointmentChangeSaving] = useState(false);
  const [transferStatusTone, setTransferStatusTone] = useState<"success" | "error">("success");
  // The profile the text fields last took their values from. Every save refetches the
  // settings, and so does coming back to the tab, and a refetch that lands while someone is
  // typing must not undo their edit, so the greeting and summary only take the new value
  // while they still hold the last one, and the transfer number only while nobody has
  // edited it since it was saved. Switching business or receptionist keeps the page
  // mounted, and none of it carries over to the next one.
  const syncedSettingsOf = useRef(settingsOf);
  const syncedProfile = useRef<AgentSettingsProfile | null>(null);
  const transferNumberRef = useRef(transferNumber);
  transferNumberRef.current = transferNumber;
  const transferNumberEdited = useRef(false);
  useEffect(() => {
    if (syncedSettingsOf.current !== settingsOf) {
      syncedSettingsOf.current = settingsOf;
      syncedProfile.current = null;
      transferNumberEdited.current = false;
      // What was saved for one receptionist says nothing about the next.
      setGreetingStatus(null);
      setOwnLocaleStatus(null);
      setTransferStatus(null);
      setTransferStatusTone("success");
      setBookingModeStatus(null);
    }
    setTimezone(configuration?.business?.timezone ?? "");
    const profile = configuration?.profile;
    if (!profile) {
      if (configuration) setFilledFor(settingsOf);
      return;
    }
    const previous = syncedProfile.current;
    syncedProfile.current = profile;
    // The sign-up placeholder isn't a summary, so the field starts empty.
    const shownSummary = (value: AgentSettingsProfile) => value.summarySource === "placeholder" ? "" : value.summary;
    setGreeting((current) => !previous || current === previous.greeting ? profile.greeting : current);
    // A profile saved before the switch existed has it on.
    setRecordingNotice(profile.recordingNotice !== false);
    setSummary((current) => !previous || current === shownSummary(previous) ? shownSummary(profile) : current);
    setDefaultLocale(normalizeRuntimeLocale(configuration.business?.defaultLocale) ?? "en");
    setOwnLocale(normalizeRuntimeLocale(profile.locale));
    if (!transferNumberEdited.current) {
      setTransferNumber(profile.transferNumber ?? "");
      setTransferNumberInputValue(profile.transferNumber ?? "");
    }
    setBookingMode(normalizeBookingMode(profile.bookingMode));
    const appointmentChangePolicy = profile.appointmentChangePolicy as AppointmentChangePolicy | null;
    setAllowAppointmentCancel(appointmentChangePolicy?.allowCancel ?? true);
    setAllowAppointmentReschedule(appointmentChangePolicy?.allowReschedule ?? true);
    setAppointmentChangeVerification(savedVerificationMode(appointmentChangePolicy?.verificationMode));
    setFilledFor(settingsOf);
  }, [settingsOf, configuration]);

  useEffect(() => {
    const timeouts: number[] = [];

    if (greetingStatus) {
      timeouts.push(window.setTimeout(() => {
        setGreetingStatus(null);
      }, 3000));
    }

    if (localeStatus) {
      timeouts.push(window.setTimeout(() => {
        setLocaleStatus(null);
      }, 3000));
    }

    if (ownLocaleStatus) {
      timeouts.push(window.setTimeout(() => {
        setOwnLocaleStatus(null);
      }, 3000));
    }

    if (recordingNoticeStatus) {
      timeouts.push(window.setTimeout(() => {
        setRecordingNoticeStatus(null);
      }, 3000));
    }

    if (transferStatus) {
      timeouts.push(window.setTimeout(() => {
        setTransferStatus(null);
        setTransferStatusTone("success");
      }, 3000));
    }

    if (appointmentChangeStatus) {
      timeouts.push(window.setTimeout(() => {
        setAppointmentChangeStatus(null);
      }, 3000));
    }

    return () => {
      for (const timeoutId of timeouts) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [appointmentChangeStatus, greetingStatus, localeStatus, ownLocaleStatus, recordingNoticeStatus, transferStatus]);

  async function saveGreeting(): Promise<void> {
    if (!canManageTenant || !persistedProfile) {
      return;
    }

    setIsGreetingSaving(true);
    setGreetingStatus(null);
    try {
      // Only the greeting: the dialog hides the other fields, so their drafts stay unsaved.
      await saveProfile({ businessId, greeting }, { scope: "own" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "greeting" });
      setGreetingStatus(t("agent:actions.saved"));
      setIsGreetingOpen(false);
    } catch {
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsGreetingSaving(false);
    }
  }

  async function saveSummary(regenerate: boolean): Promise<void> {
    if (!canManageTenant || !persistedProfile || (!regenerate && !summary.trim())) {
      return;
    }
    setIsSummarySaving(true);
    setSummaryStatus(null);
    try {
      await saveProfile(regenerate ? { businessId, regenerateSummary: true } : { businessId, summary: summary.trim() }, { scope: "shared" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: regenerate ? "summary_regenerated" : "summary" });
      setSummaryStatus(regenerate ? t("agent:fields.summary.regenerating") : t("agent:actions.saved"));
      setIsSummaryOpen(false);
    } catch {
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsSummarySaving(false);
    }
  }

  async function saveTransferNumber(): Promise<void> {
    if (!canManageTenant || !persistedProfile) {
      return;
    }

    const transferNumberResolution = resolveTransferNumberForSave({
      rawInputValue: transferNumberInputValue,
      validTransferNumber: transferNumber,
    });
    if (!transferNumberResolution.ok) {
      setTransferStatus(t(transferNumberResolution.errorKey));
      setTransferStatusTone("error");
      return;
    }

    setIsTransferSaving(true);
    setTransferStatus(null);
    try {
      await saveProfile({ businessId, transferNumber: transferNumberResolution.value }, { scope: "own" });
      // Typing that started during the save is still unsaved.
      if (transferNumberRef.current === (transferNumberResolution.value ?? "")) transferNumberEdited.current = false;
      telemetry.track("web.agent.settings_saved", { businessId, setting: "transfer_number" });
      setTransferStatus(t("agent:actions.saved"));
      setTransferStatusTone("success");
    } catch {
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsTransferSaving(false);
    }
  }

  async function saveAppointmentChangePolicy({
    allowCancel = allowAppointmentCancel,
    allowReschedule = allowAppointmentReschedule,
    verificationMode = appointmentChangeVerification,
  }: {
    allowCancel?: boolean;
    allowReschedule?: boolean;
    verificationMode?: AppointmentChangeVerificationMode;
  } = {}): Promise<void> {
    if (!canManageTenant || !persistedProfile) {
      return;
    }

    setIsAppointmentChangeSaving(true);
    setAppointmentChangeStatus(null);
    try {
      await saveProfile({
        businessId,
        appointmentChangePolicy: buildAppointmentChangePolicyForSave({
          allowCancel,
          allowReschedule,
          verificationMode,
        }),
      }, { scope: "shared" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "appointment_change_policy" });
      setAppointmentChangeStatus(t("agent:actions.saved"));
    } catch {
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsAppointmentChangeSaving(false);
    }
  }

  async function saveBusinessLocale(nextLocale: RuntimeLocale): Promise<void> {
    setDefaultLocale(nextLocale);
    setLocaleStatus(null);
    if (!canManageTenant || !persistedProfile) {
      return;
    }

    setIsLocaleSaving(true);
    try {
      await saveProfile({ businessId, defaultLocale: nextLocale }, { scope: "shared" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "default_locale" });
      setLocaleStatus(t("agent:actions.saved"));
    } catch {
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsLocaleSaving(false);
    }
  }

  async function saveOwnLocale(nextLocale: RuntimeLocale | null): Promise<void> {
    if (!canManageTenant || !persistedProfile || isDefaultReceptionist) return;
    const previous = ownLocale;
    setOwnLocale(nextLocale);
    setIsOwnLocaleSaving(true);
    setOwnLocaleStatus(null);
    try {
      await saveProfile({ businessId, receptionistLocale: nextLocale }, { scope: "own" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "receptionist_locale" });
      setOwnLocaleStatus(t("agent:actions.saved"));
    } catch {
      setOwnLocale(previous);
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsOwnLocaleSaving(false);
    }
  }

  async function saveTimezone(nextTimezone: string): Promise<void> {
    if (!canManageTenant) return;
    const previous = timezone;
    setTimezone(nextTimezone);
    setIsTimezoneSaving(true);
    setTimezoneStatus(null);
    try {
      // A refetch resets every unsaved draft on this page, so the saved settings only go stale.
      await saveProfile({ businessId, timezone: nextTimezone }, { refetchType: "none", scope: "shared" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "timezone" });
      setTimezoneStatus(t("agent:actions.saved"));
    } catch {
      setTimezone(previous);
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsTimezoneSaving(false);
    }
  }

  async function saveRecordingNotice(next: boolean): Promise<void> {
    if (!canManageTenant || !persistedProfile) return;
    setRecordingNotice(next);
    setIsRecordingNoticeSaving(true);
    setRecordingNoticeStatus(null);
    try {
      await saveProfile({ businessId, recordingNotice: next }, { scope: "shared" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "recording_notice" });
      setRecordingNoticeStatus(t("agent:actions.saved"));
    } catch {
      setRecordingNotice(!next);
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsRecordingNoticeSaving(false);
    }
  }

  async function saveBookingMode(nextMode: BookingMode): Promise<void> {
    if (!canManageTenant || !persistedProfile) return;
    setIsBookingModeSaving(true);
    setBookingModeStatus(null);
    try {
      await saveProfile({ businessId, bookingMode: nextMode }, { scope: "own" });
      telemetry.track("web.agent.settings_saved", { businessId, setting: "booking_mode" });
      setBookingModeStatus(t("agent:actions.saved"));
    } catch {
      toast.error(t("agent:actions.saveFailed"));
    } finally {
      setIsBookingModeSaving(false);
    }
  }

  const greetingItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.greeting.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.greeting.hint")}</ItemDescription>
        {greetingStatus ? <ItemDescription>{greetingStatus}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full justify-end self-center sm:w-auto">
        <Button
          aria-label={t("agent:actions.editField", { field: t("agent:fields.greeting.label") })}
          disabled={isLoadingConfiguration || !persistedProfile || !canManageTenant}
          onClick={() => {
            setGreeting(persistedProfile?.greeting ?? "");
            setGreetingStatus(null);
            setIsGreetingOpen(true);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("agent:actions.edit")}
        </Button>
      </ItemActions>
      <Dialog onOpenChange={(open) => { if (!open && !isGreetingSaving) setIsGreetingOpen(false); }} open={isGreetingOpen}>
        <DialogContent className="flex flex-col gap-4 sm:max-w-lg">
          <DialogHeader><DialogTitle>{t("agent:fields.greeting.label")}</DialogTitle></DialogHeader>
          <Textarea
            autoFocus
            disabled={!canManageTenant || isGreetingSaving}
            id="agent-greeting"
            onChange={(event) => setGreeting(event.target.value)}
            placeholder={t("agent:fields.greeting.placeholder")}
            rows={3}
            value={greeting}
          />
          <DialogFooter>
            <Button disabled={isGreetingSaving} onClick={() => setIsGreetingOpen(false)} type="button" variant="outline">{t("agent:actions.cancel")}</Button>
            <Button disabled={isGreetingSaving || !canManageTenant || !greeting.trim()} onClick={() => void saveGreeting()} type="button">
              {isGreetingSaving ? t("agent:actions.saving") : t("agent:actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Item>
  );

  const recordingNoticeItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.recordingNotice.label")}</ItemTitle>
        {/* What callers hear, in the language calls open in. */}
        <ItemDescription>{t("agent:fields.recordingNotice.hint", { notice: callRecordingNotices[defaultLocale] })}</ItemDescription>
        {recordingNoticeStatus ? <ItemDescription>{recordingNoticeStatus}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        {isLoadingConfiguration ? (
          <Skeleton className="h-5 w-8 rounded-full" />
        ) : (
          <Switch
            aria-label={t("agent:fields.recordingNotice.label")}
            checked={recordingNotice}
            disabled={isRecordingNoticeSaving || !persistedProfile || !canManageTenant}
            onCheckedChange={(checked) => void saveRecordingNotice(checked)}
          />
        )}
      </ItemActions>
    </Item>
  );

  const summaryItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.summary.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.summary.hint")}</ItemDescription>
        {summaryStatus ? <ItemDescription>{summaryStatus}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full justify-end self-center sm:w-auto">
        <Button
          aria-label={t("agent:actions.editField", { field: t("agent:fields.summary.label") })}
          disabled={isLoadingConfiguration || !persistedProfile || !canManageTenant}
          onClick={() => {
            setSummary(savedSummary);
            setSummaryStatus(null);
            setIsSummaryOpen(true);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("agent:actions.edit")}
        </Button>
      </ItemActions>
      <Dialog onOpenChange={(open) => { if (!open && !isSummarySaving) setIsSummaryOpen(false); }} open={isSummaryOpen}>
        <DialogContent className="flex flex-col gap-4 sm:max-w-lg">
          <DialogHeader><DialogTitle>{t("agent:fields.summary.label")}</DialogTitle></DialogHeader>
          <Textarea
            autoFocus
            disabled={!canManageTenant || isSummarySaving}
            id="agent-summary"
            maxLength={2000}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={t("agent:fields.summary.placeholder")}
            rows={6}
            value={summary}
          />
          <DialogFooter className="sm:justify-between">
            {persistedProfile?.summarySource === "operator" ? (
              <Button disabled={isSummarySaving || !canManageTenant} onClick={() => void saveSummary(true)} type="button" variant="ghost">
                {t("agent:fields.summary.regenerate")}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button disabled={isSummarySaving} onClick={() => setIsSummaryOpen(false)} type="button" variant="outline">{t("agent:actions.cancel")}</Button>
              <Button disabled={isSummarySaving || !canManageTenant || !summary.trim()} onClick={() => void saveSummary(false)} type="button">
                {isSummarySaving ? t("agent:actions.saving") : t("agent:actions.save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Item>
  );

  // With several receptionists the business's language is the one the
  // default receptionist and every receptionist without its own speak.
  const businessLanguageLabel = split ? t("agent:receptionists.businessLanguage.label") : t("agent:fields.defaultLocale.label");
  const businessLanguageItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{businessLanguageLabel}</ItemTitle>
        <ItemDescription>{split ? t("agent:receptionists.businessLanguage.hint") : t("agent:fields.defaultLocale.hint")}</ItemDescription>
        {isLocaleSaving ? (
          <ItemDescription>{t("agent:actions.saving")}</ItemDescription>
        ) : null}
        {!isLocaleSaving && localeStatus ? (
          <ItemDescription>{localeStatus}</ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {isLoadingConfiguration ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-40" />
        ) : (
          <NativeSelect
            aria-label={businessLanguageLabel}
            className="w-full sm:w-40"
            disabled={!canManageTenant}
            id="agent-default-language"
            onChange={(event) => void saveBusinessLocale((event.target.value as RuntimeLocale | "") || "en")}
            value={defaultLocale}
          >
            {/* Each language in its own name, as in every dashboard language. */}
            {runtimeLocales.map((locale) => (
              <NativeSelectOption key={locale} lang={locale} value={locale}>
                {runtimeLocaleEndonyms[locale]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );

  const ownLanguageItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:receptionists.language.label")}</ItemTitle>
        <ItemDescription>{isDefaultReceptionist ? t("agent:receptionists.language.defaultHint") : t("agent:receptionists.language.hint")}</ItemDescription>
        {isOwnLocaleSaving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!isOwnLocaleSaving && ownLocaleStatus ? <ItemDescription>{ownLocaleStatus}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {isLoadingConfiguration ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-56" />
        ) : (
          <NativeSelect
            aria-label={t("agent:receptionists.language.label")}
            className="w-full sm:w-56"
            disabled={isDefaultReceptionist || isOwnLocaleSaving || !persistedProfile || !canManageTenant}
            id="agent-receptionist-language"
            onChange={(event) => void saveOwnLocale(normalizeRuntimeLocale(event.target.value))}
            value={isDefaultReceptionist ? "" : ownLocale ?? ""}
          >
            <NativeSelectOption value="">{t("agent:receptionists.language.business", { language: runtimeLocaleEndonyms[defaultLocale] })}</NativeSelectOption>
            {runtimeLocales.map((locale) => (
              <NativeSelectOption key={locale} lang={locale} value={locale}>
                {runtimeLocaleEndonyms[locale]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );

  const timezoneItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.timezone.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.timezone.hint")}</ItemDescription>
        {isTimezoneSaving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!isTimezoneSaving && timezoneStatus ? <ItemDescription>{timezoneStatus}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {isLoadingConfiguration ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-72" />
        ) : (
          <NativeSelect
            aria-label={t("agent:fields.timezone.label")}
            className="w-full sm:w-72"
            disabled={isTimezoneSaving || !timezone || !canManageTenant}
            id="agent-timezone"
            onChange={(event) => void saveTimezone(event.target.value)}
            value={timezone}
          >
            {timeZoneGroups.flatMap((group) => group.region === null ? timeZoneOptions(group.zones) : [<NativeSelectOptGroup key={group.region} label={isTimeZoneRegion(group.region) ? t(`agent:fields.timezone.regions.${group.region.toLowerCase()}`) : group.region}>{timeZoneOptions(group.zones)}</NativeSelectOptGroup>])}
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );

  const transferItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.transferNumber.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.transferNumber.hint")}</ItemDescription>
        <div className="pt-2">
          {isLoadingConfiguration ? (
            <Skeleton className="h-10 w-full rounded-md sm:w-48" />
          ) : (
            <PhoneInput
              // A fresh field for each receptionist, so one's number never shows as the next one's.
              key={settingsOf}
              className="w-full min-w-0 sm:w-48"
              containerClassName="w-full sm:w-fit"
              disabled={!canManageTenant}
              id="agent-transfer-number"
              locale={i18n.language}
              maxLength={18}
              onChange={(nextValue) => {
                setTransferNumber(nextValue ?? "");
                setTransferStatus(null);
                setTransferStatusTone("success");
              }}
              onRawValueChange={(nextRawValue) => {
                transferNumberEdited.current = true;
                setTransferNumberInputValue(nextRawValue);
                setTransferStatus(null);
                setTransferStatusTone("success");
              }}
              {...(transferNumber ? { value: transferNumber } : {})}
            />
          )}
        </div>
        {transferStatus ? (
          <ItemDescription
            className={transferStatusTone === "error" ? "text-destructive" : undefined}
          >
            {transferStatus}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="w-full justify-end self-center sm:w-auto">
        <Button
          disabled={
            isLoadingConfiguration ||
            isTransferSaving ||
            !persistedProfile ||
            !canManageTenant
          }
          onClick={() => void saveTransferNumber()}
          size="sm"
          type="button"
          variant="outline"
        >
          {isTransferSaving ? t("agent:actions.saving") : t("agent:actions.save")}
        </Button>
      </ItemActions>
    </Item>
  );

  const bookingItem = (
    <Item className={itemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:booking.mode.label")}</ItemTitle>
        <ItemDescription>{t(`agent:booking.mode.descriptions.${bookingMode}`)}</ItemDescription>
        {isBookingModeSaving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!isBookingModeSaving && bookingModeStatus ? <ItemDescription>{bookingModeStatus}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {isLoadingConfiguration ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-48" />
        ) : (
          <NativeSelect
            aria-label={t("agent:booking.mode.label")}
            className="w-full sm:w-48"
            disabled={isBookingModeSaving || !persistedProfile || !canManageTenant}
            id="agent-booking-mode"
            onChange={(event) => {
              const nextMode = normalizeBookingMode(event.target.value);
              setBookingMode(nextMode);
              void saveBookingMode(nextMode);
            }}
            value={bookingMode}
          >
            <NativeSelectOption value="instant">{t("agent:booking.mode.options.instant")}</NativeSelectOption>
            <NativeSelectOption value="request">{t("agent:booking.mode.options.request")}</NativeSelectOption>
            <NativeSelectOption value="off">{t("agent:booking.mode.options.off")}</NativeSelectOption>
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );

  const bookingWithoutHours = !isLoadingConfiguration && hours.data && needsHoursForBooking({ ...hours.data, bookingMode }) ? <BookingWithoutHoursAlert /> : null;

  const appointmentChangesSection = (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-sm leading-snug font-medium">
        {t("agent:appointmentChanges.title")}
      </h2>
      <Surface className="flex flex-col">
        <Item className={itemClassName} variant="default">
          <ItemContent>
            <ItemTitle>{t("agent:appointmentChanges.allowCancel.label")}</ItemTitle>
            <ItemDescription>
              {t("agent:appointmentChanges.allowCancel.hint")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {isLoadingConfiguration ? (
              <Skeleton className="h-5 w-8 rounded-full" />
            ) : (
              <Switch
                aria-label={t("agent:appointmentChanges.allowCancel.label")}
                checked={allowAppointmentCancel}
                disabled={isAppointmentChangeSaving || !persistedProfile || !canManageTenant}
                onCheckedChange={(checked) => {
                  setAllowAppointmentCancel(checked);
                  setAppointmentChangeStatus(null);
                  void saveAppointmentChangePolicy({ allowCancel: checked });
                }}
              />
            )}
          </ItemActions>
        </Item>

        <Item className={itemClassName} variant="default">
          <ItemContent>
            <ItemTitle>{t("agent:appointmentChanges.allowReschedule.label")}</ItemTitle>
            <ItemDescription>
              {t("agent:appointmentChanges.allowReschedule.hint")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {isLoadingConfiguration ? (
              <Skeleton className="h-5 w-8 rounded-full" />
            ) : (
              <Switch
                aria-label={t("agent:appointmentChanges.allowReschedule.label")}
                checked={allowAppointmentReschedule}
                disabled={isAppointmentChangeSaving || !persistedProfile || !canManageTenant}
                onCheckedChange={(checked) => {
                  setAllowAppointmentReschedule(checked);
                  setAppointmentChangeStatus(null);
                  void saveAppointmentChangePolicy({ allowReschedule: checked });
                }}
              />
            )}
          </ItemActions>
        </Item>

        <Item className={itemClassName} variant="default">
          <ItemContent>
            <ItemTitle>{t("agent:appointmentChanges.verification.label")}</ItemTitle>
            <ItemDescription>
              {t(`agent:appointmentChanges.verification.descriptions.${appointmentChangeVerification}`)}
            </ItemDescription>
            {appointmentChangeStatus ? (
              <ItemDescription>{appointmentChangeStatus}</ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions className="w-full sm:w-auto">
            {isLoadingConfiguration ? (
              <Skeleton className="h-10 w-full rounded-md sm:w-56" />
            ) : (
              <NativeSelect
                aria-label={t("agent:appointmentChanges.verification.label")}
                className="w-full sm:w-56"
                disabled={isAppointmentChangeSaving || !persistedProfile || !canManageTenant}
                id="agent-appointment-change-verification"
                onChange={(event) => {
                  const nextMode = savedVerificationMode(event.target.value);
                  setAppointmentChangeVerification(nextMode);
                  setAppointmentChangeStatus(null);
                  void saveAppointmentChangePolicy({ verificationMode: nextMode });
                }}
                value={appointmentChangeVerification}
              >
                {(offeredVerificationModes.includes(appointmentChangeVerification) ? offeredVerificationModes : [...offeredVerificationModes, appointmentChangeVerification]).map((mode) => (
                  <NativeSelectOption key={mode} value={mode}>{t(`agent:appointmentChanges.verification.options.${mode}`)}</NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </ItemActions>
        </Item>
      </Surface>
    </section>
  );

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
