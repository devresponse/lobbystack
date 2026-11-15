# Protect a test deployment's public address

On 2026-11-14 a study asked how to keep strangers off a test deployment on Railway without a VPN and without an IP allowlist, which phones on mobile networks can't use. The maintainer's idea was a long secret in a variable that must be passed to the sign-in page in its address, with "not found" for everyone else. The study read the code on `releases/r2` at `f9f4633`, looked at a running test deployment, and read Railway's, Cloudflare's, Vercel's and Next.js's pages that day. **Its answer: the idea works, and works best built into the admin itself, as a check in its proxy that swaps the token in an address for a 30-day cookie and answers a bare 404 without it.** It was built the next day as fork PR #176 on `releases/r2`; [close a test deployment to strangers](../features/access-gate.md) describes what runs now. Prices and product limits are as published on the study's date.

## Know the answer

- **For people:** open `https://<address>/login?access=<the token>` once in each browser. The admin drops the token from the address and leaves a cookie; after that the deployment works as usual for 30 days. Anyone without the cookie gets a 404 at every page and API.
- **One variable:** `PROTECTION_TOKEN` on the admin, at least 32 characters. Without it nothing changes, so a production deployment is unaffected.
- **Routes that must stay open:** nine groups of addresses are called by a provider's server, a visitor's browser on another website, a script or the host, and gating them would break phone calls, texts, billing, the website widget, the API, AI assistants and Railway's deploy check. Each already checks its own signature, key or token ([the list](../features/access-gate.md#know-what-stays-open)).
- **Effort:** 2 to 3 days in one pull request, plus half a day for the bootstrap script to make the token. No database change.
- **Why not at the edge:** every option in front of Railway needs more than a setting, and a second lock, because the admin has two public addresses.

## Know how a test deployment is reached

- **Two addresses.** A test deployment with its own domain points a DNS-only CNAME at Railway, and the admin also keeps the `up.railway.app` address the bootstrap script made, which stays in `AUTH_TRUSTED_ORIGINS`. Protection on one address only leaves the other as a back door.
- **The worker is private.** It has no public domain; the admin reaches it on Railway's private network, and its `/internal/live/` routes also need `INTERNAL_SERVICE_TOKEN`. Postgres and Redis are private too. None of them needs a change.
- **One place sees every request.** `apps/admin/proxy.ts`, Next.js 16's renamed middleware on the Node.js runtime, runs before every page and API, except build files, images, `/locales/`, `/brand/` and the logo. It already handles maintenance mode, language redirects, cache and security headers and the cross-site check, so a gate belongs there.
- **Railway's deploy check** calls `/api/health/ready` on the admin's port, from the host `healthcheck.railway.app`, only while a deploy starts.
- **Sign-in is open to anyone.** Anyone can open `/en/login`, `/` redirects there, and `/api/auth/sign-up/email` asks only for Turnstile. A gate on the sign-in page alone would leave that route open to scripts, so the gate closes the rest of `/api/auth/` too.

## Compare the options

Only the in-app gate covers both addresses with no new service and no DNS change. Every edge option also needs a lock that stops people from reaching Railway directly, because the deployment's own `up.railway.app` address stays open, and Railway's edge answers anyone who asks it for the custom domain directly.

| Option | How it works | Back door through Railway's own address | Phones and links | Cost and effort | Verdict |
| --- | --- | --- | --- | --- | --- |
| **In-app token gate** | The proxy checks a signed cookie, and `?access=<token>` sets it. The open routes are listed in the code, with tests | Closed: it runs behind every address of the admin | Open the link once per browser; the cookie lasts 30 days | No new service or DNS change; 2 to 3 days | Built |
| **Cloudflare Access** | Cloudflare's login (an emailed code, or Google) in front of the custom domain, with Bypass rules for the open routes in Cloudflare's dashboard | Open unless locked: Railway Edge Rules allowing only Cloudflare's addresses, the admin checking Cloudflare's signed `Cf-Access-Jwt-Assertion` header, or a Cloudflare Tunnel with the admin's public domains removed | A login per person, sessions up to a month, removable one by one | Free for a small team; the DNS record goes proxied, with SSL set to Full; about a day | Later, if a login per tester is needed |
| **Password proxy service** | Railway's nginx Basic Auth Proxy template in front, with the admin's public domains removed. Open routes need a forked nginx config | Closed, once the admin has no public domain | The browser's password box, again after it closes; awkward in apps' built-in browsers | One more service to run and pay for, and an extra hop for live chat streams; about a day | Not recommended |
| **Railway Edge Rules alone** | Allow or block at Railway's edge by client IP, host, path or header, on every domain of the service | Closed | No way to let phones in: rules can't read the query string or set a cookie | Needs a plan with an edge-rule allowance | Only as Cloudflare's lock |
| **IP allowlist or VPN** | Only known addresses, or a VPN, reach the site | Closed | Phones change addresses, and a VPN was ruled out | Not costed | Ruled out |

