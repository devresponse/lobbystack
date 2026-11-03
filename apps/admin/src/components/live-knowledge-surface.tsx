"use client";

import { useTable, type PaginationState } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, FileText, Globe, ListTree, MoreHorizontal, Pause, Play, Plus, Search, Text, Trash2, Upload, Users } from "lucide-react";
import { toast } from "sonner";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { receptionistMayUse } from "@lobbystack/shared";

import { useActiveBusiness } from "@/hooks/use-active-business";
import { useSetupAction } from "@/lib/use-setup-action";
import { useTelemetry } from "@/components/product-analytics";
import { requestJson } from "@/lib/request-json";
import { uploadKnowledgeDocument } from "@/lib/storage-upload";
import { UploadKnowledgeDocumentSheet } from "./upload-knowledge-document-sheet";
import { AddKnowledgeSheet } from "./add-knowledge-sheet";
import { ImportWebsiteKnowledgeSheet } from "./import-website-knowledge-sheet";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { articleReceptionistIds, KnowledgeAudienceDialog, knowledgeAudienceQueryKey, KnowledgeAvailableTo, KnowledgeBulkAudience, useKnowledgeAudience, type KnowledgeArticle } from "./knowledge-audience";
import { WebsiteRulesDialog, websiteRulesQueryKey, type WebsiteSource } from "./knowledge-website-rules";
import { audienceValueOf, type AudienceChoice } from "./receptionists/audience-field";
import { useReceptionistChoices, useReceptionistFilter } from "./receptionists/receptionist-choices";
import { ReceptionistFilter } from "./receptionists/receptionist-filter";
import { DataTableRowActions, DATA_TABLE_ROW_ACTIONS_COLGROUP_CLASS, DATA_TABLE_ROW_ACTIONS_CELL_CLASS, DATA_TABLE_ROW_TRAILING_VALUE_OFFSET_CLASS } from "./data-table/row-controls";
import { DataTablePagination, paginationFeatures } from "./data-table/pagination";
import { TableCardSkeleton } from "./loading-skeletons";
import { PageSurface } from "./page-surface";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Skeleton } from "./ui/skeleton";
import { Progress } from "./ui/progress";
import { Textarea } from "./ui/textarea";
import { intlLocale } from "@/lib/locale";

export type WebsiteImport = { crawlFinishedCount?: number | null; crawlTotalCount?: number | null; documentCount?: number; id: string; status: string; websiteUrl: string; importedCount: number; indexedCount: number };
// audience is everyone, the default, or chosen: then GET /api/knowledge/audience names the receptionists.
type Document = { websiteImport?: WebsiteImport | null; revision?: number; active?: boolean; textContent?: string; audience?: string | null; id: string; title: string; sourceType: string; sourceUrl: string | null; storageObjectId: string | null; status: string; error?: string | null; processingProgress: number | null; createdAt: string; updatedAt: string };
type Snippet = { tags?: string[]; audience?: string | null; id: string; title: string; content: string; active: boolean; priority: number; createdAt: string };
// site marks a website's own row, the source its pages and rules belong to.
type Row = ({ entryType: "document"; site?: boolean } & Document) | ({ entryType: "snippet" } & Snippet);
type SnippetValues = { title: string; content: string; tags: string[]; priority: number; active: boolean; audience?: AudienceChoice };

