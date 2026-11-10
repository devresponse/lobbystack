"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy, MoreHorizontal, Pause, Pencil, Play, Plus, QrCode, Search } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { entryLinkPath, ENTRY_LINK_LABEL_MAX_LENGTH, MAX_ENTRY_LINKS_PER_BUSINESS, type EntryLinkStatus } from "@lobbystack/shared";

import { intlLocale, resolveLocale } from "@/lib/locale";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";
import { ReceptionistAvatar } from "../receptionists/receptionist-avatar";
import { receptionistsQueryKey, type ReceptionistOption } from "../receptionists/receptionist-choices";
import { entryPointErrorMessage } from "../receptionists/receptionist-errors";
import { ReceptionistFilter } from "../receptionists/receptionist-filter";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { QrLinkDialog, type QrLinkValues } from "./qr-link-dialog";
import { ScansSparkline } from "./scans-chart";

// Settings → QR code, "Your QR codes": the business page's own code, which
// signs printed before QR links existed carry, then the QR links, newest
// first, 10 to a page. Each link is a short /q/<code> address with its own
// scan count, so two signs for the same receptionist can each have one and
// the owner sees which gets scanned. Choosing a row shows its sign below.
// Owners and admins add links, change who answers one, rename and pause it;
// everyone on the team can copy a link's address. Links are paused, never
// deleted, so a printed sign always opens a page.

/** A QR link as GET /api/entry-links lists it. */
export type EntryLinkView = {
  id: string;
  code: string;
  label: string;
  status: EntryLinkStatus;
  /** The receptionist the link names. */
  receptionistId: string;
  /** The one it opens now: the default receptionist while the link or the one it names is paused or archived. */
  opensReceptionistId: string;
  createdAt: string;
  updatedAt: string;
  scansLast30Days: number;
  scansKept: number;
  lastScannedOn: string | null;
  recentScans: { from: string; counts: number[] };
};

export type EntryLinkListPage = { links: EntryLinkView[]; total: number; page: number; pageSize: number };

export type EntryLinkFilters = { search: string; page: number; receptionistId: string | null };

/** The server's page of links. */
export const ENTRY_LINKS_PAGE_SIZE = 10;

/** Every QR link query of a business, for invalidating after a change. */
export const entryLinksQueryKey = (businessId: string | undefined) => ["entry-links", businessId] as const;

/** The API address of a page of links. */
export function entryLinkListUrl(businessId: string, filters: EntryLinkFilters): string {
  const query = new URLSearchParams({ businessId, page: String(filters.page) });
  if (filters.search) query.set("search", filters.search);
  if (filters.receptionistId) query.set("receptionist", filters.receptionistId);
  return `/api/entry-links?${query.toString()}`;
}

/** A page of the business's QR links; the page shown stays while the next one loads. */
export function useEntryLinks(businessId: string | undefined, filters: EntryLinkFilters) {
  return useQuery({
    queryKey: [...entryLinksQueryKey(businessId), "list", filters],
    queryFn: () => requestJson<EntryLinkListPage>(entryLinkListUrl(businessId!, filters)),
    enabled: Boolean(businessId),
    placeholderData: keepPreviousData,
  });
}

type Translate = (key: string, options: Record<string, string>) => string;

/** What the dashboard calls a link: its label, or its code when it has none. */
export function entryLinkName(link: Pick<EntryLinkView, "label" | "code">, t: Translate): string {
  return link.label || t("settings:qrCode.links.untitled", { code: link.code });
}

/** The address a link's sign carries, on the business page's domain. */
export function entryLinkUrl(origin: string, code: string): string {
  return `${origin}${entryLinkPath(code)}`;
}

/** Explains a refused QR link change in the dashboard's language. */
export function entryLinkErrorMessage(error: unknown, t: Translate, locale: string): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "entry_link_limit") return t("settings:qrCode.links.errors.limit", { max: new Intl.NumberFormat(intlLocale(resolveLocale(locale))).format(MAX_ENTRY_LINKS_PER_BUSINESS) });
  if (code === "entry_link_code_unavailable") return t("settings:qrCode.links.errors.codeUnavailable", {});
  if (code === "invalid_label") return t("settings:qrCode.links.errors.invalidLabel", { max: String(ENTRY_LINK_LABEL_MAX_LENGTH) });
  return entryPointErrorMessage(error, t);
}

/** Where the business page lives: its address, the domain signs carry, and its path. */
function pageAddress(url: string): { origin: string; host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, host: parsed.host, path: parsed.pathname };
  } catch {
    return { origin: "", host: "", path: url };
  }
}

