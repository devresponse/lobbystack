"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { callTranscriptContentChoices, type CallTranscriptContent, type CallTranscriptRecipients, type CallTranscriptUnavailableReason } from "@lobbystack/shared";

import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Surface } from "@/components/ui/surface";
import { requestJson } from "@/lib/request-json";

/** What the notification settings say about the email after each call, for the person reading them. */
export type CallTranscriptState = { available: boolean; unavailableReason: CallTranscriptUnavailableReason | null; recipients: CallTranscriptRecipients; content: CallTranscriptContent; canEdit: boolean };

// The default first, and turning the email off last.
const recipientChoices: CallTranscriptRecipients[] = ["owners_and_admins", "team", "nobody"];

/** The business's choice of who can get an email after each call and what it holds, which owners and admins make. */
export function CallTranscriptSettingsCard({ businessId, settings }: { businessId: string; settings: CallTranscriptState }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (change: { recipients: CallTranscriptRecipients } | { content: CallTranscriptContent }) => requestJson(`/api/call-transcript-settings?businessId=${encodeURIComponent(businessId)}`, { method: "PUT", body: JSON.stringify(change) }),
    // The table above names the email for what it holds, and says who gets it.
    onSettled: async () => { await queryClient.invalidateQueries({ queryKey: ["notification-preferences", businessId] }); },
    onError: () => toast.error(t("notifications.callTranscripts.saveFailed")),
  });
  const pending = save.isPending ? save.variables : undefined;
  const recipients = pending && "recipients" in pending ? pending.recipients : settings.recipients;
  const content = pending && "content" in pending ? pending.content : settings.content;
  const row = "rounded-none border-x-0 border-t-0 border-b border-border last:border-b-0";
  return <section className="flex flex-col gap-4"><div className="flex flex-col gap-1"><h3 className="text-sm font-medium text-foreground">{t("notifications.callTranscripts.title")}</h3><p className="text-sm text-muted-foreground">{t("notifications.callTranscripts.description")}</p></div><Surface className="flex flex-col">
    <Item className={row}><ItemContent><ItemTitle>{t("notifications.callTranscripts.recipients.title")}</ItemTitle><ItemDescription>{t("notifications.callTranscripts.recipients.description")}</ItemDescription></ItemContent><ItemActions className="w-full sm:w-auto"><NativeSelect aria-label={t("notifications.callTranscripts.recipients.title")} className="w-full sm:w-56" disabled={save.isPending} onChange={(event) => save.mutate({ recipients: event.target.value as CallTranscriptRecipients })} value={recipients}>{recipientChoices.map((choice) => <NativeSelectOption key={choice} value={choice}>{t(`notifications.callTranscripts.recipients.${choice}`)}</NativeSelectOption>)}</NativeSelect></ItemActions></Item>
    <Item className={row}><ItemContent><ItemTitle>{t("notifications.callTranscripts.content.title")}</ItemTitle><ItemDescription>{t(`notifications.callTranscripts.content.${content}Description`)}</ItemDescription></ItemContent><ItemActions className="w-full sm:w-auto"><NativeSelect aria-label={t("notifications.callTranscripts.content.title")} className="w-full sm:w-56" disabled={save.isPending || recipients === "nobody"} onChange={(event) => save.mutate({ content: event.target.value as CallTranscriptContent })} value={content}>{callTranscriptContentChoices.map((choice) => <NativeSelectOption key={choice} value={choice}>{t(`notifications.callTranscripts.content.${choice}`)}</NativeSelectOption>)}</NativeSelect></ItemActions></Item>
  </Surface></section>;
}
