"use client";

import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PlanChangeRefusal } from "@lobbystack/shared";

import { Button } from "./ui/button";
import { FieldDescription, FieldError } from "./ui/field";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** Polar's refusals of the email a business's new Polar customer would get. */
export type BillingEmailRefusal = Extract<PlanChangeRefusal, "billing_email_taken" | "billing_email_invalid">;

export function isBillingEmailRefusal(refusal: PlanChangeRefusal | null | undefined): refusal is BillingEmailRefusal {
  return refusal === "billing_email_taken" || refusal === "billing_email_invalid";
}

/**
 * Asks for a billing email when Polar wouldn't make this business's customer
 * with the email it was given: Polar keeps one customer per email, so someone
 * who pays for a second business gives it its own. The checkout then starts
 * again with it. refusedEmail is the billing email Polar refused, or null when
 * it refused the person's own.
 */
export function BillingEmailForm({ refusal, refusedEmail, pending, onSubmit, onCancel }: { refusal: BillingEmailRefusal; refusedEmail: string | null; pending: boolean; onSubmit: (email: string) => void; onCancel: () => void }) {
  const { t } = useTranslation("settings");
  const id = useId();
  const [value, setValue] = useState(refusedEmail ?? "");
  const error = refusedEmail ? t(refusal === "billing_email_taken" ? "billing.billingEmail.taken" : "billing.billingEmail.invalid") : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = value.trim();
    if (email && !pending) onSubmit(email);
  }

  return <form className="flex w-full max-w-xl flex-col gap-2" onSubmit={submit}>
    {refusedEmail ? null : <p className="text-sm text-foreground">{t(`billing.toast.planChangeRefused.${refusal}`)}</p>}
    <Label htmlFor={id}>{t("billing.billingEmail.label")}</Label>
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input aria-describedby={`${id}-note`} aria-invalid={error ? true : undefined} autoComplete="email" disabled={pending} id={id} maxLength={320} onChange={(event) => setValue(event.target.value)} placeholder={t("billing.billingEmail.placeholder")} required type="email" value={value} />
      <div className="flex gap-2">
        <Button disabled={!value.trim()} loading={pending} loadingLabel={t("billing.billingEmail.submit")} size="sm" type="submit">{t("billing.billingEmail.submit")}</Button>
        <Button disabled={pending} onClick={onCancel} size="sm" type="button" variant="ghost">{t("billing.billingEmail.cancel")}</Button>
      </div>
    </div>
    {error ? <FieldError id={`${id}-note`}>{error}</FieldError> : <FieldDescription id={`${id}-note`}>{t("billing.billingEmail.hint")}</FieldDescription>}
  </form>;
}
