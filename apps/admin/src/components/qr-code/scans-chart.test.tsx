// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import en from "../../../public/locales/en/settings.json";
import { scanDays, scanSummary, ScansChart, ScansSparkline, type RecentScans } from "./scans-chart";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "settings", interpolation: { escapeValue: false }, resources: { en: { settings: en } } });
});
afterEach(cleanup);

/** Formatting puts thin and no-break spaces around a date range's dash; the tests compare words. */
const plain = (text: string | null | undefined) => (text ?? "").replace(/[\u2009\u202f\u00a0]/g, " ");

/** 30 days from October 5 to November 3, with the counts given by day of the month. */
function scans(byDay: Record<string, number> = {}): RecentScans {
  const days = scanDays({ from: "2026-10-05", counts: Array.from({ length: 30 }, () => 0) });
  return { from: "2026-10-05", counts: days.map(({ day }) => byDay[day] ?? 0) };
}

describe("scans per day", () => {
  it("gives each count its UTC day, across the end of a month", () => {
    const days = scanDays(scans({ "2026-10-31": 4, "2026-11-01": 2 }));
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ day: "2026-10-05", scans: 0 });
    expect(days[26]).toEqual({ day: "2026-10-31", scans: 4 });
    expect(days[27]).toEqual({ day: "2026-11-01", scans: 2 });
    expect(days[29]).toEqual({ day: "2026-11-03", scans: 0 });
  });

  it("sums the scans and names the latest of the busiest days", () => {
    expect(scanSummary(scans({ "2026-10-10": 5, "2026-10-12": 9, "2026-10-20": 9, "2026-11-02": 1 }))).toEqual({ total: 24, busiest: { day: "2026-10-20", scans: 9 } });
    expect(scanSummary(scans())).toEqual({ total: 0, busiest: null });
  });
});

describe("the scans chart under a link's sign", () => {
  function renderChart(recent: RecentScans) {
    return render(<I18nextProvider i18n={i18n}><ScansChart scans={recent} /></I18nextProvider>);
  }
  const columns = () => Array.from(document.querySelectorAll<HTMLElement>("[data-day]"));

  it("draws a column per day, the busiest one dark, and sums them up in a sentence", () => {
    renderChart(scans({ "2026-10-06": 3, "2026-10-17": 9, "2026-11-03": 1 }));
    expect(screen.getByText("Scans per day")).toBeTruthy();
    expect(columns()).toHaveLength(30);
    const bar = (day: string) => columns().find((column) => column.dataset.day === day)!.firstElementChild as HTMLElement;
    expect(bar("2026-10-17").className).toContain("bg-foreground");
    expect(bar("2026-10-06").className).not.toContain("bg-foreground");
    expect(bar("2026-10-17").style.height).toBe("max(2px, 100%)");
    expect(bar("2026-10-06").style.height).toBe("max(2px, 33.33333333333333%)");
    expect(bar("2026-10-07").style.height).toBe("0px");
    expect(plain(screen.getByText(/^13 scans/).textContent)).toBe("13 scans, October 5 – November 3. Busiest: Sat, Oct 17, 9 scans.");
    // The highest count and 0 beside the columns, and the first, middle and last days below them.
    expect(screen.getByRole("img").parentElement?.textContent).toBe("Oct 5Oct 19Nov 3");
    expect(screen.getByRole("img").closest("figure")?.textContent).toContain("90");
  });

  it("names the chart and points screen readers at the sentence and a table of the days", () => {
    renderChart(scans({ "2026-10-17": 9 }));
    const chart = screen.getByRole("img", { name: "Scans per day" });
    expect(plain(document.getElementById(chart.getAttribute("aria-describedby")!)?.textContent)).toBe("9 scans, October 5 – November 3. Busiest: Sat, Oct 17, 9 scans.");
    const table = screen.getByRole("table");
    expect(plain(within(table).getByText(/^Scans per day,/).textContent)).toBe("Scans per day, October 5 – November 3");
    expect(within(table).getAllByRole("row")).toHaveLength(31);
    expect(within(table).getByRole("rowheader", { name: "Sat, Oct 17" }).nextElementSibling?.textContent).toBe("9");
  });

  it("shows a day's count while it's pointed at", () => {
    renderChart(scans({ "2026-10-17": 1 }));
    fireEvent.pointerEnter(columns().find((column) => column.dataset.day === "2026-10-17")!);
    expect(screen.getByText("Sat, Oct 17: 1 scan")).toBeTruthy();
    fireEvent.pointerLeave(screen.getByRole("img"));
    expect(screen.queryByText("Sat, Oct 17: 1 scan")).toBeNull();
  });

  it("says when a link wasn't scanned", () => {
    renderChart(scans());
    expect(plain(screen.getByText(/^No scans/).textContent)).toBe("No scans, October 5 – November 3.");
    expect(document.querySelector(".bg-foreground")).toBeNull();
  });
});

describe("the scans line in a table row", () => {
  it("draws the 30 days as one line, and nothing for a link without scans", () => {
    const { container, rerender } = render(<ScansSparkline counts={[0, 2, 4, 0]} />);
    const line = container.querySelector("polyline");
    expect(line?.getAttribute("points")).toBe("0.0,15.0 16.0,8.0 32.0,1.0 48.0,15.0");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    rerender(<ScansSparkline counts={[0, 0, 0]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
