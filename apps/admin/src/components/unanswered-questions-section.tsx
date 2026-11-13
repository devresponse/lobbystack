"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTable, type PaginationState } from "@tanstack/react-table";
import { MessageCircleQuestionMark } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useReceptionistChoices, useReceptionistFilter, receptionistQuery } from "@/components/receptionists/receptionist-choices";
import { DataTablePagination, paginationFeatures } from "@/components/data-table/pagination";
import { ReceptionistFilter } from "@/components/receptionists/receptionist-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError, FieldLegend, FieldSet } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { intlLocale } from "@/lib/locale";
import { requestJson } from "@/lib/request-json";

/** A receptionist that heard a question, most often first; an archived one still shows it heard it. */
export type QuestionAsker = { receptionistId: string; name: string; archived: boolean; timesAsked: number; lastAskedAt: string };
export type UnansweredQuestion = { id: string; question: string; timesAsked: number; firstAskedAt: string; lastAskedAt: string; lastChannel: string; askedOf?: QuestionAsker[] };
/** openByReceptionist counts each receptionist's open questions, for the filter. */
export type UnansweredQuestions = { questions: UnansweredQuestion[]; openCount: number; openByReceptionist?: Record<string, number> };
type AnswerAudience = "everyone" | "asked";

const NAMES_SHOWN = 2;

// The domain's MAX_UNANSWERED_ANSWER_LENGTH.
const MAX_ANSWER_LENGTH = 5_000;

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** A page of the list: its number from 0 and how many questions it holds. */
export type QuestionsPage = { pageIndex: number; pageSize: number };

/** The open questions, or with a receptionist the ones it heard, or a page of them, under one key per business so a change refreshes them all. */
export const unansweredQuestionsQueryKey = (businessId: string | undefined, receptionistId: string | null = null, page?: QuestionsPage) => ["unanswered-questions", businessId, ...(receptionistId ? [receptionistId] : []), ...(page ? ["page", page.pageIndex, page.pageSize] : [])] as const;

/** The open questions, most asked first: the first 50 without a page, as Home's card reads them. */
export function fetchUnansweredQuestions(businessId: string, receptionistId: string | null = null, page?: QuestionsPage): Promise<UnansweredQuestions> {
  const paging = page ? `&limit=${page.pageSize}&offset=${page.pageIndex * page.pageSize}` : "";
  return requestJson<UnansweredQuestions>(`/api/knowledge/questions?businessId=${encodeURIComponent(businessId)}${receptionistQuery(receptionistId)}${paging}`);
}

