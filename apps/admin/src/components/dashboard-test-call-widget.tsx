"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Phone } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useReceptionistChoices } from "@/components/receptionists/receptionist-choices";
import { ReceptionistSelect } from "@/components/receptionists/receptionist-select";
import { AuraVoiceDemo } from "@/components/web-voice/AuraVoiceDemo";
import { LIVE_WEB_CALL_ENDPOINT } from "@lobbystack/web-voice";
import { announceTestCallEnded, registerTestCallStarter, setTestCallActive } from "@/lib/test-call-launcher";
import { useTelemetry } from "@/components/product-analytics";
import type { TelemetryEventName, TelemetryProperties } from "@lobbystack/telemetry";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";

type TestCallWidgetProps = {
  businessId?: string;
  businessSlug?: string;
  className?: string;
  /** The signed-in member's role in the business: owners and admins make test calls. */
  role?: string;
};

type WebVoiceControls = {
  forceEndCall: () => Promise<void>;
  startCall: () => Promise<void>;
};

/**
 * Who answers a test call: the receptionist chosen in the dropdown beside the
 * button, the default one until then. Only active receptionists are offered:
 * a paused one answers nothing, so its test call would reach the default one.
 * The choice belongs to the business it was made for, and gives way to the
 * default receptionist when the one chosen is paused or archived meanwhile.
 */
function useTestCallReceptionist(businessId: string | undefined) {
  const { receptionists } = useReceptionistChoices(businessId);
  const options = useMemo(() => receptionists.filter((receptionist) => receptionist.status === "active"), [receptionists]);
  const [choice, setChoice] = useState<{ businessId: string | undefined; receptionistId: string } | null>(null);
  const chosen = choice && choice.businessId === businessId ? options.find((receptionist) => receptionist.id === choice.receptionistId && !receptionist.isDefault) : undefined;
  const receptionistId = chosen?.id ?? null;
  // Read when a call starts, which can come from another page's "Make a test call" too.
  const startingWith = useRef<string | null>(receptionistId);
  useEffect(() => {
    startingWith.current = receptionistId;
  }, [receptionistId]);
  const startPayload = useCallback((): Record<string, string> => (startingWith.current ? { receptionistId: startingWith.current } : {}), []);
  const choose = useCallback((next: string | null) => setChoice(next ? { businessId, receptionistId: next } : null), [businessId]);
  return {
    options,
    value: receptionistId ?? options.find((receptionist) => receptionist.isDefault)?.id ?? null,
    /** The receptionist chosen, null for the default one. */
    chosenId: receptionistId,
    choose,
    /** What the call's start request adds: the receptionist chosen to answer. */
    startPayload,
  };
}

/** What POST /api/test-call/greeting answers about the opening's recording. */
type GreetingStatus = "ready" | "recording" | "missing" | "failed" | "off";

// A call that starts while its greeting is being recorded waits this long at
// most, asking again every GREETING_POLL_MS, then opens without the recording.
// Recording one takes GPT-Live several seconds.
export const GREETING_WAIT_MS = 15_000;
const GREETING_POLL_MS = 1_000;

