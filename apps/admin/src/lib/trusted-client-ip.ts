import { isIP } from "node:net";

/**
 * Ingress headers we are willing to trust once the deployment explicitly opts
 * in. Both are single-value headers that a managed edge proxy overwrites:
 * Railway replaces `x-real-ip`, Cloudflare overwrites `cf-connecting-ip`.
 * `x-forwarded-for` is intentionally excluded because it is appended to and
 * carries a proxy hop, so its leftmost value is caller-controlled.
 */
const TRUSTED_CLIENT_IP_HEADERS = ["x-real-ip", "cf-connecting-ip"] as const;
type TrustedClientIpHeader = (typeof TRUSTED_CLIENT_IP_HEADERS)[number];

let warnedUnconfigured = false;

/** Whether the server runs on Railway, whose edge proxy writes x-real-ip on every request it passes on. */
function onRailway(env: Record<string, string | undefined>): boolean {
  return Boolean(env.RAILWAY_PROJECT_ID?.trim() || env.RAILWAY_ENVIRONMENT_ID?.trim() || env.RAILWAY_SERVICE_ID?.trim());
}

/**
 * Why a production admin on Railway must not start (AUDIT-004): without a
 * trusted header the website chat's and sign-in's limits per IP address don't
 * run, and a script can make up visitors without end. Railway's proxy always
 * writes x-real-ip, so one of the two headers always fits there. Null when the
 * setting is right, off Railway, where the admin can't tell which proxy is in
 * front of it, outside production, and during a build, which serves no one.
 */
export function trustedClientIpStartupError(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build" || !onRailway(env) || trustedClientIpHeader(env)) return null;
  const configured = env.TRUSTED_CLIENT_IP_HEADER?.trim();
  const fix = "On Railway set it to x-real-ip, which Railway's proxy writes on every request, or to cf-connecting-ip when Cloudflare's proxy sits in front of Railway.";
  return configured
    ? `[trusted-client-ip] TRUSTED_CLIENT_IP_HEADER is "${configured}", which the admin doesn't accept. ${fix}`
    : `[trusted-client-ip] TRUSTED_CLIENT_IP_HEADER is not set, so the website chat's and sign-in's limits per IP address would not run. ${fix}`;
}

export function trustedClientIpHeader(
  env: Record<string, string | undefined> = process.env,
): TrustedClientIpHeader | undefined {
  const configured = env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  return TRUSTED_CLIENT_IP_HEADERS.find((header) => header === configured);
}

/**
 * Emit a single production warning when no trusted header is configured. The
 * request still fails closed (callers fall back to shared limits), but the
 * operator is told why per-client attribution is unavailable instead of the
 * degradation staying silent.
 */
function warnTrustedClientIpUnconfigured(env: Record<string, string | undefined>): void {
  if (warnedUnconfigured || env.NODE_ENV !== "production") return;
  warnedUnconfigured = true;
  console.warn(
    "[trusted-client-ip] TRUSTED_CLIENT_IP_HEADER is not configured; per-client IP attribution is disabled and requests share one fallback bucket. Set it to x-real-ip or cf-connecting-ip only after verifying the ingress overwrites that header.",
  );
}

/**
 * Resolve a client IP only from the deployment's opted-in, ingress-controlled
 * header. Without that opt-in nothing is trusted: callers must treat
 * `undefined` as "no attributable client" and apply shared/global limits rather
 * than letting a caller-forged forwarding header mint identity. Multi-value or
 * non-IP values are rejected for the same reason.
 */
export function trustedClientIpFromHeaders(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const header = trustedClientIpHeader(env);
  if (!header) {
    warnTrustedClientIpUnconfigured(env);
    return undefined;
  }
  const value = headers.get(header)?.trim();
  return value && isIP(value) !== 0 ? value : undefined;
}

export function trustedClientIp(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return trustedClientIpFromHeaders(request.headers, env);
}
