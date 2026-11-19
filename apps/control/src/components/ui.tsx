import Link from "next/link";
import type { ReactNode } from "react";

/** A headline figure: what it counts, the number, and a line of context. */
export function StatTile({ label, value, note, trend }: { label: string; value: string; note?: ReactNode; trend?: { text: string; good: boolean } | null }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {trend || note ? (
        <div className="note">
          {trend ? <span className={trend.good ? "up" : "down"}>{trend.text}</span> : null}
          {trend && note ? " " : null}
          {note}
        </div>
      ) : null}
    </div>
  );
}

export function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel" aria-label={title}>
      <h2>
        {title}
        {aside ? <small>{aside}</small> : null}
      </h2>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

const GOOD = new Set(["active", "paid", "verified", "accepted", "published", "succeeded", "completed", "ended", "trialing"]);
const WARNING = new Set(["pending", "paused", "past_due", "incomplete", "partially_refunded", "draft", "scheduled", "suspended", "frozen", "in_progress", "started"]);
const SERIOUS = new Set(["canceled", "cancelled", "expired", "refunded", "replaced", "closed", "archived", "reclaimed", "ended_early"]);
const CRITICAL = new Set(["failed", "error", "blocked", "unpaid", "uncollectible", "void", "deleted", "revoked"]);

/** A state in words beside a colored dot, so the color never carries it alone. */
export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="status">none</span>;
  const tone = GOOD.has(value) ? "good" : WARNING.has(value) ? "warning" : SERIOUS.has(value) ? "serious" : CRITICAL.has(value) ? "critical" : "";
  return <span className={`status ${tone}`.trim()}>{value.replaceAll("_", " ")}</span>;
}

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

/** Words beside a dot in a chosen tone, for states the Status list doesn't know. The words carry the meaning, the dot repeats it. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status ${tone === "neutral" ? "" : tone}`.trim()}>{children}</span>;
}

/** Previous and next links that keep the page's other filters. */
export function Pager({ path, params, page, total, pageSize }: { path: string; params: Record<string, string>; page: number; total: number; pageSize: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (target: number) => {
    const query = new URLSearchParams({ ...params, ...(target > 1 ? { page: String(target) } : {}) });
    for (const [key, value] of [...query.entries()]) if (!value) query.delete(key);
    const text = query.toString();
    return text ? `${path}?${text}` : path;
  };
  return (
    <nav className="pager" aria-label="Pages">
      <span>
        Page {page} of {pages} ({total.toLocaleString("en-US")} in all)
      </span>
      {page > 1 ? <Link href={href(page - 1)}>Previous</Link> : null}
      {page < pages ? <Link href={href(page + 1)}>Next</Link> : null}
    </nav>
  );
}

/** The page number in a query string: a whole number from 1, else 1. */
export function pageNumber(value: string | string[] | undefined): number {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(number) && number >= 1 && number <= 100_000 ? number : 1;
}

/** One value of a query string parameter. */
export function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.slice(0, 200) ?? "";
}
