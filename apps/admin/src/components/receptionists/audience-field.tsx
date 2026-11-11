"use client";

import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { ReceptionistOption } from "./receptionist-choices";
import { ReceptionistMultiSelect } from "./receptionist-multi-select";

// Who an article is for, wherever one is written: everyone, which stays the
// default, or the receptionists chosen in the multiselect box. Files, website
// pages and text entries all use it. With one receptionist there is nothing
// to choose, so it renders nothing and every article stays for everyone.

/** Who an article is for, as the field edits it; chosen keeps the ids even while empty, so switching back keeps them. */
export type AudienceValue = { audience: "everyone" | "chosen"; receptionistIds: string[] };

/** Who an article is for, as a save sends it. */
export type AudienceChoice = { audience: "everyone" } | { audience: "chosen"; receptionistIds: string[] };

export const EVERYONE: AudienceValue = { audience: "everyone", receptionistIds: [] };

/**
 * What the field starts from for an article: who it is for now, keeping only
 * the receptionists the business lists (archived ones answer nothing, so
 * saving drops them).
 */
export function audienceValueOf(audience: string | null | undefined, receptionistIds: readonly string[], receptionists: readonly ReceptionistOption[]): AudienceValue {
  if (audience !== "chosen") return EVERYONE;
  return { audience: "chosen", receptionistIds: receptionistIds.filter((id) => receptionists.some((receptionist) => receptionist.id === id)) };
}

/** The choice to save, or null while chosen names no receptionist the business lists. */
export function audienceChoiceOf(value: AudienceValue, receptionists: readonly ReceptionistOption[]): AudienceChoice | null {
  if (value.audience === "everyone") return { audience: "everyone" };
  const receptionistIds = value.receptionistIds.filter((id) => receptionists.some((receptionist) => receptionist.id === id));
  return receptionistIds.length ? { audience: "chosen", receptionistIds } : null;
}

/**
 * Segmented choices that are radio buttons underneath: one tab stop, arrow
 * keys move between them, and each reads as a radio with its label.
 */
export function SegmentedChoice<T extends string>({ label, hideLabel = false, value, options, onChange, disabled = false, className }: {
  label: string;
  hideLabel?: boolean;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-1.5", className)} disabled={disabled}>
      <legend className={hideLabel ? "sr-only" : "mb-1.5 text-sm font-medium"}>{label}</legend>
      <div className="inline-flex w-full rounded-lg bg-muted p-0.5 sm:w-auto">
        {options.map((option) => (
          <label
            className={cn(
              "relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 sm:flex-none",
              value === option.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-60",
            )}
            key={option.value}
          >
            <input checked={value === option.value} className="sr-only" name={id} onChange={() => onChange(option.value)} type="radio" value={option.value} />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The Available to field: Everyone or Chosen receptionists, then the
 * multiselect box. It says how many are chosen, and that articles for chosen
 * receptionists stay out of the business summary.
 */
export function AudienceField({ value, onChange, receptionists, invalid = false, disabled = false, note }: {
  value: AudienceValue;
  onChange: (value: AudienceValue) => void;
  receptionists: ReceptionistOption[];
  /** Chosen with no receptionist, after a save was tried. */
  invalid?: boolean;
  disabled?: boolean;
  /** A line about this article, such as the website rule that chose it. */
  note?: ReactNode;
}) {
  const { t } = useTranslation("receptionists");
  const id = useId();
  if (receptionists.length < 2) return null;
  const chosen = receptionists.filter((receptionist) => value.receptionistIds.includes(receptionist.id)).length;
  const defaultReceptionist = receptionists.find((receptionist) => receptionist.isDefault);
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-2" data-invalid={invalid || undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium" id={`${id}-label`}>{t("audience.label")}</span>
        {value.audience === "chosen" ? <span className="text-xs tabular-nums text-muted-foreground">{t("audience.chosenOf", { count: chosen, total: receptionists.length })}</span> : null}
      </div>
      <SegmentedChoice
        disabled={disabled}
        hideLabel
        label={t("audience.label")}
        onChange={(audience) => onChange({ ...value, audience })}
        options={[{ value: "everyone", label: t("audience.everyone") }, { value: "chosen", label: t("audience.chosen") }]}
        value={value.audience}
      />
      {value.audience === "chosen" ? (
        <ReceptionistMultiSelect
          className="w-full"
          describedBy={invalid ? errorId : undefined}
          disabled={disabled}
          hideLabel
          invalid={invalid}
          label={t("audience.receptionists")}
          onChange={(receptionistIds) => onChange({ audience: "chosen", receptionistIds })}
          receptionists={receptionists}
          value={value.receptionistIds}
        />
      ) : null}
      {invalid ? <p className="text-sm text-destructive" id={errorId} role="alert">{t("audience.required")}</p> : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <p className="text-xs text-muted-foreground">
        {defaultReceptionist?.knowledgeScope === "all" ? t("audience.hintAll", { name: defaultReceptionist.name }) : t("audience.hint")}
      </p>
    </div>
  );
}
