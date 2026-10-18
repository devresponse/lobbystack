"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Globe, LayoutList, MapPin, MessageSquareMore } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PUBLIC_PROFILE_LIMITS, publicProfileSettingsSchema, type PublicProfileSettings } from "@lobbystack/shared";

import { useActiveBusiness } from "@/hooks/use-active-business";
import { formatDateTime } from "@/lib/locale";
import { getPhoneCountryOptions } from "@/lib/phone";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";

import { PageSurface } from "./page-surface";
import { Alert, AlertDescription } from "./ui/alert";
import { Button, buttonVariants } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

/** What GET and PUT /api/business-profile answer. */
export type PublicProfileSettingsResponse = {
  saved: boolean;
  slug: string;
  businessName: string;
  publishedAt: string | null;
  settings: PublicProfileSettings;
  widgetKeys: Array<{ id: string; label: string | null; lastUsedAt: string | null; createdAt: string }>;
  url: string;
  canEdit: boolean;
};

type Form = {
  published: boolean;
  category: string;
  description: string;
  publicEmail: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  showPhone: boolean;
  showHours: boolean;
  showServices: boolean;
  showMap: boolean;
  widgetKeyId: string;
};

type Toggle = "showPhone" | "showHours" | "showServices" | "showMap";

const TEXT_FIELDS = ["category", "description", "publicEmail", "line1", "line2", "city", "region", "postalCode"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** The form field a settings issue is about, when it's one the owner types in. */
function issueField(path: readonly PropertyKey[] | undefined): TextField | null {
  const key = path?.[0] === "address" ? path[1] : path?.[0];
  return TEXT_FIELDS.find((field) => field === key) ?? null;
}

function formFromView(view: PublicProfileSettingsResponse): Form {
  const { settings } = view;
  return {
    published: settings.published,
    category: settings.category ?? "",
    description: settings.description ?? "",
    publicEmail: settings.publicEmail ?? "",
    line1: settings.address.line1 ?? "",
    line2: settings.address.line2 ?? "",
    city: settings.address.city ?? "",
    region: settings.address.region ?? "",
    postalCode: settings.address.postalCode ?? "",
    countryCode: settings.address.countryCode ?? "",
    showPhone: settings.showPhone,
    showHours: settings.showHours,
    showServices: settings.showServices,
    showMap: settings.showMap,
    // A paused or revoked widget can't be saved again, so the form starts without it.
    widgetKeyId: view.widgetKeys.some((key) => key.id === settings.widgetKeyId) ? settings.widgetKeyId ?? "" : "",
  };
}

function settingsFromForm(form: Form) {
  return {
    published: form.published,
    category: form.category,
    description: form.description,
    publicEmail: form.publicEmail,
    address: { line1: form.line1, line2: form.line2, city: form.city, region: form.region, postalCode: form.postalCode, countryCode: form.countryCode },
    showPhone: form.showPhone,
    showHours: form.showHours,
    showServices: form.showServices,
    showMap: form.showMap,
    widgetKeyId: form.widgetKeyId || null,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

/** Settings → Public profile: publishing the business's page at /profile/<slug> and what it shows. */
export function LivePublicProfileSettingsSurface() {
  const { t } = useTranslation("settings");
  const { businesses, business } = useActiveBusiness();
  const businessId = business?.businessId;
  const profile = useQuery({
    queryKey: ["business-profile", businessId],
    queryFn: () => requestJson<PublicProfileSettingsResponse>(`/api/business-profile?businessId=${encodeURIComponent(businessId!)}`),
    enabled: Boolean(businessId),
    // A refetch must not throw away what the owner is typing.
    refetchOnWindowFocus: false,
  });
  return (
    <PageSurface title={t("publicPage.title")}>
      {businesses.isLoading || profile.isLoading ? <p className="py-12 text-center text-sm text-muted-foreground">{t("publicPage.loading")}</p> : null}
      {businesses.isError || profile.isError ? <p className="py-12 text-center text-sm text-destructive">{t("publicPage.unavailable")}</p> : null}
      {businessId && profile.data ? <PublicProfileForm businessId={businessId} key={businessId} view={profile.data} /> : null}
    </PageSurface>
  );
}

function PublicProfileForm({ businessId, view: initialView }: { businessId: string; view: PublicProfileSettingsResponse }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const queryClient = useQueryClient();
  const [view, setView] = useState(initialView);
  const [form, setForm] = useState(() => formFromView(initialView));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ field: TextField | null; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const countries = useMemo(() => getPhoneCountryOptions(locale), [locale]);
  const readOnly = !view.canEdit;
  const dirty = JSON.stringify(form) !== JSON.stringify(formFromView(view));
  const widgetMissing = Boolean(view.settings.widgetKeyId) && !view.widgetKeys.some((key) => key.id === view.settings.widgetKeyId);

  const save = useMutation({
    mutationFn: (settings: PublicProfileSettings) => requestJson<PublicProfileSettingsResponse>(`/api/business-profile?businessId=${encodeURIComponent(businessId)}`, { method: "PUT", body: JSON.stringify(settings) }),
    onSuccess: (result) => {
      setView(result);
      setForm(formFromView(result));
      setSaved(true);
      queryClient.setQueryData(["business-profile", businessId], result);
    },
    onError: (cause) => {
      const code = errorCode(cause);
      setError({ field: null, message: t(code === "widget_key_unavailable" ? "publicPage.errors.widgetUnavailable" : code === "public_profile_invalid" ? "publicPage.errors.invalid" : "publicPage.errors.saveFailed") });
    },
  });

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
    if (error) setError(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = publicProfileSettingsSchema.safeParse(settingsFromForm(form));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issueField(issue?.path);
      // Text fields refuse characters that hide or reorder text; a too-long one can't be typed.
      setError({ field, message: t(field === "publicEmail" ? "publicPage.errors.email" : field && issue?.code === "custom" ? "publicPage.errors.plainText" : "publicPage.errors.invalid") });
      return;
    }
    setError(null);
    save.mutate(parsed.data);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(view.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const invalid = (key: TextField) => (error?.field === key ? true : undefined);
  const fieldError = (key: TextField) => (error?.field === key ? <FieldError>{error.message}</FieldError> : null);

  const textField = (key: "category" | "line1" | "line2" | "city" | "region" | "postalCode", label: string, maxLength: number, options: { placeholder?: string; autoComplete?: string; className?: string } = {}) => (
    <Field className={options.className} data-invalid={invalid(key)}>
      <FieldLabel htmlFor={`public-profile-${key}`}>{label}</FieldLabel>
      <Input aria-invalid={invalid(key)} autoComplete={options.autoComplete} disabled={readOnly} id={`public-profile-${key}`} maxLength={maxLength} onChange={(event) => update(key, event.target.value)} placeholder={options.placeholder} value={form[key]} />
      {fieldError(key)}
    </Field>
  );

  const toggles: Array<{ key: Toggle; label: string; hint: string; edit?: { href: string; label: string } }> = [
    { key: "showPhone", label: t("publicPage.sections.phone"), hint: t("publicPage.sections.phoneHint") },
    { key: "showHours", label: t("publicPage.sections.hours"), hint: t("publicPage.sections.hoursHint"), edit: { href: "/agent", label: t("publicPage.sections.editHours") } },
    { key: "showServices", label: t("publicPage.sections.services"), hint: t("publicPage.sections.servicesHint"), edit: { href: "/agent/services", label: t("publicPage.sections.editServices") } },
    { key: "showMap", label: t("publicPage.sections.map"), hint: t("publicPage.sections.mapHint") },
  ];

  return (
    <form className="flex flex-col gap-6 pb-12" noValidate onSubmit={submit}>
      {readOnly ? <Alert><AlertDescription>{t("publicPage.readOnly")}</AlertDescription></Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Globe className="size-5 text-muted-foreground" />{t("publicPage.publish.title")}</CardTitle>
          <CardDescription>{t("publicPage.publish.description", { business: view.businessName })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-xl bg-muted px-3 py-2 text-sm" dir="ltr">{view.url}</code>
            <Button onClick={() => void copyLink()} size="sm" type="button" variant="outline">{copied ? <Check /> : <Copy />}{copied ? t("publicPage.publish.copied") : t("publicPage.publish.copy")}</Button>
            <a className={cn(buttonVariants({ size: "sm", variant: "outline" }))} href={view.url} rel="noopener noreferrer" target="_blank"><ExternalLink />{view.settings.published ? t("publicPage.publish.open") : t("publicPage.publish.preview")}</a>
          </div>
          <Field orientation="horizontal">
            <FieldContent className="min-w-0">
              <FieldLabel htmlFor="public-profile-published">{t("publicPage.publish.label")}</FieldLabel>
              <FieldDescription>
                {form.published ? t("publicPage.publish.on") : t("publicPage.publish.off")}
                {form.published && view.settings.published && view.publishedAt ? <> {t("publicPage.publish.since", { date: formatDateTime(view.publishedAt, locale, { dateStyle: "medium" }) })}</> : null}
              </FieldDescription>
            </FieldContent>
            <Switch checked={form.published} disabled={readOnly} id="public-profile-published" onCheckedChange={(checked) => update("published", checked)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MapPin className="size-5 text-muted-foreground" />{t("publicPage.details.title")}</CardTitle>
          <CardDescription>{t("publicPage.details.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          {textField("category", t("publicPage.details.category"), PUBLIC_PROFILE_LIMITS.category, { placeholder: t("publicPage.details.categoryPlaceholder") })}
          <Field data-invalid={invalid("publicEmail")}>
            <FieldLabel htmlFor="public-profile-email">{t("publicPage.details.email")}</FieldLabel>
            <Input aria-invalid={invalid("publicEmail")} autoComplete="email" disabled={readOnly} id="public-profile-email" maxLength={PUBLIC_PROFILE_LIMITS.email} onChange={(event) => update("publicEmail", event.target.value)} placeholder={t("publicPage.details.emailPlaceholder")} type="email" value={form.publicEmail} />
            {fieldError("publicEmail")}
          </Field>
          <Field className="sm:col-span-2" data-invalid={invalid("description")}>
            <FieldLabel htmlFor="public-profile-description">{t("publicPage.details.about")}</FieldLabel>
            <Textarea aria-invalid={invalid("description")} className="min-h-28" disabled={readOnly} id="public-profile-description" maxLength={PUBLIC_PROFILE_LIMITS.description} onChange={(event) => update("description", event.target.value)} placeholder={t("publicPage.details.aboutPlaceholder")} value={form.description} />
            <FieldDescription>{t("publicPage.details.aboutCount", { count: form.description.length, max: PUBLIC_PROFILE_LIMITS.description })}</FieldDescription>
            {fieldError("description")}
          </Field>
          <FieldSet className="grid gap-5 sm:col-span-2 sm:grid-cols-2">
            <FieldLegend className="sm:col-span-2" variant="label">{t("publicPage.details.address")}</FieldLegend>
            {textField("line1", t("publicPage.details.line1"), PUBLIC_PROFILE_LIMITS.addressLine, { autoComplete: "address-line1", className: "sm:col-span-2" })}
            {textField("line2", t("publicPage.details.line2"), PUBLIC_PROFILE_LIMITS.addressLine, { autoComplete: "address-line2", className: "sm:col-span-2" })}
            {textField("city", t("publicPage.details.city"), PUBLIC_PROFILE_LIMITS.city, { autoComplete: "address-level2" })}
            {textField("region", t("publicPage.details.region"), PUBLIC_PROFILE_LIMITS.region, { autoComplete: "address-level1" })}
            {textField("postalCode", t("publicPage.details.postalCode"), PUBLIC_PROFILE_LIMITS.postalCode, { autoComplete: "postal-code" })}
            <Field>
              <FieldLabel htmlFor="public-profile-country">{t("publicPage.details.country")}</FieldLabel>
              <NativeSelect className="w-full" disabled={readOnly} id="public-profile-country" onChange={(event) => update("countryCode", event.target.value)} value={form.countryCode}>
                <NativeSelectOption value="">{t("publicPage.details.noCountry")}</NativeSelectOption>
                {countries.map((country) => <NativeSelectOption key={country.code} value={country.code}>{country.label}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
          </FieldSet>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LayoutList className="size-5 text-muted-foreground" />{t("publicPage.sections.title")}</CardTitle>
          <CardDescription>{t("publicPage.sections.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {toggles.map((toggle) => (
            <Field className="py-3.5 first:pt-0 last:pb-0" key={toggle.key} orientation="horizontal">
              <FieldContent className="min-w-0">
                <FieldLabel htmlFor={`public-profile-${toggle.key}`}>{toggle.label}</FieldLabel>
                <FieldDescription>
                  {toggle.hint}
                  {toggle.edit ? <> <Link className="font-medium text-foreground" href={toggle.edit.href}>{toggle.edit.label}</Link></> : null}
                </FieldDescription>
              </FieldContent>
              <Switch checked={form[toggle.key]} disabled={readOnly} id={`public-profile-${toggle.key}`} onCheckedChange={(checked) => update(toggle.key, checked)} />
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MessageSquareMore className="size-5 text-muted-foreground" />{t("publicPage.chat.title")}</CardTitle>
          <CardDescription>{t("publicPage.chat.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {view.widgetKeys.length ? (
            <Field>
              <FieldLabel htmlFor="public-profile-widget">{t("publicPage.chat.widget")}</FieldLabel>
              <NativeSelect className="w-full sm:max-w-md" disabled={readOnly} id="public-profile-widget" onChange={(event) => update("widgetKeyId", event.target.value)} value={form.widgetKeyId}>
                {view.widgetKeys.map((key) => {
                  const label = key.label ?? t("publicPage.chat.untitled");
                  return <NativeSelectOption key={key.id} value={key.id}>{key.lastUsedAt ? t("publicPage.chat.lastUsed", { label, date: formatDateTime(key.lastUsedAt, locale, { dateStyle: "medium" }) }) : label}</NativeSelectOption>;
                })}
                <NativeSelectOption value="">{t("publicPage.chat.none")}</NativeSelectOption>
              </NativeSelect>
            </Field>
          ) : <p className="text-sm text-muted-foreground">{t("publicPage.chat.empty")}</p>}
          {widgetMissing ? <p className="text-sm text-muted-foreground">{t("publicPage.chat.unavailable")}</p> : null}
          <Link className="self-start text-sm font-medium underline underline-offset-4" href="/settings/widget">{t("publicPage.chat.manage")}</Link>
        </CardContent>
      </Card>

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!dirty} loading={save.isPending} type="submit">{t("publicPage.save")}</Button>
          {saved && !dirty ? <p className="flex items-center gap-1 text-sm text-muted-foreground" role="status"><Check className="size-4" />{t("publicPage.saved")}</p> : null}
          {error && !error.field ? <p className="text-sm text-destructive" role="alert">{error.message}</p> : null}
        </div>
      )}
    </form>
  );
}
