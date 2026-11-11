"use client";

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  isReceptionistHandle,
  RECEPTIONIST_DESCRIPTION_MAX_LENGTH,
  RECEPTIONIST_HANDLE_MAX_LENGTH,
  RECEPTIONIST_NAME_MAX_LENGTH,
  runtimeLocaleEndonyms,
  runtimeLocales,
  type ReceptionistKnowledgeScope,
} from "@lobbystack/shared";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ReceptionistOption } from "./receptionist-choices";
import { ReceptionistSelect } from "./receptionist-select";

// Adding a receptionist, or changing what the Receptionists page holds for
// one: its name, what it helps with, its page address, language, knowledge and
// whether visitors can pick it. A new receptionist copies the greeting,
// booking, transfer and instructions of another; AI settings change those.

/** What the editor sends: the body of POST /api/receptionists, or of PATCH /api/receptionists/<id>. */
export type ReceptionistEditorValues = {
  name: string;
  description: string;
  /** Empty: made from the name for a new receptionist, kept for one being edited. */
  handle: string;
  /** Null speaks the business's language. */
  locale: string | null;
  knowledgeScope: ReceptionistKnowledgeScope;
  listed: boolean;
  copyFromId: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The receptionist being changed; null adds one. */
  editing: ReceptionistOption | null;
  /** Receptionists a new one can copy, the default first. */
  receptionists: ReceptionistOption[];
  businessSlug: string;
  businessLocale: string | undefined;
  pending: boolean;
  /** A message from the server about the last save. */
  error: string | null;
  save: (values: ReceptionistEditorValues) => void;
};

function initialValues(editing: ReceptionistOption | null, receptionists: ReceptionistOption[]): ReceptionistEditorValues {
  if (editing) return { name: editing.name, description: editing.description, handle: editing.handle ?? "", locale: editing.locale, knowledgeScope: editing.knowledgeScope, listed: editing.listed, copyFromId: null };
  return { name: "", description: "", handle: "", locale: null, knowledgeScope: "audience", listed: true, copyFromId: receptionists.find((receptionist) => receptionist.isDefault)?.id ?? receptionists[0]?.id ?? null };
}

