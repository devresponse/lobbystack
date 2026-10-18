import { afterEach, describe, expect, it, vi } from "vitest";

import { classifySmsConsentUpdate, classifySmsKeywordReply, normalizeSmsKeyword, sharedSenderHelpReply } from "./sms";

describe("SMS consent classifiers", () => {
  it("normalizes keywords to alphanumeric uppercase", () => {
    expect(normalizeSmsKeyword("  stop! ")).toBe("STOP");
    expect(normalizeSmsKeyword("unsubscribe")).toBe("UNSUBSCRIBE");
  });

  it("classifies Twilio opt-out types with source precedence", () => {
    expect(classifySmsConsentUpdate({ body: "irrelevant", optOutType: "STOP" })).toEqual({ status: "opted_out", source: "twilio_opt_out:STOP" });
    expect(classifySmsConsentUpdate({ body: "irrelevant", optOutType: "START" })).toEqual({ status: "subscribed", source: "twilio_opt_out:START" });
  });

  it("classifies STOP and START keyword bodies", () => {
    expect(classifySmsConsentUpdate({ body: "stop" })).toEqual({ status: "opted_out", source: "keyword:STOP" });
    expect(classifySmsConsentUpdate({ body: "start" })).toEqual({ status: "subscribed", source: "keyword:START" });
    expect(classifySmsConsentUpdate({ body: "Yes please" })).toBeNull();
  });

  it("returns compliance replies only for HELP and START", () => {
    expect(classifySmsKeywordReply({ body: "help" }, "AlloPlace")?.kind).toBe("help");
    expect(classifySmsKeywordReply({ body: "start" }, "AlloPlace")?.kind).toBe("start");
    expect(classifySmsKeywordReply({ body: "stop" }, "AlloPlace")).toBeNull();
    expect(classifySmsKeywordReply({ body: "hello" }, "AlloPlace")).toBeNull();
  });
});

describe("SMS HELP replies", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keep LobbyStack's registered wording when the deployment sets no name or links", () => {
    expect(classifySmsKeywordReply({ body: "help" }, "LobbyStack")?.body).toBe("LobbyStack: For help, contact hello@lobbystack.com or visit https://lobbystack.com. Reply STOP to opt out.");
    expect(sharedSenderHelpReply("LobbyStack")).toBe("LobbyStack: For help with an appointment, call the business you booked with. For anything else, email hello@lobbystack.com. Reply STOP to opt out.");
  });

  it("give the deployment's own name, and the address and website of the brand file its domain picks", async () => {
    // The brand is resolved once per process, so this test loads the modules afresh.
    vi.resetModules();
    vi.stubEnv("APP_BASE_URL", "https://demo.alloplace.com");
    const sms = await import("./sms");
    expect(sms.classifySmsKeywordReply({ body: "HELP" }, "AlloPlace")?.body).toBe("AlloPlace: For help, contact support@alloplace.com or visit https://alloplace.com. Reply STOP to opt out.");
    expect(sms.classifySmsKeywordReply({ body: "START" }, "AlloPlace")?.body).toBe("AlloPlace: You are subscribed again. Reply HELP for help or STOP to opt out.");
    expect(sms.sharedSenderHelpReply("AlloPlace")).toBe("AlloPlace: For help with an appointment, call the business you booked with. For anything else, email support@alloplace.com. Reply STOP to opt out.");
    expect(sms.sharedSenderStartReply("AlloPlace")).toBe("AlloPlace: You can get texts from this number again. Reply HELP for help or STOP to opt out.");
  });
});
