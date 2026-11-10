"use client";

import { useTranslation } from "react-i18next";

import type { ReceptionistOption } from "./receptionist-choices";

const NAMES_SHOWN = 2;

/**
 * Who something is for, in a table cell: "Everyone", or up to 2 names and
 * "+N". Receptionists the business doesn't list any more (archived ones) are
 * left out: they answer nothing. With none left, the default receptionist
 * answers from it, and the cell says so.
 */
export function ReceptionistNames({ everyone, receptionistIds, receptionists, className }: { everyone: boolean; receptionistIds: readonly string[]; receptionists: ReceptionistOption[]; className?: string }) {
  const { t } = useTranslation("receptionists");
  if (everyone) return <span className={className}>{t("names.everyone")}</span>;
  const named = receptionists.filter((receptionist) => receptionistIds.includes(receptionist.id));
  if (!named.length) return <span className={className}>{t("names.defaultOnly")}</span>;
  const shown = named.slice(0, NAMES_SHOWN).map((receptionist) => receptionist.name).join(", ");
  const more = named.length - NAMES_SHOWN;
  return (
    <span className={className} title={more > 0 ? named.map((receptionist) => receptionist.name).join(", ") : undefined}>
      {shown}{more > 0 ? <span className="text-muted-foreground"> {t("names.more", { count: more })}</span> : null}
    </span>
  );
}
