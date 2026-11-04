"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { appointmentChangeVerificationModes, callRecordingNotices, intlLocale, runtimeLocaleEndonyms, runtimeLocales, type AppointmentChangePolicy, type AppointmentChangeVerificationMode, type RuntimeLocale } from "@lobbystack/shared";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { availableTimeZones, groupTimeZones, isTimeZoneRegion, type TimeZoneOption } from "@/lib/time-zones";

import { settingItemClassName, useFlashStatus, useSavedDraft, type SettingProps } from "./settings-kit";

// The AI settings every receptionist of a business shares: the summary, the
// AI and recording notice, the business's language and time zone, and the
// rules for changing appointments. The page saves them to the business,
// whichever receptionist it shows.

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

/** What the business does, which calls and chats start from. */
export function SummaryItem({ profile, canManage, loading, save }: SettingProps) {
  const { t } = useTranslation("agent");
  // The sign-up placeholder isn't a summary, so it shows as empty.
  const saved = profile ? (profile.summarySource === "placeholder" ? "" : profile.summary) : undefined;
  const [summary, setSummary] = useSavedDraft(saved);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function saveSummary(regenerate: boolean): Promise<void> {
    if (!canManage || !profile || (!regenerate && !summary.trim())) return;
    setSaving(true);
    setStatus(null);
    if (await save(regenerate ? { regenerateSummary: true } : { summary: summary.trim() }, regenerate ? "summary_regenerated" : "summary")) {
      setStatus(regenerate ? t("agent:fields.summary.regenerating") : t("agent:actions.saved"));
      setOpen(false);
    }
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.summary.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.summary.hint")}</ItemDescription>
        {status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full justify-end self-center sm:w-auto">
        <Button
          aria-label={t("agent:actions.editField", { field: t("agent:fields.summary.label") })}
          disabled={loading || !profile || !canManage}
          onClick={() => {
            setSummary(saved ?? "");
            setStatus(null);
            setOpen(true);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("agent:actions.edit")}
        </Button>
      </ItemActions>
      <Dialog onOpenChange={(next) => { if (!next && !saving) setOpen(false); }} open={open}>
        <DialogContent className="flex flex-col gap-4 sm:max-w-lg">
          <DialogHeader><DialogTitle>{t("agent:fields.summary.label")}</DialogTitle></DialogHeader>
          <Textarea
            autoFocus
            disabled={!canManage || saving}
            id="agent-summary"
            maxLength={2000}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={t("agent:fields.summary.placeholder")}
            rows={6}
            value={summary}
          />
          <DialogFooter className="sm:justify-between">
            {profile?.summarySource === "operator" ? (
              <Button disabled={saving || !canManage} onClick={() => void saveSummary(true)} type="button" variant="ghost">
                {t("agent:fields.summary.regenerate")}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button disabled={saving} onClick={() => setOpen(false)} type="button" variant="outline">{t("agent:actions.cancel")}</Button>
              <Button disabled={saving || !canManage || !summary.trim()} onClick={() => void saveSummary(false)} type="button">
                {saving ? t("agent:actions.saving") : t("agent:actions.save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Item>
  );
}

/** Whether calls say they're with an AI and recorded, quoting what callers hear in the business's language. */
export function RecordingNoticeItem({ profile, canManage, loading, save, locale }: SettingProps & { locale: RuntimeLocale }) {
  const { t } = useTranslation("agent");
  // A profile saved before the switch existed has it on.
  const saved = profile ? profile.recordingNotice !== false : undefined;
  const [on, setOn] = useState(saved ?? true);
  useEffect(() => {
    if (saved !== undefined) setOn(saved);
  }, [saved]);
  const [status, setStatus] = useFlashStatus<string>();
  const [saving, setSaving] = useState(false);

  async function change(next: boolean): Promise<void> {
    if (!canManage || !profile) return;
    setOn(next);
    setSaving(true);
    setStatus(null);
    if (await save({ recordingNotice: next }, "recording_notice")) setStatus(t("agent:actions.saved"));
    else setOn(!next);
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.recordingNotice.label")}</ItemTitle>
        {/* What callers hear, in the language calls open in. */}
        <ItemDescription>{t("agent:fields.recordingNotice.hint", { notice: callRecordingNotices[locale] })}</ItemDescription>
        {status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        {loading ? (
          <Skeleton className="h-5 w-8 rounded-full" />
        ) : (
          <Switch
            aria-label={t("agent:fields.recordingNotice.label")}
            checked={on}
            disabled={saving || !profile || !canManage}
            onCheckedChange={(checked) => void change(checked)}
          />
        )}
      </ItemActions>
    </Item>
  );
}

/**
 * The language calls open in: the default receptionist's, and every other
 * receptionist's that has none of its own. The page keeps the value, since
 * the AI notice and other receptionists' languages show it too.
 */
export function BusinessLanguageItem({ profile, canManage, loading, save, value, onChange, split }: SettingProps & { value: RuntimeLocale; onChange: (next: RuntimeLocale) => void; split: boolean }) {
  const { t } = useTranslation("agent");
  const [status, setStatus] = useFlashStatus<string>();
  const [saving, setSaving] = useState(false);
  // With several receptionists the business's language is the one the
  // default receptionist and every receptionist without its own speak.
  const label = split ? t("agent:receptionists.businessLanguage.label") : t("agent:fields.defaultLocale.label");

  async function change(next: RuntimeLocale): Promise<void> {
    onChange(next);
    setStatus(null);
    if (!canManage || !profile) return;
    setSaving(true);
    if (await save({ defaultLocale: next }, "default_locale")) setStatus(t("agent:actions.saved"));
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{split ? t("agent:receptionists.businessLanguage.hint") : t("agent:fields.defaultLocale.hint")}</ItemDescription>
        {saving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!saving && status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {loading ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-40" />
        ) : (
          <NativeSelect
            aria-label={label}
            className="w-full sm:w-40"
            disabled={!canManage}
            id="agent-default-language"
            onChange={(event) => void change((event.target.value as RuntimeLocale | "") || "en")}
            value={value}
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
}

/** The business's time zone, which a business without a receptionist yet can set too. */
export function TimezoneItem({ saved, canManage, loading, save }: Omit<SettingProps, "profile"> & { saved: string }) {
  const { i18n, t } = useTranslation("agent");
  const [timezone, setTimezone] = useState(saved);
  useEffect(() => {
    setTimezone(saved);
  }, [saved]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Built once the business's zone loads, so the server render and hydration agree.
  const groups = useMemo(() => saved ? groupTimeZones(availableTimeZones(saved), intlLocale(i18n.language)) : [], [saved, i18n.language]);
  const options = (zones: TimeZoneOption[]) => zones.map((zone) => <NativeSelectOption key={zone.id} value={zone.id}>{zone.label}</NativeSelectOption>);

  async function change(next: string): Promise<void> {
    if (!canManage) return;
    const previous = timezone;
    setTimezone(next);
    setSaving(true);
    setStatus(null);
    // Only this field shows the zone, so the saved settings go stale rather than refetch.
    if (await save({ timezone: next }, "timezone", { refetchType: "none" })) setStatus(t("agent:actions.saved"));
    else setTimezone(previous);
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.timezone.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.timezone.hint")}</ItemDescription>
        {saving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!saving && status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {loading ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-72" />
        ) : (
          <NativeSelect
            aria-label={t("agent:fields.timezone.label")}
            className="w-full sm:w-72"
            disabled={saving || !timezone || !canManage}
            id="agent-timezone"
            onChange={(event) => void change(event.target.value)}
            value={timezone}
          >
            {groups.flatMap((group) => group.region === null ? options(group.zones) : [<NativeSelectOptGroup key={group.region} label={isTimeZoneRegion(group.region) ? t(`agent:fields.timezone.regions.${group.region.toLowerCase()}`) : group.region}>{options(group.zones)}</NativeSelectOptGroup>])}
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );
}

/** Whether callers can cancel or reschedule an appointment, and how they prove it's theirs. */
export function AppointmentChangesSection({ profile, canManage, loading, save }: SettingProps) {
  const { t } = useTranslation("agent");
  // Undefined while the settings load; null when the business never saved any.
  const saved = profile?.appointmentChangePolicy;
  const [allowCancel, setAllowCancel] = useState(saved?.allowCancel ?? true);
  const [allowReschedule, setAllowReschedule] = useState(saved?.allowReschedule ?? true);
  const [verification, setVerification] = useState(() => savedVerificationMode(saved?.verificationMode));
  useEffect(() => {
    if (saved === undefined) return;
    setAllowCancel(saved?.allowCancel ?? true);
    setAllowReschedule(saved?.allowReschedule ?? true);
    setVerification(savedVerificationMode(saved?.verificationMode));
  }, [saved]);
  const [status, setStatus] = useFlashStatus<string>();
  const [saving, setSaving] = useState(false);

  /** Saves the rules with one of them changed; the state holding it may not have caught up yet. */
  async function saveChange(change: { allowCancel?: boolean; allowReschedule?: boolean; verificationMode?: AppointmentChangeVerificationMode }): Promise<void> {
    setStatus(null);
    if (!canManage || !profile) return;
    setSaving(true);
    if (await save({ appointmentChangePolicy: buildAppointmentChangePolicyForSave({ allowCancel, allowReschedule, verificationMode: verification, ...change }) }, "appointment_change_policy")) setStatus(t("agent:actions.saved"));
    setSaving(false);
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-sm leading-snug font-medium">
        {t("agent:appointmentChanges.title")}
      </h2>
      <Surface className="flex flex-col">
        <Item className={settingItemClassName} variant="default">
          <ItemContent>
            <ItemTitle>{t("agent:appointmentChanges.allowCancel.label")}</ItemTitle>
            <ItemDescription>
              {t("agent:appointmentChanges.allowCancel.hint")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {loading ? (
              <Skeleton className="h-5 w-8 rounded-full" />
            ) : (
              <Switch
                aria-label={t("agent:appointmentChanges.allowCancel.label")}
                checked={allowCancel}
                disabled={saving || !profile || !canManage}
                onCheckedChange={(checked) => {
                  setAllowCancel(checked);
                  void saveChange({ allowCancel: checked });
                }}
              />
            )}
          </ItemActions>
        </Item>

        <Item className={settingItemClassName} variant="default">
          <ItemContent>
            <ItemTitle>{t("agent:appointmentChanges.allowReschedule.label")}</ItemTitle>
            <ItemDescription>
              {t("agent:appointmentChanges.allowReschedule.hint")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {loading ? (
              <Skeleton className="h-5 w-8 rounded-full" />
            ) : (
              <Switch
                aria-label={t("agent:appointmentChanges.allowReschedule.label")}
                checked={allowReschedule}
                disabled={saving || !profile || !canManage}
                onCheckedChange={(checked) => {
                  setAllowReschedule(checked);
                  void saveChange({ allowReschedule: checked });
                }}
              />
            )}
          </ItemActions>
        </Item>

        <Item className={settingItemClassName} variant="default">
          <ItemContent>
            <ItemTitle>{t("agent:appointmentChanges.verification.label")}</ItemTitle>
            <ItemDescription>
              {t(`agent:appointmentChanges.verification.descriptions.${verification}`)}
            </ItemDescription>
            {status ? (
              <ItemDescription>{status}</ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions className="w-full sm:w-auto">
            {loading ? (
              <Skeleton className="h-10 w-full rounded-md sm:w-56" />
            ) : (
              <NativeSelect
                aria-label={t("agent:appointmentChanges.verification.label")}
                className="w-full sm:w-56"
                disabled={saving || !profile || !canManage}
                id="agent-appointment-change-verification"
                onChange={(event) => {
                  const next = savedVerificationMode(event.target.value);
                  setVerification(next);
                  void saveChange({ verificationMode: next });
                }}
                value={verification}
              >
                {(offeredVerificationModes.includes(verification) ? offeredVerificationModes : [...offeredVerificationModes, verification]).map((mode) => (
                  <NativeSelectOption key={mode} value={mode}>{t(`agent:appointmentChanges.verification.options.${mode}`)}</NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </ItemActions>
        </Item>
      </Surface>
    </section>
  );
}
