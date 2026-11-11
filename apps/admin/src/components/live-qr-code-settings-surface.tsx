"use client";

import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { CircleAlert, Download, ExternalLink, Printer, QrCode } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { receptionistPagePath, trimEndWhere } from "@lobbystack/shared";

import { useBranding } from "@/components/branding-provider";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { loadRouteNamespaces } from "@/i18n";
import { brandLogoSrc } from "@/lib/branding-snapshot";
import { intlLocale, LOCALE_LABEL_KEYS, resolveLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/locale";
import { drawQrCode, QR_NAME_LETTER_SPACING_EM, type QrCodeMark } from "@/lib/qr-code";
import { qrCodeFileName, qrCodePng, qrCodeSvgFile, saveFile } from "@/lib/qr-code-files";
import { QR_MESSAGE_MAX_LENGTH } from "@/lib/qr-code-headline";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";

import type { PublicProfileSettingsResponse } from "./live-public-profile-settings-surface";
import { PageSurface } from "./page-surface";
import { QR_SIGN_SHEETS, QR_SIGN_SIZES, QR_SIGN_TEMPLATES, QrSignSheet, qrSheetSize, qrSignCodeWidth, type QrSignContent, type QrSignSize, type QrSignTemplate } from "./qr-code/qr-code-sign";
import { entryLinkName, entryLinkUrl, QrLinksCard, useEntryLinks, type EntryLinkView } from "./qr-code/qr-links";
import { ScansChart } from "./qr-code/scans-chart";
import { useDarkLogo } from "./qr-code/use-dark-logo";
import { QR_SIGN_FONT_FAMILY, useTextMeasure } from "./qr-code/use-text-measure";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button, buttonVariants } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { useReceptionistChoices, useReceptionistFilter } from "./receptionists/receptionist-choices";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

// Settings → QR code: the business's QR codes and a printable sign for each.
// The business page has its own code, which signs printed before QR links
// existed carry; each QR link is a short /q/<code> address that opens one
// receptionist's page and counts its scans. Signs are drawn in the browser
// from the chosen code's address, and nothing about a sign is saved.

const PX_PER_MM = 96 / 25.4;
// The preview's widest sheet, in pixels: portrait and sideways.
const PREVIEW_WIDTH = { portrait: 420, landscape: 594 };

/** The sign's words in its own language, which may differ from the dashboard's. */
function useSignTranslation(language: SupportedLocale): TFunction<"settings"> {
  const { t, i18n } = useTranslation("settings", { lng: language });
  useEffect(() => {
    // Until the language loads, and if it can't, the sign reads in English.
    void loadRouteNamespaces(i18n, language, ["settings"]).catch(() => undefined);
  }, [i18n, language]);
  return t;
}

function subscribeNothing(): () => void {
  return () => undefined;
}

/** The sheet the printer gets, outside the dashboard, shown only when printing. */
function PrintSheet({ landscape, children }: { landscape: boolean; children: ReactNode }) {
  const inBrowser = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (!inBrowser) return null;
  return createPortal(
    <div aria-hidden="true" className="qr-print-root">
      <style>{`
        .qr-print-root { display: none; }
        @media print {
          @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; width: auto !important; height: auto !important; min-height: 0 !important; overflow: visible !important; background: #FFFFFF !important; }
          body > *:not(.qr-print-root) { display: none !important; }
          .qr-print-root { display: block !important; }
        }
      `}</style>
      {children}
    </div>,
    document.body,
  );
}

