import type { Metadata } from "next";
import Link from "next/link";

import { ColumnChart } from "@/components/column-chart";
import { Empty, Panel, StatTile, Status } from "@/components/ui";
import { compact, count, counted, date, minutes, money, monthName, usd, words } from "@/lib/format";
import {
  businessesWithoutBilling,
  costByMonth,
  currentMonth,
  endingSoon,
  packs,
  planCounts,
  recentMonths,
  revenueByMonth,
  transactions,
} from "@/lib/queries";
import { adminDatabase } from "@/lib/session";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage() {
  const db = await adminDatabase();
  const [plans, unbilled, revenue, costs, ending, payments, bought] = await Promise.all([
    planCounts(db),
    businessesWithoutBilling(db),
    revenueByMonth(db),
    costByMonth(db),
    endingSoon(db),
    transactions(db, { limit: 50 }),
    packs(db, { limit: 20 }),
  ]);
  const thisMonth = currentMonth();
  const active = plans.filter((row) => row.subscription_state === "active").reduce((sum, row) => sum + row.businesses, 0);
  const currencies = [...new Set(revenue.map((row) => row.currency))];
  // One chart needs one currency: with several, the table below is the only view.
  const currency = currencies.length === 1 ? currencies[0]! : null;
  const net = (row: { gross_cents: number; refunded_cents: number }) => row.gross_cents - row.refunded_cents;
  const takenThisMonth = revenue.filter((row) => row.month === thisMonth);
  const costThisMonth = costs.find((row) => row.month === thisMonth);
  return (
    <>
      <h1>Billing</h1>
      <p className="lead">Plans, payments and what serving the businesses costs. Payments are what the billing provider reported; costs are the worker&apos;s hourly estimate, in US dollars.</p>
      <div className="tiles">
        <StatTile label="Active subscriptions" value={compact(active)} />
        <StatTile label="Businesses with no billing" value={compact(unbilled)} note="never subscribed" />
        <StatTile
          label="Taken this month"
          value={takenThisMonth.length ? takenThisMonth.map((row) => money(net(row), row.currency)).join(" + ") : "none"}
          note={`${counted(takenThisMonth.reduce((sum, row) => sum + row.payments, 0), "payment", "payments")}, less refunds`}
        />
        <StatTile label="Cost to serve this month" value={usd(costThisMonth?.total_cost_usd ?? 0)} />
        <StatTile label="Overage this month" value={money(costThisMonth?.overage_cents ?? 0, "USD")} note="usage past plans' allowances" />
        <StatTile label="Ending in 30 days" value={compact(ending.length)} note="canceled, or a plan that runs out" />
      </div>

      {currency ? (
        <Panel title={`Taken per month, ${currency}`} aside="last 12 months, less refunds">
          <ColumnChart
            title={`Taken per month in ${currency}`}
            format={(cents) => money(Math.round(cents), currency).replace(/\.00$/, "")}
            columns={recentMonths(12).map((month) => {
              const row = revenue.find((entry) => entry.month === month);
              const value = row ? net(row) : 0;
              return { label: monthName(month).slice(0, 3), value, title: `${monthName(month)}: ${money(value, currency)} from ${counted(row?.payments ?? 0, "payment", "payments")}` };
            })}
          />
        </Panel>
      ) : null}

      <div className="grid-2">
        <Panel title="Plans" aside="businesses on each">
          {plans.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Billed by</th>
                    <th>Subscription</th>
                    <th className="num">Businesses</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((row) => (
                    <tr key={`${row.plan}-${row.source}-${row.billing_interval}-${row.subscription_state}`}>
                      <td>
                        {row.plan ?? "none"}
                        {row.billing_interval ? <span className="sub">{row.billing_interval}</span> : null}
                      </td>
                      <td>{row.source}</td>
                      <td>
                        <Status value={row.subscription_state} />
                      </td>
                      <td className="num">{count(row.businesses)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No business has a billing account yet.</Empty>
          )}
        </Panel>

        <Panel title="Ending in the next 30 days" aside="soonest first">
          {ending.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Plan</th>
                    <th>Why</th>
                    <th>Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {ending.map((row) => (
                    <tr key={row.business_id}>
                      <td>
                        <Link href={`/businesses/${row.business_id}`}>{row.name}</Link>
                      </td>
                      <td>
                        {row.plan ?? "-"}
                        {row.subscription_state ? <span className="sub">{words(row.subscription_state)}</span> : null}
                      </td>
                      <td>{row.why}</td>
                      <td className="when">{date(row.ends_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Nothing ends in the next 30 days.</Empty>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Taken per month" aside="newest first">
          {revenue.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Payments</th>
                    <th className="num">Paid</th>
                    <th className="num">Refunded</th>
                    <th className="num">Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.map((row) => (
                    <tr key={`${row.month}-${row.currency}`}>
                      <td>
                        {monthName(row.month)}
                        {currency ? null : <span className="sub">{row.currency}</span>}
                      </td>
                      <td className="num">{count(row.payments)}</td>
                      <td className="num">{money(row.gross_cents, row.currency)}</td>
                      <td className="num">{row.refunded_cents ? money(row.refunded_cents, row.currency) : "-"}</td>
                      <td className="num">{money(net(row), row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No payments in the last 12 months.</Empty>
          )}
        </Panel>

        <Panel title="Cost to serve per month" aside="US dollars, newest first">
          {costs.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Calls</th>
                    <th className="num">Texts</th>
                    <th className="num">AI</th>
                    <th className="num">Servers</th>
                    <th className="num">Total</th>
                    <th className="num">Overage</th>
                    <th className="num">Stopped</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((row) => (
                    <tr key={row.month}>
                      <td>
                        <Link href={`/usage?month=${row.month}`}>{monthName(row.month)}</Link>
                      </td>
                      <td className="num">{usd(row.voice_cost_usd)}</td>
                      <td className="num">{usd(row.sms_cost_usd)}</td>
                      <td className="num">{usd(row.ai_cost_usd)}</td>
                      <td className="num">{usd(row.infra_cost_usd)}</td>
                      <td className="num">{usd(row.total_cost_usd)}</td>
                      <td className="num">{money(row.overage_cents, "USD")}</td>
                      <td className="num">{count(row.blocked_businesses)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No costs recorded yet. The worker adds them up every hour.</Empty>
          )}
          <p className="note">Stopped counts the businesses that ran out of something on their plan that month.</p>
        </Panel>
      </div>

      <Panel title="Latest payments" aside="50 newest">
        {payments.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Business</th>
                  <th>What</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="when">{date(payment.occurred_at)}</td>
                    <td>
                      <Link href={`/businesses/${payment.business_id}`}>{payment.business_name}</Link>
                    </td>
                    <td>{payment.description || words(payment.kind)}</td>
                    <td>
                      <Status value={payment.status} />
                    </td>
                    <td className="num">
                      {money(payment.amount_cents, payment.currency)}
                      {payment.refunded_amount_cents ? <span className="sub">{money(payment.refunded_amount_cents, payment.currency)} refunded</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No payments yet.</Empty>
        )}
      </Panel>

      <Panel title="Latest prepaid packs" aside="20 newest">
        {bought.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Paid</th>
                  <th>Business</th>
                  <th>Pack</th>
                  <th>Status</th>
                  <th className="num">Minutes used</th>
                  <th>Ends</th>
                </tr>
              </thead>
              <tbody>
                {bought.map((pack) => (
                  <tr key={pack.id}>
                    <td className="when">{date(pack.paid_at)}</td>
                    <td>
                      <Link href={`/businesses/${pack.business_id}`}>{pack.business_name}</Link>
                    </td>
                    <td>
                      {pack.pack}
                      <span className="sub">
                        {money(pack.amount_cents, pack.currency)} through {pack.provider}
                      </span>
                    </td>
                    <td>
                      <Status value={pack.status} />
                    </td>
                    <td className="num">
                      {minutes(pack.seconds_used / 60)} of {minutes(pack.seconds_total / 60)}
                    </td>
                    <td className="when">{pack.ends_at ? date(pack.ends_at) : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No packs bought yet.</Empty>
        )}
      </Panel>
    </>
  );
}
