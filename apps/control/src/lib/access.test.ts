import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCESS_HEADER, cloudflareKeys, verifyAccessRequest, verifyAccessToken } from "./access";
import type { AccessSettings } from "./config";

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const settings: AccessSettings = { teamDomain: TEAM, audience: AUD, adminEmails: new Set(["owner@example.com"]) };
const env = { CONTROL_ACCESS_TEAM_DOMAIN: TEAM, CONTROL_ACCESS_AUD: AUD, CONTROL_ADMIN_EMAILS: "owner@example.com" };

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = (team: string, kid: string) => Promise.resolve(team === TEAM && kid === "key-1" ? publicKey : null);

const NOW = Date.UTC(2026, 10, 18, 12);
const SECONDS = NOW / 1000;
const claims = { aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 600, iat: SECONDS - 5, nbf: SECONDS - 5, email: "Owner@Example.com", type: "app" };

function token(body: Record<string, unknown>, { kid = "key-1", alg = "RS256", key = privateKey }: { kid?: string; alg?: string; key?: KeyObject } = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = `${encode({ alg, kid, typ: "JWT" })}.${encode(body)}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url")}`;
}

const check = (value: string) => verifyAccessToken(value, settings, keys, NOW);

describe("a Cloudflare Access token", () => {
  it("lets in an allowed email, in lower case, once everything checks out", async () => {
    await expect(check(token(claims))).resolves.toEqual({ ok: true, email: "owner@example.com" });
    await expect(check(token({ ...claims, aud: AUD }))).resolves.toEqual({ ok: true, email: "owner@example.com" });
  });

  it("turns away an email the panel doesn't list, even one Access let through", async () => {
    await expect(check(token({ ...claims, email: "someone@example.com" }))).resolves.toEqual({ ok: false, status: 403, reason: "not_allowed" });
  });

  it("turns away a service token, which carries no email", async () => {
    const { email: _email, ...service } = claims;
    await expect(check(token({ ...service, common_name: "robot" }))).resolves.toMatchObject({ ok: false, reason: "no_email" });
  });

  it("turns away another application's token, another team's, and an old one", async () => {
    await expect(check(token({ ...claims, aud: ["another-application-audience-tag"] }))).resolves.toMatchObject({ ok: false, reason: "audience" });
    await expect(check(token({ ...claims, iss: "https://another-team.cloudflareaccess.com" }))).resolves.toMatchObject({ ok: false, reason: "issuer" });
    await expect(check(token({ ...claims, exp: SECONDS - 1 }))).resolves.toMatchObject({ ok: false, reason: "expired" });
    const { exp: _exp, ...forever } = claims;
    await expect(check(token(forever))).resolves.toMatchObject({ ok: false, reason: "expired" });
  });

  it("allows a minute of clock difference, and no more", async () => {
    await expect(check(token({ ...claims, nbf: SECONDS + 30, iat: SECONDS + 30 }))).resolves.toMatchObject({ ok: true });
    await expect(check(token({ ...claims, nbf: SECONDS + 120 }))).resolves.toMatchObject({ ok: false, reason: "not_yet_valid" });
    await expect(check(token({ ...claims, iat: SECONDS + 120 }))).resolves.toMatchObject({ ok: false, reason: "not_yet_valid" });
  });

  it("turns away a token signed by anyone but Cloudflare", async () => {
    await expect(check(token(claims, { key: stranger.privateKey }))).resolves.toMatchObject({ ok: false, reason: "bad_signature" });
    await expect(check(token(claims, { kid: "key-2" }))).resolves.toMatchObject({ ok: false, reason: "unknown_key" });
    const [head, , signature] = token(claims).split(".");
    const forged = `${head}.${Buffer.from(JSON.stringify({ ...claims, email: "owner@example.com", exp: SECONDS + 99_999 })).toString("base64url")}.${signature}`;
    await expect(check(forged)).resolves.toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("turns away anything that isn't a signed RS256 token", async () => {
    for (const value of ["", "a.b", "a.b.c.d", "not a token", token(claims).replace(/\.[^.]*$/, ".")]) {
      await expect(check(value)).resolves.toMatchObject({ ok: false, status: 403, reason: "malformed" });
    }
    await expect(check(token(claims, { alg: "HS256" }))).resolves.toMatchObject({ ok: false, reason: "malformed" });
    await expect(check(token(claims, { alg: "none" }))).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("a request to the panel", () => {
  const headers = (value?: string) => new Headers(value === undefined ? {} : { [ACCESS_HEADER]: value });

  it("is answered 503 until Access is set up, so a half set-up panel stays shut", async () => {
    await expect(verifyAccessRequest(headers(token(claims)), {}, keys)).resolves.toMatchObject({ ok: false, status: 503 });
    await expect(verifyAccessRequest(headers(token(claims)), { ...env, CONTROL_ADMIN_EMAILS: "" }, keys)).resolves.toMatchObject({ ok: false, status: 503 });
  });

  it("needs Access's token", async () => {
    await expect(verifyAccessRequest(headers(), env, keys)).resolves.toEqual({ ok: false, status: 403, reason: "missing" });
  });

  it("is let in with a good token", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      await expect(verifyAccessRequest(headers(token(claims)), env, keys)).resolves.toEqual({ ok: true, email: "owner@example.com" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is let in as the developer on a developer's computer, without Access", async () => {
    await expect(verifyAccessRequest(headers(), { CONTROL_DEV_ADMIN_EMAIL: "Dev@Example.com" }, keys)).resolves.toEqual({ ok: true, email: "dev@example.com" });
  });
});

describe("Cloudflare's signing keys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const jwks = () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" }, { kty: "EC", kid: "ec-key", crv: "P-256", x: "x", y: "y" }] });

  it("are fetched once from the team's certs address and kept", async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json(jwks())));
    vi.stubGlobal("fetch", fetch);
    const team = "kept-team.cloudflareaccess.com";
    const key = await cloudflareKeys(team, "key-1");
    expect(key?.export({ format: "jwk" })).toEqual(publicKey.export({ format: "jwk" }));
    await cloudflareKeys(team, "key-1");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://${team}/cdn-cgi/access/certs`, expect.anything());
  });

  it("are fetched again for a key they don't hold, but not on every request", async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json(jwks())));
    vi.stubGlobal("fetch", fetch);
    const team = "rotating-team.cloudflareaccess.com";
    await cloudflareKeys(team, "key-1");
    await expect(cloudflareKeys(team, "ec-key")).resolves.toBeNull();
    await expect(cloudflareKeys(team, "new-key")).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("let nobody in while Cloudflare can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("down", { status: 502 }))));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(cloudflareKeys("unreachable-team.cloudflareaccess.com", "key-1")).resolves.toBeNull();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("502"));
  });
});
