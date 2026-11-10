"use client";

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ENTRY_LINK_CODE_LENGTH, ENTRY_LINK_LABEL_MAX_LENGTH } from "@lobbystack/shared";

import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { EntryPointReceptionist } from "../receptionists/entry-point-receptionist";
import type { ReceptionistOption } from "../receptionists/receptionist-choices";

// New link, and Edit link from a row's menu, on the QR code page: the label
// the team knows the link by and, with several receptionists, who answers it.
// The code is made by the server when the link is created and never changes,
// so a printed sign keeps working whatever the link is changed to.

/** What the dialog saves: the body of POST /api/entry-links, or what PATCH changes. */
export type QrLinkValues = { label: string; receptionistId: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The link being changed; null makes a new one. */
  editing: { label: string; code: string; receptionistId: string } | null;
  receptionists: ReceptionistOption[];
  /** Who answers a new link to begin with: the receptionist the list is filtered to, else the default one. */
  initialReceptionistId: string | null;
  /** The domain signs carry, such as demo.alloplace.com. */
  host: string;
  pending: boolean;
  /** Why the server refused the last save, in the dashboard's language. */
  error: string | null;
  save: (values: QrLinkValues) => void;
};

export function QrLinkDialog({ open, onOpenChange, editing, receptionists, initialReceptionistId, host, pending, error, save }: Props) {
  const { t } = useTranslation("settings");
  const ids = { label: useId(), address: useId() };
  const defaultId = receptionists.find((receptionist) => receptionist.isDefault)?.id ?? null;
  const [label, setLabel] = useState("");
  const [receptionistId, setReceptionistId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Fill the form afresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setLabel(editing?.label ?? "");
    setReceptionistId(editing?.receptionistId ?? null);
    setSubmitted(false);
  }, [editing, open]);

  // A new link starts with the receptionist the list shows, else the default; the choices can arrive after the dialog opens.
  const chosen = receptionistId ?? initialReceptionistId ?? defaultId;
  const labelMissing = submitted && !label.trim();
  const several = receptionists.length > 1;
  const defaultName = receptionists.find((receptionist) => receptionist.isDefault)?.name ?? "";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? t("qrCode.links.dialog.editTitle") : t("qrCode.links.dialog.newTitle")}</DialogTitle>
          <DialogDescription>
            {editing ? t("qrCode.links.dialog.editDescription") : several ? t("qrCode.links.dialog.newDescription") : t("qrCode.links.dialog.newDescriptionOne")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (pending || !label.trim() || !chosen) return;
            save({ label: label.replace(/\s+/g, " ").trim(), receptionistId: chosen });
          }}
        >
          <FieldGroup>
            <Field data-invalid={labelMissing || undefined}>
              <FieldContent>
                <FieldLabel htmlFor={ids.label}>{t("qrCode.links.dialog.label")}</FieldLabel>
              </FieldContent>
              <Input
                aria-describedby={labelMissing ? `${ids.label}-error ${ids.label}-hint` : `${ids.label}-hint`}
                aria-invalid={labelMissing || undefined}
                autoComplete="off"
                id={ids.label}
                maxLength={ENTRY_LINK_LABEL_MAX_LENGTH}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("qrCode.links.dialog.labelPlaceholder")}
                value={label}
              />
              {labelMissing ? <FieldError id={`${ids.label}-error`}>{t("qrCode.links.dialog.labelMissing")}</FieldError> : null}
              <FieldDescription id={`${ids.label}-hint`}>{t("qrCode.links.dialog.labelHint")}</FieldDescription>
            </Field>
            {several ? (
              <Field>
                <EntryPointReceptionist
                  hint={t("qrCode.links.dialog.answeredByHint", { name: defaultName })}
                  label={t("qrCode.links.dialog.answeredBy")}
                  onChange={setReceptionistId}
                  receptionists={receptionists}
                  value={chosen}
                />
              </Field>
            ) : null}
            <Field>
              <FieldContent>
                <FieldLabel htmlFor={ids.address}>{t("qrCode.links.dialog.address")}</FieldLabel>
              </FieldContent>
              <Input
                aria-describedby={`${ids.address}-hint`}
                className="font-mono text-muted-foreground"
                dir="ltr"
                id={ids.address}
                readOnly
                value={`${host}/q/${editing ? editing.code : "·".repeat(ENTRY_LINK_CODE_LENGTH)}`}
              />
              <FieldDescription id={`${ids.address}-hint`}>{editing ? t("qrCode.links.dialog.addressHint") : t("qrCode.links.dialog.addressNewHint")}</FieldDescription>
            </Field>
          </FieldGroup>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="outline">{t("qrCode.links.dialog.cancel")}</Button>
            <Button loading={pending} type="submit">{editing ? t("qrCode.links.dialog.save") : t("qrCode.links.dialog.create")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