/** The sheet scaled down to fit the preview column. */
function SheetPreview({ size, label, children }: { size: QrSignSize; label: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const paper = qrSheetSize(size);
  const landscape = QR_SIGN_SHEETS[size].landscape;
  const sheetWidth = paper.width * PX_PER_MM;
  const sheetHeight = paper.height * PX_PER_MM;
  const widest = landscape ? PREVIEW_WIDTH.landscape : PREVIEW_WIDTH.portrait;
  const [available, setAvailable] = useState(widest);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(widest, available || widest) / sheetWidth;
  return (
    <div className="flex w-full justify-center" ref={frame}>
      <div aria-label={label} className="overflow-hidden bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_10px_30px_rgba(0,0,0,0.10)]" role="img" style={{ width: sheetWidth * scale, height: sheetHeight * scale }}>
        <div style={{ width: sheetWidth, height: sheetHeight, transform: `scale(${scale})`, transformOrigin: "0 0" }}>{children}</div>
      </div>
    </div>
  );
}

/** A small drawing of each template, for its choice. */
function TemplateThumbnail({ template }: { template: QrSignTemplate }) {
  if (template === "frontDesk") {
    return (
      <span aria-hidden="true" className="flex h-[118px] flex-col gap-[5px] rounded-md bg-white p-2 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="block h-2 w-[50px] bg-black" />
        <span className="block h-[3px] w-9 bg-[#3D3D3D]" />
        <span className="flex h-[58px] items-center justify-center rounded-[5px] bg-[#FFD100]"><span className="block size-[34px] bg-white" /></span>
        <span className="mt-auto block h-2.5 rounded-[3px] bg-black" />
      </span>
    );
  }
  const night = template === "night";
  const ink = night ? "bg-white" : "bg-black";
  return (
    <span aria-hidden="true" className={cn("flex h-[118px] flex-col justify-between rounded-md px-[9px] pt-[9px] pb-[7px]", night ? "bg-black" : "bg-[#FFD100]")}>
      <span className="flex flex-col gap-[3px]">
        <span className={cn("block h-[3px] w-[26px]", ink)} />
        <span className={cn("block h-1.5 w-14", ink)} />
        <span className={cn("block h-1.5 w-11", ink)} />
      </span>
      <span className={cn("block size-10 self-center bg-white", night ? "shadow-[-4px_-4px_0_-1px_#FFD100,4px_4px_0_-1px_#FFD100]" : "shadow-[-4px_-4px_0_-1px_#000,4px_4px_0_-1px_#000]")} />
      <span className={cn("block h-1 w-[46px] self-center", ink)} />
    </span>
  );
}

/** A file-name part from a link's label, such as "front-window": plain letters and digits, at most 40. */
export function fileNamePart(label: string): string {
  // Runs of anything else become single dashes, so one at each end is all there is.
  const part = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return trimEndWhere(part.slice(0, 40), (character) => character === "-");
}

/** The name a link's code downloads under, after the page and the link: acme-dental-front-window-7kq2mx. */
export function linkFileStem(slug: string, link: Pick<EntryLinkView, "label" | "code">): string {
  return [slug, fileNamePart(link.label), link.code].filter(Boolean).join("-");
}

/** Settings → QR code: the business's QR codes and their printable signs. */
export function LiveQrCodeSettingsSurface() {
  const { t } = useTranslation("settings");
  const { businesses, business } = useActiveBusiness();
  const businessId = business?.businessId;
  const canManage = business ? ["business_owner", "business_admin"].includes(business.role) : false;
  const profile = useQuery({
    queryKey: ["business-profile", businessId],
    queryFn: () => requestJson<PublicProfileSettingsResponse>(`/api/business-profile?businessId=${encodeURIComponent(businessId!)}`),
    enabled: Boolean(businessId),
  });
  return (
    <PageSurface title={t("qrCode.title")}>
      {businesses.isLoading || profile.isLoading ? <p className="py-12 text-center text-sm text-muted-foreground">{t("qrCode.loading")}</p> : null}
      {businesses.isError || profile.isError ? <p className="py-12 text-center text-sm text-destructive">{t("qrCode.unavailable")}</p> : null}
      {businessId && profile.data ? <QrCodeStudio businessId={businessId} canManage={canManage} key={businessId} view={profile.data} /> : null}
    </PageSurface>
  );
}

function QrCodeStudio({ view, businessId, canManage }: { view: PublicProfileSettingsResponse; businessId: string; canManage: boolean }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const locale = resolveLocale(i18n.resolvedLanguage, i18n.language);
  const id = useId();
  const { receptionists } = useReceptionistChoices(businessId);
  const [receptionistFilter] = useReceptionistFilter();
  const [search, setSearch] = useState("");
  // The page shown, for the filter it was chosen under: another filter starts at the first page.
  const [paging, setPaging] = useState<{ filter: string | null; page: number }>({ filter: null, page: 1 });
  const page = paging.filter === receptionistFilter ? paging.page : 1;
  const filters = { search: search.trim(), page, receptionistId: receptionistFilter };
  const links = useEntryLinks(businessId, filters);
  // The link whose sign shows, as last seen; null is the business page.
  const [chosen, setChosen] = useState<EntryLinkView | null>(null);
  const link = chosen ? links.data?.links?.find((entry) => entry.id === chosen.id) ?? chosen : null;
  const branding = useBranding();
  const logoSrc = brandLogoSrc(branding);
  const logoNeedsTile = useDarkLogo(logoSrc);
  const [template, setTemplate] = useState<QrSignTemplate>("signal");
  const [size, setSize] = useState<QrSignSize>("a4");
  const [mark, setMark] = useState<QrCodeMark>("name");
  const [language, setLanguage] = useState<SupportedLocale>(locale);
  // Null until the owner types, so the message follows the sign's language.
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState<"png" | "svg" | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const signT = useSignTranslation(language);
  const plate = useTextMeasure(700, QR_NAME_LETTER_SPACING_EM);
  const heavy = useTextMeasure(780, -0.035);
  const regular = useTextMeasure(500, 0);
  const measures = useMemo(() => ({ heavy, regular }), [heavy, regular]);

  const marks: QrCodeMark[] = logoSrc ? ["name", "logo", "none"] : ["name", "none"];
  const chosenMark = marks.includes(mark) ? mark : "name";
  const origin = useMemo(() => { try { return new URL(view.url).origin; } catch { return ""; } }, [view.url]);
  // The address the code holds: the business page's, or the chosen link's short one.
  const signUrl = link ? entryLinkUrl(origin, link.code) : view.url;
  const defaultReceptionist = receptionists.find((receptionist) => receptionist.isDefault);
  const named = link ? receptionists.find((receptionist) => receptionist.id === link.receptionistId) : undefined;
  const opens = link ? receptionists.find((receptionist) => receptionist.id === link.opensReceptionistId) : undefined;
  // A link to a receptionist other than the default one invites visitors to that receptionist by name.
  const personal = named && !named.isDefault ? named : null;
  // "Open page" goes straight to the page the code opens now, so checking it doesn't count as a scan.
  const destination = link ? `${origin}${receptionistPagePath(view.slug, opens && !opens.isDefault ? opens.handle : null)}` : view.url;
  const drawing = useMemo(() => drawQrCode(signUrl, { mark: chosenMark, name: branding.appName, nameWidthEm: plate(branding.appName, 1) }), [signUrl, chosenMark, branding.appName, plate]);
  const message = typed ?? (personal ? signT("qrCode.sign.defaultMessageFor", { name: personal.name }) : signT("qrCode.sign.defaultMessage"));
  const chat = Boolean(view.settings.widgetKeyId) && view.widgetKeys.some((key) => key.id === view.settings.widgetKeyId);
  const scanLine = chat ? (personal ? signT("qrCode.sign.scanChatWith", { name: personal.name }) : signT("qrCode.sign.scanChat")) : signT("qrCode.sign.scanPage");
  const sheet = QR_SIGN_SHEETS[size];
  const content: QrSignContent | null = drawing
    ? { businessName: view.businessName, message, scanLine, url: signUrl, drawing, appName: branding.appName, logoSrc, logoNeedsTile, t: signT }
    : null;
  const linkNote = !link ? null
    : link.status === "paused" ? t("qrCode.signCard.linkPaused")
      : !named && defaultReceptionist ? t("receptionists:entry.archived", { default: defaultReceptionist.name })
        : named?.status === "paused" && defaultReceptionist && !named.isDefault ? t("receptionists:entry.paused", { name: named.name, default: defaultReceptionist.name })
          : null;
  // The links the sign's Link dropdown offers: the table's page, and the chosen one wherever it is.
  const linkChoices = [...(links.data?.links ?? [])];
  if (link && !linkChoices.some((entry) => entry.id === link.id)) linkChoices.unshift(link);

  /** Shows another code's sign; its message starts over from that sign's own. */
  const choose = (next: EntryLinkView | null) => {
    if ((next?.id ?? null) === (chosen?.id ?? null)) return;
    setChosen(next);
    setTyped(null);
  };

  const numbers = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 });
  const sizeHint = (value: QrSignSize) => {
    const codeMm = qrSignCodeWidth(template, value);
    // A code scans from about ten times its width.
    const distanceCm = codeMm >= 95 ? Math.round(codeMm / 10) * 10 : Math.round(codeMm / 5) * 5;
    const distance = new Intl.NumberFormat(intlLocale(locale), { style: "unit", unit: distanceCm >= 100 ? "meter" : "centimeter", maximumFractionDigits: 1 }).format(distanceCm >= 100 ? distanceCm / 100 : distanceCm);
    return t("qrCode.size.hint", { count: QR_SIGN_SHEETS[value].columns * QR_SIGN_SHEETS[value].rows, code: numbers.format(codeMm / 10), distance });
  };

  async function download(kind: "png" | "svg") {
    if (!drawing) return;
    setBusy(kind);
    setDownloadFailed(false);
    try {
      const options = { name: branding.appName, logoSrc: drawing.mark === "logo" ? logoSrc : null, fontFamily: QR_SIGN_FONT_FAMILY, title: t("qrCode.codeLabel", { url: signUrl }) };
      saveFile(kind === "png" ? await qrCodePng(drawing, options) : await qrCodeSvgFile(drawing, options), qrCodeFileName(link ? linkFileStem(view.slug, link) : view.slug, kind));
    } catch {
      setDownloadFailed(true);
    } finally {
      setBusy(null);
    }
  }

  const sheetElement = content ? <QrSignSheet content={content} measures={measures} size={size} template={template} /> : null;

  return (
    <div className="flex flex-col gap-6 pb-12">
      {view.settings.published ? null : (
        <Alert role="status">
          <div className="flex items-start gap-3">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div className="flex min-w-0 flex-col gap-1">
              <AlertTitle>{t("qrCode.unpublished.title")}</AlertTitle>
              <AlertDescription>{t("qrCode.unpublished.description")}</AlertDescription>
              {view.canEdit
                ? <Link className="mt-1 self-start text-sm font-medium underline underline-offset-4" href="/settings/profile">{t("qrCode.unpublished.link")}</Link>
                : <AlertDescription>{t("qrCode.unpublished.askAdmin")}</AlertDescription>}
            </div>
          </div>
        </Alert>
      )}

      <QrLinksCard
        businessId={businessId}
        businessPageUrl={view.url}
        canManage={canManage}
        filters={filters}
        links={links}
        onChanged={(changed) => { if (chosen?.id === changed.id) setChosen(changed); }}
        onPageChange={(next) => setPaging({ filter: receptionistFilter, page: next })}
        onSearchChange={(next) => { setSearch(next); setPaging({ filter: receptionistFilter, page: 1 }); }}
        onSelect={choose}
        receptionists={receptionists}
        search={search}
        selectedId={link?.id ?? null}
        signId={`${id}-sign`}
      />

      <Card aria-labelledby={`${id}-sign-title`} id={`${id}-sign`} role="region">
        <CardHeader>
          <CardTitle className="flex items-center gap-2" id={`${id}-sign-title`}><QrCode aria-hidden="true" className="size-5 text-muted-foreground" />{link ? t("qrCode.signCard.linkTitle", { name: entryLinkName(link, t) }) : t("qrCode.signCard.pageTitle")}</CardTitle>
          <CardDescription>{t("qrCode.signCard.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t("qrCode.opens")}</span>
              <code className="min-w-0 break-all rounded-xl bg-muted px-3 py-2 text-sm" dir="ltr">{signUrl}</code>
              <a className={cn(buttonVariants({ size: "sm", variant: "outline" }))} href={destination} rel="noopener noreferrer" target="_blank"><ExternalLink />{view.settings.published ? t("qrCode.open") : t("qrCode.preview")}</a>
            </div>
            {linkNote ? <p className="text-xs text-amber-700 dark:text-amber-400">{linkNote}</p> : null}
          </div>

          <div className="flex flex-wrap items-start gap-8">
            <form className="flex min-w-0 flex-[1_1_360px] flex-col gap-6 sm:max-w-[460px]" noValidate onSubmit={(event) => event.preventDefault()}>
              {linkChoices.length ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-link`}>{t("qrCode.signCard.link")}</FieldLabel>
                  <NativeSelect className="w-full" id={`${id}-link`} onChange={(event) => choose(linkChoices.find((entry) => entry.id === event.target.value) ?? null)} value={link?.id ?? ""}>
                    <NativeSelectOption value="">{t("qrCode.links.businessPage")}</NativeSelectOption>
                    {linkChoices.map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entryLinkName(entry, t)}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
              ) : null}

              <FieldSet className="gap-0">
                <FieldLegend variant="label">{t("qrCode.template.label")}</FieldLegend>
                <div className="grid grid-cols-3 gap-3">
                  {QR_SIGN_TEMPLATES.map((value) => (
                    <label className={cn("flex cursor-pointer flex-col gap-2 rounded-xl border p-2.5 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50", template === value ? "border-foreground ring-1 ring-foreground" : "border-border hover:bg-muted/50")} key={value}>
                      <input aria-describedby={`${id}-template-${value}-hint`} aria-labelledby={`${id}-template-${value}`} checked={template === value} className="sr-only" name={`${id}-template`} onChange={() => setTemplate(value)} type="radio" value={value} />
                      <TemplateThumbnail template={value} />
                      <span className="flex flex-col">
                        <span className="text-sm font-medium" id={`${id}-template-${value}`}>{t(`qrCode.template.${value}`)}</span>
                        <span className="text-xs text-muted-foreground" id={`${id}-template-${value}-hint`}>{t(`qrCode.template.${value}Hint`)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </FieldSet>

              <Field>
                <FieldLabel htmlFor={`${id}-message`}>{t("qrCode.message.label")}</FieldLabel>
                <Textarea aria-describedby={`${id}-message-hint`} id={`${id}-message`} maxLength={QR_MESSAGE_MAX_LENGTH} onChange={(event) => setTyped(event.target.value)} rows={2} value={message} />
                <FieldDescription className="flex justify-between gap-3" id={`${id}-message-hint`}>
                  <span>{t("qrCode.message.hint")}</span>
                  <span className="shrink-0 tabular-nums">{t("qrCode.message.count", { count: message.length, max: QR_MESSAGE_MAX_LENGTH })}</span>
                </FieldDescription>
              </Field>

              <FieldSet className="gap-0">
                <FieldLegend variant="label">{t("qrCode.size.label")}</FieldLegend>
                <div className="flex flex-col divide-y divide-border rounded-xl border">
                  {QR_SIGN_SIZES.map((value) => (
                    <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3 first:rounded-t-xl last:rounded-b-xl has-[:focus-visible]:bg-muted/50" key={value}>
                      <input aria-describedby={`${id}-size-${value}-hint`} aria-labelledby={`${id}-size-${value}`} checked={size === value} className="mt-0.5 size-4 shrink-0 accent-primary" name={`${id}-size`} onChange={() => setSize(value)} type="radio" value={value} />
                      <span className="flex flex-col">
                        <span className="text-sm font-medium" id={`${id}-size-${value}`}>{t(`qrCode.size.${value}`)}</span>
                        <span className="text-[13px]/[18px] text-muted-foreground" id={`${id}-size-${value}-hint`}>{sizeHint(value)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </FieldSet>

              <FieldSet className="gap-0">
                <FieldLegend variant="label">{t("qrCode.mark.label")}</FieldLegend>
                <div className="grid gap-1 rounded-full bg-muted p-1" style={{ gridTemplateColumns: `repeat(${marks.length}, minmax(0, 1fr))` }}>
                  {marks.map((value) => (
                    <label className={cn("relative flex h-8 cursor-pointer items-center justify-center rounded-full text-sm font-medium transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50", chosenMark === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} key={value}>
                      <input checked={chosenMark === value} className="sr-only" name={`${id}-mark`} onChange={() => setMark(value)} type="radio" value={value} />
                      {t(`qrCode.mark.${value}`)}
                    </label>
                  ))}
                </div>
                {drawing && drawing.mark !== chosenMark ? <FieldDescription className="mt-2">{t("qrCode.mark.tooLong")}</FieldDescription> : null}
              </FieldSet>

              <Field>
                <FieldLabel htmlFor={`${id}-language`}>{t("qrCode.language.label")}</FieldLabel>
                <NativeSelect className="w-full" id={`${id}-language`} onChange={(event) => setLanguage(resolveLocale(event.target.value))} value={language}>
                  {SUPPORTED_LOCALES.map((value) => <NativeSelectOption key={value} value={value}>{t(LOCALE_LABEL_KEYS[value])}</NativeSelectOption>)}
                </NativeSelect>
                <FieldDescription>{t("qrCode.language.hint")}</FieldDescription>
              </Field>

              <div className="flex flex-col gap-3 pt-1">
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!content} onClick={() => window.print()} size="lg" type="button"><Printer data-icon="inline-start" />{t("qrCode.print")}</Button>
                  <Button disabled={!drawing || busy !== null} loading={busy === "png"} onClick={() => void download("png")} size="lg" type="button" variant="outline"><Download data-icon="inline-start" />{t("qrCode.png")}</Button>
                  <Button disabled={!drawing || busy !== null} loading={busy === "svg"} onClick={() => void download("svg")} size="lg" type="button" variant="outline"><Download data-icon="inline-start" />{t("qrCode.svg")}</Button>
                </div>
                {downloadFailed ? <p className="text-sm text-destructive" role="alert">{t("qrCode.downloadFailed")}</p> : null}
                <p className="text-[13px]/[18px] text-muted-foreground">{t("qrCode.printHint")}</p>
              </div>
            </form>

            <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-6">
              <div className="flex flex-col items-center gap-4 rounded-xl bg-muted px-6 pt-8 pb-6">
                {sheetElement ? (
                  <SheetPreview label={t("qrCode.previewLabel", { template: t(`qrCode.template.${template}`), size: t(`qrCode.size.${size}`) })} size={size}>{sheetElement}</SheetPreview>
                ) : <p className="py-12 text-center text-sm text-destructive">{t("qrCode.noCode")}</p>}
                <p className="text-[13px]/[18px] text-muted-foreground">{t("qrCode.caption", { count: sheet.columns * sheet.rows, width: numbers.format(sheet.piece.width / 10), height: numbers.format(sheet.piece.height / 10) })}</p>
              </div>
              {link ? <ScansChart scans={link.recentScans} /> : <p className="text-[13px]/[18px] text-muted-foreground">{t("qrCode.chart.notCounted")}</p>}
            </div>
          </div>
        </CardContent>
      </Card>

      {sheetElement ? <PrintSheet landscape={sheet.landscape}>{sheetElement}</PrintSheet> : null}
    </div>
  );
}
