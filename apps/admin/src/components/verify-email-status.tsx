"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";
import { AuthShell, brandLink } from "./auth-shell";
import { resolveLocale } from "@/lib/locale";
import { localizePublicPath } from "@/lib/locale-path";

export function VerifyEmailStatus() {
  const { t, i18n } = useTranslation("auth");
  const loginPath = localizePublicPath("/login", resolveLocale(i18n.resolvedLanguage, i18n.language));
  return <AuthShell title={t("verifyEmail.invalidTitle")} description={t("verifyEmail.missingToken")}>
    <p className="text-sm"><Link className={brandLink} href={loginPath}>{t("verifyEmail.backToLogin")}</Link></p>
  </AuthShell>;
}
