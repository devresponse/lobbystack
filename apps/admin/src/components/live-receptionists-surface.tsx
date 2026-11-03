"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTable, type PaginationState } from "@tanstack/react-table";
import { Archive, ArchiveRestore, ArrowDown, ArrowDownAZ, ArrowUp, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Settings2, Sparkles, Star } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { receptionistPagePath, runtimeLocaleEndonyms } from "@lobbystack/shared";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { formatDateTime } from "@/lib/locale";
import { requestJson } from "@/lib/request-json";
import { DataTablePagination, paginationFeatures } from "./data-table/pagination";
import { TableCardSkeleton } from "./loading-skeletons";
import { PageSurface } from "./page-surface";
import { ReceptionistAvatar } from "./receptionists/receptionist-avatar";
import { receptionistsQueryKey, useReceptionistChoices, type ReceptionistOption } from "./receptionists/receptionist-choices";
import { ReceptionistEditor, type ReceptionistEditorValues } from "./receptionists/receptionist-editor";
import { receptionistErrorMessage, type ReceptionistAction } from "./receptionists/receptionist-errors";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "./ui/item";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { useOpenUpgradePlanDialog } from "./upgrade-plan-dialog-context";

// The Receptionists page, /agent/receptionists: every receptionist of the
// business in a table with a search, a status filter and pages of 10. Owners
// and admins add receptionists, edit what each is called and where its page
// is, order them, pause, resume, archive and restore them, and pick the
// default one; AI settings changes how each answers. Free and Starter include
// one receptionist, so they see its row and an upgrade card.

/** A row of the table, as GET /api/receptionists gives it. */
export type ReceptionistRow = ReceptionistOption & {
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  phoneNumbers: number;
  widgetKeys: number;
  entryLinks: number;
};

/** How many receptionists the plan allows active, the deployment's cap, and how many the business has. */
export type ReceptionistAllowance = { plan: string; limit: number; cap: number; active: number; current: number; canAdd: boolean };

export type ReceptionistListPage = {
  receptionists: ReceptionistRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: { active: number; paused: number; archived: number };
  allowance: ReceptionistAllowance;
};

export type ReceptionistStatusFilter = "all" | "active" | "paused" | "archived";

export type ReceptionistListFilters = { status: ReceptionistStatusFilter; search: string; page: number; pageSize: number };

export const receptionistListQueryKey = (businessId: string | undefined, filters: ReceptionistListFilters) => [...receptionistsQueryKey(businessId), "list", filters] as const;

/** The API address of a page of the table. */
export function receptionistListUrl(businessId: string, filters: ReceptionistListFilters): string {
  const query = new URLSearchParams({ businessId });
  if (filters.status === "archived") query.set("view", "archived");
  else if (filters.status !== "all") query.set("status", filters.status);
  if (filters.search) query.set("search", filters.search);
  query.set("page", String(filters.page));
  query.set("pageSize", String(filters.pageSize));
  return `/api/receptionists?${query.toString()}`;
}

/** What the editor's values change on the receptionist being edited; the default one keeps its page, language and listing. */
export function receptionistIdentityPatch(editing: ReceptionistOption, values: ReceptionistEditorValues): Partial<ReceptionistEditorValues> {
  const patch: Partial<ReceptionistEditorValues> = {};
  if (values.name !== editing.name) patch.name = values.name;
  if (values.description !== editing.description) patch.description = values.description;
  if (values.knowledgeScope !== editing.knowledgeScope) patch.knowledgeScope = values.knowledgeScope;
  if (!editing.isDefault) {
    // An emptied page address keeps the one it has.
    if (values.handle && values.handle !== editing.handle) patch.handle = values.handle;
    if (values.locale !== editing.locale) patch.locale = values.locale;
    if (values.listed !== editing.listed) patch.listed = values.listed;
  }
  return patch;
}

