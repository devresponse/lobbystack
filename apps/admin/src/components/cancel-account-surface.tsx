"use client";

import { readPublicAuthSession } from "@/lib/public-auth-session";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { ReplacementOnboardingShell } from "./replacement-onboarding-shell";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { useSignOut } from "@/hooks/use-sign-out";
import { buildAuthPathWithReturnTo } from "@/lib/auth-return-to";
import { resolveLocale } from "@/lib/locale";
import { localizePublicPath } from "@/lib/locale-path";

type Cancellation = { businessName: string; email: string; expiresAt: string; state: "pending" | "expired" | "replaced" | "canceled" };

// The refusals the page explains; any other failure says it couldn't cancel.
const confirmErrors = new Set(["invalid_password", "other_businesses", "forbidden", "number_in_progress", "call_in_progress", "checkout_open", "expired", "replaced", "already_canceled", "invalid_link", "rate_limited"]);

/**
 * Where an owner's cancellation email leads (/cancel-account?token=). It asks
 * them to sign in as the owner who asked, then for their password, and
 * cancels the business. Nothing is deleted. The business is closed to them
 * too from then on, so they start again with a new business, through
 * onboarding.
 */
export function CancelAccountSurface() {
  const { t, i18n } = useTranslation("auth");
  const locale = resolveLocale(i18n.resolvedLanguage, i18n.language);
  const router = useRouter();
  const [token, setToken] = useState("");
  const [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [canceledName, setCanceledName] = useState<string | null>(null);
  const signOut = useSignOut();

  useEffect(() => {
    const nextToken = new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
    setToken(nextToken);
    const sessionController = new AbortController();
    void readPublicAuthSession(sessionController.signal).then((session) => setIsAuthenticated(Boolean(session?.user))).catch(() => undefined);
    if (!nextToken) {
      setIsPreviewLoading(false);
      return () => sessionController.abort();
    }
    void fetch(`/api/businesses/cancellation?token=${encodeURIComponent(nextToken)}`)
      .then(async (response) => response.ok ? await response.json() as { cancellation: Cancellation | null } : { cancellation: null })
      .then((result) => setCancellation(result.cancellation))
      .catch(() => setCancellation(null))
      .finally(() => setIsPreviewLoading(false));
    return () => sessionController.abort();
  }, []);

  const returnPath = `${localizePublicPath("/cancel-account", locale)}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const loginHref = buildAuthPathWithReturnTo("/login", returnPath, locale);
  const isPending = cancellation?.state === "pending";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !isAuthenticated || !password || isSubmitting) return;
    setIsSubmitting(true);
    setErrorCode(null);
    try {
      const response = await fetch("/api/businesses/cancellation/confirm", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });
      const body = await response.json().catch(() => ({})) as { code?: string; businessName?: string };
      if (!response.ok) {
        setErrorCode(body.code ?? "failed");
        if (body.code === "invalid_password") setPassword("");
        setIsSubmitting(false);
        return;
      }
      setCanceledName(body.businessName ?? cancellation?.businessName ?? "");
    } catch {
      setErrorCode("failed");
      setIsSubmitting(false);
    }
  }

  // Closed to them now, the dashboard has no business to open, so it starts onboarding.
  function startOver() {
    router.replace("/");
    router.refresh();
  }

  if (canceledName !== null) {
    return <div className="ph-no-capture"><ReplacementOnboardingShell description={t("cancelAccount.canceledDescription", { businessName: canceledName })} progress={null} title={t("cancelAccount.canceledTitle")} width="sm"><div className="flex flex-col gap-6">
      <Button className="h-11 w-full" onClick={startOver}>{t("cancelAccount.startOver")}</Button>
    </div></ReplacementOnboardingShell></div>;
  }

  const wrongAccount = errorCode === "wrong_account";
  let description = t("cancelAccount.invalidLink");
  if (isPreviewLoading) description = t("cancelAccount.loading");
  else if (wrongAccount) description = t("cancelAccount.wrongAccount", { email: cancellation?.email ?? "" });
  else if (cancellation?.state === "expired") description = t("cancelAccount.expired");
  else if (cancellation?.state === "replaced") description = t("cancelAccount.replaced");
  else if (cancellation?.state === "canceled") description = t("cancelAccount.alreadyCanceled", { businessName: cancellation.businessName });
  else if (isPending) description = t(isAuthenticated ? "cancelAccount.confirmPrompt" : "cancelAccount.signInPrompt", { businessName: cancellation!.businessName, email: cancellation!.email });

  return <div className="ph-no-capture"><ReplacementOnboardingShell description={description} progress={null} title={t("cancelAccount.title")} width="sm"><div className="flex flex-col gap-6">
    {isPending && wrongAccount ? <Button className="h-11 w-full" onClick={() => void signOut(loginHref)}>{t("cancelAccount.switchAccount")}</Button> : null}
    {isPending && !wrongAccount && !isAuthenticated ? <Button className="h-11 w-full" role="link" nativeButton={false} render={<Link href={loginHref} />}>{t("cancelAccount.signIn")}</Button> : null}
    {isPending && !wrongAccount && isAuthenticated ? <form className="flex flex-col gap-6" onSubmit={submit}>
      <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" data-testid="cancel-account-effects">{t("cancelAccount.effects")}</p>
      <FieldGroup><Field><FieldLabel htmlFor="cancel-account-password">{t("cancelAccount.passwordLabel")}</FieldLabel><Input autoComplete="current-password" className="h-11" id="cancel-account-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Field></FieldGroup>
      {errorCode ? <p className="text-center text-sm text-destructive" role="alert">{t(`cancelAccount.errors.${confirmErrors.has(errorCode) ? errorCode : "failed"}`)}</p> : null}
      <Button className="h-11 w-full" disabled={!password || isSubmitting} loading={isSubmitting} loadingLabel={t("cancelAccount.submitting")} type="submit" variant="destructive">{t("cancelAccount.submit")}</Button>
    </form> : null}
    <p className="text-center text-sm"><Link className="font-medium text-foreground underline-offset-4 hover:underline" href={isAuthenticated ? "/" : localizePublicPath("/login", locale)}>{isAuthenticated ? t(isPending ? "cancelAccount.keep" : "cancelAccount.backToDashboard") : t("cancelAccount.backToLogin")}</Link></p>
  </div></ReplacementOnboardingShell></div>;
}
