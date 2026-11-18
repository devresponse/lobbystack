import { headers } from "next/headers";

import { verifyAccessRequest } from "./access";
import { database, type Queryable } from "./db";

/** The signed-in operator's email. proxy.ts has already checked it; a page asks again before it reads anything. */
export async function currentAdmin(): Promise<string> {
  const access = await verifyAccessRequest(await headers());
  if (!access.ok) throw new Error("This page needs a Cloudflare Access sign-in for an email the control panel allows.");
  return access.email;
}

/** The database, for a request from an allowed operator only. */
export async function adminDatabase(): Promise<Queryable> {
  await currentAdmin();
  return await database();
}
