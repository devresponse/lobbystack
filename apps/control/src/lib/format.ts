/**
 * How the panel writes numbers, money and times. Everything is in English and
 * every time is UTC, which the pages say (docs/features/control-panel.md).
 */

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : whole.format(value);
}

/** A number and its noun: "1 call", "1,204 calls". */
export function counted(value: number, one: string, many: string): string {
  return `${whole.format(value)} ${value === 1 ? one : many}`;
}

/** 1,284 below ten thousand, then 12.9K and 4.2M. */
export function compact(value: number): string {
  return Math.abs(value) < 10_000 ? whole.format(value) : compactNumber.format(value);
}

export function minutes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return value > 0 && value < 0.1 ? "<0.1" : oneDecimal.format(value);
}

/** Seconds as 4:05, or 1:02:09 past an hour. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "-";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const rest = `${Math.floor((total % 3600) / 60)}`.padStart(hours ? 2 : 1, "0") + `:${`${total % 60}`.padStart(2, "0")}`;
  return hours ? `${hours}:${rest}` : rest;
}

const currencies = new Map<string, Intl.NumberFormat>();

/** An amount in cents of a currency, such as $49.00 or CA$87.00. */
export function money(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents === null || cents === undefined) return "-";
  const code = (currency ?? "USD").toUpperCase();
  let format = currencies.get(code);
  if (!format) {
    try {
      format = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    } catch {
      return `${(cents / 100).toFixed(2)} ${code}`;
    }
    currencies.set(code, format);
  }
  return format.format(cents / 100);
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return money(Math.round(value * 100), "USD");
}

/** 2026-11-18 19:04, in UTC. */
export function dateTime(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString().slice(0, 16).replace("T", " ");
}

/** 2026-11-18, in UTC. */
export function date(value: Date | string | null | undefined): string {
  return dateTime(value).slice(0, 10);
}

/** How long ago, roughly: just now, 5 minutes ago, 3 hours ago, 12 days ago, 4 months ago. */
export function ago(value: Date | string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(then)) return "never";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return seconds < -60 ? dateTime(value) : "just now";
  const unit = (amount: number, name: string) => `${amount} ${name}${amount === 1 ? "" : "s"} ago`;
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 86_400 * 60) return unit(Math.floor(seconds / 86_400), "day");
  if (seconds < 86_400 * 730) return unit(Math.floor(seconds / (86_400 * 30.44)), "month");
  return unit(Math.floor(seconds / (86_400 * 365.25)), "year");
}

/** A month key such as 2026-11 as Nov 2026. */
export function monthName(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? month : parsed.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** A code such as business_owner or past_due in words: business owner, past due. */
export function words(value: string | null | undefined): string {
  return value ? value.replaceAll("_", " ") : "-";
}

/** A signed change against an earlier figure, such as +12% or -3%, or null when there is nothing to compare with. */
export function change(current: number, earlier: number): string | null {
  if (earlier <= 0) return null;
  const percent = Math.round(((current - earlier) / earlier) * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

const SIGN_IN: Record<string, string> = { credential: "password", google: "Google", apple: "Apple", microsoft: "Microsoft", github: "GitHub" };

/** The ways an account signs in, from its accounts rows' provider IDs, such as "password, Google". */
export function signInMethods(providers: string | null | undefined): string {
  const names = [...new Set((providers ?? "").split(",").map((provider) => provider.trim()).filter(Boolean))];
  return names.length ? names.map((provider) => SIGN_IN[provider] ?? provider).join(", ") : "-";
}