- **Railway has no built-in gate.** A request for one, "Built-in Auth Gate" (August 2025), was still under review.
- **The in-app design follows Vercel's Deployment Protection,** which lets tests in the same way: a secret in a header or query parameter, swapped by a redirect for a SameSite=Lax cookie.
- **Behind Cloudflare's proxy, keep `TRUSTED_CLIENT_IP_HEADER=x-real-ip`.** Railway fills that header from `CF-Connecting-IP` only for requests from Cloudflare's IPv4 addresses, and says not to read `CF-Connecting-IP` directly. `cf-connecting-ip` is safe only once nothing but Cloudflare can reach Railway ([protect the widget and the deployment](../roadmap/protect-the-deployment.md#change-these-settings-first)).

## Know what the design settled

The maintainer took the study's recommendation on each of its five questions the same day ([decisions](../project/decisions.md)):

| Question | Answer |
| --- | --- |
| Gate public business pages, QR links, prospect demos and the help center too? | Yes: anything left open shows the product to strangers. A phone scanning a test QR code opens the access link once first |
| Answer strangers 404 or 401? | 404, so an address looks empty rather than locked, and no browser shows a password box |
| How long does the cookie last? | 30 days |
| Build it on `releases/r2` only, or on `main` too? | `releases/r2` only, which the test deployments build from |
| Should the bootstrap script protect every deployment that isn't production? | No: only with `PROTECT=yes` |

## Know the limits it found

- One shared secret: dropping one tester means changing the token for everyone. Cloudflare Access is the fix if that matters.
- The access link can leak wherever it's pasted, and into Railway's HTTP logs if they keep query strings, which Railway's pages don't say.
- A new phone, or an app's built-in browser, keeps its own cookies and needs the link once.
- Build files, interface text and logos stay reachable; they hold no business data. The health checks stay open and name the service, its version and the brand.
- The widget stays usable by anyone with a widget key, as on any deployment, behind its allowed websites, Turnstile and daily limit.
- A gate in the proxy relies on Next.js running it for every request. A 2025 flaw let a header skip middleware (CVE-2025-29927, fixed in 15.2.3); the branch ran 16.4.2.

## Know what has happened since

- **Built on 2026-11-15** as fork PR #176 on `releases/r2`, with the study's design: the gate, its start-up check, the bootstrap script's `PROTECT=yes`, and the docs ([close a test deployment to strangers](../features/access-gate.md)).
- **Two things differ from the study's to-do list.** The bootstrap script keeps the token it makes in its state file, with the platform secrets, instead of writing it into the secrets file, which the script only reads. And it refuses `PROTECT=yes` with `ENVIRONMENT=production`.
- **Two things the study didn't see, found while building.** The sign-in pages asked `/api/branding` for the deployment's name and logo without cookies, which the gate would have answered with the 404, so that request now carries them. And Next.js's image optimizer, which the proxy doesn't see, fetches a local address through the proxy with no cookie, so it can't tell a closed page from a made-up one; a browser test holds it to that.
- **Not done:** Cloudflare Access, which stays an option for a login per tester, and a first protected deployment on Railway ([open items](../project/open-items.md)).

## Sources

Opened on 2026-11-14.

- Railway: [Edge Rules](https://docs.railway.com/networking/edge-rules), [Healthchecks](https://docs.railway.com/reference/healthchecks), [Working with domains](https://docs.railway.com/networking/domains/working-with-domains) (Cloudflare's proxy needs SSL set to Full), the [Basic Auth Proxy template](https://railway.com/deploy/basic-auth-proxy), the [cloudflared template](https://railway.com/deploy/cloudflared-template), the ["Built-in Auth Gate" request](https://station.railway.com/feedback/built-in-auth-gate-for-public-services-5e22d5c5), an [origin lockdown answer](https://station.railway.com/questions/origin-lockdown-options-for-a-public-htt-06bb047a) and an answer on the [client IP behind Cloudflare](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86).
- Cloudflare: [Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/), [validating Access's signed header](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/), [session durations](https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/) and [seats](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/).
- [Vercel: Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation), [Next.js: proxy.js](https://nextjs.org/docs/app/api-reference/file-conventions/proxy) and the [GitHub advisory for CVE-2025-29927](https://github.com/advisories/GHSA-f82v-jwr5-mffw).
- The code on `releases/r2` at `f9f4633`: `apps/admin/proxy.ts`, `apps/admin/instrumentation.ts`, `docs/reference/routes.md`, `.railway/railway.ts` and `devops/bootstrap.mjs`.
