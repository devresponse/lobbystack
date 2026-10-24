# Track the open items

What is waiting, on `main` at `da1f548` (2026-10-24): steps to take on the demo after deploys, things built but never tried for real, decisions not yet made, recommended work not started, and leftovers from the original project. Take an item off this page in the pull request that settles it.

## Do these on the demo after deploys

The demo was last seen running `fa0aa11` (fork PR #70) on 2026-10-23. Fork PRs #71 to #76 merged on 2026-10-24.

1. **Check the version line** under the account menu reads `da1f548` or later ([overview](overview.md#know-where-it-runs)).
2. **Give each service its own Polar token** with only its scopes ([Polar](../providers/polar.md#give-each-service-its-own-token)): the admin's `customer_sessions:write`, and the worker's `checkouts:write`, `customers:write` (new with fork PR #72), `events:write` and `subscriptions:write` plus four read scopes for the daily check. Neither gets `webhooks:read` (fork PR #74).
3. **Apply the plans once more,** for fork PR #73's monthly meter on yearly plans: `pnpm billing apply --brand alloplace --polar sandbox --adopt --allow-replace`, then `pnpm billing verify --brand alloplace --polar sandbox` ([guide, step 7](../deployment/guide/part-3-outside-services.md)). Then delete the four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables from the admin and the worker: nothing reads them since fork PR #66, and the two yearly ones now name archived products.
4. **Confirm `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`:** 1860 on the worker so a deploy doesn't cut calls, and 120 on the admin so it doesn't cut replies being written.
5. **Check the settings the codebase review named:** `APP_BASE_URL` on the worker, `EMAIL_FROM` as a bare address, and the same `OTP_HASH_SECRET` on both services ([codebase review](../reviews/codebase-2026-10-18.md#check-the-deployment-settings-it-named)).
6. **Set up alerts.** None is set up on the demo: an uptime check on `/api/health/ready`, PostHog error and log alerts, the billing alerts, and spending alerts at OpenAI and Twilio ([observability](../features/observability.md#alert-on-what-matters), [alerts](../operations/alerts.md)).

## Test these

- **Polar, end to end on the sandbox.** Nothing has been tried against Polar itself since fork PR #59: a checkout, an upgrade, a second business with the same payer, a promo code, a promo plan's end, the portal, and Polar's invoices against **Settings > Usage** ([billing](../billing/README.md#know-the-known-problems)).
- **A real call with a keypad PIN:** one that cancels a test appointment with the right PIN, then one with a wrong PIN three times ([caller authentication](../features/caller-authentication.md#know-what-is-untested)).
- **`pnpm voice:eval` and `pnpm voice:call`,** which need an OpenAI key and haven't been run since fork PRs #13, #18, #45, #50, #52 and #54 ([calls](../features/calls.md#know-what-hasnt-been-tried)); and `pnpm voice:eval --browser` for the widget's calls.
- **French on GPT-Live** over a phone line: its supported languages aren't published ([voice platforms](../research/voice-platforms.md)).

## Decide these

| Question | Options and background |
| --- | --- |
| Should allowances reset at each renewal instead of on the first of the month (UTC)? | Today a mid-month downgrade or promo end counts the month's earlier usage against the smaller allowance ([billing](../billing/README.md#know-the-known-problems)) |
| Add a diagnostics tab to each call page? | 4 to 6 days, or 1 to 2 for a first cut ([observability options](../research/observability-options.md#weigh-logs-inside-the-dashboard)) |
| Which voice route for the long term: GPT-Live, a SIP-native alternative, a cheaper bridged one, or LiveKit? Build the provider seam? | The Azure port's choice of Azure OpenAI over SIP predates evidence that favours GPT-Live ([voice platforms](../research/voice-platforms.md), [Azure port](../research/azure-port.md)) |
| Add a middle plan between Pro and Enterprise? | Rivals sell one at $129 to $299, where retention is better ([voice agent market](../research/voice-agent-market.md#estimate-the-profit)) |
| Run the QR place guide pilot, and build its minimum product? | One downtown district, 15 signs, 90 days ([QR place guide](../research/qr-place-guide-market.md#run-the-pilot)) |
| Build the Railway bootstrap script? | A few days of work ([Railway automation](../research/railway-automation.md)) |
| Bring in the original's 14 newer commits? | A trial merge conflicted in 286 files ([overview](overview.md#know-what-the-fork-is)) |
| The codebase review's issues left alone: 15, 16, 19, 20, 21, 23 and 27 | [Codebase review](../reviews/codebase-2026-10-18.md) |

## Build these when they're needed

**Protect the widget and the deployment.** None of these is started ([widget scalability](../reviews/widget-scalability-2026-10-15.md#do-these-in-order)):

- Cloudflare in front of the dashboard's domain with a rate-limit rule, as the only way in, then `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip` on the admin, which turns on the per-IP limits.
- Turnstile before a widget session and before a call; rate limits checked before any database work; an early 503 under overload; a per-business call concurrency cap below the GPT-Live session limit; caps on operator alert emails.
- `AI_CHAT_REASONING_EFFORT=low` on the admin.
- A sign-up allowlist or invite-only mode: sign-up is open to anyone who passes Turnstile ([multitenancy](../features/multitenancy.md)).

**Scale one stack** ([scalability](../reviews/scalability-2026-10-18.md#follow-the-roadmap)): PgBouncer, an index on `transcripts (business_id, expires_at)`, one job per type instead of per business, a Redis memory ceiling, two admin copies, Cloudflare caching the loader and profile pages, usage counters and batched Polar events. Ask Polar to confirm in writing that an AI receptionist that rents phone numbers is accepted under its acceptable use policy before revenue depends on it.

**Finish the widget** ([website widget](../features/website-widget.md#know-the-gaps), [widget review](../reviews/widget-2026-10-15.md#follow-the-code-improvements)): improvements 5, 6 and 8 to 11 (stop the history poll while live updates are up, time to first word for chats, loader caching, a panel-only layout, Turnstile, a spending cap per website), and the realtime leftovers listed there.

**Close smaller gaps:**

- Appointment notifications by email, and a Resend webhook that can match emails sent over SMTP ([email](../features/email.md#know-the-gaps)).
- Twilio's call SID on the worker's log lines ([observability](../features/observability.md#know-what-isnt-built)).
- Extra public plans in the plan screens and checkout ([billing](../billing/README.md#know-the-known-problems)).
- Changing a business's public page slug, and custom domains per business ([public page](../features/public-profile-and-qr.md)).
- The v1 API's remaining gaps against the database ([API gaps](../reference/api-gaps.md)).
- A dedicated n8n node ([API, CLI and integrations](../features/api-cli-integrations.md)).
- An automatic check after each deploy.

## Clean up what still points at the original

The docs no longer link to the original project's sites, but some code and configuration still default to them. Each is a code change for its own pull request:

- `NEXT_PUBLIC_POSTHOG_HOST` defaults to the original's PostHog relay in `docker-compose.yml` and `.env.example`; on Railway, leave it unset.
- `packages/shared/src/brandLinks.ts` and `brands/lobbystack/brand.json` name the original's site, docs and email addresses for the `lobbystack` brand, and the affiliate route falls back to the original's dashboard address.
- `scripts/production-smoke.ts` expects the original's phone numbers unless `SMOKE_EXPECTED_NUMBERS` is set, and `scripts/write-openapi.ts` writes the original's server address into the OpenAPI file.
- The Zapier app (`integrations/zapier/`) connects to the original's dashboard and docs unless `ZAPIER_DEFAULT_URL` and `ZAPIER_DOCS_URL` are set; the CLI's onboarding help links to the original's docs.
- `.railway/railway.ts` allows the original's site as a website-call origin; the fork's deployments don't use that file.
- `apps/landing/`, `mintlify/` and `research/` are the original's site, help pages and articles, full of its links. The fork doesn't publish them.
- A `.gitattributes` that keeps Linux line endings for shell scripts would spare Windows users the manual setting in [part 2 of the guide](../deployment/guide/part-2-local-development.md).

## Know what lives outside the repository

Two helper scripts are kept in the maintainer's project files, not in the repository: `polar-setup.mjs`, the first Polar setup script, which `pnpm billing apply --adopt` replaced, and `railway-vars.mjs`, which sets Railway variables from a file with a project token and was only tested against a stand-in. Anything a deployment needs should be in the repository and the [deployment guide](../deployment/guide/README.md) instead.
