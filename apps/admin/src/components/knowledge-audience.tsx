"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { MAX_ARTICLES_PER_AUDIENCE_CHANGE } from "@lobbystack/shared";

import { AudienceField, audienceChoiceOf, audienceValueOf, SegmentedChoice, type AudienceValue } from "@/components/receptionists/audience-field";
import type { ReceptionistOption } from "@/components/receptionists/receptionist-choices";
import { ReceptionistMultiSelect } from "@/components/receptionists/receptionist-multi-select";
import { ReceptionistNames } from "@/components/receptionists/receptionist-names";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { intlLocale } from "@/lib/locale";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";

// Who each article on the Knowledge page is for: the Available to column, the
// bulk change for the articles selected, and the dialog for one article. With
// one receptionist none of it shows.

/** The receptionists each chosen article is for, as GET /api/knowledge/audience gives them; articles for everyone have no entry. */
export type KnowledgeAudienceLinks = {
  documents: Record<string, Array<{ receptionistId: string; websiteRuleId: string | null }>>;
  snippets: Record<string, string[]>;
};

/** A file, website page or text entry, and who it is for now. */
export type KnowledgeArticle = { kind: "document" | "snippet"; id: string; title: string; audience?: string | null | undefined };

export const knowledgeAudienceQueryKey = (businessId: string | undefined) => ["knowledge-audience", businessId] as const;

/** Who the business's chosen articles are for; asked only while there are several receptionists to tell apart. */
export function useKnowledgeAudience(businessId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: knowledgeAudienceQueryKey(businessId),
    queryFn: () => requestJson<KnowledgeAudienceLinks>(`/api/knowledge/audience?businessId=${encodeURIComponent(businessId!)}`),
    enabled: Boolean(businessId) && enabled,
  });
}

/** The receptionists an article is chosen for, archived ones included. */
export function articleReceptionistIds(links: KnowledgeAudienceLinks | undefined, article: Pick<KnowledgeArticle, "kind" | "id">): string[] {
  if (!links) return [];
  return article.kind === "document" ? (links.documents[article.id] ?? []).map((link) => link.receptionistId) : links.snippets[article.id] ?? [];
}

/** Whether a website rule chose the page for a receptionist the business still lists. */
export function chosenByRule(links: KnowledgeAudienceLinks | undefined, article: Pick<KnowledgeArticle, "kind" | "id">, receptionists: readonly ReceptionistOption[]): boolean {
  if (!links || article.kind !== "document") return false;
  return (links.documents[article.id] ?? []).some((link) => link.websiteRuleId !== null && receptionists.some((receptionist) => receptionist.id === link.receptionistId));
}

type Translate = TFunction;

/** The codes the server refuses a change to who articles are for, or to a website rule, with. */
const AUDIENCE_ERROR_CODES = new Set(["receptionist_archived", "receptionist_not_found", "knowledge_not_found", "invalid_audience", "invalid_articles", "website_rule_exists", "invalid_website_rule", "website_rule_not_found"]);

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** Whether the server refused a change because of who articles are for or a website rule, which audienceErrorMessage explains. */
export function isAudienceError(error: unknown): boolean {
  const code = errorCode(error);
  return typeof code === "string" && AUDIENCE_ERROR_CODES.has(code);
}

/** Explains a refused change to who articles are for, or to a website rule, by the code the server sends. */
export function audienceErrorMessage(error: unknown, t: Translate): string {
  const code = errorCode(error);
  const errorId = typeof error === "object" && error !== null ? (error as { errorId?: unknown }).errorId : undefined;
  switch (code) {
    case "receptionist_archived": return t("receptionists:audience.errors.archived");
    case "receptionist_not_found": return t("receptionists:errors.notFound");
    case "knowledge_not_found": return t("receptionists:audience.errors.articleGone");
    case "invalid_audience": return t("receptionists:audience.required");
    case "invalid_articles": return t("receptionists:audience.errors.articles", { max: MAX_ARTICLES_PER_AUDIENCE_CHANGE });
    case "website_rule_exists": return t("receptionists:audience.errors.ruleExists");
    case "invalid_website_rule": return t("receptionists:audience.errors.rulePath");
    case "website_rule_not_found": return t("receptionists:audience.errors.ruleGone");
    default:
      return typeof errorId === "string" && errorId
        ? t("receptionists:errors.withErrorId", { message: t("receptionists:errors.generic"), errorId })
        : t("receptionists:errors.generic");
  }
}