/** Who answers, as the receptionist's initials and name. */
function ReceptionistChip({ receptionist, archivedLabel }: { receptionist: ReceptionistOption | undefined; archivedLabel: string }) {
  if (!receptionist) return <span className="text-xs text-muted-foreground">{archivedLabel}</span>;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-xs" title={receptionist.name}>
      <ReceptionistAvatar id={receptionist.id} name={receptionist.name} size="sm" />
      <span className="truncate">{receptionist.name}</span>
    </span>
  );
}

type Props = {
  businessId: string;
  /** The business page's address, where its own code goes and on whose domain links live. */
  businessPageUrl: string;
  canManage: boolean;
  receptionists: ReceptionistOption[];
  links: UseQueryResult<EntryLinkListPage>;
  /** The search as typed. */
  search: string;
  onSearchChange: (search: string) => void;
  filters: EntryLinkFilters;
  onPageChange: (page: number) => void;
  /** The link whose sign shows; null is the business page. */
  selectedId: string | null;
  onSelect: (link: EntryLinkView | null) => void;
  /** A link changed: the sign shows it as it is now. */
  onChanged: (link: EntryLinkView) => void;
  /** The sign card's id, which choosing a row changes. */
  signId: string;
};

export function QrLinksCard({ businessId, businessPageUrl, canManage, receptionists, links, search, onSearchChange, filters, onPageChange, selectedId, onSelect, onChanged, signId }: Props) {
  const { t, i18n } = useTranslation(["settings", "receptionists"]);
  const queryClient = useQueryClient();
  const searchId = useId();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numbers = new Intl.NumberFormat(intlLocale(resolveLocale(locale)));
  const [dialog, setDialog] = useState<{ editing: EntryLinkView | null } | null>(null);

  const several = receptionists.length > 1;
  const byId = new Map(receptionists.map((receptionist) => [receptionist.id, receptionist]));
  const defaultReceptionist = receptionists.find((receptionist) => receptionist.isDefault);
  const defaultName = defaultReceptionist?.name ?? "";
  const address = pageAddress(businessPageUrl);
  const rows = links.data?.links ?? [];
  const total = links.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / ENTRY_LINKS_PAGE_SIZE));
  const searching = Boolean(filters.search);
  // The business page's code isn't a link: it shows above them, while nothing narrows the list past the default receptionist.
  const showBusinessPage = filters.page === 1 && !searching && (!filters.receptionistId || filters.receptionistId === defaultReceptionist?.id);
  const showSearch = searching || Boolean(search) || total > ENTRY_LINKS_PAGE_SIZE || filters.receptionistId !== null;
  const columns = several ? 5 : 4;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: entryLinksQueryKey(businessId) }),
      // The Receptionists page counts each receptionist's links.
      queryClient.invalidateQueries({ queryKey: receptionistsQueryKey(businessId) }),
    ]);
  };

  const save = useMutation({
    mutationFn: async ({ editing, values }: { editing: EntryLinkView | null; values: QrLinkValues }) => {
      if (!editing) {
        const { link } = await requestJson<{ link: EntryLinkView }>(`/api/entry-links?businessId=${encodeURIComponent(businessId)}`, { method: "POST", body: JSON.stringify(values) });
        return { link, created: true };
      }
      const patch = {
        ...(values.label !== editing.label ? { label: values.label } : {}),
        ...(values.receptionistId !== editing.receptionistId ? { receptionistId: values.receptionistId } : {}),
      };
      if (!Object.keys(patch).length) return { link: editing, created: false };
      const { link } = await requestJson<{ link: EntryLinkView }>(`/api/entry-links/${encodeURIComponent(editing.id)}?businessId=${encodeURIComponent(businessId)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return { link, created: false };
    },
    onSuccess: async ({ link, created }) => {
      setDialog(null);
      toast.success(t(created ? "qrCode.links.toast.created" : "qrCode.links.toast.saved", { name: entryLinkName(link, t) }));
      if (created) {
        // The newest link heads the first page, and its sign shows below.
        onSelect(link);
        if (filters.page !== 1) onPageChange(1);
      } else {
        onChanged(link);
      }
      await invalidate();
    },
    meta: { inlineError: true },
  });

  const setStatus = useMutation({
    mutationFn: async ({ link, status }: { link: EntryLinkView; status: EntryLinkStatus }) => (
      (await requestJson<{ link: EntryLinkView }>(`/api/entry-links/${encodeURIComponent(link.id)}?businessId=${encodeURIComponent(businessId)}`, { method: "PATCH", body: JSON.stringify({ status }) })).link
    ),
    onSuccess: async (link, { status }) => {
      toast.success(t(status === "paused" ? "qrCode.links.toast.paused" : "qrCode.links.toast.resumed", { name: entryLinkName(link, t) }));
      onChanged(link);
      await invalidate();
    },
    onError: (error) => { toast.error(entryLinkErrorMessage(error, t, locale)); },
  });

  async function copyAddress(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("qrCode.links.toast.copied"));
    } catch {
      toast.error(t("qrCode.links.toast.copyFailed", { url }));
    }
  }

  const openDialog = (editing: EntryLinkView | null) => {
    save.reset();
    setDialog({ editing });
  };

  // A new link starts with the receptionist the list is filtered to, when that one can still answer.
  const filtered = filters.receptionistId && byId.has(filters.receptionistId) ? filters.receptionistId : null;
  const from = (filters.page - 1) * ENTRY_LINKS_PAGE_SIZE + 1;
  const to = Math.min(total, filters.page * ENTRY_LINKS_PAGE_SIZE);

  const rowMenu = (label: string, items: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button aria-label={t("qrCode.links.menu.label", { name: label })} size="icon-sm" variant="ghost"><MoreHorizontal /></Button>} />
      <DropdownMenuContent align="end" className="w-fit min-w-44 p-1">{items}</DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><QrCode aria-hidden="true" className="size-5 text-muted-foreground" />{t("qrCode.links.title")}</CardTitle>
        <CardDescription>{several ? t("qrCode.links.description") : t("qrCode.links.descriptionOne")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canManage ? (
          <div>
            <Button onClick={() => openDialog(null)} size="sm" variant="outline"><Plus data-icon="inline-start" />{t("qrCode.links.new")}</Button>
          </div>
        ) : null}

        {showSearch || several ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {showSearch ? (
              <div className="relative w-full sm:max-w-xs">
                <label className="sr-only" htmlFor={searchId}>{t("qrCode.links.searchLabel")}</label>
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-10" id={searchId} onChange={(event) => onSearchChange(event.target.value)} placeholder={t("qrCode.links.search", { count: total, total: numbers.format(total) })} type="search" value={search} />
              </div>
            ) : <div />}
            <ReceptionistFilter businessId={businessId} className="sm:w-60" size="sm" />
          </div>
        ) : null}

        <TableCard>
          <Table className={cn("w-full table-fixed", several ? "min-w-[40rem]" : "min-w-[32rem]")}>
            <colgroup>
              <col className={several ? "w-[30%]" : "w-[38%]"} />
              {several ? <col className="w-[25%]" /> : null}
              <col className={several ? "w-[21%]" : "w-[30%]"} />
              <col className="w-[24%]" />
              <col className="w-12" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>{t("qrCode.links.columns.link")}</TableHead>
                {several ? <TableHead>{t("qrCode.links.columns.answeredBy")}</TableHead> : null}
                <TableHead>{t("qrCode.links.columns.opens")}</TableHead>
                <TableHead className="text-right">{t("qrCode.links.columns.scans")}</TableHead>
                <TableHead><span className="sr-only">{t("qrCode.links.columns.actions")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showBusinessPage ? (
                <TableRow className="h-14 cursor-pointer" data-link="business-page" data-state={selectedId === null ? "selected" : undefined} onClick={() => onSelect(null)}>
                  <TableCell className="max-w-0">
                    <button aria-controls={signId} aria-current={selectedId === null ? "true" : undefined} className="max-w-full truncate rounded-sm text-left font-medium outline-none underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={(event) => { event.stopPropagation(); onSelect(null); }} type="button">
                      {t("qrCode.links.businessPage")}
                    </button>
                  </TableCell>
                  {several ? <TableCell className="max-w-0"><ReceptionistChip archivedLabel={t("qrCode.links.archivedReceptionist")} receptionist={defaultReceptionist} /></TableCell> : null}
                  <TableCell className="max-w-0"><span className="block truncate font-mono text-[13px]" dir="ltr" title={address.path}>{address.path}</span></TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">{t("qrCode.links.notCounted")}</TableCell>
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    {rowMenu(t("qrCode.links.businessPage"), <DropdownMenuItem onClick={() => void copyAddress(businessPageUrl)}><Copy />{t("qrCode.links.menu.copy")}</DropdownMenuItem>)}
                  </TableCell>
                </TableRow>
              ) : null}

              {rows.map((link) => {
                const name = entryLinkName(link, t);
                const selected = selectedId === link.id;
                const busy = setStatus.isPending && setStatus.variables?.link.id === link.id;
                const opensSomeoneElse = link.opensReceptionistId !== link.receptionistId;
                return (
                  <TableRow className="h-14 cursor-pointer" data-link={link.id} data-state={selected ? "selected" : undefined} key={link.id} onClick={() => onSelect(link)}>
                    <TableCell className="max-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <button aria-controls={signId} aria-current={selected ? "true" : undefined} className="min-w-0 truncate rounded-sm text-left font-medium outline-none underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={(event) => { event.stopPropagation(); onSelect(link); }} title={name} type="button">
                          {name}
                        </button>
                        {link.status === "paused" ? <Badge className="flex-none" variant="outline">{t("qrCode.links.paused")}</Badge> : null}
                      </div>
                    </TableCell>
                    {several ? (
                      <TableCell className="max-w-0">
                        <div className="flex min-w-0 flex-col items-start gap-0.5">
                          <ReceptionistChip archivedLabel={t("qrCode.links.archivedReceptionist")} receptionist={byId.get(link.receptionistId)} />
                          {opensSomeoneElse ? <span className="max-w-full truncate text-xs text-muted-foreground">{t("qrCode.links.answersNow", { name: byId.get(link.opensReceptionistId)?.name ?? defaultName })}</span> : null}
                        </div>
                      </TableCell>
                    ) : null}
                    <TableCell className="max-w-0"><span className="block truncate font-mono text-[13px]" dir="ltr">{entryLinkPath(link.code)}</span></TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <span className="tabular-nums">{numbers.format(link.scansLast30Days)}</span>
                        <ScansSparkline counts={link.recentScans?.counts ?? []} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                      {busy ? <Button aria-label={t("qrCode.links.menu.label", { name })} disabled loading size="icon-sm" variant="ghost" /> : rowMenu(name, (
                        <>
                          {canManage ? <DropdownMenuItem onClick={() => openDialog(link)}><Pencil />{t("qrCode.links.menu.edit")}</DropdownMenuItem> : null}
                          <DropdownMenuItem onClick={() => void copyAddress(entryLinkUrl(address.origin, link.code))}><Copy />{t("qrCode.links.menu.copy")}</DropdownMenuItem>
                          {canManage ? (
                            <>
                              <DropdownMenuSeparator />
                              {link.status === "active"
                                ? <DropdownMenuItem onClick={() => setStatus.mutate({ link, status: "paused" })}><Pause />{t("qrCode.links.menu.pause")}</DropdownMenuItem>
                                : <DropdownMenuItem onClick={() => setStatus.mutate({ link, status: "active" })}><Play />{t("qrCode.links.menu.resume")}</DropdownMenuItem>}
                            </>
                          ) : null}
                        </>
                      ))}
                    </TableCell>
                  </TableRow>
                );
              })}

              {links.isLoading ? (
                <TableRow><TableCell className="h-16 text-center text-sm text-muted-foreground" colSpan={columns}>{t("qrCode.links.loading")}</TableCell></TableRow>
              ) : links.isError ? (
                <TableRow>
                  <TableCell className="h-16 text-center text-sm" colSpan={columns}>
                    <span className="text-destructive">{t("qrCode.links.unavailable")}</span>{" "}
                    <Button className="h-auto p-0 align-baseline" onClick={() => void links.refetch()} size="sm" variant="link">{t("qrCode.links.retry")}</Button>
                  </TableCell>
                </TableRow>
              ) : !rows.length ? (
                <TableRow>
                  <TableCell className="h-16 text-center text-sm whitespace-normal text-muted-foreground" colSpan={columns}>
                    {searching || filters.receptionistId ? t("qrCode.links.noMatches") : canManage ? t("qrCode.links.empty") : t("qrCode.links.emptyViewer")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableCard>

        {total > ENTRY_LINKS_PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
            <span aria-live="polite">{t("qrCode.links.range", { from: numbers.format(from), to: numbers.format(to), total: numbers.format(total) })}</span>
            <Button aria-label={t("qrCode.links.previous")} disabled={filters.page <= 1} onClick={() => onPageChange(filters.page - 1)} size="icon-sm" variant="outline"><ChevronLeft className="rtl:rotate-180" /></Button>
            <Button aria-label={t("qrCode.links.next")} disabled={filters.page >= pages} onClick={() => onPageChange(filters.page + 1)} size="icon-sm" variant="outline"><ChevronRight className="rtl:rotate-180" /></Button>
          </div>
        ) : null}

        <p className="text-[13px]/[18px] text-muted-foreground">
          {canManage ? (several ? t("qrCode.links.menuNote") : t("qrCode.links.menuNoteOne")) : t("qrCode.links.menuNoteViewer")}
          {" "}
          {several ? t("qrCode.links.routingNote", { name: defaultName }) : t("qrCode.links.routingNoteOne")}
        </p>
      </CardContent>

      <QrLinkDialog
        editing={dialog?.editing ?? null}
        error={save.error ? entryLinkErrorMessage(save.error, t, locale) : null}
        host={address.host}
        initialReceptionistId={filtered}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        open={dialog !== null}
        pending={save.isPending}
        receptionists={receptionists}
        save={(values) => save.mutate({ editing: dialog?.editing ?? null, values })}
      />
    </Card>
  );
}
