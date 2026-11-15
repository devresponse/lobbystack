# Close a test deployment to strangers

A test deployment has a public address, so anyone who finds it can open its sign-in page, sign up, and see its test businesses' public pages. Since fork PR #176 on `releases/r2`, one variable on the admin, `PROTECTION_TOKEN`, closes such a deployment: every page and API answers a bare 404 until a browser opens an address with `?access=<the token>` once, which lets that browser in for 30 days. The routes that other services and visitors' browsers call, such as webhooks, health checks and the website widget, stay open. Without the variable nothing changes. This page covers how the gate works, switching it on, the access link, what stays open, changing the token, and its limits. Checked against the code of fork PR #176; [the study behind it](../research/dev-server-protection.md) compares it with the other ways to protect an address on Railway.

**Use it on test deployments only.** On a deployment the public should reach, or one a marketing site sends visitors to, customers, search engines and link previews would all get the 404. A production deployment that hasn't launched yet can be closed the same way, by hand, provided the variable is deleted before the launch; the bootstrap script sets it only on a test environment.

## Know how it works

The gate is the first check in the admin's proxy (`apps/admin/proxy.ts`), which sees every request before any page or route. With `PROTECTION_TOKEN` set, a request meets these questions in order:

1. **Is the address an [open route](#know-what-stays-open)?** It goes on as if the gate were off, without a look at any token or cookie.
2. **Is it a page load that carries the token,** a `GET` or `HEAD` with `?access=<the token>`? It answers 303 to the same address without `access`, keeping its other parameters such as `returnTo`, and sets the cookie. No page ever loads with the token in its address, so no script, analytics tool or `Referer` header sees it.
3. **Does it carry the cookie, or the token in an `X-Protection-Token` header?** It goes on to the page or route, which checks sign-in as it always has.
4. **Otherwise** it answers 404 with the two words "Not found": no page and no brand, the same for a real address as for a made-up one, so an address looks empty rather than locked.

- **The cookie** is `__Host-lobbystack-access`: HttpOnly, Secure, SameSite=Lax, for the whole site, for 30 days. Its value is `v1.<expiry>.<signature>`, where the signature is an HMAC-SHA256 of the cookie's name and expiry, keyed by the token, and is compared in constant time. It doesn't hold the token, can't be stretched past its date, and stops working the moment the token changes. Over plain HTTP, such as a server on your computer, the cookie is `lobbystack-access` without Secure, since a browser refuses the `__Host-` prefix there.
- **It isn't sign-in.** The cookie only lets a browser reach the sign-in page; an account and its password are still needed, and signing out leaves the cookie in place.
- **It runs before maintenance mode,** so a stranger gets the 404 whatever state the deployment is in, while open routes and people with the cookie get maintenance mode's 503 as before.
- **Nothing is cached or indexed.** The 404 and the 303 say `Cache-Control: no-store`. Every answer to a browser the gate let through says `private, no-store`, because the sign-in and help pages otherwise say `public, s-maxage=300`, and a cache in front could hand them to a stranger. Every answer the proxy handles, the open routes' included, says `X-Robots-Tag: noindex, nofollow`.
- **Nothing is stored:** no table and no Redis key. Every copy of the admin and every address it has, its own domain and Railway's `up.railway.app` one, follows the variable.

## Switch it on

1. **Make a token:** 32 or more letters, digits, hyphens, underscores, dots or tildes, which are the characters an address carries as they are. This prints 43 random ones:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

2. **Set it on the admin only,** as `PROTECTION_TOKEN=<the token>`: on Railway under `admin` > **Variables**, then **Deploy** on the banner; on a server, as a line in `.env`, then `docker compose up -d` ([7.6](../deployment/guide/part-7-operations.md#76-change-a-setting-safely)). The worker doesn't read it.
3. **Open the access link** in your own browser: `https://<your address>/login?access=<the token>`. You land on the sign-in page, with the token gone from the address.
4. **Check it:** in a private window, `https://<your address>/` shows only "Not found", and `https://<your address>/api/health/live` still answers.
5. **Send the access link** to the people who should get in.

With the bootstrap script, set `PROTECT=yes` in the settings file and run `up`: it makes the token, sets it on the admin and shows the access link. A token of your own works the same way with no `PROTECT=yes`: since fork PR #178, a `PROTECTION_TOKEN` in the script's secrets file closes the deployment by itself, as the variable does on the admin ([devops/bootstrap.md](../../devops/bootstrap.md#close-the-deployment-to-strangers)).

- **A token the admin refuses.** With a token shorter than 32 characters, or one with any other character, the admin doesn't start: it stops with `[access-gate] PROTECTION_TOKEN is 9 characters long and needs at least 32.` or `… has a character an address can't carry as it is.`, and Railway keeps the version that was running. A short token could be guessed, and a character such as `+` would break the access link. The message never repeats the token.
- **Unset or empty** means no gate. Spaces and line ends around a pasted token are dropped.
- **The admin says so as it starts:** one `access_gate.on` line in its log ([below](#watch-it-in-the-logs)).
- **It needs a version with the gate.** A deployment built from a branch from before fork PR #176 ignores the variable and stays open, with no error anywhere. Step 4 is the check.

## Give people the access link

- **Any closed address takes the token,** not only the sign-in page: `https://<your address>/profile/<slug>?access=<the token>` opens a business's public page directly, and `https://<your address>/en/signup?access=<the token>` the sign-up page.
- **Each browser needs it once.** A phone, a second browser on the same computer, a private window and an app's built-in browser, such as the one a chat app opens links in, each keep their own cookies.
- **It lasts 30 days from when the link was opened,** and using the deployment doesn't extend it. Opening the link again starts another 30 days. A browser whose cookie has run out gets the 404 until then.
- **Links from outside open only in a browser that has used the access link:** the links in emails (invitations, email changes, account cancellation, call summaries), a business's QR codes, its public page and its receptionists' pages.
- **Coming back from another site works:** Google Calendar's return, Polar's and Stripe's checkout returns, and an AI assistant's sign-in and consent pages are full-page visits in the person's own browser, which sends the cookie along.
- **Treat the link as a password.** Whoever has it gets in, and it stays wherever it was written, such as the message it was sent in; a browser can also remember an address that was typed or pasted into it. [Change the token](#change-the-token-or-turn-it-off) when the link has gone somewhere it shouldn't.

## Let a script in

A script sends the token in a header on each request, since it has no cookie:

```sh
curl -H "X-Protection-Token: <the token>" https://<your address>/api/auth/get-session
```

- The header sets no cookie, and the proxy takes it off the request before any page or route runs, on open routes too, so the token reaches no handler, log line or error report.
- Only a page load swaps a token in the address for the cookie: a `POST` with `?access=` gets the 404.
- A browser test opens the access link first, as a person does, and the cookie then covers every page and call. Don't set the header on a whole browser session: the browser would send the token to every other site the pages load from.
- `pnpm smoke:production` sends the header when `PROTECTION_TOKEN=<the token>` is on its command line; without it, its sign-in check fails with a 404 and says why ([4.9](../deployment/guide/part-4-test-environment.md#49-smoke-test)).
- The API, the command line, the MCP server, Zapier, Make and n8n need neither the header nor the cookie: their routes are open and ask for their own key or token.

## Know what stays open

These answer without the cookie, because the caller is a provider's server, a visitor's browser on another website, a script with its own key, or the host. Each already has its own check, so leaving it open adds no way in.

| Addresses | Called by | Its own check |
| --- | --- | --- |
| `/api/webhooks/` (OpenAI, Twilio's texts and statuses, Polar, Stripe and its meter errors, the email provider) | Those providers' servers | The provider's signature |
| `/api/health/live`, `/api/health/ready` | Railway's deploy check, uptime checks, the bootstrap script | None: they show the service, its version, the brand and whether its parts are up |
| `/embed.js`, `/embed/` | Visitors' browsers on a business's website: the widget's loader and its chat window | An active widget key and its allowed websites |
| `/api/widget/` | That chat window | The session, the allowed websites, Turnstile and the daily limit ([website widget](website-widget.md#stop-scripts-from-spending-a-businesss-chats)) |
| `/api/voice/live/session`, `/api/voice/live/session/end` | A call from the website widget, or from a marketing site's voice demo | The widget's session, a demo token or an allowed origin |
| `/api/v1/` | The command line, the bootstrap script, Zapier, Make and n8n | An API key |
| `/api/mcp`, the four `/.well-known/oauth-…` addresses, and `/api/auth/oauth2/token`, `register`, `revoke` and `introspect` | AI assistants' servers | An OAuth token or an API key |
| `/api/storage/local` | An upload or download on a deployment that keeps files on its disk | A signed token in the address |
| `/api/internal/finance/export` | The finance export, off unless `FINANCE_EXPORT_ENABLED=true` | `FINANCE_EXPORT_TOKEN` |

- **Files that never pass through the proxy** answer as before: the build's files under `/_next/static/`, `/_next/image`, the favicon, `/locales/`, `/brand/` and the logo file. They hold code, interface text and logos, and no business data. Emails load their logo from `/brand/`, so they keep it. `/_next/image` fetches the address it's given through the proxy with no cookie, so a closed page answers it the 404 whether the page exists or not.
- **Everything else is closed:** the sign-in and sign-up pages and the rest of `/api/auth/`, the dashboard and its API, onboarding, businesses' public pages, receptionist pages and QR links (`/profile/`, `/q/`), prospect demos, the help center, and `/api/widget-keys`, which sits beside an open address.
- **A prefix keeps its closing slash,** and the other addresses match exactly, so a route added beside an open one stays closed: `/api/widget/` doesn't open `/api/widget-keys`, and `/api/health/live` doesn't open `/api/health/livex`.
- **A new route that a service or another website must reach** needs a line in `OPEN_PREFIXES` or `OPEN_PATHS` in `apps/admin/src/lib/access-gate.ts`, and in the two lists of its test. Without one it answers the 404 on a protected deployment, and nothing else says so.

## Change the token, or turn it off

- **Change it** by setting a new value on the admin and deploying. Every cookie signed with the old token stops working at once, on every device, and the old link gets the 404: send out the new link. It's also the only way to take one person's access away, since everyone shares one token.
- **Turn it off** by deleting the variable and deploying. The cookies left in browsers do nothing.
- **With the bootstrap script,** `node devops/bootstrap.mjs redo .env.bootstrap-<name> protection`, then `up`, takes the secrets file's token, or makes a new one, and shows the new link. To turn the gate off, set `PROTECT=no` and take `PROTECTION_TOKEN` out of the secrets file, and delete `PROTECTION_TOKEN` from the admin's variables in Railway yourself, since the script deletes no variables ([devops/bootstrap.md](../../devops/bootstrap.md#close-the-deployment-to-strangers)).

## Watch it in the logs

| Line | Written when |
| --- | --- |
| `access_gate.on` | The admin starts with `PROTECTION_TOKEN` set. Never with the token |
| `access_gate.wrong_token` | A warning: a request offered a token that isn't `PROTECTION_TOKEN` and got the 404. `via` is `query` for a token in an address, or `header`. At most one line a minute from each copy of the admin, with `notLogged`, the number left out since the line before. Never with the token that was offered |

A wrong token is usually someone with an access link from before the token changed: send them the current one. A stranger's 404 writes no line, since scanners would fill the log.

## Know the limits

- **One token for everyone.** To drop one tester, change the token for all. A login for each person needs a service in front, such as Cloudflare Access ([the study](../research/dev-server-protection.md#compare-the-options)).
- **The link can leak** wherever it's pasted. Everyone in the Railway project can read the variable, and Railway's HTTP logs record each request's address; whether they keep the part after `?` isn't confirmed.
- **Open routes stay reachable by anyone,** as on an open deployment: the health checks name the service, its version and the brand, and the widget works for anyone with a widget key, behind its allowed websites, Turnstile and daily limit.
- **A cookie lasts its 30 days.** There's no list of browsers that were let in and no way to end one cookie; changing the token ends all of them.
- **It doesn't replace sign-in, sign-up limits or Turnstile,** and it doesn't hide that a server answers at the address. An address with a closing slash or a doubled one first gets Next.js's redirect to the tidy address, whatever the address, and that one answers the 404.
- **The gate relies on Next.js running the proxy for every request.** A 2025 flaw let a crafted header skip it (CVE-2025-29927, fixed in Next.js 15.2.3); the admin runs 16.4.2, and Dependabot keeps it current.
- **Not yet seen on Railway.** It was tried on a server on a computer with the variable set, including the website widget on a page of another site in a browser without the cookie. The first protected deployment on Railway will settle the rest ([open items](../project/open-items.md)).

## Know how it's built

- **`apps/admin/src/lib/access-gate.ts`:** the open routes (`isOpenRoute`), the token's rules (`protectionTokenStartupError`), the cookie (`accessCookieValue`, `accessCookieIsValid`, `accessCookieName`), the decision for a request (`decideAccess`: off, open, pass, grant or deny), the two answers (`accessGrantedResponse`, `accessDeniedResponse`) and the warning (`reportWrongAccessToken`). It uses `node:crypto` and no database.
- **`apps/admin/proxy.ts`:** asks `decideAccess` first, answers the 404 or the 303 itself, and otherwise runs as before, with `private, no-store` for a browser the gate let through and `X-Robots-Tag` on every answer. Its `matcher` is unchanged.
- **`apps/admin/instrumentation.ts`:** refuses to start with a token the gate wouldn't take, and logs `access_gate.on`. A build skips both, since it serves no one.
- **The proxy is built apart from the rest of the admin,** so the warning is written with `console.warn` as the JSON line `logEvent` would write, which Railway reads the same way, without loading the telemetry package into the proxy.
- **Around it:** `PROTECTION_TOKEN` in `.env.example` and `docker-compose.yml`; `PROTECT`, the secrets file's `PROTECTION_TOKEN` and the `protection` step in `devops/bootstrap.mjs`; the header in `scripts/production-smoke.ts`.
- **Every request a page makes has to carry the cookie.** The sign-in pages asked `/api/branding` for the deployment's name and logo without cookies, which the gate would answer with the 404, so `apps/admin/src/components/branding-provider.tsx` now sends them. A new `fetch` with `credentials: "omit"` would meet the same 404.

## Know how it's tested

- **The gate:** `apps/admin/src/lib/access-gate.test.ts` covers every open route and the addresses beside them, the token's rules, the cookie's expiry and signature, each decision, the two answers and the warning's limit.
- **The proxy:** `apps/admin/proxy.test.ts` covers that nothing changes without the variable, the 404 at every kind of closed address, the exchange of the token for the cookie, the cache headers with the gate on, the open routes, the header, the order with maintenance mode, and `access_gate.wrong_token` from the proxy itself.
- **Start-up:** `apps/admin/src/lib/instrumentation.test.ts` covers the refused tokens and `access_gate.on`.
- **A browser journey:** `apps/admin/e2e/access-gate.e2e.ts` runs against a server of its own, started with the variable by `apps/admin/playwright.access-gate.config.ts`: a stranger's 404, the image optimizer's same answer for a real page and a made-up one, the access link landing on the sign-in page with the cookie and none of that page's own requests turned away, a script's header, and the widget's loader and chat, a Twilio webhook, the API and MCP answering as on an open deployment. `pnpm --filter @lobbystack/admin e2e:access-gate` runs it, and so do `scripts/e2e-local.sh` and CI's Replacement Platform workflow.
- **The page's own request:** `apps/admin/src/components/branding-provider.test.tsx` covers that the request for the name and logo carries the browser's cookies.
- **The scripts:** `scripts/bootstrap.test.ts` covers `PROTECT=yes`, and a `PROTECTION_TOKEN` in the secrets file without it, in `up`, `status`, `connect`, `doctor` and `redo`, that production refuses both, and that the log never has the token; `scripts/production-smoke.test.ts` covers the header.
