import { describe, expect, it } from "vitest";

import { niceMax } from "./column-chart";

describe("the chart's axis", () => {
  it("tops out at a round number at least the largest value", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(250)).toBe(250);
    expect(niceMax(251)).toBe(500);
    expect(niceMax(0.3)).toBeCloseTo(0.5);
  });
});