/** The order with one receptionist moved a place up or down; the default stays first. */
export function movedReceptionistOrder(receptionists: ReceptionistOption[], id: string, direction: -1 | 1): string[] | null {
  const defaults = receptionists.filter((receptionist) => receptionist.isDefault).map((receptionist) => receptionist.id);
  const others = receptionists.filter((receptionist) => !receptionist.isDefault).map((receptionist) => receptionist.id);
  const from = others.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= others.length) return null;
  [others[from], others[to]] = [others[to]!, others[from]!];
  return [...defaults, ...others];
}

/** The order by name, the default first, in the dashboard's language. */
export function alphabeticalReceptionistOrder(receptionists: ReceptionistOption[], locale: string): string[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const defaults = receptionists.filter((receptionist) => receptionist.isDefault);
  const others = receptionists.filter((receptionist) => !receptionist.isDefault).sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  return [...defaults, ...others].map((receptionist) => receptionist.id);
}

type RowAction = Exclude<ReceptionistAction, "add" | "edit" | "order">;

const statusFilters: ReceptionistStatusFilter[] = ["all", "active", "paused", "archived"];

export function LiveReceptionistsSurface() {
  const { i18n, t } = useTranslation(["receptionists", "agent"]);
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openUpgradePlanDialog = useOpenUpgradePlanDialog();
  const statusId = useId();
  const searchId = useId();
  const { businesses, business } = useActiveBusiness();
  const businessId = business?.businessId;
  const canManage = business ? ["business_owner", "business_admin"].includes(business.role) : false;
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const [status, setStatus] = useState<ReceptionistStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ReceptionistRow | null>(null);
  const [archiveCandidate, setArchiveCandidate] = useState<ReceptionistRow | null>(null);
  const [defaultCandidate, setDefaultCandidate] = useState<ReceptionistRow | null>(null);
  const [sortOpen, setSortOpen] = useState(false);

  const filters: ReceptionistListFilters = { status, search: search.trim(), page: pagination.pageIndex + 1, pageSize: pagination.pageSize };
  const list = useQuery({
    queryKey: receptionistListQueryKey(businessId, filters),
    queryFn: () => requestJson<ReceptionistListPage>(receptionistListUrl(businessId!, filters)),
    enabled: Boolean(businessId),
    placeholderData: keepPreviousData,
  });
  const choices = useReceptionistChoices(businessId);
  const rows = list.data?.receptionists ?? [];
  const total = list.data?.total ?? 0;
  const counts = list.data?.counts;
  const allowance = list.data?.allowance;
  const currentCount = counts ? counts.active + counts.paused : 0;
  const everyCount = counts ? currentCount + counts.archived : 0;
  const defaultReceptionist = choices.receptionists.find((receptionist) => receptionist.isDefault) ?? null;

  const table = useTable({ features: paginationFeatures, data: rows, columns: [], manualPagination: true, rowCount: total, onPaginationChange: setPagination, state: { pagination } });

  // Back to a page that exists after archiving the last row of the last one.
  useEffect(() => {
    if (!list.data) return;
    setPagination((current) => {
      const lastPage = Math.max(0, Math.ceil(total / current.pageSize) - 1);
      return current.pageIndex > lastPage ? { ...current, pageIndex: lastPage } : current;
    });
  }, [list.data, total]);

  const invalidate = useCallback(async () => { await queryClient.invalidateQueries({ queryKey: receptionistsQueryKey(businessId) }); }, [businessId, queryClient]);

  const save = useMutation({
    mutationFn: async ({ receptionist, values }: { receptionist: ReceptionistRow | null; values: ReceptionistEditorValues }) => {
      if (!receptionist) {
        const { handle, ...rest } = values;
        return await requestJson<{ receptionist: { name: string } }>(`/api/receptionists?businessId=${encodeURIComponent(businessId!)}`, { method: "POST", body: JSON.stringify({ ...rest, ...(handle ? { handle } : {}) }) });
      }
      const patch = receptionistIdentityPatch(receptionist, values);
      if (!Object.keys(patch).length) return { receptionist: { name: receptionist.name } };
      return await requestJson<{ receptionist: { name: string } }>(`/api/receptionists/${encodeURIComponent(receptionist.id)}?businessId=${encodeURIComponent(businessId!)}`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    onSuccess: async (result, { receptionist }) => {
      toast.success(t(receptionist ? "toast.saved" : "toast.added", { name: result.receptionist.name }));
      setEditorOpen(false);
      setEditing(null);
      await invalidate();
    },
  });

  const act = useMutation({
    mutationFn: async ({ receptionist, action }: { receptionist: ReceptionistRow; action: RowAction }) => (
      await requestJson<{ receptionist: { name: string; status: string } | null }>(`/api/receptionists/${encodeURIComponent(receptionist.id)}?businessId=${encodeURIComponent(businessId!)}`, { method: "POST", body: JSON.stringify({ action }) })
    ),
    onSuccess: async (result, { receptionist, action }) => {
      const name = receptionist.name;
      if (action === "restore") toast.success(t(receptionist.status === "active" && result.receptionist?.status === "paused" ? "toast.restoredPaused" : "toast.restored", { name }));
      else toast.success(t({ pause: "toast.paused", resume: "toast.resumed", archive: "toast.archived", make_default: "toast.madeDefault" }[action], { name }));
      await invalidate();
    },
    onError: (error, { action }) => { toast.error(receptionistErrorMessage(error, t, action, allowance?.limit)); },
  });

  const reorder = useMutation({
    mutationFn: async (receptionistIds: string[]) => await requestJson(`/api/receptionists/order?businessId=${encodeURIComponent(businessId!)}`, { method: "PUT", body: JSON.stringify({ receptionistIds }) }),
    onSuccess: invalidate,
    onError: (error) => { toast.error(receptionistErrorMessage(error, t, "order")); },
  });

  const startAdding = useCallback(() => {
    if (!allowance) return;
    if (allowance.canAdd) {
      save.reset();
      setEditing(null);
      setEditorOpen(true);
    } else if (allowance.current >= allowance.cap) {
      toast.error(t("errors.cap"));
    } else if (allowance.limit <= 1) {
      openUpgradePlanDialog();
    } else {
      toast.error(t("errors.limit"));
    }
  }, [allowance, openUpgradePlanDialog, save, t]);

  // Add receptionist in a dropdown opens this page with ?add=1.
  const wantsAdd = searchParams.get("add") === "1";
  useEffect(() => {
    if (!wantsAdd || !list.data) return;
    const query = new URLSearchParams(searchParams.toString());
    query.delete("add");
    const rest = query.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
    if (canManage) startAdding();
    // Once per arrival with ?add=1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsAdd, Boolean(list.data)]);

  const changeFilter = (next: Partial<Pick<ReceptionistListFilters, "status" | "search">>) => {
    if (next.status !== undefined) setStatus(next.status);
    if (next.search !== undefined) setSearch(next.search);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  if (businesses.isLoading) return <TableCardSkeleton columns={6} />;
  if (!business) return <PageSurface title={t("agent:sections.receptionists.title")}><p className="text-sm text-muted-foreground">{t("agent:empty.description")}</p></PageSurface>;
  if (list.isError) return <PageSurface title={t("agent:sections.receptionists.title")}><p className="text-sm text-destructive">{t("page.unavailable")}</p></PageSurface>;

  // Ordering moves rows through the whole list, so it needs every current row in its place: no search, no status filter.
  const ordering = canManage && status === "all" && !search.trim() && currentCount >= 3;
  const orderIds = choices.receptionists.filter((receptionist) => !receptionist.isDefault).map((receptionist) => receptionist.id);
  const showFilters = everyCount > 1 || status !== "all" || Boolean(search);
  const columns = 5 + (ordering ? 1 : 0) + (canManage ? 1 : 0);

  return (
    <PageSurface title={t("agent:sections.receptionists.title")}>
      <div className="flex w-full flex-col gap-6">
        {allowance ? <AllowanceNotice allowance={allowance} canManage={canManage} onUpgrade={openUpgradePlanDialog} /> : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {showFilters ? (
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative w-full sm:max-w-sm">
                <label className="sr-only" htmlFor={searchId}>{t("toolbar.search")}</label>
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input id={searchId} type="search" className="pl-10" placeholder={t("toolbar.search")} value={search} onChange={(event) => changeFilter({ search: event.target.value })} />
              </div>
              <label className="sr-only" htmlFor={statusId}>{t("toolbar.status")}</label>
              <NativeSelect id={statusId} className="w-full sm:w-44" value={status} onChange={(event) => changeFilter({ status: event.target.value as ReceptionistStatusFilter })}>
                {statusFilters.map((filter) => (
                  <NativeSelectOption key={filter} value={filter}>
                    {t(`toolbar.${filter}`, { number: filter === "all" ? currentCount : counts?.[filter] ?? 0 })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : <div />}
          {canManage ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {currentCount >= 3 && status !== "archived" ? (
                <Button variant="outline" onClick={() => setSortOpen(true)} disabled={reorder.isPending}><ArrowDownAZ data-icon="inline-start" />{t("toolbar.sort")}</Button>
              ) : null}
              <Button onClick={startAdding} disabled={!allowance}><Plus data-icon="inline-start" />{t("toolbar.add")}</Button>
            </div>
          ) : null}
        </div>

        {list.isLoading ? <TableCardSkeleton columns={6} /> : (
          <>
            <TableCard>
              <Table className="w-full min-w-[56rem] table-fixed">
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[22%]" />
                  <col className="w-[11%]" />
                  <col className="w-[19%]" />
                  <col className="w-[14%]" />
                  {ordering ? <col className="w-20" /> : null}
                  {canManage ? <col className="w-14" /> : null}
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.receptionist")}</TableHead>
                    <TableHead>{t("table.page")}</TableHead>
                    <TableHead>{t("table.status")}</TableHead>
                    <TableHead>{t("table.answers")}</TableHead>
                    <TableHead>{t("table.language")}</TableHead>
                    {ordering ? <TableHead>{t("table.order")}</TableHead> : null}
                    {canManage ? <TableHead><span className="sr-only">{t("table.actions")}</span></TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length ? rows.map((row) => {
                    const place = orderIds.indexOf(row.id);
                    const busy = act.isPending && act.variables?.receptionist.id === row.id;
                    return (
                      <TableRow key={row.id} className="h-14" data-receptionist={row.id}>
                        <TableCell className="max-w-0">
                          <div className="flex min-w-0 items-center gap-3">
                            <ReceptionistAvatar id={row.id} name={row.name} />
                            <div className="flex min-w-0 flex-col">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-medium" title={row.name}>{row.name}</span>
                                {row.isDefault ? <Badge variant="secondary" className="flex-none"><Star data-icon="inline-start" aria-hidden="true" />{t("table.default")}</Badge> : null}
                              </div>
                              {row.description ? <span className="truncate text-sm text-muted-foreground" title={row.description}>{row.description}</span> : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-0">
                          {row.archivedAt ? <span className="text-sm text-muted-foreground">—</span> : (
                            <div className="flex min-w-0 flex-col">
                              <a className="truncate text-sm text-foreground underline-offset-4 hover:underline" dir="ltr" href={receptionistPagePath(business.slug, row.isDefault ? null : row.handle)} rel="noreferrer" target="_blank">
                                {receptionistPagePath(business.slug, row.isDefault ? null : row.handle)}
                              </a>
                              {!row.listed ? <span className="truncate text-xs text-muted-foreground">{t("table.notListed")}</span> : null}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant={row.archivedAt || row.status === "paused" ? "outline" : "secondary"}>{t(row.archivedAt ? "status.archived" : `status.${row.status}`)}</Badge>
                            {row.archivedAt ? <span className="text-xs text-muted-foreground">{t("table.archivedOn", { date: formatDateTime(row.archivedAt, locale, { dateStyle: "medium" }) })}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-0">
                          <EntryPointCounts row={row} />
                        </TableCell>
                        <TableCell className="max-w-0">
                          <span className={row.isDefault || !row.locale ? "truncate text-sm text-muted-foreground" : "truncate text-sm"}>
                            {row.isDefault || !row.locale ? t("table.businessLanguage") : runtimeLocaleEndonyms[row.locale as keyof typeof runtimeLocaleEndonyms] ?? row.locale}
                          </span>
                        </TableCell>
                        {ordering ? (
                          <TableCell>
                            {row.isDefault ? null : (
                              <div className="flex items-center gap-1">
                                <Button aria-label={t("table.moveUp", { name: row.name })} disabled={reorder.isPending || place <= 0} onClick={() => { const order = movedReceptionistOrder(choices.receptionists, row.id, -1); if (order) reorder.mutate(order); }} size="icon-sm" variant="ghost"><ArrowUp /></Button>
                                <Button aria-label={t("table.moveDown", { name: row.name })} disabled={reorder.isPending || place < 0 || place >= orderIds.length - 1} onClick={() => { const order = movedReceptionistOrder(choices.receptionists, row.id, 1); if (order) reorder.mutate(order); }} size="icon-sm" variant="ghost"><ArrowDown /></Button>
                              </div>
                            )}
                          </TableCell>
                        ) : null}
                        {canManage ? (
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<Button aria-label={t("table.moreOptions", { name: row.name })} disabled={busy} size="icon-sm" variant="ghost"><MoreHorizontal /></Button>} />
                              <DropdownMenuContent align="end" className="w-fit min-w-44 p-1">
                                {row.archivedAt ? (
                                  <DropdownMenuItem onClick={() => act.mutate({ receptionist: row, action: "restore" })}><ArchiveRestore />{t("actions.restore")}</DropdownMenuItem>
                                ) : (
                                  <>
                                    <DropdownMenuItem onClick={() => { save.reset(); setEditing(row); setEditorOpen(true); }}><Pencil />{t("actions.edit")}</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => router.push(`/agent?receptionist=${encodeURIComponent(row.id)}`)}><Settings2 />{t("actions.aiSettings")}</DropdownMenuItem>
                                    {row.isDefault ? null : (
                                      <>
                                        <DropdownMenuSeparator />
                                        {row.status === "active"
                                          ? <DropdownMenuItem onClick={() => act.mutate({ receptionist: row, action: "pause" })}><Pause />{t("actions.pause")}</DropdownMenuItem>
                                          : <DropdownMenuItem onClick={() => act.mutate({ receptionist: row, action: "resume" })}><Play />{t("actions.resume")}</DropdownMenuItem>}
                                        {row.status === "active" ? <DropdownMenuItem onClick={() => setDefaultCandidate(row)}><Star />{t("actions.makeDefault")}</DropdownMenuItem> : null}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={() => setArchiveCandidate(row)} variant="destructive"><Archive />{t("actions.archive")}</DropdownMenuItem>
                                      </>
                                    )}
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  }) : (
                    <TableRow>
                      <TableCell className="h-24 text-center text-muted-foreground" colSpan={columns}>{t(status === "archived" && !search.trim() ? "table.emptyArchived" : "table.empty")}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableCard>
            <DataTablePagination
              labels={{
                rowsPerPage: t("agent:pagination.rowsPerPage"),
                pageOf: (page, pages) => t("agent:pagination.pageOf", { page, total: pages }),
                firstPage: t("agent:pagination.firstPage"),
                previousPage: t("agent:pagination.previousPage"),
                nextPage: t("agent:pagination.nextPage"),
                lastPage: t("agent:pagination.lastPage"),
                goToPage: (page) => t("agent:pagination.goToPage", { page }),
              }}
              table={table}
            />
          </>
        )}

        <ReceptionistEditor
          open={editorOpen}
          onOpenChange={(open) => { setEditorOpen(open); if (!open) setEditing(null); }}
          editing={editing}
          receptionists={choices.receptionists}
          businessSlug={business.slug}
          businessLocale={business.defaultLocale}
          pending={save.isPending}
          error={save.error ? receptionistErrorMessage(save.error, t, editing ? "edit" : "add", allowance?.limit) : null}
          save={(values) => save.mutate({ receptionist: editing, values })}
        />
        <ConfirmActionDialog
          cancelLabel={t("actions.cancel")}
          confirmLabel={t("archive.confirm")}
          confirmVariant="destructive"
          description={t("archive.description")}
          onConfirm={async () => { if (archiveCandidate) await act.mutateAsync({ receptionist: archiveCandidate, action: "archive" }); }}
          onOpenChange={(open) => { if (!open) setArchiveCandidate(null); }}
          open={archiveCandidate !== null}
          pending={act.isPending}
          title={t("archive.title", { name: archiveCandidate?.name ?? "" })}
        />
        <ConfirmActionDialog
          cancelLabel={t("actions.cancel")}
          confirmLabel={t("makeDefault.confirm")}
          description={t("makeDefault.description", { current: defaultReceptionist?.name ?? "" })}
          onConfirm={async () => { if (defaultCandidate) await act.mutateAsync({ receptionist: defaultCandidate, action: "make_default" }); }}
          onOpenChange={(open) => { if (!open) setDefaultCandidate(null); }}
          open={defaultCandidate !== null}
          pending={act.isPending}
          title={t("makeDefault.title", { name: defaultCandidate?.name ?? "" })}
        />
        <ConfirmActionDialog
          cancelLabel={t("actions.cancel")}
          confirmLabel={t("sort.confirm")}
          description={t("sort.description")}
          onConfirm={async () => { await reorder.mutateAsync(alphabeticalReceptionistOrder(choices.receptionists, locale)); toast.success(t("toast.sorted")); }}
          onOpenChange={setSortOpen}
          open={sortOpen}
          pending={reorder.isPending}
          title={t("sort.title")}
        />
      </div>
    </PageSurface>
  );
}

/** The phone numbers, website widgets and QR links that open a receptionist, or that it answers only its page. */
function EntryPointCounts({ row }: { row: ReceptionistRow }) {
  const { t } = useTranslation("receptionists");
  if (row.archivedAt) return <span className="text-sm text-muted-foreground">—</span>;
  const lines = [
    row.phoneNumbers ? t("table.numbers", { count: row.phoneNumbers }) : null,
    row.widgetKeys ? t("table.widgets", { count: row.widgetKeys }) : null,
    row.entryLinks ? t("table.links", { count: row.entryLinks }) : null,
  ].filter((line): line is string => line !== null);
  if (!lines.length) return <span className="text-sm text-muted-foreground">{t("table.pageOnly")}</span>;
  return <div className="flex min-w-0 flex-col text-sm">{lines.map((line) => <span key={line} className="truncate">{line}</span>)}</div>;
}

/** The plan's receptionists: an upgrade card on a plan with one, else how many are active and what stops another. */
function AllowanceNotice({ allowance, canManage, onUpgrade }: { allowance: ReceptionistAllowance; canManage: boolean; onUpgrade: () => void }) {
  const { t } = useTranslation("receptionists");
  if (allowance.limit <= 1) {
    return (
      <Item variant="outline">
        <ItemMedia variant="icon"><Sparkles aria-hidden="true" /></ItemMedia>
        <ItemContent>
          <ItemTitle>{t("allowance.upgradeTitle")}</ItemTitle>
          <ItemDescription>{t("allowance.upgradeDescription")}{canManage ? null : ` ${t("allowance.upgradeAsk")}`}</ItemDescription>
        </ItemContent>
        {canManage ? <ItemActions><Button onClick={onUpgrade} size="sm" variant="outline">{t("allowance.upgrade")}</Button></ItemActions> : null}
      </Item>
    );
  }
  const capped = allowance.current >= allowance.cap;
  const full = !capped && allowance.active >= allowance.limit;
  return (
    <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <p>
        {t("allowance.used", { active: allowance.active, count: allowance.limit })}
        {capped ? ` ${t("allowance.cap", { count: allowance.cap })}` : full ? ` ${t("allowance.full")}` : ""}
      </p>
      {full && canManage ? <Button className="self-start sm:self-auto" onClick={onUpgrade} size="sm" variant="outline">{t("allowance.upgrade")}</Button> : null}
    </div>
  );
}
