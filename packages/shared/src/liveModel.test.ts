import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIVE_MODEL, isLiveModel, LIVE_FALLBACK_MODEL, liveModelRefusal, liveModelSetting, liveModelSettingErrors, withLiveModelFallback } from "./liveModel";

// The shape of the errors OpenAI's SDK throws for a refused request.
function refusal(status: number, code?: string, type?: string) {
  return Object.assign(new Error(`${status} refused`), { status, ...(code ? { code } : {}), ...(type ? { type } : {}) });
}

describe("LIVE_MODEL", () => {
  it("runs calls on gpt-live-1.1 unless it says otherwise", () => {
    expect(DEFAULT_LIVE_MODEL).toBe("gpt-live-1.1");
    expect(liveModelSetting({})).toBe("gpt-live-1.1");
    expect(liveModelSetting({ LIVE_MODEL: "  " })).toBe("gpt-live-1.1");
  });

  it("goes back to gpt-live-1 when it names it", () => {
    expect(liveModelSetting({ LIVE_MODEL: "gpt-live-1" })).toBe("gpt-live-1");
    expect(liveModelSetting({ LIVE_MODEL: " gpt-live-1.1 " })).toBe("gpt-live-1.1");
  });

  it("refuses a model it doesn't know, so a service won't start on a typo", () => {
    expect(() => liveModelSetting({ LIVE_MODEL: "gpt-live-2" })).toThrow("LIVE_MODEL must be gpt-live-1.1 or gpt-live-1, or unset for gpt-live-1.1.");
    expect(liveModelSettingErrors({ LIVE_MODEL: "GPT-Live-1.1" })).toEqual(["LIVE_MODEL must be gpt-live-1.1 or gpt-live-1, or unset for gpt-live-1.1."]);
    expect(liveModelSettingErrors({ LIVE_MODEL: "gpt-live-1" })).toEqual([]);
    expect(liveModelSettingErrors({})).toEqual([]);
  });

  it("knows only the two models", () => {
    expect(isLiveModel("gpt-live-1.1")).toBe(true);
    expect(isLiveModel("gpt-live-1")).toBe(true);
    expect(isLiveModel("gpt-realtime-2.1")).toBe(false);
    expect(isLiveModel(undefined)).toBe(false);
  });
});

describe("liveModelRefusal", () => {
  it("counts refusals another model may not share", () => {
    expect(liveModelRefusal(refusal(403, "model_not_found"))).toEqual({ status: 403, code: "model_not_found" });
    expect(liveModelRefusal(refusal(404))).toEqual({ status: 404 });
    expect(liveModelRefusal(refusal(400, "invalid_value"))).toEqual({ status: 400, code: "invalid_value" });
    expect(liveModelRefusal(refusal(429, "rate_limit_exceeded"))).toEqual({ status: 429, code: "rate_limit_exceeded" });
    expect(liveModelRefusal(refusal(503, "server_is_overloaded"))).toEqual({ status: 503, code: "server_is_overloaded" });
  });

  it("leaves out what every model would refuse alike", () => {
    expect(liveModelRefusal(refusal(429, "credit_balance_exhausted"))).toBeUndefined();
    expect(liveModelRefusal(refusal(429, "project_spend_limit_exceeded"))).toBeUndefined();
    expect(liveModelRefusal(refusal(429, undefined, "insufficient_quota"))).toBeUndefined();
    expect(liveModelRefusal(refusal(403, "unsupported_country_region_territory"))).toBeUndefined();
    expect(liveModelRefusal(refusal(409, "decision_already_made"))).toBeUndefined();
    expect(liveModelRefusal(refusal(400, "decision_already_made"))).toBeUndefined();
    expect(liveModelRefusal(refusal(401))).toBeUndefined();
  });

  it("leaves out server errors, after which the session may exist, and errors without a status", () => {
    expect(liveModelRefusal(refusal(500))).toBeUndefined();
    expect(liveModelRefusal(refusal(502))).toBeUndefined();
    expect(liveModelRefusal(new Error("Connection error."))).toBeUndefined();
    expect(liveModelRefusal(undefined)).toBeUndefined();
  });
});

describe("withLiveModelFallback", () => {
  it("starts on the configured model when OpenAI takes it", async () => {
    const start = vi.fn(async (config: { model: string }) => `started on ${config.model}`);
    const onFallback = vi.fn();

    const started = await withLiveModelFallback({ model: "gpt-live-1.1", instructions: "Answer calls." }, start, onFallback);

    expect(started).toEqual({ config: { model: "gpt-live-1.1", instructions: "Answer calls." }, result: "started on gpt-live-1.1" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("starts on gpt-live-1, with the rest of the config, when OpenAI refuses gpt-live-1.1", async () => {
    const start = vi.fn(async (config: { model: string }) => {
      if (config.model === "gpt-live-1.1") throw refusal(403, "model_not_found");
      return "started";
    });
    const onFallback = vi.fn();

    const started = await withLiveModelFallback({ model: "gpt-live-1.1", instructions: "Answer calls." }, start, onFallback);

    expect(started.config).toEqual({ model: LIVE_FALLBACK_MODEL, instructions: "Answer calls." });
    expect(start.mock.calls.map(([config]) => config.model)).toEqual(["gpt-live-1.1", "gpt-live-1"]);
    expect(onFallback).toHaveBeenCalledWith({ status: 403, code: "model_not_found", model: "gpt-live-1.1", fallbackModel: "gpt-live-1" });
  });

  it("fails as it is on a refusal every model shares, and tries once only", async () => {
    const noCredit = refusal(429, "credit_balance_exhausted");
    const start = vi.fn(async () => { throw noCredit; });
    await expect(withLiveModelFallback({ model: "gpt-live-1.1" }, start)).rejects.toBe(noCredit);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("has nothing to fall back to on gpt-live-1", async () => {
    const refused = refusal(429, "rate_limit_exceeded");
    const start = vi.fn(async () => { throw refused; });
    await expect(withLiveModelFallback({ model: "gpt-live-1" }, start)).rejects.toBe(refused);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("fails with the second refusal when gpt-live-1 is refused too", async () => {
    const second = refusal(400, "invalid_value");
    const start = vi.fn(async (config: { model: string }) => { throw config.model === "gpt-live-1.1" ? refusal(400, "invalid_value") : second; });
    await expect(withLiveModelFallback({ model: "gpt-live-1.1" }, start)).rejects.toBe(second);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
