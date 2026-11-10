import { describe, expect, it } from "vitest";

import { fillPlanDisplayText, planDisplayPlaceholders } from "./index";

describe("planDisplayPlaceholders", () => {
  it("names what each {{...}} prints, without the spaces around it", () => {
    expect(planDisplayPlaceholders("Includes {{voiceMinutes}} minutes, {{ voiceMinuteRate }} after, on {{\tappName\n}}.")).toEqual(["voiceMinutes", "voiceMinuteRate", "appName"]);
    expect(planDisplayPlaceholders("{{ free_cloud.voiceMinutes }} on Free")).toEqual(["free_cloud.voiceMinutes"]);
  });

  it("reads only braces with no other brace between them", () => {
    expect(planDisplayPlaceholders("No values here.")).toEqual([]);
    expect(planDisplayPlaceholders("{{}} and {{ }}")).toEqual(["", ""]);
    expect(planDisplayPlaceholders("{{{voiceMinutes}}}")).toEqual(["voiceMinutes"]);
    expect(planDisplayPlaceholders("{{voice{Minutes}} {voiceMinutes} {{voiceMinutes}")).toEqual([]);
  });

  it("takes linear time on a long run of spaces after {{", () => {
    const started = performance.now();
    expect(planDisplayPlaceholders(`{{${" ".repeat(3_000)}`)).toEqual([]);
    expect(planDisplayPlaceholders(`${"{{".repeat(1_500)}${" ".repeat(3_000)}x`)).toEqual([]);
    expect(planDisplayPlaceholders(`{{${" ".repeat(3_000)}appName${" ".repeat(3_000)}}}`)).toEqual(["appName"]);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("fillPlanDisplayText", () => {
  const values = { voiceMinutes: "100", "free_cloud.voiceMinutes": "20", appName: "LobbyStack" };

  it("fills each name it has a value for, with or without spaces inside the braces", () => {
    expect(fillPlanDisplayText("{{voiceMinutes}} minutes on {{ appName }}", values)).toBe("100 minutes on LobbyStack");
    expect(fillPlanDisplayText("Free has {{\tfree_cloud.voiceMinutes\n}} minutes.", values)).toBe("Free has 20 minutes.");
  });

  it("leaves a name without a value as written", () => {
    expect(fillPlanDisplayText("{{ minutes }} and {{toString}} and {{}}", values)).toBe("{{ minutes }} and {{toString}} and {{}}");
  });

  it("takes linear time on a long run of spaces after {{", () => {
    const started = performance.now();
    const text = `{{${" ".repeat(3_000)}`;
    expect(fillPlanDisplayText(text, values)).toBe(text);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
