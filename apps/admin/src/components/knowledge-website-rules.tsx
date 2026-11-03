"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { normalizeWebsiteRulePath } from "@lobbystack/shared";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { audienceErrorMessage } from "@/components/knowledge-audience";
import type { ReceptionistOption } from "@/components/receptionists/receptionist-choices";
import { ReceptionistSelect } from "@/components/receptionists/receptionist-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { requestJson } from "@/lib/request-json";

// Website rules: each gives the pages of a site the business added, under a
// path such as /stores/kitsilano/, to one receptionist, on the crawl it is
// made with and every later one. A rule is made with the site in the Import
// Website dialog, or later in the Website rules dialog, which also lists and
// deletes them. Only owners and admins see either.

/** A website rule as GET /api/knowledge/website-rules lists it. */
export type WebsiteRule = { id: string; rootDocumentId: string; siteUrl: string; pathPrefix: string; receptionistId: string; createdAt: string; pages: number };

/** A website the business added to Knowledge: the source rules belong to. */
export type WebsiteSource = { id: string; url: string };

export const websiteRulesQueryKey = (businessId: string | undefined) => ["knowledge-website-rules", businessId] as const;

/** Rules a page shows before "Show all". */
const RULES_SHOWN = 5;

/** A rule as the Import Website dialog edits it, before the site exists. */
export type DraftRule = { key: string; path: string; receptionistId: string | null };

/** The site's host and path without the scheme, as the rules list names a site. */
export function siteLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.replace(/^www\./u, "")}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return url;
  }
}

/**
 * The rules to send with a new website: rows with a path or a receptionist
 * must have both, and a path the rules can use; empty rows are skipped.
 * Returns the rules, or the keys of the rows to fix.
 */
export function draftRulesForSave(drafts: DraftRule[]): { rules: Array<{ pathPrefix: string; receptionistId: string }>; invalid: string[] } {
  const rules: Array<{ pathPrefix: string; receptionistId: string }> = [];
  const invalid: string[] = [];
  for (const draft of drafts) {
    if (!draft.path.trim() && !draft.receptionistId) continue;
    const pathPrefix = normalizeWebsiteRulePath(draft.path);
    if (!pathPrefix || !draft.receptionistId) invalid.push(draft.key);
    else rules.push({ pathPrefix, receptionistId: draft.receptionistId });
  }
  return { rules, invalid };
}

let draftKeys = 0;
/** An empty rule row with its own key. */
export function newDraftRule(): DraftRule {
  draftKeys += 1;
  return { key: `rule-${draftKeys}`, path: "", receptionistId: null };
}

/** The page rules of the Import Website dialog: a path and "Goes to" for each, Add rule, and what they do. */
export function ImportWebsiteRules({ drafts, onChange, invalid, receptionists, disabled = false }: {
  drafts: DraftRule[];
  onChange: (drafts: DraftRule[]) => void;
  /** Keys of the rows a save found unusable. */
  invalid: readonly string[];
  receptionists: ReceptionistOption[];
  disabled?: boolean;
}) {
  const { t } = useTranslation(["agent", "receptionists"]);
  const id = useId();
  if (receptionists.length < 2) return null;
  const update = (key: string, change: Partial<DraftRule>) => onChange(drafts.map((draft) => draft.key === key ? { ...draft, ...change } : draft));
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{t("agent:sections.knowledge.receptionists.rules.importLabel")}</legend>
      {drafts.map((draft, index) => {
        const wrong = invalid.includes(draft.key);
        const errorId = `${id}-${draft.key}-error`;
        return (
          <div className="flex flex-col gap-2 rounded-lg border p-3" data-invalid={wrong || undefined} key={draft.key}>
            <div className="flex items-center gap-2">
              <Input
                aria-describedby={wrong ? errorId : undefined}
                aria-invalid={wrong || undefined}
                aria-label={t("agent:sections.knowledge.receptionists.rules.pathOf", { number: index + 1 })}
                className="font-mono text-sm"
                onChange={(event) => update(draft.key, { path: event.target.value })}
                placeholder={t("agent:sections.knowledge.receptionists.rules.pathPlaceholder")}
                value={draft.path}
              />
              <Button aria-label={t("agent:sections.knowledge.receptionists.rules.removeDraft", { number: index + 1 })} onClick={() => onChange(drafts.filter((other) => other.key !== draft.key))} size="icon-sm" type="button" variant="ghost">
                <X />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden="true">{t("agent:sections.knowledge.receptionists.rules.goesTo")}</span>
              <ReceptionistSelect
                className="min-w-48"
                hideLabel
                label={t("agent:sections.knowledge.receptionists.rules.goesToOf", { number: index + 1 })}
                onChange={(receptionistId) => update(draft.key, { receptionistId })}
                receptionists={receptionists}
                size="sm"
                value={draft.receptionistId}
              />
            </div>
            {wrong ? <p className="text-sm text-destructive" id={errorId} role="alert">{t("agent:sections.knowledge.receptionists.rules.invalidDraft")}</p> : null}
          </div>
        );
      })}
      <Button className="self-start" onClick={() => onChange([...drafts, newDraftRule()])} size="sm" type="button" variant="outline">
        <Plus data-icon="inline-start" />{t("agent:sections.knowledge.receptionists.rules.add")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("agent:sections.knowledge.receptionists.rules.description")}</p>
    </fieldset>
  );
}

