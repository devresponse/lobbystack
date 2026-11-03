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
import { cn } from "@/lib/utils";

type TestCallWidgetProps = {
  businessId?: string;
  businessSlug?: string;
  className?: string;
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
  const getStartPayload = useCallback(async (): Promise<Record<string, string>> => (startingWith.current ? { receptionistId: startingWith.current } : {}), []);
  const choose = useCallback((next: string | null) => setChoice(next ? { businessId, receptionistId: next } : null), [businessId]);
  return {
    options,
    value: receptionistId ?? options.find((receptionist) => receptionist.isDefault)?.id ?? null,
    choose,
    getStartPayload,
  };
}

export function DashboardTestCallWidget({
  businessId,
  businessSlug,
  className,
}: TestCallWidgetProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const voiceControlsRef = useRef<WebVoiceControls | null>(null);
  const receptionist = useTestCallReceptionist(businessId);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      void voiceControlsRef.current?.forceEndCall();
      setTestCallActive(false);
    }
    setOpen(nextOpen);
  };

  const handleTestCallClick = useCallback(() => {
    setOpen(true);
    setTestCallActive(true);
    void Promise.resolve(voiceControlsRef.current?.startCall()).catch(() => setTestCallActive(false));
  }, []);

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
          getStartPayload={receptionist.getStartPayload}
          onCallEnded={() => { setOpen(false); setTestCallActive(false); announceTestCallEnded(); }}
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
  /** What the call's start request adds: the receptionist chosen to answer. */
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
