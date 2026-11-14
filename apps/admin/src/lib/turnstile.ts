const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type TurnstileResponse = {
  success?: boolean;
  "error-codes"?: string[];
};

/**
 * Why a Turnstile check didn't pass: the deployment has no secret key, the
 * request carried no token, Cloudflare turned the token down, or Cloudflare
 * couldn't be asked. Only the last is worth trying again with the same token.
 */
export type TurnstileFailure = "not_configured" | "missing" | "rejected" | "unavailable";

export class TurnstileError extends Error {
  readonly reason: TurnstileFailure;

  constructor(message: string, reason: TurnstileFailure) {
    super(message);
    this.name = "TurnstileError";
    this.reason = reason;
  }
}

function isLocalApp(): boolean {
  const baseUrl = process.env.APP_BASE_URL?.trim();
  return Boolean(baseUrl?.startsWith("http://localhost:") || baseUrl?.startsWith("http://127.0.0.1:"));
}

export async function verifyTurnstile(input: { token?: unknown; remoteIp?: string | null }): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    if (isLocalApp()) return;
    throw new TurnstileError("Turnstile is not configured.", "not_configured");
  }
  const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : undefined;
  if (!token) {
    throw new TurnstileError("Turnstile verification is required.", "missing");
  }
  const body = new URLSearchParams({ secret, response: token });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);
  let response: Response;
  try {
    response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new TurnstileError("Turnstile verification failed.", "unavailable");
  }
  if (!response.ok) {
    throw new TurnstileError("Turnstile verification failed.", response.status >= 500 || response.status === 429 ? "unavailable" : "rejected");
  }
  const outcome = (await response.json().catch(() => null)) as TurnstileResponse | null;
  if (!outcome) {
    throw new TurnstileError("Turnstile verification failed.", "unavailable");
  }
  if (outcome.success !== true) {
    // Cloudflare's own fault, as opposed to a bad token.
    throw new TurnstileError("Turnstile verification failed.", outcome["error-codes"]?.includes("internal-error") ? "unavailable" : "rejected");
  }
}
