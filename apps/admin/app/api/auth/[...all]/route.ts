import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";
import { logAuthRateLimit } from "@/lib/auth-events";
import { withOAuthClientCors, oauthClientPreflight } from "@/lib/oauth-cors";
import { attachVerificationFlow } from "@/lib/verification-flow";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const response = await toNextJsHandler(getAuth()).GET(request);
  logAuthRateLimit(request, response);
  return response;
}

export async function POST(request: Request) {
  const signup = new URL(request.url).pathname === "/api/auth/sign-up/email";
  const body = signup ? await request.clone().json().catch(() => null) as { email?: unknown } | null : null;
  const response = await toNextJsHandler(getAuth()).POST(request);
  logAuthRateLimit(request, response);
  // The signup hook validates Turnstile before Better Auth accepts the request.
  // Generic duplicate-signup success receives the same proof as a new account.
  if (signup && response.ok && typeof body?.email === "string") attachVerificationFlow(response, body.email);
  return withOAuthClientCors(request, response);
}

export function OPTIONS(request: Request) {
  return oauthClientPreflight(request);
}
