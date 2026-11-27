import { demoSnapshot } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { buildBrowserSessionConfig, buildPhoneSessionConfig, LIVE_MODEL } from "./session";

// The greeting, then the notice that the call is with an AI and recorded.
const openingText = "Thank you for calling Maple Family Clinic. You're speaking with an AI assistant, and this call is recorded and transcribed.";
const command = (text: string) => [{ role: "developer", content: [{ type: "input_text", text: `Start the conversation now: say exactly "${text}" in the language of that greeting, then stop and listen to the caller.` }] }];
const opening = command(openingText);

describe("GPT-Live session config", () => {
  // OpenAI's guide: context the model needs from the start goes in input.
  // Tested against the API, this made GPT-Live greet about 2 seconds in every time.
  it("starts phone and browser sessions with the greeting command in their history", () => {
    expect(buildPhoneSessionConfig(demoSnapshot).input).toEqual(opening);
    expect(buildBrowserSessionConfig(demoSnapshot).input).toEqual(opening);
  });

  it("opens with the greeting alone once the business turns the notice off", () => {
    expect(buildPhoneSessionConfig({ ...demoSnapshot, recordingNotice: false }).input).toEqual(command("Thank you for calling Maple Family Clinic."));
  });

  // Without a greeting the call still says it's with an AI and recorded.
  it("opens with the notice alone for a business with no greeting, and leaves the history empty with nothing to say", () => {
    expect(buildPhoneSessionConfig({ ...demoSnapshot, greeting: " " }).input).toEqual(command("You're speaking with an AI assistant, and this call is recorded and transcribed."));
    expect(buildPhoneSessionConfig({ ...demoSnapshot, greeting: " ", recordingNotice: false })).not.toHaveProperty("input");
  });

  // A recording of the greeting opens the call, so GPT-Live mustn't say it again.
  it("puts the greeting in the history as already said when a recording plays it", () => {
    const said = [{ role: "assistant", content: [{ type: "output_text", text: openingText }] }];
    expect(buildBrowserSessionConfig(demoSnapshot, { greetingRecorded: true }).input).toEqual(said);
    expect(buildPhoneSessionConfig(demoSnapshot, { greetingRecorded: true }).input).toEqual(said);
    expect(buildBrowserSessionConfig({ ...demoSnapshot, greeting: " ", recordingNotice: false }, { greetingRecorded: true })).not.toHaveProperty("input");
    expect(buildPhoneSessionConfig({ ...demoSnapshot, greeting: " ", recordingNotice: false }, { greetingRecorded: true })).not.toHaveProperty("input");
  });

  // Only a phone call can be transferred, so a browser call gives the number to call instead.
  it("tells GPT-Live whether it's on a phone call or a browser call", () => {
    const browser = buildBrowserSessionConfig(demoSnapshot).instructions;
    const phone = buildPhoneSessionConfig(demoSnapshot).instructions;
    expect(browser).toContain("This call is in the caller's web browser, not on a phone line, so it can't be transferred");
    expect(browser).not.toContain("- Transfers:");
    expect(phone).toContain("- Transfers: connect the caller to a person when the business allows it.");
    expect(phone).not.toContain("web browser");
  });

  // OpenAI's GPT-Live-1.1 since 2026-11-19, unless LIVE_MODEL names gpt-live-1.
  it("starts phone and browser sessions on gpt-live-1.1", () => {
    expect(LIVE_MODEL).toBe("gpt-live-1.1");
    expect(buildPhoneSessionConfig(demoSnapshot).model).toBe("gpt-live-1.1");
    expect(buildBrowserSessionConfig(demoSnapshot).model).toBe("gpt-live-1.1");
  });

  // The fallback when OpenAI refuses the configured model, and the voice eval's --model.
  it("starts a session on another model when asked, with the same instructions", () => {
    const phone = buildPhoneSessionConfig(demoSnapshot, { model: "gpt-live-1" });
    const browser = buildBrowserSessionConfig(demoSnapshot, { model: "gpt-live-1" });
    expect(phone.model).toBe("gpt-live-1");
    expect(browser.model).toBe("gpt-live-1");
    expect(phone.instructions).toBe(buildPhoneSessionConfig(demoSnapshot).instructions);
  });
});
