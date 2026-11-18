import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Empty, Panel, Status } from "@/components/ui";
import { ago, count, counted, date, dateTime, signInMethods, words } from "@/lib/format";
import { accountDetail, accountMemberships } from "@/lib/queries";
import { adminDatabase } from "@/lib/session";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await adminDatabase();
  const account = await accountDetail(db, id);
  if (!account) notFound();
  const memberships = await accountMemberships(db, id);
  return (
    <>
      <div className="crumbs">
        <Link href="/accounts">Accounts</Link> / {account.email}
      </div>
      <h1>{account.name || account.email}</h1>
      <p className="lead">
        Signed up {date(account.created_at)} · last seen {ago(account.last_seen_at)} · ID {account.id}
      </p>

      <div className="grid-2">
        <Panel title="Account">
          <dl className="facts">
            <dt>Name</dt>
            <dd>{account.name || "-"}</dd>
            <dt>Email</dt>
            <dd>
              {account.email} ({account.email_verified ? "verified" : "not verified"})
            </dd>
            <dt>Phone</dt>
            <dd>{account.phone ? `${account.phone} (${account.phone_verified_at ? `verified ${date(account.phone_verified_at)}` : "not verified"})` : "-"}</dd>
            <dt>Platform role</dt>
            <dd>{words(account.platform_role)}</dd>
            <dt>Language</dt>
            <dd>{account.preferred_locale}</dd>
            {account.created_by_partner_id ? (
              <>
                <dt>Made by partner</dt>
                <dd>{account.created_by_partner_id}</dd>
              </>
            ) : null}
            <dt>Changed</dt>
            <dd>{dateTime(account.updated_at)}</dd>
          </dl>
        </Panel>

        <Panel title="Signing in">
          <dl className="facts">
            <dt>Signs in with</dt>
            <dd>{signInMethods(account.sign_in_methods)}</dd>
            <dt>Open sign-ins</dt>
            <dd>{count(account.open_sessions)}</dd>
            <dt>Oldest on file</dt>
            <dd>{dateTime(account.first_sign_in)}</dd>
            <dt>Latest sign-in</dt>
            <dd>{dateTime(account.last_sign_in)}</dd>
            <dt>Last seen</dt>
            <dd>{account.last_seen_at ? `${dateTime(account.last_seen_at)} (${ago(account.last_seen_at)})` : "never"}</dd>
          </dl>
          <p className="note">Signing out removes a sign-in&apos;s record, so these count only the sign-ins still on file.</p>
        </Panel>
      </div>

      <Panel title="Businesses" aside={counted(memberships.length, "membership", "memberships")}>
        {memberships.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Role</th>
                  <th>Membership</th>
                  <th>Business status</th>
                  <th>Plan</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((membership) => (
                  <tr key={membership.business_id}>
                    <td>
                      <Link href={`/businesses/${membership.business_id}`}>{membership.name}</Link>
                    </td>
                    <td>{words(membership.role)}</td>
                    <td>
                      <Status value={membership.membership_status} />
                    </td>
                    <td>
                      <Status value={membership.status} />
                    </td>
                    <td>
                      {membership.plan ?? "-"}
                      {membership.subscription_state ? <span className="sub">{words(membership.subscription_state)}</span> : null}
                    </td>
                    <td className="when">{date(membership.joined_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>This account isn&apos;t on any business&apos;s team.</Empty>
        )}
      </Panel>
    </>
  );
}
