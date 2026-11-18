import type { Metadata } from "next";
import Link from "next/link";

import { Empty, Pager, Panel, pageNumber, param } from "@/components/ui";
import { ago, count, date, signInMethods, words } from "@/lib/format";
import { accountList, PAGE_SIZE } from "@/lib/queries";
import { adminDatabase } from "@/lib/session";

export const metadata: Metadata = { title: "Accounts" };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function AccountsPage({ searchParams }: { searchParams: Search }) {
  const query = await searchParams;
  const search = param(query.q);
  const page = pageNumber(query.page);
  const db = await adminDatabase();
  const rows = await accountList(db, { search, page });
  const total = rows[0]?.total ?? 0;
  return (
    <>
      <h1>Accounts</h1>
      <p className="lead">Everyone who can sign in, newest first. Search by name, email, phone number or ID.</p>
      <form className="filters" method="get" action="/accounts">
        <input type="search" name="q" defaultValue={search} placeholder="Name, email, phone or ID" aria-label="Search accounts" />
        <button type="submit">Search</button>
        {search ? <Link href="/accounts">Clear</Link> : null}
      </form>
      <Panel title={search ? "Matching accounts" : "All accounts"} aside={`${count(total)} in all`}>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Phone</th>
                  <th>Owns</th>
                  <th className="num">Businesses</th>
                  <th>Signs in with</th>
                  <th>Last seen</th>
                  <th>Signed up</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <Link href={`/accounts/${account.id}`}>{account.name || account.email}</Link>
                      <span className="sub">
                        {account.name ? `${account.email}, ` : ""}
                        {account.email_verified ? "verified" : "not verified"}
                        {account.platform_role !== "operator" ? `, ${words(account.platform_role)}` : ""}
                      </span>
                    </td>
                    <td>
                      {account.phone || "-"}
                      {account.phone ? <span className="sub">{account.phone_verified_at ? "verified" : "not verified"}</span> : null}
                    </td>
                    <td>{account.owns ?? "-"}</td>
                    <td className="num">{count(account.businesses)}</td>
                    <td>{signInMethods(account.sign_in_methods)}</td>
                    <td className="when">{ago(account.last_seen_at)}</td>
                    <td className="when">{date(account.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{search ? "No account matches." : "No accounts yet."}</Empty>
        )}
        <Pager path="/accounts" params={{ q: search }} page={page} total={total} pageSize={PAGE_SIZE} />
      </Panel>
    </>
  );
}
