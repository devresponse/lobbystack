"use client";

import { useTranslation } from "react-i18next";

import { useReceptionistChoices, useReceptionistFilter } from "./receptionist-choices";
import { ReceptionistSelect } from "./receptionist-select";

/**
 * The receptionist filter on Knowledge, Questions, Calls, Messages and QR
 * links: "All receptionists" first, kept in the address as ?receptionist=<id>.
 * Hidden while the business has one receptionist, unless the address names
 * one, so a filter that applies can always be cleared.
 */
export function ReceptionistFilter({ businessId, className }: { businessId: string | undefined; className?: string }) {
  const { t } = useTranslation("receptionists");
  const { receptionists } = useReceptionistChoices(businessId);
  const [receptionistId, setReceptionistId] = useReceptionistFilter();
  return (
    <ReceptionistSelect
      label={t("filter.label")}
      hideLabel
      receptionists={receptionists}
      value={receptionistId}
      onChange={setReceptionistId}
      allLabel={t("filter.all")}
      alwaysShow={receptionistId !== null && receptionists.length > 0}
      className={className}
    />
  );
}
