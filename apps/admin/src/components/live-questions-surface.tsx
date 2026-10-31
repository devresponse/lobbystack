"use client";

import { useTranslation } from "react-i18next";

import { useActiveBusiness } from "@/hooks/use-active-business";
import { PageSurface } from "./page-surface";
import { UnansweredQuestionsSection } from "./unanswered-questions-section";

/** The Questions page: what the receptionist couldn't answer, for owners and admins to answer or dismiss. */
export function LiveQuestionsSurface() {
  const { t } = useTranslation("agent");
  const { businesses, business } = useActiveBusiness();
  const canManage = business ? ["business_owner", "business_admin"].includes(business.role) : false;

  if (businesses.isLoading) return <p className="text-sm text-muted-foreground">{t("loading.workspace")}</p>;
  if (!business) return <PageSurface title={t("sections.questions.title")}><p className="text-sm text-muted-foreground">{t("empty.description")}</p></PageSurface>;
  return <PageSurface title={t("sections.questions.title")}><UnansweredQuestionsSection businessId={business.businessId} canManage={canManage} /></PageSurface>;
}
