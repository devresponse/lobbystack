import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Empty, Panel, Status } from "@/components/ui";
import { ago, count, counted, date, dateTime, duration, minutes, money, monthName, usd, words } from "@/lib/format";
import {
  businessCosts,
  businessDetail,
  businessMembers,
  businessPhoneNumbers,
  businessReceptionists,
  businessUsageMonths,
  monthlyActivity,
  packs,
  pendingInvitations,
  recentCalls,
  transactions,
} from "@/lib/queries";
import { adminDatabase } from "@/lib/session";

export const metadata: Metadata = { title: "Business" };

const CALL_CHANNEL: Record<string, string> = { web_voice: "website", voice: "phone", pstn: "phone", sip: "phone" };

export default async function BusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await adminDatabase();
  const business = await businessDetail(db, id);
  if (!business) notFound();
  const [members, invitations, numbers, receptionists, usage, activity, costs, calls, payments, bought] = await Promise.all([
    businessMembers(db, id),
    pendingInvitations(db, id),
    businessPhoneNumbers(db, id),
    businessReceptionists(db, id),
    businessUsageMonths(db, id),
    monthlyActivity(db, { businessId: id }),
    businessCosts(db, id),
    recentCalls(db, id),
    transactions(db, { businessId: id, limit: 20 }),
    packs(db, { businessId: id, limit: 20 }),
  ]);
  const address = [business.address_line1, business.address_line2, business.city, business.region, business.postal_code, business.country_code].filter(Boolean).join(", ");
  return (
    <>
      <div className="crumbs">
        <Link href="/businesses">Businesses</Link> / {business.slug}
      </div>
      <h1>{business.name}</h1>
      <p className="lead">
        <Status value={business.status} /> · created {date(business.created_at)} · ID {business.id}
      </p>

      <div className="grid-2">
        <Panel title="Business">
          <dl className="facts">
            <dt>Legal name</dt>
            <dd>{business.legal_name || "-"}</dd>
            <dt>Type</dt>
            <dd>{words(business.business_type)}</dd>
            <dt>Mode</dt>
            <dd>{words(business.deployment_mode)}</dd>
            <dt>Website</dt>
            <dd>{business.website_url || "-"}</dd>
            <dt>Time zone</dt>
            <dd>{business.timezone}</dd>
            <dt>Language</dt>
            <dd>{business.default_locale}</dd>
            <dt>Setup step</dt>
            <dd>{words(business.onboarding_stage)}</dd>
            <dt>Came from</dt>
            <dd>{business.onboarding_attribution || "-"}</dd>
            <dt>Public page</dt>
            <dd>{business.published ? `published${business.category ? `, ${business.category}` : ""}` : "not published"}</dd>
            <dt>Public email</dt>
            <dd>{business.public_email || "-"}</dd>
            <dt>Address</dt>
            <dd>{address || "-"}</dd>
            {business.canceled_at ? (
              <>
                <dt>Canceled</dt>
                <dd>{dateTime(business.canceled_at)}</dd>
              </>
            ) : null}
          </dl>
        </Panel>

        <Panel title="Billing">
          {business.billing_source ? (
            <dl className="facts">
              <dt>Plan</dt>
              <dd>
                {business.plan_name ? `${business.plan_name} (${business.plan})` : business.plan || "-"}
                {business.billing_interval ? `, ${business.billing_interval}` : ""}
              </dd>
              <dt>Subscription</dt>
              <dd>
                <Status value={business.subscription_state} />
              </dd>
              <dt>Billed by</dt>
              <dd>{business.billing_source}</dd>
              <dt>This period</dt>
              <dd>{business.current_period_start ? `${date(business.current_period_start)} to ${date(business.current_period_end)}` : "-"}</dd>
              <dt>Overage cap</dt>
              <dd>{business.overage_spending_cap_cents === null ? "none" : money(business.overage_spending_cap_cents, "USD")}</dd>
              {business.cancel_at ? (
                <>
                  <dt>Ends</dt>
                  <dd>{dateTime(business.cancel_at)}</dd>
                </>
              ) : null}
              {business.plan_ends ? (
                <>
                  <dt>Plan runs out</dt>
                  <dd>{dateTime(business.plan_ends)}</dd>
                </>
              ) : null}
              {business.next_plan_code ? (
                <>
                  <dt>Changes to</dt>
                  <dd>
                    {business.next_plan_code}
                    {business.next_interval ? `, ${business.next_interval}` : ""} on {date(business.next_change_at)}
                  </dd>
                </>
              ) : null}
              <dt>Customer</dt>
              <dd>{business.customer_id || "-"}</dd>
              <dt>Subscription ID</dt>
              <dd>{business.subscription_id || "-"}</dd>
            </dl>
          ) : (
            <Empty>No billing account: this business has never subscribed.</Empty>
          )}
        </Panel>
      </div>

      <Panel title="Team" aside={counted(members.length, "person", "people")}>
        {members.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.user_id}>
                    <td>
                      <Link href={`/accounts/${member.user_id}`}>{member.name || "(no name)"}</Link>
                    </td>
                    <td>
                      {member.email}
                      <span className="sub">{member.email_verified ? "verified" : "not verified"}</span>
                    </td>
                    <td>
                      {member.phone || "-"}
                      {member.phone ? <span className="sub">{member.phone_verified_at ? "verified" : "not verified"}</span> : null}
                    </td>
                    <td>{words(member.role)}</td>
                    <td>
                      <Status value={member.status} />
                    </td>
                    <td className="when">{date(member.joined_at)}</td>
                    <td className="when">{ago(member.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nobody is on this business&apos;s team.</Empty>
        )}
        {invitations.length ? (
          <>
            <h2>Invitations waiting</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Sent</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>{invitation.email}</td>
                      <td>
                        {words(invitation.role)}
                        {invitation.transfers_ownership ? <span className="sub">hands the business over</span> : null}
                      </td>
                      <td className="when">{date(invitation.created_at)}</td>
                      <td className="when">{date(invitation.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Panel>

      <div className="grid-2">
        <Panel title="Phone numbers">
          {numbers.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Status</th>
                    <th>Answers</th>
                    <th>Receptionist</th>
                  </tr>
                </thead>
                <tbody>
                  {numbers.map((number) => (
                    <tr key={number.id}>
                      <td>
                        {number.e164}
                        <span className="sub">since {date(number.created_at)}</span>
                      </td>
                      <td>
                        <Status value={number.status} />
                        {number.reclaim_scheduled_at ? <span className="sub">released {date(number.reclaim_scheduled_at)}</span> : null}
                      </td>
                      <td>
                        {[number.voice_enabled ? "calls" : null, number.sms_enabled ? "texts" : null].filter(Boolean).join(" and ") || "nothing"}
                        {number.voice_webhook_status && number.voice_webhook_status !== "synced" ? <span className="sub">calls webhook {words(number.voice_webhook_status)}</span> : null}
                        {number.sms_webhook_status && number.sms_webhook_status !== "synced" ? <span className="sub">texts webhook {words(number.sms_webhook_status)}</span> : null}
                      </td>
                      <td>{number.receptionist ?? "the default one"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No phone numbers.</Empty>
          )}
        </Panel>

        <Panel title="Receptionists">
          {receptionists.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Language</th>
                    <th>Booking</th>
                    <th>Transfers</th>
                  </tr>
                </thead>
                <tbody>
                  {receptionists.map((receptionist) => (
                    <tr key={receptionist.id}>
                      <td>
                        {receptionist.name}
                        <span className="sub">
                          {receptionist.is_default ? "default" : receptionist.handle ? `/${receptionist.handle}` : ""}
                          {receptionist.listed ? "" : " (not listed)"}
                        </span>
                      </td>
                      <td>
                        <Status value={receptionist.archived_at ? "archived" : receptionist.status} />
                      </td>
                      <td>{receptionist.locale ?? business.default_locale}</td>
                      <td>{words(receptionist.booking_mode)}</td>
                      <td>{words(receptionist.transfer_mode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No receptionists.</Empty>
          )}
        </Panel>
      </div>

      <Panel title="Month by month" aside="activity, and what billing counted">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
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
                <th className="num">Cost to serve</th>
              </tr>
            </thead>
            <tbody>
              {[...activity].reverse().map((month) => {
                const billed = usage.find((row) => row.period_key === month.month);
                const cost = costs.find((row) => row.month_key === month.month);
                return (
                  <tr key={month.month}>
                    <td>{monthName(month.month)}</td>
                    <td className="num">{count(month.calls)}</td>
                    <td className="num">{minutes(month.minutes)}</td>
                    <td className="num">{count(month.texts)}</td>
                    <td className="num">{count(month.chats)}</td>
                    <td className="num">{count(month.bookings)}</td>
                    <td className="num">{billed ? minutes(billed.voice_seconds_used / 60) : "-"}</td>
                    <td className="num">{billed ? count(billed.alert_sms_segments_used) : "-"}</td>
                    <td className="num">{billed ? count(billed.outbound_call_attempts_used) : "-"}</td>
                    <td className="num">{billed ? count(billed.chat_ai_tokens_used) : "-"}</td>
                    <td className="num">{billed ? money(billed.overage_spend_cents, "USD") : "-"}</td>
                    <td>{billed?.blocked ?? "-"}</td>
                    <td className="num">{cost ? usd(cost.total_cost_usd) : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Latest calls" aside="25 newest">
        {calls.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th>Receptionist</th>
                  <th className="num">Length</th>
                  <th className="num">Phone cost</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id}>
                    <td className="when">{dateTime(call.started_at)}</td>
                    <td>
                      {CALL_CHANNEL[call.transport] ?? words(call.transport)}
                      {call.session_purpose ? <span className="sub">{words(call.session_purpose)}</span> : null}
                    </td>
                    <td>
                      <Status value={call.status} />
                    </td>
                    <td>
                      {words(call.disposition)}
                      {call.billing_excluded ? <span className="sub">not billed</span> : null}
                    </td>
                    <td>{call.receptionist ?? "-"}</td>
                    <td className="num">{duration(call.seconds)}</td>
                    <td className="num">{call.provider_cost_usd === null ? "-" : usd(call.provider_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No calls yet.</Empty>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Payments">
          {payments.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="when">{date(payment.occurred_at)}</td>
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
            <Empty>No payments.</Empty>
          )}
        </Panel>

        <Panel title="Prepaid packs">
          {bought.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pack</th>
                    <th>Status</th>
                    <th className="num">Minutes used</th>
                    <th>Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {bought.map((pack) => (
                    <tr key={pack.id}>
                      <td>
                        {pack.pack}
                        <span className="sub">
                          {money(pack.amount_cents, pack.currency)} on {date(pack.paid_at)}
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
            <Empty>No packs bought.</Empty>
          )}
        </Panel>
      </div>
    </>
  );
}
