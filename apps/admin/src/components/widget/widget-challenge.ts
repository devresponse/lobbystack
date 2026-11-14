"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadTurnstileScript } from "@/components/turnstile";

/**
 * Where the chat's check stands: not needed on this deployment, running,
 * waiting for the visitor to tick Turnstile's box, passed, or failed.
 */
export type WidgetChallengeState = "off" | "checking" | "interactive" | "passed" | "failed";

/** A session that passed the check, and when it ends by this page's clock. */
type CheckedSession = { token: string; expiresAtMs: number };

// A check that neither passes nor asks the visitor anything by then has stalled.
const TOKEN_TIMEOUT_MS = 30_000;
// A checked session this close to its end goes for a new check first.
const RENEW_MARGIN_MS = 60_000;

/** Between half and all of `ms`, at random, so chats that failed together don't all try again together. */
function jittered(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * The website chat's Turnstile check (AUDIT-004). With a site key, Turnstile
 * runs in the chat's own frame, on the deployment's address, invisibly unless
 * Cloudflare wants the visitor to tick a box. Its token goes with the
 * loader's session to /api/widget/session/verify, which signs the session as
 * checked, and the chat sends its messages with that one. Each new session
 * from the loader gets its own check, which starts as soon as it arrives, so
 * it has usually passed by the time the visitor sends a message. Without a
 * site key it does nothing, and messages go with the loader's session.
 */
export function useWidgetChallenge(input: {
  siteKey: string | null | undefined;
  sessionToken: string | null;
  parentOrigin: string | null;
  /** The server turned the loader's session down, so the loader should get a new one. */
  onSessionRejected: () => void;
}): {
  /** Where Turnstile draws its box, when it needs the visitor. */
  containerRef: (element: HTMLDivElement | null) => void;
  state: WidgetChallengeState;
  /** The session to send a message with once the check has passed, or null when it couldn't pass. */
  ensure: () => Promise<string | null>;
} {
  const { siteKey, sessionToken, parentOrigin } = input;
  const [state, setState] = useState<WidgetChallengeState>(siteKey ? "checking" : "off");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const executedRef = useRef(false);
  const pendingTokenRef = useRef<{ resolve: (token: string) => void; reject: (error: Error) => void; timer: number | undefined } | null>(null);
  const checkedRef = useRef<CheckedSession | null>(null);
  // The check under way, and the loader's session it's for.
  const runRef = useRef<{ forSession: string; promise: Promise<string | null> } | null>(null);
  const latestRef = useRef({ sessionToken, parentOrigin, onSessionRejected: input.onSessionRejected });
  latestRef.current = { sessionToken, parentOrigin, onSessionRejected: input.onSessionRejected };

  const settleToken = useCallback((outcome: { token: string } | { error: Error }) => {
    const pending = pendingTokenRef.current;
    if (!pending) return;
    pendingTokenRef.current = null;
    window.clearTimeout(pending.timer);
    if ("token" in outcome) pending.resolve(outcome.token);
    else pending.reject(outcome.error);
  }, []);

  /** Draws Turnstile's box once the script is in; it runs only when asked for a token. */
  const renderWidget = useCallback(async (): Promise<boolean> => {
    if (!siteKey) return false;
    if (widgetIdRef.current) return true;
    await loadTurnstileScript();
    const turnstile = window.turnstile;
    const container = containerRef.current;
    if (!turnstile || !container) return false;
    if (widgetIdRef.current) return true;
    widgetIdRef.current = turnstile.render(container, {
      sitekey: siteKey,
      action: "widget_chat",
      appearance: "interaction-only",
      execution: "execute",
      "refresh-expired": "never",
      retry: "never",
      "response-field": false,
      size: "flexible",
      theme: "light",
      callback: (token) => settleToken({ token }),
      "error-callback": (errorCode) => {
        settleToken({ error: new Error(`Turnstile failed: ${errorCode ?? "unknown"}`) });
        return true;
      },
      "timeout-callback": () => settleToken({ error: new Error("Turnstile timed out.") }),
      // Every token is used at once, so one that ages out only needs the next check.
      "expired-callback": () => undefined,
      "before-interactive-callback": () => {
        const pending = pendingTokenRef.current;
        // The visitor takes their time with the box: only Turnstile's own timeout applies.
        if (pending) window.clearTimeout(pending.timer);
        setState("interactive");
      },
      "after-interactive-callback": () => setState("checking"),
    });
    return true;
  }, [settleToken, siteKey]);

  /** A new token from Turnstile, which each check uses once. */
  const requestToken = useCallback(async (): Promise<string> => {
    if (!(await renderWidget()) || !widgetIdRef.current) throw new Error("Turnstile could not load.");
    const turnstile = window.turnstile!;
    settleToken({ error: new Error("Superseded.") });
    const token = new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => settleToken({ error: new Error("Turnstile stalled.") }), TOKEN_TIMEOUT_MS);
      pendingTokenRef.current = { resolve, reject, timer };
    });
    try {
      // A widget that ran before starts over.
      if (executedRef.current) turnstile.reset(widgetIdRef.current);
      executedRef.current = true;
      turnstile.execute(containerRef.current!);
    } catch (error) {
      // Turnstile refused to run, as for a box that left the page: this try fails, the next starts over.
      settleToken({ error: error instanceof Error ? error : new Error("Turnstile could not run.") });
    }
    return await token;
  }, [renderWidget, settleToken]);

  /** Checks the loader's session: Turnstile, then the server. A few tries through passing trouble. */
  const check = useCallback(async (forSession: string): Promise<string | null> => {
    setState("checking");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await wait(jittered(1_000 * 2 ** attempt));
      // A newer session from the loader replaced this one: its own check takes over.
      if (latestRef.current.sessionToken !== forSession) return null;
      let turnstileToken: string;
      try {
        turnstileToken = await requestToken();
      } catch {
        continue;
      }
      let response: Response;
      try {
        response = await fetch(new URL("/api/widget/session/verify", window.location.origin), {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json", authorization: `Bearer ${forSession}`, "x-widget-parent-origin": latestRef.current.parentOrigin ?? "" },
          body: JSON.stringify({ turnstileToken }),
        });
      } catch {
        continue;
      }
      if (response.ok) {
        const payload = await response.json().catch(() => null) as { token?: unknown; expiresIn?: unknown } | null;
        if (typeof payload?.token !== "string") continue;
        const lifetimeMs = typeof payload.expiresIn === "number" && payload.expiresIn > 0 ? payload.expiresIn * 1_000 : 3_600_000;
        checkedRef.current = { token: payload.token, expiresAtMs: Date.now() + lifetimeMs };
        setState("passed");
        return payload.token;
      }
      // The session itself is gone, as after a slow clock let it lapse: the loader gets a new one, which brings its own check.
      if (response.status === 401) {
        latestRef.current.onSessionRejected();
        break;
      }
      // Turnstile's token didn't pass, or Cloudflare or the server had trouble: a new token may do.
      // Anything else is a refusal for good, such as a website taken off the key's list.
      const code = response.status === 403 ? (await response.json().catch(() => null) as { code?: unknown } | null)?.code : undefined;
      if (!(code === "widget_challenge_failed" || response.status === 429 || response.status >= 500)) break;
    }
    setState("failed");
    return null;
  }, [requestToken]);

  const start = useCallback((forSession: string): Promise<string | null> => {
    if (runRef.current?.forSession === forSession) return runRef.current.promise;
    const promise = check(forSession).finally(() => {
      if (runRef.current?.promise === promise) runRef.current = null;
    });
    runRef.current = { forSession, promise };
    return promise;
  }, [check]);

  // Each session the loader sends gets its check at once, while the visitor reads and types.
  useEffect(() => {
    if (!siteKey || !sessionToken || !parentOrigin) return;
    void start(sessionToken);
  }, [parentOrigin, sessionToken, siteKey, start]);

  useEffect(() => () => {
    settleToken({ error: new Error("The chat closed.") });
    if (widgetIdRef.current) window.turnstile?.remove(widgetIdRef.current);
    widgetIdRef.current = null;
    executedRef.current = false;
  }, [settleToken]);

  const ensure = useCallback(async (): Promise<string | null> => {
    const current = latestRef.current.sessionToken;
    if (!siteKey) return current;
    if (!current) return null;
    const checked = checkedRef.current;
    // A checked session from before the loader's last renewal still works until it ends.
    if (checked && checked.expiresAtMs - Date.now() > RENEW_MARGIN_MS) return checked.token;
    return await start(current);
  }, [siteKey, start]);

  const attach = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
  }, []);

  return { containerRef: attach, state, ensure };
}
