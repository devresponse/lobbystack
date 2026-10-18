import { demoSnapshot } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { buildBrowserSessionConfig, buildPhoneSessionConfig } from "./session";

const opening = [{ role: "developer", content: [{ type: "input_text", text: `Start the conversation now: say exactly "${demoSnapshot.greeting}" in the language of that greeting, then stop and listen to the caller.` }] }];

describe("GPT-Live session config", () => {
  // OpenAI's guide: context the model needs from the start goes in input.
  // Tested against the API, this made GPT-Live greet about 2 seconds in every time.
  it("starts phone and browser sessions with the greeting command in their history", () => {
    expect(buildPhoneSessionConfig(demoSnapshot).input).toEqual(opening);
    expect(buildBrowserSessionConfig(demoSnapshot).input).toEqual(opening);
  });

  it("leaves the history empty for a business with no greeting", () => {
    expect(buildPhoneSessionConfig({ ...demoSnapshot, greeting: " " })).not.toHaveProperty("input");
  });

  // A recording of the greeting opens the call, so GPT-Live mustn't say it again.
  it("puts the greeting in the history as already said when a recording plays it", () => {
    expect(buildBrowserSessionConfig(demoSnapshot, { greetingRecorded: true }).input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: demoSnapshot.greeting }] },
    ]);
    expect(buildBrowserSessionConfig({ ...demoSnapshot, greeting: " " }, { greetingRecorded: true })).not.toHaveProperty("input");
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
});
