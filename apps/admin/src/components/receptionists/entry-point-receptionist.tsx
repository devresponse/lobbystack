"use client";

import { useTranslation } from "react-i18next";

import type { ReceptionistOption } from "./receptionist-choices";
import { ReceptionistSelect } from "./receptionist-select";

// Who answers a phone number, a widget key or a QR link: the dropdown, what
// the choice does, and who answers meanwhile when the receptionist chosen is
// paused or was archived (the default receptionist, as calls and chats are
// routed). With one receptionist it renders nothing: the default answers
// everything.

export function EntryPointReceptionist({ label, hint, receptionists, value, onChange, disabled = false, readOnly = false, size, className }: {
  label: string;
  /** What the choice does, such as "Calls and texts to this number go to the receptionist you pick." */
  hint?: string | undefined;
  receptionists: ReceptionistOption[];
  /** The receptionist the entry point names: null is the default receptionist, and an archived one is missing from the list. */
  value: string | null | undefined;
  /** Called only when the owner picks a receptionist other than the one answering now. */
  onChange: (receptionistId: string) => void;
  disabled?: boolean;
  /** Shows who answers as text, for people who can't change it. */
  readOnly?: boolean;
  size?: "default" | "sm" | undefined;
  className?: string | undefined;
}) {
  const { t } = useTranslation("receptionists");
  if (receptionists.length < 2) return null;
  const defaultReceptionist = receptionists.find((receptionist) => receptionist.isDefault);
  // An entry point that names nobody is answered by the default receptionist.
  const chosen = value ? receptionists.find((receptionist) => receptionist.id === value) : defaultReceptionist;
  // A receptionist the business no longer lists was archived; its calls and chats go to the default one.
  const archived = Boolean(value) && !chosen;
  const note = chosen?.status === "paused" && defaultReceptionist && !chosen.isDefault
    ? t("entry.paused", { name: chosen.name, default: defaultReceptionist.name })
    : archived && defaultReceptionist
      ? t("entry.archived", { default: defaultReceptionist.name })
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {readOnly ? (
        <p className="text-sm">
          <span className="text-muted-foreground">{label}: </span>
          {chosen?.name ?? defaultReceptionist?.name}
        </p>
      ) : (
        <ReceptionistSelect
          className={className}
          disabled={disabled}
          label={label}
          onChange={(receptionistId) => { if (receptionistId && receptionistId !== chosen?.id) onChange(receptionistId); }}
          receptionists={receptionists}
          size={size}
          value={chosen ? chosen.id : null}
        />
      )}
      {note ? <p className="text-xs text-amber-700 dark:text-amber-400" role="status">{note}</p> : null}
      {hint && !readOnly ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