/**
 * The Website rules dialog: the rules of the business's sites, or of one, with
 * how many pages each gave its receptionist, Delete, and a form to add one.
 */
export function WebsiteRulesDialog({ businessId, open, onOpenChange, sites, siteId, receptionists, onChanged }: {
  businessId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: WebsiteSource[];
  /** Opens on one site's rules, from that site's row. */
  siteId?: string | null | undefined;
  receptionists: ReceptionistOption[];
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation(["agent", "receptionists"]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("agent:sections.knowledge.receptionists.rules.title")}</DialogTitle>
          <DialogDescription>{t("agent:sections.knowledge.receptionists.rules.description")}</DialogDescription>
        </DialogHeader>
        {open ? <WebsiteRulesBody businessId={businessId} key={siteId ?? "all"} onChanged={onChanged} receptionists={receptionists} siteId={siteId ?? null} sites={sites} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function WebsiteRulesBody({ businessId, sites, siteId, receptionists, onChanged }: {
  businessId: string;
  sites: WebsiteSource[];
  siteId: string | null;
  receptionists: ReceptionistOption[];
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation(["agent", "receptionists"]);
  const id = useId();
  const [showAll, setShowAll] = useState(false);
  const [site, setSite] = useState<string>(siteId ?? sites[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [receptionistId, setReceptionistId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [deleting, setDeleting] = useState<WebsiteRule | null>(null);
  const rules = useQuery({
    queryKey: websiteRulesQueryKey(businessId),
    queryFn: () => requestJson<{ rules: WebsiteRule[] }>(`/api/knowledge/website-rules?businessId=${encodeURIComponent(businessId)}`),
  });
  const listed = (rules.data?.rules ?? []).filter((rule) => !siteId || rule.rootDocumentId === siteId);
  const visible = showAll ? listed : listed.slice(0, RULES_SHOWN);
  const nameOf = (rule: WebsiteRule) => receptionists.find((receptionist) => receptionist.id === rule.receptionistId)?.name;
  const pathPrefix = normalizeWebsiteRulePath(path);
  const pathWrong = submitted && !pathPrefix;
  const receptionistMissing = submitted && !receptionistId;
  const refresh = async () => { await Promise.all([rules.refetch(), onChanged()]); };
  const add = useMutation({
    mutationFn: () => requestJson<{ rule: WebsiteRule }>(`/api/knowledge/website-rules?businessId=${encodeURIComponent(businessId)}`, { method: "POST", body: JSON.stringify({ rootDocumentId: site, pathPrefix, receptionistId }) }),
    onSuccess: async ({ rule }) => {
      toast.success(t("agent:sections.knowledge.receptionists.rules.added", { count: rule.pages, name: nameOf(rule) ?? "" }));
      setPath("");
      setReceptionistId(null);
      setSubmitted(false);
      await refresh();
    },
    onError: (error) => { toast.error(audienceErrorMessage(error, t)); },
  });
  const remove = useMutation({
    mutationFn: (rule: WebsiteRule) => requestJson(`/api/knowledge/website-rules/${encodeURIComponent(rule.id)}?businessId=${encodeURIComponent(businessId)}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("agent:sections.knowledge.receptionists.rules.removed"));
      setDeleting(null);
      await refresh();
    },
    onError: (error) => { toast.error(audienceErrorMessage(error, t)); },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!site || !pathPrefix || !receptionistId) return;
    add.mutate();
  }

  if (!sites.length) return <p className="text-sm text-muted-foreground">{t("agent:sections.knowledge.receptionists.rules.noSites")}</p>;
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${id}-list`} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium" id={`${id}-list`}>{t("agent:sections.knowledge.receptionists.rules.listTitle")}</h3>
        {rules.isLoading ? <p className="text-sm text-muted-foreground">{t("agent:loading.rules")}</p> : listed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agent:sections.knowledge.receptionists.rules.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {visible.map((rule) => (
              <li className="flex items-center gap-3 px-3 py-2" key={rule.id}>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-sm">{siteId ? rule.pathPrefix : `${siteLabel(rule.siteUrl)}${rule.pathPrefix}`}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t("agent:sections.knowledge.receptionists.rules.goesToName", { name: nameOf(rule) ?? t("receptionists:picker.unknown") })}
                    {" · "}
                    {t("agent:sections.knowledge.receptionists.rules.pages", { count: rule.pages })}
                  </span>
                </div>
                <Button aria-label={t("agent:sections.knowledge.receptionists.rules.delete", { path: rule.pathPrefix })} onClick={() => setDeleting(rule)} size="icon-sm" type="button" variant="ghost">
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!showAll && listed.length > RULES_SHOWN ? (
          <Button className="self-start px-0" onClick={() => setShowAll(true)} size="sm" type="button" variant="link">
            {t("agent:sections.knowledge.receptionists.rules.showAll", { count: listed.length })}
          </Button>
        ) : null}
      </section>
      <form aria-labelledby={`${id}-add`} className="flex flex-col gap-3 rounded-lg border p-3" noValidate onSubmit={submit}>
        <h3 className="text-sm font-medium" id={`${id}-add`}>{t("agent:sections.knowledge.receptionists.rules.add")}</h3>
        {!siteId && sites.length > 1 ? (
          <label className="flex flex-col gap-1.5 text-sm">
            <span>{t("agent:sections.knowledge.receptionists.rules.site")}</span>
            <NativeSelect className="w-full" onChange={(event) => setSite(event.target.value)} value={site}>
              {sites.map((source) => <NativeSelectOption key={source.id} value={source.id}>{siteLabel(source.url)}</NativeSelectOption>)}
            </NativeSelect>
          </label>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm">
          <span>{t("agent:sections.knowledge.receptionists.rules.path")}</span>
          <Input
            aria-describedby={pathWrong ? `${id}-path-error` : undefined}
            aria-invalid={pathWrong || undefined}
            className="font-mono"
            onChange={(event) => setPath(event.target.value)}
            placeholder={t("agent:sections.knowledge.receptionists.rules.pathPlaceholder")}
            value={path}
          />
        </label>
        {pathWrong ? <p className="text-sm text-destructive" id={`${id}-path-error`} role="alert">{t("receptionists:audience.errors.rulePath")}</p> : null}
        <div className="flex flex-col gap-1.5 text-sm">
          <ReceptionistSelect
            className="w-full sm:w-72"
            label={t("agent:sections.knowledge.receptionists.rules.goesTo")}
            onChange={setReceptionistId}
            receptionists={receptionists}
            value={receptionistId}
          />
          {receptionistMissing ? <p className="text-sm text-destructive" role="alert">{t("agent:sections.knowledge.receptionists.rules.chooseReceptionist")}</p> : null}
        </div>
        <Button className="self-start" loading={add.isPending} size="sm" type="submit">
          <Plus data-icon="inline-start" />{t("agent:sections.knowledge.receptionists.rules.add")}
        </Button>
      </form>
      <ConfirmActionDialog
        cancelLabel={t("agent:actions.deleteCancel")}
        confirmLabel={t("agent:sections.knowledge.receptionists.rules.deleteConfirm")}
        confirmVariant="destructive"
        description={t("agent:sections.knowledge.receptionists.rules.deleteDescription")}
        onConfirm={async () => { if (deleting) await remove.mutateAsync(deleting); }}
        onOpenChange={(open) => { if (!open && !remove.isPending) setDeleting(null); }}
        open={deleting !== null}
        pending={remove.isPending}
        title={t("agent:sections.knowledge.receptionists.rules.deleteTitle", { path: deleting?.pathPrefix ?? "" })}
      />
    </div>
  );
}
