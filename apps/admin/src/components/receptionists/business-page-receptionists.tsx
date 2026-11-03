"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Users } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { alphabeticalReceptionistOrder, isAlphabeticalReceptionistOrder } from "@lobbystack/shared";

import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { FieldDescription, FieldLegend, FieldSet } from "../ui/field";
import { ReceptionistAvatar } from "./receptionist-avatar";
import { receptionistChoicesQueryKey, receptionistsQueryKey, useReceptionistChoices, type ReceptionistOption } from "./receptionist-choices";
import { receptionistErrorMessage } from "./receptionist-errors";
import { ReceptionistMultiSelect } from "./receptionist-multi-select";

// Settings → Public profile, "Receptionists on your page": which receptionists
// the business page offers under "Choose who to talk to", and in what order.
// The default receptionist answers the page, so it is always there and
// always first. Changes save as they're made, one after another, and show at
// once; a refusal puts the list back as the server has it. Hidden while the
// business has one receptionist.

type Change =
  | { kind: "listed"; receptionistIds: string[] }
  | { kind: "order"; order: string[] | "alphabetical" };

/**
 * The order with a listed receptionist moved past the next listed one up or
 * down; unlisted receptionists keep their places, and the default stays
 * first. Null at either end.
 */
export function movedAmongListed(receptionists: readonly ReceptionistOption[], receptionistId: string, direction: -1 | 1): string[] | null {
  const others = receptionists.filter((receptionist) => !receptionist.isDefault);
  const listed = others.filter((receptionist) => receptionist.listed);
  const at = listed.findIndex((receptionist) => receptionist.id === receptionistId);
  const neighbour = at < 0 ? undefined : listed[at + direction];
  if (!neighbour) return null;
  const ids = others.map((receptionist) => receptionist.id);
  const from = ids.indexOf(receptionistId);
  const to = ids.indexOf(neighbour.id);
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return [...receptionists.filter((receptionist) => receptionist.isDefault).map((receptionist) => receptionist.id), ...ids];
}

/** The receptionists in the order given, numbered as the server numbers them. */
function inOrder(receptionists: readonly ReceptionistOption[], order: readonly string[]): ReceptionistOption[] {
  const byId = new Map(receptionists.map((receptionist) => [receptionist.id, receptionist]));
  return order.flatMap((id, index) => {
    const receptionist = byId.get(id);
    return receptionist ? [{ ...receptionist, sortOrder: index + 1 }] : [];
  });
}