/** Names in a sentence: "Sales and Support", or the first two and "+N" past three. */
export function receptionistList(names: string[], language: string, t: Translate): string {
  if (names.length <= 3) return new Intl.ListFormat(intlLocale(language), { type: "conjunction" }).format(names);
  return `${names.slice(0, 2).join(", ")} ${t("receptionists:names.more", { count: names.length - 2 })}`;
}

/** The Available to cell: "Everyone", up to 2 names and "+N", and "by rule" for a page a website rule chose. */
export function KnowledgeAvailableTo({ article, links, receptionists }: { article: KnowledgeArticle; links: KnowledgeAudienceLinks | undefined; receptionists: ReceptionistOption[] }) {
  const { t } = useTranslation("receptionists");
  const chosen = article.audience === "chosen";
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm">
      <ReceptionistNames className="min-w-0 truncate" everyone={!chosen} receptionistIds={articleReceptionistIds(links, article)} receptionists={receptionists} />
      {chosen && chosenByRule(links, article, receptionists) ? <span className="shrink-0 text-xs text-muted-foreground">{t("audience.byRule")}</span> : null}
    </span>
  );
}

type BulkMode = "add" | "remove" | "replace";

/**
 * The bar over the table while articles are selected: how many, Available to
 * with its panel to open them to everyone or add, remove or replace chosen
 * receptionists, and Clear.
 */
