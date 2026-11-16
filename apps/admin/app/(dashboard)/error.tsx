"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { captureBrowserError } from "@/lib/browser-error-reporting";

/**
 * The dashboard's own boundary (AUDIT-019). Next renders it inside
 * `(dashboard)/layout.tsx`, so a screen that fails to render leaves the
 * navigation in place and the operator can go somewhere else. The root
 * `app/error.tsx` sits above that layout and replaces everything, which is
 * right for a failure in the shell itself and wrong for one screen.
 */
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { t } = useTranslation("common");
  useEffect(() => { captureBrowserError(error); }, [error]);
  return (
    <main className="flex flex-col items-start gap-3 p-8" role="alert">
      <h1 className="type-section-title">{t("errorBoundary.screenTitle")}</h1>
      <p className="type-body-muted max-w-prose">{t("errorBoundary.screenDescription")}</p>
      <Button onClick={retry}>{t("errorBoundary.retry")}</Button>
      {error.digest ? <p className="type-body-muted">{t("errorBoundary.reference", { digest: error.digest })}</p> : null}
    </main>
  );
}