function summarize(value: string, length: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 3).trimEnd()}...` : normalized;
}

function stripHtmlTags(value: string): string {
  // Remove tags repeatedly until the text stops changing so nested or
  // recombined tag markers cannot survive a single pass.
  let previous: string;
  let current = value;
  do {
    previous = current;
    current = current.replace(/<[^>\s]+>/gu, "");
  } while (current !== previous);
  return current;
}

function previewText(value: string): string {
  const withoutImages = value.replace(/!\[([^\]]*?)\]\((?:[^)\s]+(?:\s+["'][^"']*["'])?)\)/gu, "$1");
  const withoutLinks = withoutImages.replace(/\[([^\]]+)\]\((?:[^)\n]+)\)/gu, "$1");
  return stripHtmlTags(withoutLinks).replace(/\s+/gu, " ").trim();
}

function isImportRow(row: Row): row is Document & { entryType: "document"; websiteImport: WebsiteImport } {
  return row.entryType === "document" && Boolean(row.websiteImport && row.websiteImport.status !== "completed");
}

function importTitle(url: string): string {
  try { const parsed = new URL(url); return parsed.hostname.replace(/^www\./u, "") + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "")); } catch { return url; }
}

export function websiteImportProgress(job: WebsiteImport): number {
  if (job.status === "queued") return 8;
  if (job.status === "failed") return 100;
  const progress = job.crawlTotalCount && typeof job.crawlFinishedCount === "number" ? Math.round(job.crawlFinishedCount / job.crawlTotalCount * 100) : job.status === "indexing" ? 72 : 12;
  return Math.max(job.status === "indexing" ? 72 : 8, Math.min(99, progress));
}

const rowKey = (row: Row) => `${row.entryType}:${row.id}`;
const articleOf = (row: Row): KnowledgeArticle => ({ kind: row.entryType, id: row.id, title: row.title, audience: row.audience });

/** A text entry's save, with who it is for when it chose. */
function snippetBody(values: SnippetValues): Record<string, unknown> {
  const { audience, ...fields } = values;
  if (!audience) return fields;
  return { ...fields, ...(audience.audience === "chosen" ? { audience: "chosen", receptionistIds: audience.receptionistIds } : { audience: "everyone" }) };
}

export function LiveKnowledgeSurface() {
  const { i18n, t } = useTranslation("agent");
  const telemetry = useTelemetry();
  const queryClient = useQueryClient();
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [form, setForm] = useState<"text" | "website" | "upload" | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Row | null>(null);
  const [viewingDocument, setViewingDocument] = useState<Document | null>(null);
  const [viewingSnippetId, setViewingSnippetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [audienceArticle, setAudienceArticle] = useState<KnowledgeArticle | null>(null);
  const [rulesFor, setRulesFor] = useState<{ siteId: string | null } | null>(null);
  const { businesses, business } = useActiveBusiness();
  const businessId = business?.businessId;
  const canManage = business ? ["business_owner", "business_admin"].includes(business.role) : false;
  // With several receptionists each article says who it is for, the table
  // filters by receptionist, and owners and admins change who articles are for.
  const { receptionists } = useReceptionistChoices(businessId);
  const several = receptionists.length > 1;
  const selectable = several && canManage;
  const [receptionistFilterId] = useReceptionistFilter();
  const filterReceptionist = several ? receptionists.find((receptionist) => receptionist.id === receptionistFilterId) : undefined;
  const audienceLinks = useKnowledgeAudience(businessId, several);
  useSetupAction(canManage, useCallback((action: string) => { if (!["upload", "website", "text"].includes(action)) return false; setEditingSnippet(null); setForm(action as "upload" | "website" | "text"); return true; }, []));
  const documents = useQuery({ queryKey: ["knowledge", businessId], enabled: Boolean(business), queryFn: () => requestJson<{ documents: Document[] }>(`/api/knowledge?businessId=${encodeURIComponent(business!.businessId)}`), refetchInterval: query => query.state.data?.documents.some(document => ["pending", "processing"].includes(document.status)) ? 1500 : false });
  const [importProgress, setImportProgress] = useState<Record<string, number>>({});
  useEffect(() => {
    setImportProgress(previous => {
      const next: Record<string, number> = {};
      for (const document of documents.data?.documents ?? []) if (document.websiteImport) {
        const key = `${document.websiteImport.id}:${document.revision ?? 0}`;
        next[key] = Math.max(previous[key] ?? 0, websiteImportProgress(document.websiteImport));
      }
      return next;
    });
  }, [documents.data]);
  const snippets = useQuery({ queryKey: ["knowledge-snippets", businessId], enabled: Boolean(business), queryFn: () => requestJson<{ snippets: Snippet[] }>(`/api/knowledge/snippets?businessId=${encodeURIComponent(business!.businessId)}`) });
  const invalidate = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["knowledge", businessId] }), queryClient.invalidateQueries({ queryKey: ["knowledge-snippets", businessId] }), queryClient.invalidateQueries({ queryKey: ["knowledge-content", businessId] }), queryClient.invalidateQueries({ queryKey: knowledgeAudienceQueryKey(businessId) }), queryClient.invalidateQueries({ queryKey: websiteRulesQueryKey(businessId) })]); };
  const addWebsite = useMutation({ mutationFn: (input: { title: string; sourceUrl: string; websiteRules?: Array<{ pathPrefix: string; receptionistId: string }> }) => requestJson(`/api/knowledge?businessId=${encodeURIComponent(business!.businessId)}`, { method: "POST", body: JSON.stringify({ businessId: business!.businessId, sourceType: "website", ...input }) }), onSuccess: invalidate, meta: { inlineError: true } });
  // The text entry dialog shows its own errors.
  const saveSnippet = useMutation({ mutationFn: ({ id, ...values }: SnippetValues & { id?: string }) => id ? requestJson(`/api/knowledge/snippets/${encodeURIComponent(id)}?businessId=${encodeURIComponent(business!.businessId)}`, { method: "PATCH", body: JSON.stringify({ id, ...snippetBody(values) }) }) : requestJson(`/api/knowledge/snippets?businessId=${encodeURIComponent(business!.businessId)}`, { method: "POST", body: JSON.stringify(snippetBody(values)) }), onSuccess: invalidate, meta: { inlineError: true } });
  const updateSnippet = useMutation({ mutationFn: (input: { id: string; title?: string; content?: string; tags?: string[]; priority?: number; active?: boolean }) => requestJson(`/api/knowledge/snippets/${encodeURIComponent(input.id)}?businessId=${encodeURIComponent(business!.businessId)}`, { method: "PATCH", body: JSON.stringify(input) }), onSuccess: invalidate });
  const deleteSnippet = useMutation({ mutationFn: (id: string) => requestJson(`/api/knowledge/snippets/${encodeURIComponent(id)}?businessId=${encodeURIComponent(business!.businessId)}`, { method: "DELETE" }), onSuccess: invalidate });
  const documentAction = useMutation({ mutationFn: ({ id, method, action, active }: { id: string; method: "PATCH" | "DELETE"; action?: "retry" | "cancel"; active?: boolean }) => requestJson(`/api/knowledge/${encodeURIComponent(id)}?businessId=${encodeURIComponent(business!.businessId)}`, { method, ...(active !== undefined ? { body: JSON.stringify({ active }) } : action ? { body: JSON.stringify({ action }) } : {}) }), onSuccess: invalidate });
  const currentDocument = documents.data?.documents.find(document => document.id === viewingDocument?.id) ?? viewingDocument;
  const documentContent = useQuery({ queryKey: ["knowledge-content", businessId, viewingDocument?.id, currentDocument?.updatedAt], enabled: Boolean(business && viewingDocument), queryFn: () => requestJson<{ document: Document & { fileName?: string | null; contentLength?: number | null }; content: string }>(`/api/knowledge/${encodeURIComponent(viewingDocument!.id)}?businessId=${encodeURIComponent(business!.businessId)}`) });
  const uploadDocument = useMutation({ mutationFn: ({ file, contentType, title, tags, audience }: { file: File; contentType: string; title: string; tags: string[]; audience?: AudienceChoice }) => uploadKnowledgeDocument({ businessId: business!.businessId, file, contentType, title, tags, ...(audience ? { audience } : {}) }, t("sections.knowledge.uploadValidation.uploadFailed")), onMutate: (variables) => { if (business) telemetry.track("web.knowledge.upload_started", { businessId: business.businessId, section: "knowledge", contentType: variables.contentType }); }, onSuccess: async (_data, variables) => { if (business) telemetry.track("web.knowledge.upload_completed", { businessId: business.businessId, section: "knowledge", contentType: variables.contentType }); await invalidate(); }, meta: { inlineError: true } });

  const rows = useMemo<Row[]>(() => [
    ...(documents.data?.documents ?? []).filter(document => !(document.websiteImport && ["completed", "cancelled"].includes(document.websiteImport.status) && !document.textContent?.trim())).map((document) => {
      const importedPage = Boolean(document.websiteImport && ["completed", "cancelled"].includes(document.websiteImport.status) && document.textContent?.trim());
      return { ...document, site: Boolean(document.websiteImport), ...(importedPage ? { websiteImport: null, status: "indexed" } : {}), title: !importedPage && document.websiteImport && document.websiteImport.status !== "completed" ? importTitle(document.websiteImport.websiteUrl) : document.title, entryType: "document" as const };
    }),
    ...(snippets.data?.snippets ?? []).map((snippet) => ({ ...snippet, entryType: "snippet" as const })),
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()), [documents.data, snippets.data]);
  // The websites the business added, which website rules belong to.
  const sites = useMemo<WebsiteSource[]>(() => (documents.data?.documents ?? []).filter((document) => document.sourceType === "website" && document.websiteImport).map((document) => ({ id: document.id, url: document.websiteImport?.websiteUrl || document.sourceUrl || document.title })), [documents.data]);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = query ? rows.filter((row) => `${row.title} ${row.entryType === "snippet" ? row.content : row.sourceUrl ?? row.sourceType}`.toLowerCase().includes(query)) : rows;
    if (!filterReceptionist) return matching;
    // What one receptionist may use: the articles for everyone and those chosen for it, by the rule calls and chats follow.
    return matching.filter((row) => receptionistMayUse(filterReceptionist, {
      audience: row.audience === "chosen" ? "chosen" : "everyone",
      receptionistIds: articleReceptionistIds(audienceLinks.data, articleOf(row)).filter((id) => receptionists.some((receptionist) => receptionist.id === id)),
    }));
  }, [rows, search, filterReceptionist, audienceLinks.data, receptionists]);
  // A new receptionist filter starts again from the first page.
  const [paginationFilter, setPaginationFilter] = useState(receptionistFilterId);
  if (paginationFilter !== receptionistFilterId) {
    setPaginationFilter(receptionistFilterId);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }
  const table = useTable({ features: paginationFeatures, data: filteredRows, columns: [], onPaginationChange: setPagination, state: { pagination } });
  const pageRows = table.getRowModel().rows.map((row) => row.original);
  // Articles that are gone since they were selected drop out of the selection.
  const selectedArticles = useMemo(() => rows.filter((row) => selected.has(rowKey(row)) && !isImportRow(row)).map(articleOf), [rows, selected]);
  const selectablePageRows = pageRows.filter((row) => !isImportRow(row));
  const pageSelected = selectablePageRows.filter((row) => selected.has(rowKey(row))).length;

  if (businesses.isLoading) return <p className="text-sm text-muted-foreground">{t("loading.workspace")}</p>;
  if (!business) return <PageSurface title={t("sections.knowledge.title")}><p className="text-sm text-muted-foreground">{t("empty.description")}</p></PageSurface>;
  const uploadProgress = (row: Row) => {
    if (isImportRow(row)) {
      if (row.websiteImport.status === "failed" || row.websiteImport.status === "cancelled") return <span className="block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm text-destructive/80">{t("sections.knowledge.websiteImport.previewFailed")}</span>;
      const value = Math.max(importProgress[`${row.websiteImport.id}:${row.revision ?? 0}`] ?? 0, websiteImportProgress(row.websiteImport));
      return <div className="flex min-w-0 flex-col gap-2"><div className="flex items-center gap-2"><Progress className="w-full [&_[data-slot=progress-track]]:h-1.5" value={value} /><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{value}%</span></div></div>;
    }
    if (row.entryType !== "document" || row.active === false || row.sourceType === "website" || !["pending", "processing"].includes(row.status) || row.textContent?.trim()) return null;
    const value = Math.min(100, Math.max(0, Math.round(row.processingProgress ?? (row.status === "processing" ? 92 : 0))));
    return <div className="flex min-w-0 flex-col gap-2"><div className="flex items-center gap-2"><Progress className="w-full [&_[data-slot=progress-track]]:h-1.5" value={value} /><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{value}%</span></div></div>;
  };
  const cancellingImport = Boolean(deleteCandidate && isImportRow(deleteCandidate) && deleteCandidate.websiteImport.status !== "failed");
  const documentPreview = (row: Document) => previewText(row.textContent ?? "") || (row.status === "error" ? row.error ?? t("sections.knowledge.previewError") : ["pending", "processing"].includes(row.status) ? t("sections.knowledge.previewPending") : t("table.documentPreviewHint"));
  const columnCount = (selectable ? 1 : 0) + 5;
  const toggleSelected = (keys: string[], on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const key of keys) { if (on) next.add(key); else next.delete(key); }
    return next;
  });
  const openRow = (row: Row) => {
    if (isImportRow(row)) return;
    if (row.entryType === "document") setViewingDocument(viewingDocument?.id === row.id ? null : row);
    else if (canManage) { setEditingSnippet(row); setForm("text"); }
    // With several receptionists the preview leaves the table, so a text entry opens to show it.
    else if (several) setViewingSnippetId(viewingSnippetId === row.id ? null : row.id);
  };
  const preview = (row: Row) => uploadProgress(row) ?? <span className="block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm text-muted-foreground" title={row.entryType === "snippet" ? previewText(row.content) : documentPreview(row)}>{summarize(row.entryType === "snippet" ? previewText(row.content) : documentPreview(row), 72)}</span>;
  const status = (row: Row) => isImportRow(row) ? <Badge variant={row.websiteImport.status === "failed" || row.websiteImport.status === "cancelled" ? "destructive" : "outline"}>{t(row.websiteImport.status === "failed" || row.websiteImport.status === "cancelled" ? "sections.knowledge.websiteImport.status.failed" : "sections.knowledge.websiteImport.status.inProgress")}</Badge> : row.entryType === "snippet" ? row.active ? <Badge variant="secondary">{t("sections.knowledge.status.indexed")}</Badge> : <Badge variant="outline">{t("table.disabled")}</Badge> : row.active === false ? <Badge variant="outline">{t("table.disabled")}</Badge> : <Badge variant={row.status === "error" ? "destructive" : row.status === "indexed" ? "secondary" : "outline"}>{t(`sections.knowledge.status.${row.status === "processing" ? "indexing" : row.status === "pending" ? "queued" : row.status}`, { defaultValue: row.status })}</Badge>;
  const actions = (row: Row) => canManage ? <DataTableRowActions><DropdownMenu open={openActionId === row.id} onOpenChange={open => setOpenActionId(open ? row.id : null)}><DropdownMenuTrigger aria-expanded={openActionId === row.id} render={<Button aria-label={t("actions.moreOptions")} title={t("actions.moreOptions")} type="button" size="icon-sm" variant="ghost"><MoreHorizontal /></Button>} /><DropdownMenuContent align="end" side="bottom" sideOffset={8} className="min-w-0 w-fit p-1">{isImportRow(row) ? <DropdownMenuItem onClick={() => setDeleteCandidate(row)} variant="destructive"><Trash2 />{row.websiteImport.status === "failed" ? t("actions.delete") : t("actions.cancelImport")}</DropdownMenuItem> : <>{several ? <DropdownMenuItem onClick={() => setAudienceArticle(articleOf(row))}><Users />{t("sections.knowledge.receptionists.rowAction")}</DropdownMenuItem> : null}{several && row.entryType === "document" && row.site ? <DropdownMenuItem onClick={() => setRulesFor({ siteId: row.id })}><ListTree />{t("sections.knowledge.receptionists.rules.rowAction")}</DropdownMenuItem> : null}<DropdownMenuItem onClick={() => row.entryType === "snippet" ? updateSnippet.mutate({ id: row.id, active: !row.active }) : documentAction.mutate({ id: row.id, method: "PATCH", active: row.active === false })}>{row.active === false ? <Play /> : <Pause />}{row.active === false ? t("actions.enable") : t("actions.disable")}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => setDeleteCandidate(row)} variant="destructive"><Trash2 />{t("actions.delete")}</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></DataTableRowActions> : null;
  const added = (row: Row) => <span className={`relative block truncate text-right text-sm text-muted-foreground ${DATA_TABLE_ROW_TRAILING_VALUE_OFFSET_CLASS}`}>{new Intl.DateTimeFormat(intlLocale(i18n.resolvedLanguage), { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.createdAt))}</span>;
  const title = (row: Row) => <div className="flex min-w-0 items-center gap-2"><span aria-label={t(row.entryType === "snippet" ? "sections.knowledge.textBadge" : row.sourceType === "website" ? "sections.knowledge.websiteImport.badge" : "sections.knowledge.documentBadge")} title={t(row.entryType === "snippet" ? "sections.knowledge.textBadge" : row.sourceType === "website" ? "sections.knowledge.websiteImport.badge" : "sections.knowledge.documentBadge")} className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">{row.entryType === "snippet" ? <Text className="size-4" /> : row.sourceType === "website" ? <Globe className="size-4" /> : <FileText className="size-4" />}</span><span className="truncate font-medium" title={row.title}>{summarize(row.title, 32)}</span></div>;
  const filterHint = !several ? null : !filterReceptionist ? t("sections.knowledge.receptionists.showingAll") : filterReceptionist.knowledgeScope === "all" ? t("sections.knowledge.receptionists.showingEverything", { name: filterReceptionist.name }) : t("sections.knowledge.receptionists.showingOne", { name: filterReceptionist.name });

  return <PageSurface title={t("sections.knowledge.title")}><div className="flex w-full flex-col gap-6">
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-10" onChange={(event) => { setSearch(event.target.value); setPagination(current => ({ ...current, pageIndex: 0 })); }} placeholder={t("table.searchPlaceholder")} value={search} /></div><div className="flex shrink-0 flex-wrap items-center gap-2"><ReceptionistFilter businessId={businessId} className="w-full sm:w-60" />{selectable && sites.length ? <Button onClick={() => setRulesFor({ siteId: null })} type="button" variant="outline"><ListTree data-icon="inline-start" />{t("sections.knowledge.receptionists.rules.open")}</Button> : null}{canManage ? <DropdownMenu><DropdownMenuTrigger render={<Button type="button"><Plus data-icon="inline-start" />{t("sections.knowledge.addKnowledge")}<ChevronDown data-icon="inline-end" /></Button>} /><DropdownMenuContent align="end" className="min-w-44 w-auto p-1"><DropdownMenuItem onClick={() => { setEditingSnippet(null); setForm("upload"); }}><Upload />{t("sections.knowledge.addKnowledgeOptions.upload")}</DropdownMenuItem><DropdownMenuItem onClick={() => { setEditingSnippet(null); setForm("website"); }}><Globe />{t("sections.knowledge.addKnowledgeOptions.website")}</DropdownMenuItem><DropdownMenuItem onClick={() => { setEditingSnippet(null); setForm("text"); }}><FileText />{t("sections.knowledge.addKnowledgeOptions.text")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}</div></div>
      {filterHint ? <p className="text-sm text-muted-foreground">{filterHint}</p> : null}
    </div>
    {selectable && selectedArticles.length ? <KnowledgeBulkAudience articles={selectedArticles} businessId={business.businessId} onChanged={async () => { setSelected(new Set()); await invalidate(); }} onClear={() => setSelected(new Set())} receptionists={receptionists} /> : null}
    {documents.isLoading || snippets.isLoading || (several && audienceLinks.isLoading) ? <TableCardSkeleton columns={columnCount} /> : <><TableCard><Table className="min-w-[60rem] w-full table-fixed">{several ? <colgroup>{selectable ? <col className="w-12" /> : null}<col className="w-[28%]" /><col className="w-[30%]" /><col className="w-[14%]" /><col className="w-[18%]" /><col className={DATA_TABLE_ROW_ACTIONS_COLGROUP_CLASS} /></colgroup> : <colgroup><col className="w-[18%]" /><col className="w-[42%]" /><col className="w-[14%]" /><col className="w-[18%]" /><col className={DATA_TABLE_ROW_ACTIONS_COLGROUP_CLASS} /></colgroup>}<TableHeader><TableRow>{selectable ? <TableHead><Checkbox aria-label={t("sections.knowledge.receptionists.selectPage")} checked={selectablePageRows.length > 0 && pageSelected === selectablePageRows.length} disabled={!selectablePageRows.length} indeterminate={pageSelected > 0 && pageSelected < selectablePageRows.length} onCheckedChange={(checked) => toggleSelected(selectablePageRows.map(rowKey), checked === true)} /></TableHead> : null}<TableHead>{t("table.title")}</TableHead><TableHead>{several ? t("sections.knowledge.receptionists.availableTo") : t("table.preview")}</TableHead><TableHead>{t("table.status")}</TableHead><TableHead className="text-right"><span className={`relative block text-right ${DATA_TABLE_ROW_TRAILING_VALUE_OFFSET_CLASS}`}>{t("table.added")}</span></TableHead><TableHead /></TableRow></TableHeader><TableBody>
      {pageRows.length ? pageRows.map((row) => <Fragment key={rowKey(row)}><TableRow className={isImportRow(row) ? `${row.websiteImport.status === "failed" ? "h-12" : "h-16"} data-[state=selected]:bg-muted/40` : "h-12 cursor-pointer data-[state=selected]:bg-muted/40"} data-state={viewingDocument?.id === row.id || selected.has(rowKey(row)) ? "selected" : undefined} onClick={() => openRow(row)}>{selectable ? <TableCell onClick={(event) => event.stopPropagation()}>{isImportRow(row) ? null : <Checkbox aria-label={t("sections.knowledge.receptionists.select", { title: row.title })} checked={selected.has(rowKey(row))} onCheckedChange={(checked) => toggleSelected([rowKey(row)], checked === true)} />}</TableCell> : null}<TableCell className="max-w-0 overflow-hidden">{title(row)}</TableCell><TableCell className="max-w-0 overflow-hidden">{several ? isImportRow(row) ? uploadProgress(row) : <KnowledgeAvailableTo article={articleOf(row)} links={audienceLinks.data} receptionists={receptionists} /> : preview(row)}</TableCell><TableCell>{status(row)}</TableCell><TableCell className="w-0 max-w-0 text-right whitespace-nowrap">{added(row)}</TableCell><TableCell className={DATA_TABLE_ROW_ACTIONS_CELL_CLASS} onClick={(event) => event.stopPropagation()}>{actions(row)}</TableCell></TableRow>{row.entryType === "document" && viewingDocument?.id === row.id ? <TableRow className="bg-muted/20 hover:bg-muted/20"><TableCell className="p-4" colSpan={columnCount}>{documentContent.isLoading ? <div className="space-y-3 rounded-md border border-border/70 p-4">{Array.from({ length: 6 }, (_, index) => <Skeleton className="h-4 w-full" key={index} />)}</div> : <Textarea className="max-h-80 resize-none overflow-y-auto text-sm leading-relaxed" rows={8} readOnly value={documentContent.isError ? t("sections.knowledge.previewError") : row.status === "error" ? row.error ?? t("sections.knowledge.previewError") : documentContent.data?.content.trim() || t("sections.knowledge.previewPending")} />}</TableCell></TableRow> : null}{row.entryType === "snippet" && viewingSnippetId === row.id ? <TableRow className="bg-muted/20 hover:bg-muted/20"><TableCell className="p-4" colSpan={columnCount}><Textarea aria-label={row.title} className="max-h-80 resize-none overflow-y-auto text-sm leading-relaxed" readOnly rows={6} value={row.content} /></TableCell></TableRow> : null}</Fragment>) : <TableRow><TableCell className="h-24 text-center text-muted-foreground" colSpan={columnCount}>{search || filterReceptionist ? t("table.empty") : t("sections.knowledge.emptyState")}</TableCell></TableRow>}
    </TableBody></Table></TableCard>
    <DataTablePagination labels={{ rowsPerPage: t("pagination.rowsPerPage"), pageOf: (page, total) => t("pagination.pageOf", { page, total }), firstPage: t("pagination.firstPage"), previousPage: t("pagination.previousPage"), nextPage: t("pagination.nextPage"), lastPage: t("pagination.lastPage"), goToPage: (page) => t("pagination.goToPage", { page }) }} table={table} /></>}
    <AddKnowledgeSheet audience={editingSnippet ? audienceValueOf(editingSnippet.audience, articleReceptionistIds(audienceLinks.data, { kind: "snippet", id: editingSnippet.id }), receptionists) : undefined} mode={editingSnippet ? "edit" : "create"} receptionists={receptionists} snippet={editingSnippet} open={form === "text"} onOpenChange={(open) => { if (!open) { setForm(null); setEditingSnippet(null); } }} save={async (values) => { await saveSnippet.mutateAsync(editingSnippet ? { id: editingSnippet.id, ...values } : values); }} />
    <ImportWebsiteKnowledgeSheet open={form === "website"} receptionists={receptionists} onOpenChange={(open) => { if (!open) setForm(null); }} save={async (sourceUrl, websiteRules) => { await addWebsite.mutateAsync({ title: sourceUrl, sourceUrl, ...(websiteRules?.length ? { websiteRules } : {}) }); }} />
    <UploadKnowledgeDocumentSheet open={form === "upload"} receptionists={receptionists} onOpenChange={(open) => { if (!open) setForm(null); }} upload={async (values) => { await uploadDocument.mutateAsync(values); }} />
    {several ? <KnowledgeAudienceDialog article={audienceArticle} businessId={business.businessId} links={audienceLinks.data} onChanged={invalidate} onOpenChange={(open) => { if (!open) setAudienceArticle(null); }} receptionists={receptionists} /> : null}
    {selectable ? <WebsiteRulesDialog businessId={business.businessId} onChanged={invalidate} onOpenChange={(open) => { if (!open) setRulesFor(null); }} open={rulesFor !== null} receptionists={receptionists} siteId={rulesFor?.siteId} sites={sites} /> : null}
    <ConfirmActionDialog confirmVariant="destructive" cancelLabel={t("actions.deleteCancel")} confirmLabel={t(cancellingImport ? "actions.cancelImport" : "actions.delete")} description={t(cancellingImport ? "actions.cancelImportDescription" : "actions.deleteDescription")} onConfirm={async () => { if (!deleteCandidate) return; if (deleteCandidate.entryType === "snippet") await deleteSnippet.mutateAsync(deleteCandidate.id); else await documentAction.mutateAsync({ id: deleteCandidate.id, method: cancellingImport ? "PATCH" : "DELETE", ...(cancellingImport ? { action: "cancel" } : {}) }); toast.success(t(cancellingImport ? "actions.importCancelled" : "actions.deleted")); }} onOpenChange={(open) => { if (!open) setDeleteCandidate(null); }} open={deleteCandidate !== null} pending={deleteSnippet.isPending || documentAction.isPending} title={t(cancellingImport ? "actions.cancelImportTitle" : "actions.deleteTitle")} />
  </div></PageSurface>;
}
