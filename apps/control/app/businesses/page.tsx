import type { Metadata } from "next";
import Link from "next/link";

import { Empty, Pager, Panel, Status, pageNumber, param } from "@/components/ui";
import { ago, count, date, minutes, words } from "@/lib/format";
import { businessList, businessStatusCounts, PAGE_SIZE } from "@/lib/queries";
import { adminDatabase } from "@/lib/session";

export const metadata: Metadata = { title: "Businesses" };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function BusinessesPage({ searchParams }: { searchParams: Search }) {
  const query = await searchParams;
  const search = param(query.q);
  const status = param(query.status);
  const page = pageNumber(query.page);
  const db = await adminDatabase();
  const [rows, statuses] = await Promise.all([businessList(db, { search, status, page }), businessStatusCounts(db)]);
  const total = rows[0]?.total ?? 0;
  return (
    <>
      <h1>Businesses</h1>
      <p className="lead">Newest first. Search by name, address slug, ID, or a team member&apos;s name, email or phone number.</p>
      <form className="filters" method="get" action="/businesses">
        <input type="search" name="q" defaultValue={search} placeholder="Name, email, phone or ID" aria-label="Search businesses" />
        <select name="status" defaultValue={status} aria-label="Status">
          <option value="">Every status</option>
          {statuses.map((row) => (
            <option key={row.status} value={row.status}>
              {words(row.status)} ({count(row.businesses)})
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
        {search || status ? <Link href="/businesses">Clear</Link> : null}
      </form>
      <Panel title={search || status ? "Matching businesses" : "All businesses"} aside={`${count(total)} in all`}>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th className="num">Team</th>
                  <th className="num">Numbers</th>
                  <th className="num">Calls this month</th>
                  <th className="num">Minutes</th>
                  <th>Last call</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((business) => (
                  <tr key={business.id}>
                    <td>
                      <Link href={`/businesses/${business.id}`}>{business.name}</Link>
                      <span className="sub">{business.slug}</span>
                    </td>
                    <td>
                      {business.owner_email ? (
                        <>
                          {business.owner_name || business.owner_email}
                          {business.owner_name ? <span className="sub">{business.owner_email}</span> : null}
                          {business.owner_phone ? <span className="sub">{business.owner_phone}</span> : null}
                        </>
                      ) : (
                        <span className="sub">no owner</span>
                      )}
                    </td>
                    <td>
                      <Status value={business.status} />
                    </td>
                    <td>
                      {business.plan ?? (business.deployment_mode === "cloud" ? "none" : words(business.deployment_mode))}
                      {business.subscription_state ? <span className="sub">{words(business.subscription_state)}</span> : null}
                    </td>
                    <td className="num">{count(business.members)}</td>
                    <td className="num">{count(business.phone_numbers)}</td>
                    <td className="num">{count(business.calls_this_month)}</td>
                    <td className="num">{minutes(business.minutes_this_month)}</td>
                    <td className="when">{business.last_call_at ? ago(business.last_call_at) : "never"}</td>
                    <td className="when">{date(business.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{search || status ? "No business matches." : "No businesses yet."}</Empty>
        )}
        <Pager path="/businesses" params={{ q: search, status }} page={page} total={total} pageSize={PAGE_SIZE} />
      </Panel>
    </>
  );
}
