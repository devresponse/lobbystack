import type { ClosureWindow, HoursWindow } from "./index";

// Whether a business is open, worked out in its own time zone from its weekly
// hours and closures. The receptionist's hours tool, the transfer rule and the
// public profile page all read it from here, so they always agree.

export type OpenStatus = {
  /** Whether the business has any weekly hours at all. */
  configured: boolean;
  openNow: boolean;
  /** While open: when it next closes, unless it stays open for more than a week. */
  closesAt?: string;
  /** While closed: when it next opens, if that's within a week. */
  opensAt?: string;
};

type LocalDate = { year: number; month: number; day: number };
type WallClock = LocalDate & { hour: number; minute: number; second: number };

const DAY_MS = 86_400_000;
// Days around today whose windows are worked out: yesterday's may run past
// midnight, and the next opening can be a week away.
const FIRST_DAY = -1;
const LAST_DAY = 8;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(formatter: Intl.DateTimeFormat, instant: number): WallClock {
  const parts = formatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** How far the zone's clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const clock = wallClock(formatter, instant);
  const whole = instant - (((instant % 1000) + 1000) % 1000);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - whole;
}

/** The instant a wall-clock time names in the zone. Minutes may reach 1440, the next midnight. */
function zonedInstant(formatter: Intl.DateTimeFormat, date: LocalDate, minutes: number): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  return wall - offsetAt(formatter, wall - offsetAt(formatter, wall));
}

function addDays(date: LocalDate, days: number): LocalDate & { weekday: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

/** Opening intervals from yesterday to a week ahead, closures cut out, overlapping and touching ones joined. */
function openIntervals(formatter: Intl.DateTimeFormat, today: LocalDate, hours: ReadonlyArray<HoursWindow>, closures: ReadonlyArray<Pick<ClosureWindow, "startsAt" | "endsAt">>): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  for (let offset = FIRST_DAY; offset <= LAST_DAY; offset += 1) {
    const date = addDays(today, offset);
    for (const window of hours) {
      if (window.dayOfWeek !== date.weekday || window.openMinutes === window.closeMinutes) continue;
      const start = zonedInstant(formatter, date, window.openMinutes);
      // A window that closes before it opens runs past midnight.
      const end = window.openMinutes < window.closeMinutes ? zonedInstant(formatter, date, window.closeMinutes) : zonedInstant(formatter, addDays(date, 1), window.closeMinutes);
      if (end > start) intervals.push([start, end]);
    }
  }
  let open = intervals;
  for (const closure of closures) {
    const closedFrom = Date.parse(closure.startsAt);
    const closedUntil = Date.parse(closure.endsAt);
    if (!(closedUntil > closedFrom)) continue;
    open = open.flatMap(([start, end]): Array<[number, number]> => {
      if (closedUntil <= start || closedFrom >= end) return [[start, end]];
      return [...(closedFrom > start ? [[start, closedFrom] as [number, number]] : []), ...(closedUntil < end ? [[closedUntil, end] as [number, number]] : [])];
    });
  }
  const merged: Array<[number, number]> = [];
  for (const [start, end] of open.sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Whether the business is open at `now`: inside one of its weekly windows, in
 * its own time zone, and outside every closure. With it, when it next closes
 * or opens. An unknown time zone reads as closed.
 */
export function openStatus(hours: ReadonlyArray<HoursWindow>, closures: ReadonlyArray<Pick<ClosureWindow, "startsAt" | "endsAt">>, timezone: string, now: Date = new Date()): OpenStatus {
  const configured = hours.length > 0;
  const instant = now.getTime();
  if (!configured || !Number.isFinite(instant)) return { configured, openNow: false };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(timezone);
  } catch {
    return { configured, openNow: false };
  }
  const clock = wallClock(formatter, instant);
  const intervals = openIntervals(formatter, clock, hours, closures);
  const horizon = instant + (LAST_DAY - 1) * DAY_MS;
  const current = intervals.find(([start, end]) => start <= instant && instant < end);
  if (current) {
    return { configured, openNow: true, ...(current[1] < horizon ? { closesAt: new Date(current[1]).toISOString() } : {}) };
  }
  const next = intervals.find(([start]) => start > instant && start < horizon);
  return { configured, openNow: false, ...(next ? { opensAt: new Date(next[0]).toISOString() } : {}) };
}