export function KnowledgeBulkAudience({ businessId, articles, receptionists, onClear, onChanged }: {
  businessId: string;
  articles: KnowledgeArticle[];
  receptionists: ReceptionistOption[];
  onClear: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { i18n, t } = useTranslation(["agent", "receptionists"]);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState<"everyone" | "chosen">("chosen");
  const [mode, setMode] = useState<BulkMode>("add");
  const [receptionistIds, setReceptionistIds] = useState<string[]>([]);
  const count = articles.length;
  const tooMany = count > MAX_ARTICLES_PER_AUDIENCE_CHANGE;
  const chosen = receptionists.filter((receptionist) => receptionistIds.includes(receptionist.id));
  const names = receptionistList(chosen.map((receptionist) => receptionist.name), i18n.language, t);
  const ready = count > 0 && !tooMany && (audience === "everyone" || chosen.length > 0);
  const change = useMutation({
    mutationFn: () => requestJson<{ documents: number; snippets: number }>(`/api/knowledge/audience?businessId=${encodeURIComponent(businessId)}`, {
      method: "POST",
      body: JSON.stringify({
        documentIds: articles.filter((article) => article.kind === "document").map((article) => article.id),
        snippetIds: articles.filter((article) => article.kind === "snippet").map((article) => article.id),
        ...(audience === "everyone" ? { audience: "everyone" } : { audience: "chosen", mode, receptionistIds: chosen.map((receptionist) => receptionist.id) }),
      }),
    }),
    onSuccess: async (result) => {
      toast.success(t("agent:sections.knowledge.receptionists.bulk.done", { count: result.documents + result.snippets }));
      setOpen(false);
      setReceptionistIds([]);
      await onChanged();
    },
    onError: (error) => { toast.error(audienceErrorMessage(error, t)); },
  });
  const summary = audience === "everyone"
    ? t("agent:sections.knowledge.receptionists.bulk.summary.everyone", { count })
    : chosen.length ? t(`agent:sections.knowledge.receptionists.bulk.summary.${mode}`, { count, names }) : null;

  return (
    <div className="flex flex-col rounded-md border bg-muted/40">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium" role="status">{t("agent:sections.knowledge.receptionists.selected", { count })}</span>
        <Button aria-controls={panelId} aria-expanded={open} onClick={() => setOpen((current) => !current)} size="sm" type="button" variant="outline">
          {t("agent:sections.knowledge.receptionists.bulk.open")}
          <ChevronDown className={cn("transition-transform", open && "rotate-180")} data-icon="inline-end" />
        </Button>
        <Button onClick={onClear} size="sm" type="button" variant="ghost">{t("agent:sections.knowledge.receptionists.clear")}</Button>
      </div>
      {open ? (
        <div aria-label={t("agent:sections.knowledge.receptionists.bulk.open")} className="flex flex-col gap-3 border-t bg-background px-3 py-3 sm:px-4" id={panelId} role="region">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            <SegmentedChoice
              hideLabel
              label={t("receptionists:audience.label")}
              onChange={setAudience}
              options={[{ value: "everyone", label: t("receptionists:audience.everyone") }, { value: "chosen", label: t("receptionists:audience.chosen") }]}
              value={audience}
            />
            {audience === "chosen" ? (
              <SegmentedChoice
                hideLabel
                label={t("agent:sections.knowledge.receptionists.bulk.mode")}
                onChange={setMode}
                options={[
                  { value: "add", label: t("agent:sections.knowledge.receptionists.bulk.add") },
                  { value: "remove", label: t("agent:sections.knowledge.receptionists.bulk.remove") },
                  { value: "replace", label: t("agent:sections.knowledge.receptionists.bulk.replace") },
                ]}
                value={mode}
              />
            ) : null}
          </div>
          {audience === "chosen" ? (
            <ReceptionistMultiSelect
              className="w-full max-w-xl"
              hideLabel
              label={t("receptionists:audience.receptionists")}
              onChange={setReceptionistIds}
              receptionists={receptionists}
              value={receptionistIds}
            />
          ) : null}
          {audience === "chosen" && mode !== "replace" ? <p className="text-xs text-muted-foreground">{t(`agent:sections.knowledge.receptionists.bulk.${mode === "add" ? "addNote" : "removeNote"}`)}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-muted-foreground">{tooMany ? t("agent:sections.knowledge.receptionists.bulk.tooMany", { max: MAX_ARTICLES_PER_AUDIENCE_CHANGE }) : summary}</p>
            <Button disabled={!ready} loading={change.isPending} onClick={() => change.mutate()} size="sm" type="button">
              {t("agent:sections.knowledge.receptionists.bulk.apply", { count })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Available to for one file, website page or text entry, from its row's
 * menu. Saving replaces who it is for with the choice, keeping only the
 * receptionists the business lists.
 */
export function KnowledgeAudienceDialog({ businessId, article, links, receptionists, onOpenChange, onChanged }: {
  businessId: string;
  article: KnowledgeArticle | null;
  links: KnowledgeAudienceLinks | undefined;
  receptionists: ReceptionistOption[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation(["agent", "receptionists"]);
  return (
    <Dialog onOpenChange={onOpenChange} open={article !== null}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {article ? <AudienceDialogBody article={article} businessId={businessId} key={`${article.kind}:${article.id}`} links={links} onChanged={onChanged} onOpenChange={onOpenChange} receptionists={receptionists} t={t} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AudienceDialogBody({ businessId, article, links, receptionists, onOpenChange, onChanged, t }: {
  businessId: string;
  article: KnowledgeArticle;
  links: KnowledgeAudienceLinks | undefined;
  receptionists: ReceptionistOption[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void> | void;
  t: Translate;
}) {
  const [value, setValue] = useState<AudienceValue>(() => audienceValueOf(article.audience, articleReceptionistIds(links, article), receptionists));
  const [submitted, setSubmitted] = useState(false);
  const choice = audienceChoiceOf(value, receptionists);
  const save = useMutation({
    mutationFn: () => requestJson(`/api/knowledge/audience?businessId=${encodeURIComponent(businessId)}`, {
      method: "POST",
      body: JSON.stringify({
        documentIds: article.kind === "document" ? [article.id] : [],
        snippetIds: article.kind === "snippet" ? [article.id] : [],
        ...(choice?.audience === "chosen" ? { audience: "chosen", mode: "replace", receptionistIds: choice.receptionistIds } : { audience: "everyone" }),
      }),
    }),
    onSuccess: async () => {
      toast.success(t("agent:sections.knowledge.receptionists.dialog.done"));
      onOpenChange(false);
      await onChanged();
    },
    onError: (error) => { toast.error(audienceErrorMessage(error, t)); },
  });
  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={(event) => { event.preventDefault(); setSubmitted(true); if (choice) save.mutate(); }}>
      <DialogHeader>
        <DialogTitle>{t("receptionists:audience.label")}</DialogTitle>
        <DialogDescription>{t("agent:sections.knowledge.receptionists.dialog.description", { title: article.title })}</DialogDescription>
      </DialogHeader>
      <AudienceField
        disabled={save.isPending}
        invalid={submitted && !choice}
        note={article.audience === "chosen" && chosenByRule(links, article, receptionists) ? t("receptionists:audience.ruleNote") : undefined}
        onChange={setValue}
        receptionists={receptionists}
        value={value}
      />
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} type="button" variant="outline">{t("agent:actions.cancel")}</Button>
        <Button loading={save.isPending} type="submit">{t("agent:actions.saveChanges")}</Button>
      </DialogFooter>
    </form>
  );
}
