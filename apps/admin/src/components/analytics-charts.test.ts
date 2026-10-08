import { describe, expect, it } from "vitest";

import { evenlySpacedTicks } from "./analytics-charts";

const weeks = Array.from({ length: 52 }, (_, index) => `W${String(index).padStart(2, "0")}x`);
const sorted = (set: Set<number>) => [...set].sort((left, right) => left - right);

describe("evenlySpacedTicks", () => {
  it("shows every label when they fit", () => {
    expect(sorted(evenlySpacedTicks(["Mon", "Tue", "Wed"], 800))).toEqual([0, 1, 2]);
  });

  it("always labels the newest point and keeps a constant step", () => {
    const shown = sorted(evenlySpacedTicks(weeks, 360));
    expect(shown.at(-1)).toBe(51);
    const steps = new Set(shown.slice(1).map((index, position) => index - shown[position]!));
    expect(steps.size).toBe(1);
    expect(shown.length).toBeLessThan(weeks.length);
  });

  it("leaves room for edge labels that shift inward", () => {
    const width = 360;
    const shown = sorted(evenlySpacedTicks(weeks, width));
    const spacing = width / (weeks.length - 1);
    expect((shown[1]! - shown[0]!) * spacing).toBeGreaterThanOrEqual(4 * 7 * 1.5 + 12);
  });

  it("shows more labels on wider charts", () => {
    expect(evenlySpacedTicks(weeks, 1200).size).toBeGreaterThan(evenlySpacedTicks(weeks, 360).size);
  });

  it("shows everything before the width is known", () => {
    expect(evenlySpacedTicks(weeks, 0).size).toBe(52);
  });
});
