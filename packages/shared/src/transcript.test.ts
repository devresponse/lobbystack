import { describe, expect, it } from "vitest";

import { withoutSoundTags } from "./transcript";

describe("withoutSoundTags", () => {
  it("leaves out the sounds GPT-Live marks, with the space before them", () => {
    expect(withoutSoundTags("[tongue click ]No, can you connect to the live person")).toBe("No, can you connect to the live person");
    expect(withoutSoundTags(" Yes [laughs] sure.")).toBe(" Yes sure.");
    expect(withoutSoundTags("Thanks. [coughs] [background noise]")).toBe("Thanks.");
    expect(withoutSoundTags(" [tongue click]")).toBe("");
  });

  it("hides a tag that hasn't finished arriving", () => {
    expect(withoutSoundTags("Thanks. [tongue cl")).toBe("Thanks.");
    expect(withoutSoundTags("[")).toBe("");
  });

  it("keeps the worker's notes on the keypad", () => {
    const keys = "Cancel it. [typed a PIN] [pressed 5] [pressed a key] [pressed #] Yes.";
    expect(withoutSoundTags(keys)).toBe(keys);
    expect(withoutSoundTags("Hi, [pressed 1] [laughs] bye")).toBe("Hi, [pressed 1] bye");
  });

  it("leaves text without tags, and a long bracketed passage, as it is", () => {
    expect(withoutSoundTags(" Are you open Sunday?")).toBe(" Are you open Sunday?");
    const long = `Note [${"a".repeat(61)}] end`;
    expect(withoutSoundTags(long)).toBe(long);
  });
});
