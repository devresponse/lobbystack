import type { Metadata } from "next";
import Link from "next/link";

import { ColumnChart } from "@/components/column-chart";
import { Empty, Panel, StatTile, param } from "@/components/ui";
import { compact, count, counted, minutes, money, monthName } from "@/lib/format";
import { currentMonth, isMonth, monthlyActivity, usageByBusiness } from "@/lib/queries";
import { adminDatabase } from "@/lib/session";

export const metadata: Metadata = { title: "Usage" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const LIMIT = 100;

export default async function UsagePage({ searchParams }: { searchParams: Search }) {
  const query = await searchParams;
  const asked = param(query.month);
  const month = isMonth(asked) ? asked : currentMonth();
  const db = await adminDatabase();
  const [months, rows] = await Promise.all([monthlyActivity(db), usageByBusiness(db, month, LIMIT)]);
  const totals = months.find((row) => row.month === month);
  return (
    <>
      <h1>Usage</h1>
      <p className="lead">What every business did in a UTC month: calls, texts, website chats and bookings, beside what billing counted against its plan.</p>
      <nav className="pills" aria-label="Month">
        {[...months].reverse().map((row) => (
          <Link key={row.month} href={`/usage?month=${row.month}`} aria-current={row.month === month ? "page" : undefined}>
            {monthName(row.month)}
          </Link>
        ))}
      </nav>

      {totals ? (
        <div className="tiles">
          <StatTile label="Calls" value={compact(totals.calls)} note={monthName(month)} />
          <StatTile label="Call minutes" value={minutes(totals.minutes)} />
          <StatTile label="Texts" value={compact(totals.texts)} />
          <StatTile label="Website chats" value={compact(totals.chats)} />
          <StatTile label="Bookings" value={compact(totals.bookings)} />
          <StatTile label="Businesses with activity" value={compact(rows.length)} note={rows.length >= LIMIT ? `the busiest ${LIMIT} are listed` : undefined} />
        </div>
      ) : null}

      <Panel title="Call minutes per month" aside="last 12 months">
        <ColumnChart
          title="Call minutes per month"
          format={(value) => compact(Math.round(value))}
          columns={months.map((row) => ({ label: monthName(row.month).slice(0, 3), value: row.minutes, title: `${monthName(row.month)}: ${minutes(row.minutes)} minutes, ${counted(row.calls, "call", "calls")}` }))}
        />
      </Panel>

      <Panel title={`Businesses in ${monthName(month)}`} aside={rows.length >= LIMIT ? `busiest ${LIMIT}` : "busiest first"}>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th className="num">Calls</th>
                  <th className="num">Call minutes</th>
                  <th className="num">Texts</th>
                  <th className="num">Website chats</th>
                  <th className="num">Bookings</th>
                  <th className="num">Billed voice min</th>
                  <th className="num">Alert texts</th>
                  <th className="num">Transfers</th>
                  <th className="num">Chat units</th>
                  <th className="num">Overage</th>
                  <th>Stopped</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/businesses/${row.id}`}>{row.name}</Link>
                      {row.status !== "active" ? <span className="sub">{row.status}</span> : null}
                    </td>
                    <td className="num">{count(row.calls)}</td>
                    <td className="num">{minutes(row.minutes)}</td>
                    <td className="num">{count(row.texts)}</td>
                    <td className="num">{count(row.chats)}</td>
                    <td className="num">{count(row.bookings)}</td>
                    <td className="num">{row.voice_seconds_used === null ? "-" : minutes(row.voice_seconds_used / 60)}</td>
                    <td className="num">{count(row.alert_sms_segments_used)}</td>
                    <td className="num">{count(row.outbound_call_attempts_used)}</td>
                    <td className="num">{count(row.chat_ai_tokens_used)}</td>
                    <td className="num">{row.overage_spend_cents === null ? "-" : money(row.overage_spend_cents, "USD")}</td>
                    <td>{row.blocked ? <span className="status critical">stopped</span> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No business did anything in {monthName(month)}.</Empty>
        )}
        <p className="note">
          Billed voice minutes, alert texts, transfers and chat units are what billing counted against each plan; a dash means billing kept no count that month. Stopped means a plan&apos;s
          limit ran out and something was turned away.
        </p>
      </Panel>
    </>
  );
}
