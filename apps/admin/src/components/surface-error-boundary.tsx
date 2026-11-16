"use client";

import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { captureBrowserError } from "@/lib/browser-error-reporting";

/**
 * One panel's own boundary, for a screen built from parts that don't depend on
 * each other (AUDIT-019): a chart that can't draw leaves the rest of the screen
 * alone instead of taking the whole route to `(dashboard)/error.tsx`. A page
 * that *is* one surface needs no wrapper; the route boundary already says the
 * same thing in the same place.
 */
export class SurfaceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    captureBrowserError(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <SurfaceErrorMessage onRetry={() => { this.setState({ failed: false }); }} />;
  }
}

function SurfaceErrorMessage({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-6" role="alert">
      <p className="type-empty-title">{t("errorBoundary.partTitle")}</p>
      <p className="type-empty-description">{t("errorBoundary.partDescription")}</p>
      <Button onClick={onRetry} size="sm" variant="outline">{t("errorBoundary.retry")}</Button>
    </div>
  );
}