/** Undefined when the answer doesn't come, and the call then starts at once. */
async function askForGreeting(businessId: string, receptionistId: string | null, signal?: AbortSignal): Promise<GreetingStatus | undefined> {
  try {
    const { status } = await requestJson<{ status?: GreetingStatus }>(`/api/test-call/greeting?businessId=${encodeURIComponent(businessId)}`, {
      method: "POST",
      body: JSON.stringify(receptionistId ? { receptionistId } : {}),
      ...(signal ? { signal } : {}),
    });
    return status;
  } catch {
    return undefined;
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Asks for the greeting's recording, and again while it's being recorded,
 * for GREETING_WAIT_MS at most, a slow answer included. Never throws.
 */
async function waitWhileRecording(businessId: string, receptionistId: string | null, signal: AbortSignal): Promise<void> {
  const wait = new AbortController();
  const stop = () => wait.abort();
  const timer = setTimeout(stop, GREETING_WAIT_MS);
  signal.addEventListener("abort", stop, { once: true });
  try {
    let status = await askForGreeting(businessId, receptionistId, wait.signal);
    while (status === "recording" && !wait.signal.aborted) {
      await pause(GREETING_POLL_MS, wait.signal);
      if (wait.signal.aborted) break;
      status = await askForGreeting(businessId, receptionistId, wait.signal);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Gets the test call's greeting recorded before the call starts. GPT-Live
 * skips its spoken greeting on about one browser call in three, and a call
 * opens with the recording only once the worker has made one
 * (docs/voice/runtime.md). So the dashboard asks for the recording as it
 * opens and when the receptionist changes, which has the worker record a
 * missing one, and a call that starts while it's being recorded waits for
 * it, at most GREETING_WAIT_MS, showing "Connecting".
 */
function useTestCallGreeting(businessId: string | undefined, receptionistId: string | null, enabled: boolean) {
  const latest = useRef({ businessId, receptionistId, enabled });
  useEffect(() => {
    latest.current = { businessId, receptionistId, enabled };
  }, [businessId, enabled, receptionistId]);
  const pending = useRef<{ businessId: string; receptionistId: string | null; controller: AbortController; done: Promise<void> } | null>(null);

  useEffect(() => {
    if (enabled && businessId) void askForGreeting(businessId, receptionistId);
  }, [businessId, enabled, receptionistId]);

  const cancel = useCallback(() => {
    pending.current?.controller.abort();
    pending.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const check = useCallback((forReceptionist: string | null): Promise<void> => {
    cancel();
    const { businessId: business, enabled: on } = latest.current;
    if (!on || !business) return Promise.resolve();
    const controller = new AbortController();
    const done = waitWhileRecording(business, forReceptionist, controller.signal);
    pending.current = { businessId: business, receptionistId: forReceptionist, controller, done };
    return done;
  }, [cancel]);

  // As the call starts, beside the microphone and the connection, so a ready greeting adds no wait.
  const prepare = useCallback(() => {
    void check(latest.current.receptionistId);
  }, [check]);
  // Before the call's request, with the check prepare started, or a new one for a call started from the orb.
  const ready = useCallback(async (forReceptionist: string | null) => {
    const started = pending.current;
    const done = started && started.businessId === latest.current.businessId && started.receptionistId === forReceptionist ? started.done : check(forReceptionist);
    await done;
    if (pending.current?.done === done) pending.current = null;
  }, [check]);
  return { prepare, ready, cancel };
}

export function DashboardTestCallWidget({
  businessId,
  businessSlug,
  className,
  role,
}: TestCallWidgetProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const voiceControlsRef = useRef<WebVoiceControls | null>(null);
  const receptionist = useTestCallReceptionist(businessId);
  const { startPayload } = receptionist;
  const { prepare: prepareGreeting, ready: greetingReady, cancel: stopGreetingWait } = useTestCallGreeting(
    businessId,
    receptionist.chosenId,
    Boolean(businessSlug && role && ["business_owner", "business_admin"].includes(role)),
  );
  const getStartPayload = useCallback(async () => {
    const payload = startPayload();
    await greetingReady(payload.receptionistId ?? null);
    return payload;
  }, [greetingReady, startPayload]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      stopGreetingWait();
      void voiceControlsRef.current?.forceEndCall();
      setTestCallActive(false);
    }
    setOpen(nextOpen);
  };

  const handleTestCallClick = useCallback(() => {
    setOpen(true);
    setTestCallActive(true);
    prepareGreeting();
    void Promise.resolve(voiceControlsRef.current?.startCall()).catch(() => setTestCallActive(false));
  }, [prepareGreeting]);

  // The flag lives in a module, so it outlives this widget: leaving the
  // dashboard mid-call must not keep every other surface waiting on a call
  // that no longer exists.
  useEffect(() => () => setTestCallActive(false), []);

  useEffect(() => {
    if (!businessSlug) return;
    return registerTestCallStarter(handleTestCallClick);
  }, [businessSlug, handleTestCallClick]);

  if (!businessSlug) {
    return null;
  }

  return (
    <div className={cn("hidden items-center gap-1.5 md:flex", className)}>
      {/* Hidden while the business has one active receptionist. */}
      <ReceptionistSelect
        align="end"
        className="w-44"
        hideLabel
        label={t("testCall.receptionist")}
        onChange={receptionist.choose}
        receptionists={receptionist.options}
        size="sm"
        value={receptionist.value}
      />
      <Button
        aria-label={t("testCall.trigger")}
        onClick={handleTestCallClick}
        size="sm"
        type="button"
        variant="outline"
      >
        <Phone className="text-sidebar-foreground" />
        <span className="text-sidebar-foreground">{t("testCall.trigger")}</span>
      </Button>

      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogContent
          className="border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-[34rem]"
          overlayClassName="bg-black/60 backdrop-blur-lg"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("testCall.title")}</DialogTitle>
            <DialogDescription>{t("testCall.description")}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <TestCallAuraPortal open={open}>
        <TestCallAura
          businessId={businessId}
          businessSlug={businessSlug}
          getStartPayload={getStartPayload}
          onCallEnded={() => { stopGreetingWait(); setOpen(false); setTestCallActive(false); announceTestCallEnded(); }}
          onRegisterControls={(controls) => {
            voiceControlsRef.current = controls;
          }}
        />
      </TestCallAuraPortal>
    </div>
  );
}

function TestCallAuraPortal({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      aria-hidden={!open}
      className={cn(
        "pointer-events-none fixed inset-0 z-[70] flex items-center justify-center transition-opacity duration-100",
        open ? "opacity-100" : "invisible opacity-0",
      )}
    >
      <div className="pointer-events-auto w-full max-w-[22rem] md:max-w-[30rem]">
        {children}
      </div>
    </div>,
    document.body,
  );
}

type TestCallAuraProps = {
  businessId?: string | undefined;
  businessSlug: string;
  /** What the call's start request adds, the receptionist chosen to answer, once its greeting is ready. */
  getStartPayload: () => Promise<Record<string, string>>;
  onCallEnded: () => void;
  onRegisterControls: (controls: WebVoiceControls) => void;
};

function TestCallAura({
  businessId,
  businessSlug,
  getStartPayload,
  onCallEnded,
  onRegisterControls,
}: TestCallAuraProps) {
  const telemetry = useTelemetry();
  const handleVoiceEvent = useCallback((eventName: TelemetryEventName, properties?: Record<string, unknown>) => {
    if (!businessId) return;
    telemetry.track(eventName, { businessId, ...properties } as TelemetryProperties);
  }, [businessId, telemetry]);

  return (
    <AuraVoiceDemo
      auraTone="dark"
      businessSlug={businessSlug}
      className="w-full"
      // The operator's login authorizes the call; the ID picks the workspace.
      endpoint={businessId ? `${LIVE_WEB_CALL_ENDPOINT}?businessId=${encodeURIComponent(businessId)}` : LIVE_WEB_CALL_ENDPOINT}
      getStartPayload={getStartPayload}
      onCallEnded={onCallEnded}
      onEvent={handleVoiceEvent}
      onRegisterControls={onRegisterControls}
      widgetId="lobbystack-dashboard-test-call"
    />
  );
}