/** Open questions the receptionist couldn't answer, most asked first. Owners and admins answer or dismiss them. */
export function UnansweredQuestionsSection({ businessId, canManage }: { businessId: string; canManage: boolean }) {
  const { i18n, t } = useTranslation(["knowledge", "receptionists", "agent"]);
  const queryClient = useQueryClient();
  const [answering, setAnswering] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [audience, setAudience] = useState<AnswerAudience>("everyone");
  // The answer box opens on a click of Answer, so the cursor goes there.
  const focusOnOpen = useCallback((node: HTMLTextAreaElement | null) => node?.focus(), []);
  // With several receptionists, each question says who heard it, the list
  // filters by receptionist, and an answer can be for only the ones that heard it.
  const { receptionists } = useReceptionistChoices(businessId);
  const several = receptionists.length > 1;
  const [receptionistId] = useReceptionistFilter();
  // 10 questions a page, as the tables start.
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const questions = useQuery({
    queryKey: unansweredQuestionsQueryKey(businessId, receptionistId, pagination),
    queryFn: () => fetchUnansweredQuestions(businessId, receptionistId, pagination),
    // The page on screen stays while the next one loads.
    placeholderData: keepPreviousData,
  });
  const total = questions.data?.openCount ?? 0;
  // Another receptionist's questions start at their first page.
  useEffect(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  }, [receptionistId]);
  // Answering or dismissing the last question of the last page goes back a page.
  useEffect(() => {
    if (!questions.data) return;
    setPagination((current) => {
      const lastPage = Math.max(0, Math.ceil(total / current.pageSize) - 1);
      return current.pageIndex > lastPage ? { ...current, pageIndex: lastPage } : current;
    });
  }, [total, questions.data]);
  const refresh = async (answered: boolean) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: unansweredQuestionsQueryKey(businessId) }),
      ...(answered ? [queryClient.invalidateQueries({ queryKey: ["knowledge-snippets", businessId] })] : []),
    ]);
  };
  // Someone else answered or dismissed it first: show the list as it is now.
  const alreadyHandled = async () => { toast.info(t("unansweredQuestions.toast.alreadyHandled")); await refresh(false); };
  const resolve = (questionId: string, body: { action: "answer"; answer: string; audience?: "asked" } | { action: "dismiss" }) =>
    requestJson(`/api/knowledge/questions/${encodeURIComponent(questionId)}?businessId=${encodeURIComponent(businessId)}`, { method: "PATCH", body: JSON.stringify(body) });
  const answer = useMutation({
    // An answer for everyone names no audience, as before receptionists.
    mutationFn: ({ questionId, text, audience: answerAudience }: { questionId: string; text: string; audience: AnswerAudience }) => resolve(questionId, { action: "answer", answer: text, ...(answerAudience === "asked" ? { audience: "asked" as const } : {}) }),
    onSuccess: async () => { setAnswering(null); setDraft(""); toast.success(t("unansweredQuestions.toast.answered")); await refresh(true); },
    onError: async (error) => {
      // A too-long answer shows at the answer box.
      if (errorCode(error) === "answer_too_long") return;
      if (errorCode(error) === "question_resolved") { setAnswering(null); setDraft(""); await alreadyHandled(); return; }
      // The receptionists that heard it were archived meanwhile; the answer can still go to everyone.
      if (errorCode(error) === "no_receptionists_asked") { setAudience("everyone"); toast.error(t("unansweredQuestions.toast.noneHeard")); await refresh(false); return; }
      toast.error(t("common:errors.unexpected"));
    },
  });
  const dismiss = useMutation({
    mutationFn: (questionId: string) => resolve(questionId, { action: "dismiss" }),
    onSuccess: async () => { toast.success(t("unansweredQuestions.toast.dismissed")); await refresh(false); },
    onError: async (error) => {
      if (errorCode(error) === "question_resolved") { await alreadyHandled(); return; }
      toast.error(t("common:errors.unexpected"));
    },
  });
  const answerTooLong = answer.isError && errorCode(answer.error) === "answer_too_long";
  const locale = intlLocale(i18n.resolvedLanguage ?? i18n.language);
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
  const open = questions.data?.questions ?? [];
  // The tables' pagination, driven by the page of questions the server sent.
  const table = useTable({ features: paginationFeatures, columns: [], data: open, manualPagination: true, rowCount: total, onPaginationChange: setPagination, state: { pagination } });
  const heardBy = (askers: QuestionAsker[]) => {
    const names = askers.map((asker) => asker.archived ? t("receptionists:record.archived", { name: asker.name }) : asker.name);
    const more = names.length - NAMES_SHOWN;
    return t("unansweredQuestions.heardBy", { names: names.slice(0, NAMES_SHOWN).join(", ") + (more > 0 ? ` ${t("receptionists:names.more", { count: more })}` : "") });
  };

  return <section aria-labelledby="unanswered-questions-title" className="flex flex-col gap-3">
    <div className="flex items-start justify-between gap-4 px-1">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="type-section-title" id="unanswered-questions-title">{t("unansweredQuestions.title")}</h2>
      </div>
      {questions.isLoading ? <Skeleton className="h-6 w-12 rounded-full" /> : <Badge variant="outline">{(questions.data?.openCount ?? 0).toLocaleString(locale)}</Badge>}
    </div>
    <ReceptionistFilter
      businessId={businessId}
      className="w-full sm:w-72"
      counts={questions.data?.openByReceptionist ? { byReceptionist: questions.data.openByReceptionist, label: (count) => t("unansweredQuestions.home.count", { count }) } : undefined}
    />
    {/* A page past the last, after its last question went, shows as loading until it moves back. */}
    {questions.isLoading || (!open.length && total > 0) ? <Card className="border-border/70"><CardContent className="flex flex-col gap-4">{Array.from({ length: 3 }, (_, index) => <div className="flex flex-col gap-2" key={index}><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>)}</CardContent></Card>
      : questions.isError ? <p className="px-1 text-sm text-destructive">{t("unansweredQuestions.loadFailed")}</p>
      : open.length ? <><Card className="ph-mask border-border/70"><CardContent><ItemGroup>
        {open.map((question, index) => {
          const editing = answering === question.id;
          const askers = question.askedOf ?? [];
          // Only receptionists that aren't archived can take an answer meant for the ones that heard it.
          const liveAskers = askers.filter((asker) => !asker.archived).length;
          const offerHeard = several && liveAskers > 0;
          return <Fragment key={question.id}>
            <Item className="px-0">
              <ItemMedia variant="icon"><MessageCircleQuestionMark className="text-muted-foreground" /></ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="line-clamp-none break-words">{question.question}</ItemTitle>
                <ItemDescription>{t("unansweredQuestions.askedSummary", { asked: t("unansweredQuestions.timesAsked", { count: question.timesAsked }), lastAsked: t("unansweredQuestions.lastAsked", { date: formatDate(question.lastAskedAt) }) })}</ItemDescription>
                {several && askers.length ? <ItemDescription>{heardBy(askers)}</ItemDescription> : null}
              </ItemContent>
              {canManage && !editing ? <ItemActions>
                <Button onClick={() => { setAnswering(question.id); setDraft(""); setAudience("everyone"); answer.reset(); }} size="sm" type="button" variant="outline">{t("unansweredQuestions.answer")}</Button>
                <Button loading={dismiss.isPending && dismiss.variables === question.id} onClick={() => dismiss.mutate(question.id)} size="sm" type="button" variant="ghost">{t("unansweredQuestions.dismiss")}</Button>
              </ItemActions> : null}
              {canManage && editing ? <ItemFooter className="flex-col items-stretch gap-2">
                <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) answer.mutate({ questionId: question.id, text: draft, audience: offerHeard ? audience : "everyone" }); }}>
                  {/* Twice a box's usual 4rem, so a few sentences show as they're written; it still grows with a longer answer. */}
                  <Textarea aria-describedby={answerTooLong ? `answer-error-${question.id}` : undefined} aria-invalid={answerTooLong || undefined} aria-label={t("unansweredQuestions.answerLabel", { question: question.question })} className="min-h-32" maxLength={MAX_ANSWER_LENGTH} onChange={(event) => { setDraft(event.target.value); if (answerTooLong) answer.reset(); }} placeholder={t("unansweredQuestions.answerPlaceholder")} ref={focusOnOpen} rows={3} value={draft} />
                  {answerTooLong ? <FieldError id={`answer-error-${question.id}`}>{t("unansweredQuestions.answerTooLong", { max: MAX_ANSWER_LENGTH.toLocaleString(locale) })}</FieldError> : null}
                  {offerHeard ? <FieldSet>
                    <FieldLegend variant="label">{t("unansweredQuestions.audience.label")}</FieldLegend>
                    <div className="flex flex-col gap-2 text-sm">
                      {(["everyone", "asked"] as const).map((choice) => (
                        <label className="flex items-start gap-2" key={choice}>
                          <input checked={audience === choice} className="mt-0.5 size-4" name={`answer-audience-${question.id}`} onChange={() => setAudience(choice)} type="radio" />
                          <span>{choice === "everyone" ? t("unansweredQuestions.audience.everyone") : (liveAskers === 1 ? t("unansweredQuestions.audience.heardOne") : t("unansweredQuestions.audience.heardMany", { count: liveAskers }))}</span>
                        </label>
                      ))}
                    </div>
                  </FieldSet> : null}
                  <div className="flex justify-end gap-2">
                    <Button disabled={answer.isPending} onClick={() => setAnswering(null)} size="sm" type="button" variant="ghost">{t("unansweredQuestions.cancel")}</Button>
                    <Button disabled={!draft.trim()} loading={answer.isPending} size="sm" type="submit">{t("unansweredQuestions.saveAnswer")}</Button>
                  </div>
                </form>
              </ItemFooter> : null}
            </Item>
            {index < open.length - 1 ? <Separator /> : null}
          </Fragment>;
        })}
      </ItemGroup></CardContent></Card>
        <DataTablePagination labels={{ rowsPerPage: t("agent:pagination.rowsPerPage"), pageOf: (page, pages) => t("agent:pagination.pageOf", { page, total: pages }), firstPage: t("agent:pagination.firstPage"), previousPage: t("agent:pagination.previousPage"), nextPage: t("agent:pagination.nextPage"), lastPage: t("agent:pagination.lastPage"), goToPage: (page) => t("agent:pagination.goToPage", { page }) }} table={table} /></>
      : <div className="rounded-xl border border-dashed p-8 text-center"><p className="type-empty-title">{t("unansweredQuestions.emptyTitle")}</p><p className="type-empty-description mt-2">{t("unansweredQuestions.emptyDescription")}</p></div>}
  </section>;
}
