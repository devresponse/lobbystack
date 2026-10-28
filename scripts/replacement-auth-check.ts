import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { accounts, createDatabaseClient, users } from "@lobbystack/db";

import { hashReplacementPassword, replacementPasswordPrefix } from "../apps/admin/src/lib/password";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cookieFromResponse(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/((?:__Secure-)?better-auth\.session_token=[^;]+)/);
  assert(match?.[1], "Better Auth sign-in did not return a session cookie.");
  return match[1];
}

async function main(): Promise<void> {
  const adminBaseUrl = process.env.ADMIN_BASE_URL ?? "http://127.0.0.1:13000";
  const auth = createDatabaseClient("lobbystack_auth");
  const userId = randomUUID();
  const email = `${userId}@auth-check.invalid`;
  const password = `Legacy-Pass-${randomUUID()}!`;
  try {
    const legacyHash = (await hashReplacementPassword(password)).slice(replacementPasswordPrefix.length);
    assert(!legacyHash.startsWith(replacementPasswordPrefix), "Test fixture is not a legacy Scrypt hash.");
    await auth.db.insert(users).values({ id: userId, email, normalizedEmail: email, emailVerified: true });
    await auth.db.insert(accounts).values({ userId, providerId: "credential", accountId: userId, password: legacyHash });

    const firstAttempt = await fetch(`${adminBaseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: adminBaseUrl },
      body: JSON.stringify({ email, password }),
    });
    assert(firstAttempt.ok, `Legacy-password sign-in failed with status ${firstAttempt.status}: ${await firstAttempt.text()}`);
    const cookie = cookieFromResponse(firstAttempt);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const stored = (await auth.db.select({ accountPassword: accounts.password, userHash: users.passwordHash }).from(accounts).innerJoin(users, eq(users.id, accounts.userId)).where(eq(users.id, userId)).limit(1))[0];
    assert(stored?.accountPassword?.startsWith("lobbystack-scrypt-v1:"), "Legacy password was not rehashed after sign-in.");
    // Sign-in reads only the account's password, so the rehash leaves no copy on the user.
    assert(stored?.userHash === null, "The rehash copied the password hash onto the user.");

    const session = await fetch(`${adminBaseUrl}/api/auth/get-session`, { headers: { cookie } });
    const sessionBody = await session.json() as { user?: { id?: string } } | null;
    assert(session.ok && sessionBody?.user?.id === userId, "Rehashed sign-in session is not valid.");

    const secondAttempt = await fetch(`${adminBaseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: adminBaseUrl },
      body: JSON.stringify({ email, password }),
    });
    assert(secondAttempt.ok, `Repeated sign-in after rehash failed with status ${secondAttempt.status}.`);
    assert((await secondAttempt.json() as { user?: { id?: string } }).user?.id === userId, "Repeated sign-in did not return the rehashed user.");

    console.log(JSON.stringify({ legacyHashAccepted: true, rehashedAfterLogin: true, sessionValid: true, repeatSignInOk: true, noUserCopy: true }));
  } finally {
    await auth.db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
    await auth.pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
