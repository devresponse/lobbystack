"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeBookingMode, normalizeRuntimeLocale, runtimeLocaleEndonyms, runtimeLocales, type BookingMode, type RuntimeLocale } from "@lobbystack/shared";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PhoneInput } from "@/components/ui/phone-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { settingItemClassName, useFlashStatus, useSavedDraft, type SettingProps } from "./settings-kit";

// Each receptionist's own AI settings: its greeting, language, transfer
// number and booking. The page saves them to the receptionist it shows, and
// mounts them afresh for each receptionist, so nothing typed for one ever
// shows as the next one's.

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

/** What a call hears first. */
export function GreetingItem({ profile, canManage, loading, save }: SettingProps) {
  const { t } = useTranslation("agent");
  const [greeting, setGreeting] = useSavedDraft(profile?.greeting);
  const [status, setStatus] = useFlashStatus<string>();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function saveGreeting(): Promise<void> {
    if (!canManage || !profile) return;
    setSaving(true);
    setStatus(null);
    // Only the greeting: the dialog hides the other fields, so their drafts stay unsaved.
    if (await save({ greeting }, "greeting")) {
      setStatus(t("agent:actions.saved"));
      setOpen(false);
    }
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.greeting.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.greeting.hint")}</ItemDescription>
        {status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full justify-end self-center sm:w-auto">
        <Button
          aria-label={t("agent:actions.editField", { field: t("agent:fields.greeting.label") })}
          disabled={loading || !profile || !canManage}
          onClick={() => {
            setGreeting(profile?.greeting ?? "");
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
          <DialogHeader><DialogTitle>{t("agent:fields.greeting.label")}</DialogTitle></DialogHeader>
          <Textarea
            autoFocus
            disabled={!canManage || saving}
            id="agent-greeting"
            onChange={(event) => setGreeting(event.target.value)}
            placeholder={t("agent:fields.greeting.placeholder")}
            rows={3}
            value={greeting}
          />
          <DialogFooter>
            <Button disabled={saving} onClick={() => setOpen(false)} type="button" variant="outline">{t("agent:actions.cancel")}</Button>
            <Button disabled={saving || !canManage || !greeting.trim()} onClick={() => void saveGreeting()} type="button">
              {saving ? t("agent:actions.saving") : t("agent:actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Item>
  );
}

/** A receptionist's own language. The default receptionist speaks the business's, set among the shared settings. */
export function OwnLanguageItem({ profile, canManage, loading, save, isDefault, businessLocale }: SettingProps & { isDefault: boolean; businessLocale: RuntimeLocale }) {
  const { t } = useTranslation("agent");
  // Null speaks the business's.
  const saved = profile ? normalizeRuntimeLocale(profile.locale) : undefined;
  const [locale, setLocale] = useState<RuntimeLocale | null>(saved ?? null);
  useEffect(() => {
    if (saved !== undefined) setLocale(saved);
  }, [saved]);
  const [status, setStatus] = useFlashStatus<string>();
  const [saving, setSaving] = useState(false);

  async function change(next: RuntimeLocale | null): Promise<void> {
    if (!canManage || !profile || isDefault) return;
    const previous = locale;
    setLocale(next);
    setSaving(true);
    setStatus(null);
    if (await save({ receptionistLocale: next }, "receptionist_locale")) setStatus(t("agent:actions.saved"));
    else setLocale(previous);
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:receptionists.language.label")}</ItemTitle>
        <ItemDescription>{isDefault ? t("agent:receptionists.language.defaultHint") : t("agent:receptionists.language.hint")}</ItemDescription>
        {saving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!saving && status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {loading ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-56" />
        ) : (
          <NativeSelect
            aria-label={t("agent:receptionists.language.label")}
            className="w-full sm:w-56"
            disabled={isDefault || saving || !profile || !canManage}
            id="agent-receptionist-language"
            onChange={(event) => void change(normalizeRuntimeLocale(event.target.value))}
            value={isDefault ? "" : locale ?? ""}
          >
            <NativeSelectOption value="">{t("agent:receptionists.language.business", { language: runtimeLocaleEndonyms[businessLocale] })}</NativeSelectOption>
            {runtimeLocales.map((option) => (
              <NativeSelectOption key={option} lang={option} value={option}>
                {runtimeLocaleEndonyms[option]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );
}

/** The number a call is handed to when the caller asks for a person. */
export function TransferNumberItem({ profile, canManage, loading, save }: SettingProps) {
  const { i18n, t } = useTranslation("agent");
  const saved = profile ? profile.transferNumber ?? "" : undefined;
  // The number as PhoneInput last read it, and what the field shows, which may not be a number yet.
  const [number, setNumber] = useState(saved ?? "");
  const [rawInput, setRawInput] = useState(saved ?? "");
  const [status, setStatus] = useFlashStatus<{ text: string; tone: "success" | "error" }>();
  const [saving, setSaving] = useState(false);
  const numberRef = useRef(number);
  numberRef.current = number;
  // The field takes the saved number only while nobody has edited it since it was saved.
  const edited = useRef(false);
  useEffect(() => {
    if (saved === undefined || edited.current) return;
    setNumber(saved);
    setRawInput(saved);
  }, [saved]);

  async function saveNumber(): Promise<void> {
    if (!canManage || !profile) return;
    const resolution = resolveTransferNumberForSave({ rawInputValue: rawInput, validTransferNumber: number });
    if (!resolution.ok) {
      setStatus({ text: t(resolution.errorKey), tone: "error" });
      return;
    }
    setSaving(true);
    setStatus(null);
    if (await save({ transferNumber: resolution.value }, "transfer_number")) {
      // Typing that started during the save is still unsaved.
      if (numberRef.current === (resolution.value ?? "")) edited.current = false;
      setStatus({ text: t("agent:actions.saved"), tone: "success" });
    }
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:fields.transferNumber.label")}</ItemTitle>
        <ItemDescription>{t("agent:fields.transferNumber.hint")}</ItemDescription>
        <div className="pt-2">
          {loading ? (
            <Skeleton className="h-10 w-full rounded-md sm:w-48" />
          ) : (
            <PhoneInput
              className="w-full min-w-0 sm:w-48"
              containerClassName="w-full sm:w-fit"
              disabled={!canManage}
              id="agent-transfer-number"
              locale={i18n.language}
              maxLength={18}
              onChange={(next) => {
                setNumber(next ?? "");
                setStatus(null);
              }}
              onRawValueChange={(next) => {
                edited.current = true;
                setRawInput(next);
                setStatus(null);
              }}
              {...(number ? { value: number } : {})}
            />
          )}
        </div>
        {status ? (
          <ItemDescription className={status.tone === "error" ? "text-destructive" : undefined}>
            {status.text}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="w-full justify-end self-center sm:w-auto">
        <Button
          disabled={loading || saving || !profile || !canManage}
          onClick={() => void saveNumber()}
          size="sm"
          type="button"
          variant="outline"
        >
          {saving ? t("agent:actions.saving") : t("agent:actions.save")}
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * Whether calls book, ask for, or don't take appointments. The page keeps
 * the value, since instant booking without opening hours shows a warning
 * below the settings.
 */
export function BookingModeItem({ profile, canManage, loading, save, value, onChange }: SettingProps & { value: BookingMode; onChange: (next: BookingMode) => void }) {
  const { t } = useTranslation("agent");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function change(next: BookingMode): Promise<void> {
    onChange(next);
    if (!canManage || !profile) return;
    setSaving(true);
    setStatus(null);
    if (await save({ bookingMode: next }, "booking_mode")) setStatus(t("agent:actions.saved"));
    setSaving(false);
  }

  return (
    <Item className={settingItemClassName} variant="default">
      <ItemContent>
        <ItemTitle>{t("agent:booking.mode.label")}</ItemTitle>
        <ItemDescription>{t(`agent:booking.mode.descriptions.${value}`)}</ItemDescription>
        {saving ? <ItemDescription>{t("agent:actions.saving")}</ItemDescription> : null}
        {!saving && status ? <ItemDescription>{status}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">
        {loading ? (
          <Skeleton className="h-10 w-full rounded-md sm:w-48" />
        ) : (
          <NativeSelect
            aria-label={t("agent:booking.mode.label")}
            className="w-full sm:w-48"
            disabled={saving || !profile || !canManage}
            id="agent-booking-mode"
            onChange={(event) => void change(normalizeBookingMode(event.target.value))}
            value={value}
          >
            <NativeSelectOption value="instant">{t("agent:booking.mode.options.instant")}</NativeSelectOption>
            <NativeSelectOption value="request">{t("agent:booking.mode.options.request")}</NativeSelectOption>
            <NativeSelectOption value="off">{t("agent:booking.mode.options.off")}</NativeSelectOption>
          </NativeSelect>
        )}
      </ItemActions>
    </Item>
  );
}
