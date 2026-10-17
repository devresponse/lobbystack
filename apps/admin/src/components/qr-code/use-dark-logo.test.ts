import { describe, expect, it } from "vitest";

import { logoPixelsAreDark } from "./use-dark-logo";

function pixels(...colors: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flat());
}

describe("logoPixelsAreDark", () => {
  it("calls a black or navy logo dark", () => {
    expect(logoPixelsAreDark(pixels([11, 11, 13, 255], [0, 0, 0, 0]))).toBe(true);
    expect(logoPixelsAreDark(pixels([30, 64, 175, 255]))).toBe(true);
  });

  it("calls a yellow tile with black marks light", () => {
    expect(logoPixelsAreDark(pixels([255, 209, 0, 255], [255, 209, 0, 255], [255, 209, 0, 255], [0, 0, 0, 255]))).toBe(false);
  });

  it("judges only the pixels that show", () => {
    expect(logoPixelsAreDark(pixels([255, 255, 255, 255], [0, 0, 0, 10], [0, 0, 0, 10]))).toBe(false);
    expect(logoPixelsAreDark(pixels([255, 255, 255, 0]))).toBe(true);
  });
});