export function ReceptionistEditor({ open, onOpenChange, editing, receptionists, businessSlug, businessLocale, pending, error, save }: Props) {
  const { t } = useTranslation("receptionists");
  const ids = { name: useId(), description: useId(), handle: useId(), language: useId(), listed: useId(), scope: useId() };
  const [values, setValues] = useState<ReceptionistEditorValues>(() => initialValues(editing, receptionists));
  const [submitted, setSubmitted] = useState(false);
  // Fill the form afresh each time it opens; the list it copies from can arrive after.
  useEffect(() => {
    if (!open) return;
    setValues(initialValues(editing, receptionists));
    setSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, open]);

  const isDefault = editing?.isDefault ?? false;
  const handle = values.handle.trim().toLowerCase();
  const nameMissing = submitted && !values.name.trim();
  const handleInvalid = submitted && !isDefault && handle !== "" && !isReceptionistHandle(handle);
  const change = <Key extends keyof ReceptionistEditorValues>(key: Key, value: ReceptionistEditorValues[Key]) => setValues((current) => ({ ...current, [key]: value }));
  const businessLanguage = businessLocale && businessLocale in runtimeLocaleEndonyms ? runtimeLocaleEndonyms[businessLocale as keyof typeof runtimeLocaleEndonyms] : businessLocale ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t("editor.editTitle", { name: editing.name }) : t("editor.addTitle")}</DialogTitle>
          <DialogDescription>{editing ? t("editor.editDescription") : t("editor.addDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (pending || !values.name.trim() || (!isDefault && handle !== "" && !isReceptionistHandle(handle))) return;
            save({ ...values, name: values.name.trim(), description: values.description.trim(), handle });
          }}
        >
          <FieldGroup>
            <Field data-invalid={nameMissing || undefined}>
              <FieldContent>
                <FieldLabel htmlFor={ids.name}>{t("editor.name")}</FieldLabel>
                <FieldDescription>{t("editor.nameHint")}</FieldDescription>
              </FieldContent>
              <Input id={ids.name} maxLength={RECEPTIONIST_NAME_MAX_LENGTH} value={values.name} onChange={(event) => change("name", event.target.value)} aria-invalid={nameMissing || undefined} aria-describedby={nameMissing ? `${ids.name}-error` : undefined} />
              {nameMissing ? <FieldError id={`${ids.name}-error`}>{t("editor.nameRequired")}</FieldError> : null}
            </Field>
            <Field>
              <FieldContent>
                <FieldLabel htmlFor={ids.description}>{t("editor.description")}</FieldLabel>
                <FieldDescription>{t("editor.descriptionHint")}</FieldDescription>
              </FieldContent>
              <Textarea id={ids.description} className="min-h-16" maxLength={RECEPTIONIST_DESCRIPTION_MAX_LENGTH} value={values.description} onChange={(event) => change("description", event.target.value)} />
            </Field>
            <Field data-invalid={handleInvalid || undefined}>
              <FieldContent>
                <FieldLabel htmlFor={ids.handle}>{t("editor.handle")}</FieldLabel>
                <FieldDescription>{isDefault ? t("editor.handleDefault") : t("editor.handleHint")}</FieldDescription>
              </FieldContent>
              <div className="flex min-w-0 items-center gap-1 text-sm">
                <span className="flex-none text-muted-foreground" dir="ltr">/profile/{businessSlug}/</span>
                <Input id={ids.handle} dir="ltr" disabled={isDefault} maxLength={RECEPTIONIST_HANDLE_MAX_LENGTH} value={values.handle} placeholder={isDefault ? "" : "kitsilano"} onChange={(event) => change("handle", event.target.value)} aria-invalid={handleInvalid || undefined} aria-describedby={handleInvalid ? `${ids.handle}-error` : undefined} />
              </div>
              {handleInvalid ? <FieldError id={`${ids.handle}-error`}>{t("editor.handleInvalid")}</FieldError> : null}
            </Field>
            <Field>
              <FieldContent>
                <FieldLabel htmlFor={ids.language}>{t("editor.language")}</FieldLabel>
                <FieldDescription>{isDefault ? t("editor.languageDefault") : t("editor.languageHint")}</FieldDescription>
              </FieldContent>
              <NativeSelect id={ids.language} className="w-full" disabled={isDefault} value={values.locale ?? ""} onChange={(event) => change("locale", event.target.value || null)}>
                <NativeSelectOption value="">{t("editor.businessLanguage", { language: businessLanguage })}</NativeSelectOption>
                {runtimeLocales.map((locale) => <NativeSelectOption key={locale} value={locale} lang={locale}>{runtimeLocaleEndonyms[locale]}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{t("editor.knowledge")}</FieldLegend>
              <div className="flex flex-col gap-2 text-sm">
                {(["audience", "all"] as const).map((scope) => (
                  <label key={scope} className="flex items-start gap-2">
                    <input type="radio" name={ids.scope} className="mt-0.5 size-4" checked={values.knowledgeScope === scope} onChange={() => change("knowledgeScope", scope)} />
                    <span>{t(scope === "all" ? "editor.knowledgeAll" : "editor.knowledgeAudience")}</span>
                  </label>
                ))}
              </div>
            </FieldSet>
            <Field orientation="horizontal">
              <Switch id={ids.listed} checked={values.listed} disabled={isDefault} onCheckedChange={(listed) => change("listed", listed)} />
              <FieldContent>
                <FieldLabel htmlFor={ids.listed}>{t("editor.listed")}</FieldLabel>
                <FieldDescription>{isDefault ? t("editor.listedDefault") : t("editor.listedHint")}</FieldDescription>
              </FieldContent>
            </Field>
            {editing ? null : (
              <Field>
                <ReceptionistSelect label={t("editor.copyFrom")} receptionists={receptionists} value={values.copyFromId} onChange={(copyFromId) => change("copyFromId", copyFromId)} alwaysShow />
                <FieldDescription>{t("editor.copyFromHint")}</FieldDescription>
              </Field>
            )}
          </FieldGroup>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button className="w-full" type="submit" disabled={pending}>{editing ? (pending ? t("editor.saving") : t("editor.save")) : (pending ? t("editor.adding") : t("editor.add"))}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
