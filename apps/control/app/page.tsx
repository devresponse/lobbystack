import Link from "next/link";

import { ColumnChart } from "@/components/column-chart";
import { Badge, Empty, Panel, StatTile } from "@/components/ui";
import { ago, change, compact, count, counted, minutes, monthName } from "@/lib/format";
import { monthlyActivity, overview, recentAccounts } from "@/lib/queries";
import { adminDatabase } from "@/lib/session";
import { readSystemHealth } from "@/lib/system-health";

// The overview waits this long at most for the admin; the System health page waits longer.
const HEALTH_TIMEOUT_MS = 2_000;

export default async function OverviewPage() {
  const db = await adminDatabase();
  const [totals, months, signups, health] = await Promise.all([overview(db), monthlyActivity(db), recentAccounts(db), readSystemHealth(db, { timeoutMs: HEALTH_TIMEOUT_MS })]);
  const verdict = health.verdict;
  const callChange = change(totals.callsThisMonth, totals.callsSamePeriodLastMonth);
  return (
    <>
      <h1>Overview</h1>
      <p className="lead">Every business and account on this deployment. This month means the current UTC month so far.</p>
      <div className="tiles">
        <StatTile label="Businesses" value={compact(totals.businesses)} note={`${count(totals.activeBusinesses)} active, ${count(totals.newBusinesses)} new in 30 days`} />
        <StatTile label="Accounts" value={compact(totals.accounts)} note={`${count(totals.activeAccounts)} seen in 30 days, ${count(totals.newAccounts)} new`} />
        <StatTile
          label="Calls this month"
          value={compact(totals.callsThisMonth)}
          trend={callChange ? { text: callChange, good: totals.callsThisMonth >= totals.callsSamePeriodLastMonth } : null}
          note={callChange ? "vs the same days last month" : "none last month to compare"}
        />
        <StatTile label="Call minutes this month" value={minutes(totals.minutesThisMonth)} />
        <StatTile label="Active subscriptions" value={compact(totals.activeSubscriptions)} />
        <StatTile label="Phone numbers" value={compact(totals.phoneNumbers)} note={counted(totals.receptionists, "receptionist", "receptionists")} />
        <StatTile
          label="System health"
          value={verdict.label}
          note={
            <>
              <Badge tone={verdict.tone}>{verdict.findings.length ? `${count(verdict.findings.length)} to look at` : "every service reports"}</Badge>{" "}
              <Link href="/system">Details</Link>
            </>
          }
        />
      </div>

      <Panel title="Call minutes per month" aside="last 12 months">
        <ColumnChart
          title="Call minutes per month"
          format={(value) => compact(Math.round(value))}
          columns={months.map((month) => ({ label: monthName(month.month).slice(0, 3), value: month.minutes, title: `${monthName(month.month)}: ${minutes(month.minutes)} minutes, ${counted(month.calls, "call", "calls")}` }))}
        />
      </Panel>

      <Panel title="Month by month" aside="newest first">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">New businesses</th>
                <th className="num">New accounts</th>
                <th className="num">Calls</th>
                <th className="num">Call minutes</th>
                <th className="num">Texts</th>
                <th className="num">Website chats</th>
                <th className="num">Bookings</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((month) => (
                <tr key={month.month}>
                  <td>
                    <Link href={`/usage?month=${month.month}`}>{monthName(month.month)}</Link>
                  </td>
                  <td className="num">{count(month.newBusinesses)}</td>
                  <td className="num">{count(month.newAccounts)}</td>
                  <td className="num">{count(month.calls)}</td>
                  <td className="num">{minutes(month.minutes)}</td>
                  <td className="num">{count(month.texts)}</td>
                  <td className="num">{count(month.chats)}</td>
                  <td className="num">{count(month.bookings)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Newest accounts" aside={<Link href="/accounts">All accounts</Link>}>
        {signups.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Businesses</th>
                  <th>Signed up</th>
                </tr>
              </thead>
              <tbody>
                {signups.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <Link href={`/accounts/${account.id}`}>{account.name || account.email}</Link>
                      {account.name ? <span className="sub">{account.email}</span> : null}
                    </td>
                    <td>{account.businesses ?? "none yet"}</td>
                    <td className="when">{ago(account.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No accounts yet.</Empty>
        )}
      </Panel>
    </>
  );
}