export function BusinessPageReceptionists({ businessId, canEdit, businessLocale }: { businessId: string; canEdit: boolean; businessLocale: string | undefined }) {
  const { t } = useTranslation("receptionists");
  const id = useId();
  const queryClient = useQueryClient();
  const { receptionists } = useReceptionistChoices(businessId);
  // "Custom" chosen while the list still goes by name: the move buttons show, and nothing changes until one is moved.
  const [customizing, setCustomizing] = useState(false);
  const locale = businessLocale ?? "en";
  const choicesKey = receptionistChoicesQueryKey(businessId);
  const mutationKey = [...receptionistsQueryKey(businessId), "business-page"] as const;

  const change = useMutation({
    mutationKey,
    // One change at a time, in the order they were made, so the last one wins.
    scope: { id: `business-page-receptionists:${businessId}` },
    mutationFn: async (next: Change) => await requestJson<{ receptionists: ReceptionistOption[] }>(
      next.kind === "listed" ? `/api/receptionists/listed?businessId=${encodeURIComponent(businessId)}` : `/api/receptionists/order?businessId=${encodeURIComponent(businessId)}`,
      { method: "PUT", body: JSON.stringify(next.kind === "listed" ? { receptionistIds: next.receptionistIds } : next.order === "alphabetical" ? { order: "alphabetical" } : { receptionistIds: next.order }) },
    ),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: choicesKey });
      queryClient.setQueryData<{ receptionists: ReceptionistOption[] }>(choicesKey, (current) => {
        if (!current) return current;
        const list = current.receptionists;
        if (next.kind === "listed") return { receptionists: list.map((receptionist) => (receptionist.isDefault ? receptionist : { ...receptionist, listed: next.receptionistIds.includes(receptionist.id) })) };
        return { receptionists: inOrder(list, next.order === "alphabetical" ? alphabeticalReceptionistOrder(list, locale) : next.order) };
      });
    },
    onError: (error, next) => { toast.error(receptionistErrorMessage(error, t, next.kind === "listed" ? "edit" : "order")); },
    onSettled: async () => {
      // Once the last change is in, the lists everywhere catch up with the server.
      if (queryClient.isMutating({ mutationKey }) <= 1) await queryClient.invalidateQueries({ queryKey: receptionistsQueryKey(businessId) });
    },
    meta: { inlineError: true },
  });

  if (receptionists.length < 2) return null;
  const defaultReceptionist = receptionists.find((receptionist) => receptionist.isDefault);
  const others = receptionists.filter((receptionist) => !receptionist.isDefault);
  const listed = others.filter((receptionist) => receptionist.listed);
  const alphabetical = isAlphabeticalReceptionistOrder(receptionists, locale);
  const custom = customizing || !alphabetical;
  const onPage = [...(defaultReceptionist ? [defaultReceptionist] : []), ...listed];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Users aria-hidden="true" className="size-5 text-muted-foreground" />{t("pageList.title")}</CardTitle>
        <CardDescription>{t("pageList.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {canEdit ? (
          <div className="flex flex-col gap-1.5">
            <ReceptionistMultiSelect
              alwaysShow
              label={t("pageList.listed")}
              onChange={(receptionistIds) => change.mutate({ kind: "listed", receptionistIds })}
              receptionists={others}
              summary={(chosen) => t("pageList.chosen", { count: chosen })}
              value={listed.map((receptionist) => receptionist.id)}
            />
            <p className="text-xs text-muted-foreground">{t("pageList.listedHint")}</p>
          </div>
        ) : null}

        {canEdit ? (
          <FieldSet className="gap-0">
            <FieldLegend variant="label">{t("pageList.order")}</FieldLegend>
            <div className="grid grid-cols-2 gap-1 rounded-full bg-muted p-1 sm:max-w-sm" role="radiogroup" aria-label={t("pageList.order")}>
              {(["alphabetical", "custom"] as const).map((value) => {
                const checked = value === "custom" ? custom : !custom;
                return (
                  <label className={cn("relative flex h-8 cursor-pointer items-center justify-center rounded-full text-sm font-medium transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50", checked ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} key={value}>
                    <input
                      checked={checked}
                      className="sr-only"
                      name={`${id}-order`}
                      onChange={() => {
                        if (value === "custom") { setCustomizing(true); return; }
                        setCustomizing(false);
                        if (!alphabetical) change.mutate({ kind: "order", order: "alphabetical" });
                      }}
                      type="radio"
                      value={value}
                    />
                    {t(`pageList.${value}`)}
                  </label>
                );
              })}
            </div>
            <FieldDescription className="mt-2">{custom ? t("pageList.customHint") : t("pageList.alphabeticalHint", { name: defaultReceptionist?.name ?? "" })}</FieldDescription>
          </FieldSet>
        ) : null}

        <ol aria-label={t("pageList.onPage")} className="flex flex-col divide-y divide-border rounded-xl border">
          {onPage.map((receptionist) => {
            const place = listed.findIndex((entry) => entry.id === receptionist.id);
            const paused = receptionist.status === "paused";
            return (
              <li className="flex min-h-14 items-center gap-3 px-3.5 py-2.5" key={receptionist.id}>
                <ReceptionistAvatar id={receptionist.id} name={receptionist.name} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium" title={receptionist.name}>{receptionist.name}</span>
                    {receptionist.isDefault ? <Badge className="flex-none" variant="secondary">{t("table.default")}</Badge> : null}
                  </div>
                  <span className="truncate text-sm text-muted-foreground">
                    {receptionist.isDefault ? t("pageList.alwaysFirst") : paused ? t("pageList.paused") : receptionist.description}
                  </span>
                </div>
                {canEdit && custom && !receptionist.isDefault ? (
                  <div className="flex flex-none items-center gap-1">
                    <Button aria-label={t("table.moveUp", { name: receptionist.name })} disabled={place <= 0} onClick={() => { const order = movedAmongListed(receptionists, receptionist.id, -1); if (order) change.mutate({ kind: "order", order }); }} size="icon-sm" type="button" variant="ghost"><ArrowUp /></Button>
                    <Button aria-label={t("table.moveDown", { name: receptionist.name })} disabled={place < 0 || place >= listed.length - 1} onClick={() => { const order = movedAmongListed(receptionists, receptionist.id, 1); if (order) change.mutate({ kind: "order", order }); }} size="icon-sm" type="button" variant="ghost"><ArrowDown /></Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {listed.length ? null : <p className="-mt-3 text-sm text-muted-foreground">{t("pageList.noneListed", { name: defaultReceptionist?.name ?? "" })}</p>}
      </CardContent>
    </Card>
  );
}
