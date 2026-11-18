import { createPublicKey, verify, type KeyObject, type webcrypto } from "node:crypto";

import { accessSettings, developmentAdmin, type AccessSettings } from "./config";

/**
 * Cloudflare Access signs each request it lets through with a JWT in the
 * Cf-Access-Jwt-Assertion header. The panel checks it on every request, so a
 * request that reached the service any other way, such as from another service
 * on Railway's private network, gets nothing.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export const ACCESS_HEADER = "cf-access-jwt-assertion";

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; status: 403 | 503; reason: string };

type Keys = (teamDomain: string, kid: string) => Promise<KeyObject | null>;

type Claims = { aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown; email?: unknown };

const CLOCK_SKEW_SECONDS = 60;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The email a Cloudflare Access token was issued to, once its signature, audience,
 * issuer and times check out and the email is one the panel lets in.
 */
export async function verifyAccessToken(token: string, settings: AccessSettings, keys: Keys = cloudflareKeys, now = Date.now()): Promise<AccessResult> {
  const deny = (reason: string): AccessResult => ({ ok: false, status: 403, reason });
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return deny("malformed");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader);
  if (header?.alg !== "RS256" || typeof header.kid !== "string") return deny("malformed");
  const key = await keys(settings.teamDomain, header.kid);
  if (!key) return deny("unknown_key");
  const signed = verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, Buffer.from(encodedSignature, "base64url"));
  if (!signed) return deny("bad_signature");
  const claims = decodeJson(encodedClaims) as Claims | null;
  if (!claims) return deny("malformed");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(settings.audience)) return deny("audience");
  if (claims.iss !== `https://${settings.teamDomain}`) return deny("issuer");
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return deny("expired");
  if (typeof claims.nbf === "number" && claims.nbf > seconds + CLOCK_SKEW_SECONDS) return deny("not_yet_valid");
  if (typeof claims.iat === "number" && claims.iat > seconds + CLOCK_SKEW_SECONDS) return deny("not_yet_valid");
  // A service token carries no email; only people use the panel.
  if (typeof claims.email !== "string" || !claims.email) return deny("no_email");
  const email = claims.email.toLowerCase();
  if (!settings.adminEmails.has(email)) return deny("not_allowed");
  return { ok: true, email };
}

/** Who sent a request, from its headers: the developer's own email on their computer, else Cloudflare Access's token. */
export async function verifyAccessRequest(headers: Headers, env: Record<string, string | undefined> = process.env, keys: Keys = cloudflareKeys): Promise<AccessResult> {
  const developer = developmentAdmin(env);
  if (developer) return { ok: true, email: developer };
  const settings = accessSettings(env);
  if ("problem" in settings) return { ok: false, status: 503, reason: settings.problem };
  const token = headers.get(ACCESS_HEADER);
  if (!token) return { ok: false, status: 403, reason: "missing" };
  return await verifyAccessToken(token, settings, keys);
}

// ---------------------------------------------------------------- Cloudflare's signing keys

const KEYS_TTL_MS = 60 * 60 * 1000;
// A token signed with a key the panel hasn't seen fetches the list again, but at most this often.
const UNKNOWN_KEY_REFETCH_MS = 30 * 1000;

type KeySet = { fetchedAt: number; keys: Map<string, KeyObject> };
const keySets = new Map<string, KeySet>();
const pending = new Map<string, Promise<KeySet>>();

async function fetchKeySet(teamDomain: string): Promise<KeySet> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok) throw new Error(`Cloudflare Access's signing keys answered ${response.status}.`);
  const body = (await response.json()) as { keys?: unknown };
  const keys = new Map<string, KeyObject>();
  for (const jwk of Array.isArray(body.keys) ? (body.keys as Array<webcrypto.JsonWebKey & { kid?: unknown }>) : []) {
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    } catch {
      // A key Node can't read can't have signed a token the panel accepts.
    }
  }
  return { fetchedAt: Date.now(), keys };
}

async function refreshKeySet(teamDomain: string): Promise<KeySet> {
  let request = pending.get(teamDomain);
  if (!request) {
    request = fetchKeySet(teamDomain).finally(() => pending.delete(teamDomain));
    pending.set(teamDomain, request);
  }
  const keySet = await request;
  keySets.set(teamDomain, keySet);
  return keySet;
}

/** Cloudflare's public key with this ID, from the team's signing keys, which Cloudflare rotates every six weeks by default. */
export async function cloudflareKeys(teamDomain: string, kid: string): Promise<KeyObject | null> {
  let keySet = keySets.get(teamDomain);
  const age = keySet ? Date.now() - keySet.fetchedAt : Infinity;
  if (!keySet || age > KEYS_TTL_MS || (!keySet.keys.has(kid) && age > UNKNOWN_KEY_REFETCH_MS)) {
    try {
      keySet = await refreshKeySet(teamDomain);
    } catch (error) {
      console.error(`control: couldn't fetch Cloudflare Access's signing keys: ${error instanceof Error ? error.message : String(error)}`);
      if (!keySet) return null;
    }
  }
  return keySet.keys.get(kid) ?? null;
}
