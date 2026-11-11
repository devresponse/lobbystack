"use client";

import { useEffect, useRef, useState } from "react";

import type { AppointmentChangePolicy, BookingMode, RuntimeLocale } from "@lobbystack/shared";

// What the AI settings page hands each of its settings. The page loads the
// settings and saves each change; every setting keeps its own field, its
// "Saving…" and "Saved", and puts its field back when its save fails. Each
// field starts from the saved value and follows it, so one the page mounts
// again, say when it switches between its one- and several-receptionist
// layouts, shows the saved value at once.

/** A receptionist's settings as GET /api/agent gives them, with the ones every receptionist shares. */
export type AgentSettingsProfile = {
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

export type AgentSettings = { business: { defaultLocale: RuntimeLocale; timezone: string } | null; profile: AgentSettingsProfile | null };

/** One change, as PATCH /api/agent takes it once the page adds the business. */
export type SettingsChange = {
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

/** The setting web.agent.settings_saved names. */
export type SavedSetting = "greeting" | "summary" | "summary_regenerated" | "recording_notice" | "default_locale" | "receptionist_locale" | "timezone" | "transfer_number" | "booking_mode" | "appointment_change_policy";

/**
 * Saves one change and says whether it saved; a failed save has already
 * shown its toast. refetchType "none" leaves the saved settings stale rather
 * than refetching them.
 */
export type SaveSetting = (change: SettingsChange, setting: SavedSetting, options?: { refetchType?: "active" | "none" }) => Promise<boolean>;

export type SettingProps = {
  /** The settings as saved: undefined while they load, null for a business without a receptionist yet. */
  profile: AgentSettingsProfile | null | undefined;
  canManage: boolean;
  /** True until the page's fields hold the settings of the business and receptionist picked. */
  loading: boolean;
  save: SaveSetting;
};

export const settingItemClassName = "rounded-none border-x-0 border-t-0 border-b border-border last:border-b-0";

/** A status line, such as "Saved", that clears itself 3 seconds after it shows. */
export function useFlashStatus<T>() {
  const [status, setStatus] = useState<T | null>(null);
  useEffect(() => {
    if (status === null) return;
    const timeout = window.setTimeout(() => setStatus(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [status]);
  return [status, setStatus] as const;
}

/**
 * A text field's draft that takes the saved value only while it still holds
 * the last one. Every save refetches the settings, and so does coming back
 * to the tab, and a refetch that lands while someone is typing must not undo
 * their edit. Undefined, while the settings load, changes nothing.
 */
export function useSavedDraft(saved: string | undefined) {
  const [draft, setDraft] = useState(saved ?? "");
  const synced = useRef(saved);
  useEffect(() => {
    if (saved === undefined) return;
    const previous = synced.current;
    synced.current = saved;
    setDraft((current) => previous === undefined || current === previous ? saved : current);
  }, [saved]);
  return [draft, setDraft] as const;
}
