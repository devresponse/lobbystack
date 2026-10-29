# Part 8. Troubleshooting

**Status:** written on 2026-10-19 from the code on `main` at `d18f916`; [8.6](#86-calls-from-the-browser)'s limits on website calls and its lines on the recorded greeting were updated the same day for fork PR #52 (`3202c18`), and its browser call length on 2026-10-20 for fork PR #54 (`9b66d01`). [8.5](#85-phone-calls)'s spending cap and [8.7](#87-the-website-chat)'s chat limit were updated on 2026-10-23 for fork PR #68 (`de62667`), and [8.4](#84-the-dashboard)'s limits on checkouts and the billing portal were added on 2026-10-24 for fork PR #74 (`7d20322`), and its message for a plan change that waits for another the same day for fork PR #75 (`24e211d`). [8.1](#81-where-to-find-the-reason)'s refusals and [8.7](#87-the-website-chat)'s chat answers were updated on 2026-10-25 for fork PR #79, and [8.10](#810-language)'s website chat row the same day for fork PR #81, and its opening-language rows for fork PR #82. [8.5](#85-phone-calls)'s notice after the greeting, [8.6](#86-calls-from-the-browser)'s first recorded opening and [8.10](#810-language)'s first row were updated on 2026-10-26 for fork PR #84. The brand rows in [8.2](#82-builds-and-start-up) and [8.4](#84-the-dashboard) were updated on 2026-10-27 for fork PR #87. [8.5](#85-phone-calls)'s silence before the greeting and [8.6](#86-calls-from-the-browser)'s recorded greeting were updated on 2026-10-29 for fork PR #96, which opens phone calls with the recording too, and [8.6](#86-calls-from-the-browser)'s recording failures the same day for fork PR #97, and [8.5](#85-phone-calls)'s spoken greeting for fork PR #98. The fix in [8.12](#812-a-business-on-the-free-plan-by-mistake) was tried on a throwaway database; nothing in this part has been run on a deployed instance yet. So the messages quoted are the code's own words, and what the code doesn't show is marked *(not confirmed)*.

Find what you see in the table, then go to its section. Each section lists the causes in the order to check them, with the fix. Where another part already covers a problem, the table sends you there.

| What you see | Go to |
| --- | --- |
| Something fails on your own computer | [2.10](part-2-local-development.md#210-if-something-fails-locally) |
| The first deploy on Railway fails | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker) ("If the first deploy fails") |
| A build fails, or a service keeps restarting | [8.2](#82-builds-and-start-up) |
| The worker stops with `listen EAFNOSUPPORT` | [8.2](#82-builds-and-start-up) |
| `/api/health/ready` shows `"failed"`, or nothing answers | [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| Sign-up says "We couldn't create your account. Please try again." | [8.3](#83-sign-up-sign-in-and-email-codes) |
| Sign-in says "Incorrect email or password. Please try again." although the password is right | [8.3](#83-sign-up-sign-in-and-email-codes) |
| Signing in brings you back to the sign-in page | [8.3](#83-sign-up-sign-in-and-email-codes) |
| An email code, a reset code or an invitation doesn't arrive | [8.3](#83-sign-up-sign-in-and-email-codes), then [7.17](part-7-operations.md#717-emails-or-texts-not-going-out) |
| A page says "Something went wrong. Please try again." | [8.4](#84-the-dashboard) |
| New calls and messages show only after a reload | [8.4](#84-the-dashboard) |
| The dashboard shows the wrong name or logo | [8.4](#84-the-dashboard) |
| Buying a plan or opening the billing portal says "Too many tries. Try again later.", or fails | [8.4](#84-the-dashboard) |
| **Upgrade to Pro** or a promo code says "An earlier change to your subscription is still being applied. Try again in a minute." | [8.4](#84-the-dashboard) |
| Calls ring with no answer, or callers hear that the number is out of service | [7.15](part-7-operations.md#715-calls-not-answered-or-dropping) |
| Calls are answered, then hang up at once | [7.16](part-7-operations.md#716-worker-crash-and-stuck-calls) |
| Callers hear a busy signal | [8.5](#85-phone-calls) |
| The receptionist goes quiet after a question | [8.5](#85-phone-calls) |
| Callers hear that they're speaking with an AI and the call is recorded | [8.5](#85-phone-calls) |
| **Test Call** is missing, or its call doesn't start | [8.6](#86-calls-from-the-browser) |
| The website chat has no **Say Allo!** button, or says "Live voice is unavailable. Try again later." | [8.6](#86-calls-from-the-browser) |
| The website chat doesn't appear, shows an error, or doesn't answer | [8.7](#87-the-website-chat) |
| Buying a number fails | [6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls) ("If it fails") |
| Texts aren't delivered, or texts people send don't appear | [7.17](part-7-operations.md#717-emails-or-texts-not-going-out) |
| The receptionist won't book | [8.8](#88-booking) |
| Google Calendar won't connect, or says "Needs attention" | [8.9](#89-google-calendar) |
| The receptionist speaks the wrong language | [8.10](#810-language) |
| The receptionist doesn't use what's in **Knowledge** | [8.11](#811-knowledge) |
| **Settings** > **Plan** says "Free Plan" on an instance that doesn't sell plans | [8.12](#812-a-business-on-the-free-plan-by-mistake) |
| You need someone technical to look at it | [8.13](#813-what-to-send-someone-technical) |

## 8.1 Where to find the reason

Most screens show a short message that fits many causes, such as "Incorrect email or password. Please try again." The reason is in one of these places:

1. **The ready check.** `https://<your address>/api/health/ready` says whether the admin reaches the database, the files and Redis ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)). It doesn't look at the worker.
2. **The logs** of the admin and the worker ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)). On Railway, open the service's newest deployment, or **Observability** for both. On a server, run `docker compose logs --since 1h admin worker`.
3. **The error ID**, when a screen shows one. It leads to the log line that says what failed ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).
4. **The browser's developer tools**, for the website chat and calls from the browser. Press F12, or right-click the page and choose **Inspect**. Open **Network**, do again what failed, click the request shown in red, and open its **Response**. Its `code`, such as `widget_origin_denied`, names the reason, and this part gives the codes that matter.

Some refusals leave no line in any log, so only the browser shows them: a widget key that isn't valid, a website the key doesn't allow and the limits, when the website chat opens; too many sign-in tries; microphone problems; and calls from the browser while the admin's `LIVE_PROTOTYPE_ENABLED` is off or its `OPENAI_API_KEY` is missing. A chat message that's turned away is logged as `widget.chat_refused` (fork PR #79).

## 8.2 Builds and start-up

[4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker) covers the first deploy on Railway, and [7.16](part-7-operations.md#716-worker-crash-and-stuck-calls) a worker that stops later. This section covers both ways of running production.

**A build fails**

| What you see | Why | What to do |
| --- | --- | --- |
| `JavaScript heap out of memory`, or the build stops with exit code 137 *(the exact text: not confirmed)* | The admin's build needs more memory than the server has | On a server with 4 GB, add swap ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 11) and build one image at a time ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 19) |
| `429 Too Many Requests` while downloading an image | Docker Hub's limit for downloads without an account | `docker login`, or try again later |
| `required variable <NAME> is missing a value` | A line is missing from the server's `.env` | Add it. The generator writes every one of them ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 13) |
| A build on Railway fails at once, without running the Dockerfile | `RAILWAY_DOCKERFILE_PATH` is missing or misspelled | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker) |

**The admin keeps restarting**

Its log has a line that starts with `An error occurred while loading instrumentation hook:`, followed by the reason. Railway restarts it a few times, then marks it **Crashed** ([7.16](part-7-operations.md#716-worker-crash-and-stuck-calls)). Docker Compose keeps restarting it.

| The reason | What it means | What to do |
| --- | --- | --- |
| `<NAME> is required in production.` | A secret is missing. The admin needs `BETTER_AUTH_SECRET`, `INTERNAL_SERVICE_SECRET`, `INTERNAL_SERVICE_TOKEN`, `WIDGET_SESSION_SECRET`, `ENCRYPTION_KEY`, `OTP_HASH_SECRET`, and `LOCAL_STORAGE_SIGNING_SECRET` unless `STORAGE_PROVIDER` is `s3` | Add it ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)). If the name is `LOCAL_STORAGE_SIGNING_SECRET` and the files go to a bucket, add `STORAGE_PROVIDER=s3` instead |
| `<NAME> must be at least 32 characters and must not use a placeholder value in production.` | The value is shorter than 32 characters, or a placeholder, such as anything that starts with `replace-with-` | Put a generated value in ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)) |
| `[brand] BRAND_REQUIRED=true, but no brand file matches <host> or BRAND_PRESET.` | `BRAND_REQUIRED` is on ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)), and no brand file applies to the address the admin was built with: no brand claims it, `BRAND_PRESET` names none, and `brands/` holds no brand besides LobbyStack, or several | Fix `APP_BASE_URL` or `BRAND_PRESET` ([3.6](part-3-outside-services.md#36-your-brand)), then build the admin again |
| `DATABASE_URL is required for PostgreSQL access.` | The database line is missing | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker) |
| `Database role assertion failed: expected unprivileged lobbystack_<role>.` | A `LOBBYSTACK_<ROLE>_PASSWORD` line is missing | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker) |
| `password authentication failed for user "lobbystack_…"` | migrate hasn't run yet, or the passwords don't match | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker). On a server, [7.18](part-7-operations.md#718-rotate-secrets-and-keys) |
| `timeout exceeded when trying to connect` | PostgreSQL didn't answer within 5 seconds | [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |

Redis and the files aren't checked at start: the admin runs without them, and the ready check shows which one fails ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).

**The worker keeps restarting, or never gets ready**

- **It stops right after it starts, again and again.** A secret, the brand or the database failed, with the same messages as the admin's. Its log shows only the message.
- **It runs, but its health check fails.** It couldn't reach its files: a bucket it can't reach, `Unsupported STORAGE_PROVIDER: <value>. Expected local or s3.`, or `S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together.` It then stays up, but never ready. On Railway, the deploy fails its health check after 5 minutes, and the old worker keeps running ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)). On a server, `docker compose ps` shows it as unhealthy, and Docker doesn't restart it *(not confirmed)*.
- **It logs `{"event":"redis.error",…}` every 30 seconds.** Redis doesn't answer. The worker waits, not ready, until Redis is back ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).
- **It logs `Worker consumer startup is isolated by maintenance mode.`** `LOBBYSTACK_MAINTENANCE_MODE` is `true`: set it back to `false` ([7.6](part-7-operations.md#76-change-a-setting-safely)).

**`listen EAFNOSUPPORT`**

The worker's health check listens on the IPv6 address `::`, which the code sets and no variable changes (`apps/worker/src/health.ts:33-34`). On a server whose IPv6 was switched off when it started, the worker stops right after starting, with `Error: listen EAFNOSUPPORT: address family not supported :::3002` *(the exact text: not confirmed)*, and restarts in a loop. [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 8 checks for this before anything is installed.

1. Turn IPv6 back on. It's usually switched off by `ipv6.disable=1` among the server's boot options: remove it and restart the server *(not confirmed)*. Or set the server up again from the provider's standard Ubuntu image.
2. If that isn't possible, someone technical can change `"::"` to `"0.0.0.0"` on line 34 of `apps/worker/src/health.ts` in the fork, and build the worker again ([Appendix E](appendix-e-doc-problems.md)). This suits a server only: on Railway, the admin reaches the worker over IPv6.

**How each platform checks health**

| Where | The admin | The worker |
| --- | --- | --- |
| Railway ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 7) | `/api/health/ready`, for up to 300 seconds | `/health/ready` |
| A server (`docker-compose.yml`) | `/api/health/live` | `/health/ready` |

- On a server, the admin and the worker start only after migrate succeeds and Redis is healthy, and Caddy only once the admin is healthy. A failed migration, or an admin that keeps restarting, leaves nothing answering at your address ([7.3](part-7-operations.md#73-database-migrations)).
- Neither of the admin's checks looks at the worker ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)).

## 8.3 Sign-up, sign-in and email codes

**Sign-in says "Incorrect email or password. Please try again."**

The page says this whatever went wrong, unless the email still needs its code. The admin's log at that minute tells the causes apart:

| The admin's log | Why | What to do |
| --- | --- | --- |
| `WARN [Better Auth]: Invalid password` | The password is wrong | **Forgot password?** ([6.1](part-6-first-run.md#61-create-your-account)) |
| `WARN [Better Auth]: User not found` | No account has that email | Check the spelling, or sign up |
| `ERROR [Better Auth]: Invalid origin: <address>` | The page is open at another address than `APP_BASE_URL`. Any difference counts: `http` for `https`, with or without `www`, Railway's address once you moved to your own domain, or the server's IP address | Open the exact `APP_BASE_URL`. On Railway, a second address can go in the admin's `AUTH_TRUSTED_ORIGINS`, after a comma *(not tried)*; emails keep using `APP_BASE_URL` |
| An `[admin] exception:` line | Usually Redis is down | [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| Nothing | Too many tries: 5 a minute from one IP address. Or `LOBBYSTACK_MAINTENANCE_MODE` is `true` | Wait a minute. Set maintenance mode back to `false` ([7.6](part-7-operations.md#76-change-a-setting-safely)) |

If the admin's log has `[trusted-client-ip] TRUSTED_CLIENT_IP_HEADER is not configured` or `Rate limiting could not determine a client IP`, the admin can't tell visitors apart, and everyone shares one count of 5 sign-ins a minute. Set `TRUSTED_CLIENT_IP_HEADER` ([3.1](part-3-outside-services.md#31-choose-your-addresses)).

**Signing in brings you back to the sign-in page**

The sign-in page, "Welcome back", opens again, with no message. The address is plain `http://`, not `https://`, and isn't `localhost`. In production, the sign-in cookie works over HTTPS only, so the browser drops it *(not confirmed)*. Serve the dashboard over HTTPS, as Parts 4 and 5 do.

Otherwise, a sign-in lasts 30 days, and a password reset or a new `BETTER_AUTH_SECRET` ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) signs people out.

**Sign-up fails**

| What you see | Why | What to do |
| --- | --- | --- |
| "We couldn't create your account. Please try again." | Most often the Turnstile keys ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)): no `TURNSTILE_SECRET_KEY` on the admin, or a site key that wasn't in the build. Also 3 tries a minute from one address. The page shows this for every refusal, and the admin logs nothing | Check both keys, and build the admin again after you set the site key ([7.6](part-7-operations.md#76-change-a-setting-safely)) |
| No security check under the form | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` wasn't set when the admin was built | Set it, and build the admin again |
| "We couldn't verify the security check. Please try again." | Turnstile failed in the browser, often because the dashboard's host name isn't in the widget's **Hostname management** | Add it ([3.5](part-3-outside-services.md#35-cloudflare-turnstile), step 4) |
| "Complete the security check and try again." | The check hasn't finished | Wait: the page goes on by itself. If **Send a new code** says this every time, Turnstile isn't set up ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)) |
| The code screen appears for an email that already has an account | Expected: that person gets an email that says they already have an account, with links to sign in and to reset the password | Nothing |

**The code doesn't arrive**

- The admin hands the code to the worker, which emails it. While the worker isn't running, the code waits, and nothing is logged; it goes out once the worker is back, perhaps after it expired ([7.16](part-7-operations.md#716-worker-crash-and-stuck-calls)). When the worker has no `SMTP_HOST`, or the email service refuses the email, the worker logs a `job.failed` line for `email.send` with the reason ([7.17](part-7-operations.md#717-emails-or-texts-not-going-out)).
- A failed email is tried for about 15 seconds, then dropped. Once email works, ask for a new code.
- Each address gets at most 1 code a minute and 3 in a clock hour, the one sent at sign-up included. When the limit stops a code, the code screen still appears, but nothing was sent. **Send a new code** then says "Please wait before requesting another verification code." Reset codes have the same limit, and their screen also moves on without saying so.
- A code works for 10 minutes and 3 tries. The messages are "That verification code is invalid. Check the code and try again.", "That verification code has expired. Request a new one." and "Too many incorrect attempts. Request a new code."

**Codes and `REQUIRE_EMAIL_VERIFICATION`**

- Sign-up always asks for the code, whatever this setting says.
- With `REQUIRE_EMAIL_VERIFICATION=true`, sign-in asks for a code only from an account that never entered one, once its password is right. Accounts that entered their code sign in as usual ([6.1](part-6-first-run.md#61-create-your-account)).
- On that screen, **Send a new code** always needs the security check, so it works only with Turnstile set up ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)).

**Invitations**

- "This invitation is for <email>. Sign in with that address and verify it to accept.": the person is signed in with another account, or hasn't verified the invited address. **Sign in with another account** signs them out and brings them back.
- "This invitation has expired. Ask a workspace admin to send a new one.": it's more than 7 days old. Cancel it and invite again ([6.6](part-6-first-run.md#66-invite-the-team)).
- "This invitation link is invalid or has expired.": the link is wrong, or the invitation was canceled.
- The invitation's link, like every link LobbyStack emails, uses `APP_BASE_URL`, so check that it's the public address.

## 8.4 The dashboard

**"Something went wrong. Please try again." with Retry loading**

Usually Redis is down, because the dashboard looks up each sign-in there: the ready check then shows `"redis":"failed"` ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)). Otherwise, look for `[admin] exception:` lines from that minute ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).

**New calls, messages and bookings show only after a reload**

The dashboard updates itself through the worker and Redis: the worker sends each change to Redis, and the admin passes it on to each open page. When that breaks, nothing says so. Only the count of calls in progress, on **Calls**, still updates, every 5 seconds.

1. Check that the worker runs ([7.16](part-7-operations.md#716-worker-crash-and-stuck-calls)).
2. Check that the admin has `REDIS_URL`, and that both services use the same Redis and the same `REDIS_PREFIX` ([7.6](part-7-operations.md#76-change-a-setting-safely)). On a server, they read the same `.env`, so they match.
3. In the browser's **Network** tab ([8.1](#81-where-to-find-the-reason)), find the request that starts with `realtime?businessId=`:
   - 503 with "Realtime is not configured": the admin has no `REDIS_URL`.
   - It stays open, but shows only `ping` lines: the worker doesn't send the changes, or sends them to another Redis or prefix. Its log may have `job.failed` lines for `realtime.publish`.

**"Too many tries. Try again later." when buying a plan or opening the billing portal**

Since fork PR #74, a business can start 10 checkouts and open the billing portal 20 times an hour, and a person 20 checkouts and 40 portal sessions across their businesses ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)"). Past that, the upgrade dialog, **Have a promo code?**, **Manage subscription** and **Update payment method** on the "Payment unsuccessful" banner say "Too many tries. Try again later.", and onboarding's plan step says "Too many checkouts started. Try again in 23 minutes.", with the minutes left to the next hour. Wait until the top of the hour, when the counts start again. Nothing is logged for these refusals.

When every try fails, with "Unable to open checkout.", "Unable to change your plan." or "Unable to open the customer portal.", or "Request failed." on onboarding's plan step, look for an `[admin] exception:` line from that minute ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)). One saying `Billing protection is unavailable.` means Redis is down, so nothing can be counted ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)). For the billing portal, one naming Polar usually means the admin's token lacks `customer_sessions:write` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). A checkout that fails once it has started leaves `job.failed` lines for `billing.createCheckout` in the worker's log instead ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).

**"An earlier change to your subscription is still being applied. Try again in a minute."**

Since fork PR #75, a business that already pays for a plan changes it one request at a time ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)"). The upgrade dialog and **Have a promo code?** say this while another change for the business, such as one another admin has just asked for, still waits for Polar. Wait a minute and try again: the earlier change shows under **Settings** > **Plan** once Polar has made it. A change waits 15 minutes at most, so after that the message stops. When it keeps coming back for minutes, check that the worker runs ([7.16](part-7-operations.md#716-worker-crash-and-stuck-calls)), since the worker makes each change, and look in its log for `job.failed` lines for `billing.createCheckout` ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)). Nothing is logged for the refusal itself.

**The wrong name or logo**

| What you see | Why | What to do |
| --- | --- | --- |
| The admin's log has `[brand] brand.build_mismatch: this build shows …` | The admin was built with another `APP_BASE_URL` or `BRAND_PRESET` than it runs with | Build the admin again ([7.6](part-7-operations.md#76-change-a-setting-safely)) |
| The admin's log has `[brand] brand.unmatched:` | No brand claims the address, and nothing else picks one: `BRAND_PRESET` is empty and `brands/` holds no brand besides LobbyStack, or several | Set `BRAND_PRESET`, or claim the domain ([3.6](part-3-outside-services.md#36-your-brand)) |
| Emails and texts name another app than the dashboard | `BRAND_PRESET` differs on the admin and the worker | [7.6](part-7-operations.md#76-change-a-setting-safely) |
| The name chosen during onboarding doesn't show | A brand file applies, by your address, `BRAND_PRESET` or as the only brand besides LobbyStack, and wins over that choice | [3.6](part-3-outside-services.md#36-your-brand) |

## 8.5 Phone calls

[7.15](part-7-operations.md#715-calls-not-answered-or-dropping) follows a call that isn't answered or that drops, and [7.16](part-7-operations.md#716-worker-crash-and-stuck-calls) a worker that stopped. Four more things callers notice:

**A busy signal**

The business is a `cloud` business on an instance that sells plans, and it has used up its call minutes for the month. Phone calls and calls from the browser share them, and both get the same time. On Free, the limit is 30 minutes, and a lapsed paid plan counts as Free. On Starter (150 minutes) and Pro (500), the included minutes always work. Extra minutes stop only when the business set a **Monthly spending cap** and their overage would take the month's spend past it. Extra texts and transfers count toward the same cap, so they can use it up before the calls do, and the included minutes still work then (`packages/domain/src/server/usage.ts:160-167` and `243-252`; fork PR #68).

- The admin turns each new call away with a busy signal before it's answered *(what callers hear: not confirmed)*. No call shows in **Calls**, and the admin's log has only a `live.incoming` line with `recordMs` and without `acceptMs` (`apps/admin/app/api/webhooks/openai/live/route.ts:153-173`).
- A call in progress when the minutes run out ends with the receptionist's time-limit goodbye.
- **Settings** > **Usage** shows the month's use. The minutes start again on the first of each month, in UTC, whatever day the subscription renews.
- The business upgrades, or raises its cap, in **Settings** > **Plan**. On an instance that doesn't sell plans, no business should be `cloud`: see [8.12](#812-a-business-on-the-free-plan-by-mistake).

**Silence after a question**

When the receptionist needs to look something up, such as open times or a document, the worker asks the text AI, and the caller hears silence meanwhile. After 4 seconds, the receptionist says it's still checking. After 30 seconds, it gives up, and offers to take a message. The worker's `live.delegation` lines show each wait as `agentMs` ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).

- Look at OpenAI's status page first ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)).
- Leave `AI_DELEGATION_REASONING_EFFORT` and `AI_DELEGATION_SERVICE_TIER` empty on the worker. They then use `low` and `priority`, the fastest. More effort, or `AI_DELEGATION_SERVICE_TIER=default` ([7.13](part-7-operations.md#713-costs-and-usage-limits)), makes callers wait longer. Both apply to OpenAI only: with another `AI_CHAT_BASE_URL`, neither does anything.

**Silence before the greeting**

Since fork PR #96, with `LIVE_RECORDED_GREETING=true` on the admin, a phone call opens with a recording of the greeting, which plays as soon as the worker connects to the call, within about a second of the answer ([8.6](#86-calls-from-the-browser), "The greeting comes late"). Without a recording, or with `LIVE_RECORDED_GREETING_PHONE=false` on the admin, the receptionist starts the greeting about 2 seconds after it answers, when it follows the request to: in October it did on about half of phone calls. If it hasn't started speaking 4 seconds after the answer, the worker asks again, up to 3 tries in all, each logged as `live.greeting`. A caller who says "Hello?" first stops those tries. Since fork PR #98 the receptionist then says the greeting and the notice before it answers them (`"trigger":"caller_spoke"`), and the 4 seconds count from the answer even when the worker connected late; on an older copy it answers without the greeting. Repeated tries point at OpenAI's status page.

**An AI and recording notice after the greeting**

Since fork PR #84, right after the greeting every call says "You're speaking with an AI assistant, and this call is recorded and transcribed.", in the **Default customer language**. That's meant: many places require telling callers that a call is recorded. A business that tells its callers another way turns **Tell callers about AI and recording** off in **AI settings**, and calls stop saying it once the business's snapshot refreshes ([calls](../../features/calls.md#tell-callers-theyre-speaking-with-an-ai-and-the-call-is-recorded)).

**A caller is turned away at once**

The call shows "Blocked" and "Call was blocked before the assistant answered.": the caller's contact is blocked, and the receptionist blocks an abusive caller by itself. Open **Contacts**, then the contact, and click **Unblock contact**.

## 8.6 Calls from the browser

Two buttons start a call in a browser: **Test Call** in the dashboard ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)), and **Say Allo!** in the website chat ([6.5](part-6-first-run.md#65-put-the-chat-on-your-website)), whose tooltip reads "Talk to us live". Both fail for the same reasons, but the website chat says less: "Live voice is unavailable. Try again later." stands for almost every failure. The admin's log says more.

**The button is missing**

- **Test Call** hides on narrow screens: widen the window. Only owners and admins can start a call.
- **Say Allo!** shows only when all of these were true as the chat opened:
  - The business has a phone number ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)). On an instance that sells plans, that takes Starter or Pro.
  - The admin has `LIVE_PROTOTYPE_ENABLED=true` and `OPENAI_API_KEY`.
  - The business has call minutes left ([8.5](#85-phone-calls)).

  A new number can take 5 minutes, and a reload of the website, to bring the button. Nothing checks the worker, so with the worker down the button shows, and the call fails.

**What the dashboard says**

| The message | Why | What to do |
| --- | --- | --- |
| "Something went wrong while starting the call." | One of many causes, which the admin's log tells apart (next table) | |
| "Too many test calls have been started. Please try again shortly." | A limit on test calls: 30 an hour and 100 a day from one browser or IP address, 120 an hour and 600 a day per business, and 120 a minute for the whole instance | Wait. Hourly limits start again on the hour, and daily ones at midnight UTC |
| "Your AI receptionist is unavailable right now." | The business has no call minutes left | [8.5](#85-phone-calls) |
| "The call took too long to connect." | Nothing answered within 15 seconds. The admin's `live.browser_start` line shows the slow step: `openaiMs` for OpenAI, `attachMs` for the worker | The worker ([7.16](part-7-operations.md#716-worker-crash-and-stuck-calls)), or OpenAI's status page ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)) |
| "Microphone access was blocked.", "No microphone was found on this device." or "The microphone is already in use by another app." | The browser or the computer | Allow the microphone for this address in the browser's site settings, or close the other app |
| "This browser does not support microphone calls." | The page is plain `http://` and not `localhost`, so the browser hides the microphone | Use HTTPS |
| "This page can't reach <app name> to start the call." | Safari couldn't reach the admin. Other browsers show the first message instead | The ready check ([8.1](#81-where-to-find-the-reason)) |
| "The voice connection dropped." | The connection broke for more than 5 seconds | Check the network, and call again |

The website chat shows "Too many calls have been started. Try again later, or keep chatting below." when a limit runs out: 10 calls an hour and 50 a day per visitor, 20 an hour and 100 a day per IP address, 30 every 10 minutes per website, and 60 an hour and 300 a day per business. It shows "The voice connection ended. You can keep chatting below." when a call drops, and "Live voice is unavailable. Try again later." for everything else, microphone problems included. The limits per IP address count only with `TRUSTED_CLIENT_IP_HEADER` set ([3.1](part-3-outside-services.md#31-choose-your-addresses)).

**What the admin's log says**

For "Something went wrong while starting the call." and "Live voice is unavailable. Try again later.", look at the admin's log at that minute:

| The admin's log | Why | What to do |
| --- | --- | --- |
| Nothing | The admin has no `OPENAI_API_KEY`, or its `LIVE_PROTOTYPE_ENABLED` isn't `true`. Or, for **Test Call**, you're signed out, or not an owner or admin of the business | Set both on the admin, and deploy ([7.6](part-7-operations.md#76-change-a-setting-safely)). Sign in as an owner or admin |
| `live.browser_refused` with `"code":"origin_denied"` | The dashboard is open at another address than `APP_BASE_URL` | Use that exact address |
| `live.browser_refused` with `"code":"web_voice_rate_limited"` | A limit ran out. Its `reason` names which, such as `rate_limit_visitor_hour` | Wait |
| `live.browser_refused` with `"code":"web_voice_rate_limit_unavailable"` | Redis is down, so no call can be counted, and every call is refused | [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| `live.browser_refused` with `"code":"voice_limit_reached"` | No call minutes left | [8.5](#85-phone-calls) |
| `live.browser_refused` with `"code":"widget_origin_denied"` or `"code":"widget_session_invalid"` | The widget key is paused, the website isn't in its **Allowed origins**, or the chat's session ran out | [8.7](#87-the-website-chat). Reload the website |
| `live.browser_refused` with `"code":"voice_unavailable"` | The website chat's business has no phone number | [6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls) |
| `[admin] exception: OpenAI refused to create the live session (<code>)` | OpenAI turned the call away. `insufficient_quota` means no credit. Other codes mean a wrong key, or a project that doesn't allow `gpt-live-1` | Add credit, check `OPENAI_API_KEY`, or allow the model on the project's **Limits** page ([3.2](part-3-outside-services.md#32-openai)) |
| `[admin] exception: Worker attach failed with status 404.` | The worker's `LIVE_PROTOTYPE_ENABLED` isn't `true` | Set it on the worker |
| `[admin] exception: Worker attach failed with status 401.` | `INTERNAL_SERVICE_TOKEN` differs on the admin and the worker | [7.6](part-7-operations.md#76-change-a-setting-safely) |
| `[admin] exception: Worker attach failed with status 503.` | The worker is stopping, during a deploy | Call again a minute later |
| `Worker attach failed with status 500.`, `fetch failed`, or a time-out | The worker failed, or isn't running | [7.16](part-7-operations.md#716-worker-crash-and-stuck-calls) |

**The call ends by itself**

- After 30 minutes, the limit for calls from the browser. A minute before its goodbye, the receptionist tells the caller that time is nearly up, and it says goodbye 30 seconds before the end. To shorten the limit, set `WEB_CALL_MAX_DURATION_MS` on the admin ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)); on a server, in the override file ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17). On a copy older than `9b66d01`, the limit is 5 minutes, with no warning, unless the variable raises it.
- After 75 seconds in which nobody speaks.
- On a `cloud` business, when its call minutes run out.

**The greeting comes late**

With `LIVE_RECORDED_GREETING=true` on the admin ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 6), calls from the browser open with a recording of the greeting, which plays once the caller's audio reaches the call, or 3 seconds after the call starts without it. Since fork PR #96, phone calls do too: the recording plays once the caller's audio reaches the worker, or a second after the worker connects to the call without it. `LIVE_RECORDED_GREETING_PHONE=false` on the admin keeps phone calls on the spoken greeting. On a copy older than fork PR #96, phone calls always have the greeting spoken.

- The first call after the setting is turned on, after the greeting changes, or after the notice after it is turned on or off, has no recording yet: the worker records the opening during that call, for the calls after it. Each business's first browser call after fork PR #84 deploys is one of these, since the notice changes every opening. Since fork PR #96, with `LIVE_RECORDED_GREETING=true` on the worker too, the worker records a business's opening as soon as the change reaches it, and the opening of every business with a phone number when it starts and once a day, so even the first call after a change usually has its recording.
- It needs one Redis shared by the admin and the worker, and `OPENAI_API_KEY` on the worker. When either is slow, the call falls back to the spoken greeting.
- The admin's `live.browser_start` line (a call from the browser) or `live.incoming` line (a phone call) shows `"greetingRecording":true` when a call used the recording. The worker logs `live.greeting_recorded` when it records one, and `live.greeting_recording_failed` when it can't. Since fork PR #97 GPT-Live records it, in up to three short sessions, and keeps it only when GPT-Live said the whole opening; after three failures the worker waits 6 hours before trying that opening again, so its calls have the greeting spoken meanwhile. The failure line gives each session's reason ([the voice runtime](../../voice/runtime.md#make-a-recording)).
- The caller can't be heard while the recording plays.
- A caller who speaks before the recording plays, such as a phone caller who says "Hello?" as they pick up, doesn't hear it. The receptionist says the greeting and the notice before it answers them instead, and the worker's `live.greeting` line shows `"trigger":"caller_spoke"`.
- A call that opens silent: the worker's `live.greeting` line with `"trigger":"recording"` and `"step":"sent"` shows `"inputAudioMs":0` when the recording played before any of the caller's audio arrived.

## 8.7 The website chat

**No chat bubble on the website**

1. Open `https://<your address>/embed.js`. If it shows `/* LobbyStack widget loader is unavailable. …`, the admin was built without the chat's loader: build it again. On your computer, run `pnpm widget:embed:build`.
2. Look at the snippet in the website's HTML. It must contain `embed.js?key=wk_live_`, and start with your public address. A snippet copied while the dashboard was open at another address, such as `http://localhost:13000`, sends every visitor there: copy it again from the dashboard at its public address.
3. A website on `https://` can't load the chat from an `http://` address *(not confirmed)*. Serve the admin over HTTPS.
4. If **Settings** > **Website widget** says "New website widgets are not available yet", see [6.5](part-6-first-run.md#65-put-the-chat-on-your-website), step 1.

**The bubble opens, but shows an error**

| The chat says | Why | What to do |
| --- | --- | --- |
| "This widget is not available." | The key is paused, revoked or mistyped, or the business isn't active | Check the key in **Settings** > **Website widget**, and copy the snippet again |
| "This website is not authorized to load this widget." | The page's address isn't in the key's **Allowed origins**. It must match exactly: `https://example.com` and `https://www.example.com` are two addresses, and a port counts too | Add every address the website uses |
| "The widget could not be loaded." | Everything else: too many chats opened at once (more than 60 a minute for one business, for example), Redis down, an error on the admin, the admin out of reach, or the key paused during the chat | The ready check, then the code in the browser ([8.1](#81-where-to-find-the-reason)): `widget_rate_limited`, `widget_rate_limit_unavailable`, `widget_session_failed` or `widget_disabled` |

**The chat doesn't answer**

| What you see | Why | What to do |
| --- | --- | --- |
| "This month's chat session limit has been reached. Our team will reply shortly." | A `cloud` business on Free used its 5 AI chats for the month, and a lapsed paid plan counts as Free. On Starter and Pro the chat keeps answering past the plan's chats, and since fork PR #68 the spending cap never stops it either (`packages/domain/src/server/billing.ts:87`, `usage.ts:243-251`). The visitor's message is still saved, and the team gets the "New website chat message" alert | Upgrade, or see [8.12](#812-a-business-on-the-free-plan-by-mistake) on an instance that doesn't sell plans |
| "Your message couldn't be sent. Please try again." and an Error ID under it | The receptionist's answer failed (OpenAI refused or failed the request, or the answer came back empty), or the admin had an error. When only the answer failed, the visitor's message is saved, and the team gets the "New website chat message" alert | Find the ID in the admin's log ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)). Its `category` says why, and the [widget's page](../../features/website-widget.md#find-out-why-a-reply-failed) says what to check for each. `provider_rate_limited` with `insufficient_quota` means OpenAI's credit ([7.13](part-7-operations.md#713-costs-and-usage-limits)) |
| "Your message couldn't be sent. Please try again." and no Error ID | The message was turned away: no AI key on the admin (`OPENAI_API_KEY` or `AI_CHAT_API_KEY`), too many messages (60 an hour per visitor), or Redis down | The admin's `widget.chat_refused` line, or the code in the browser ([8.1](#81-where-to-find-the-reason)): `ai_provider_unavailable` means the key, `widget_rate_limited` the limit, and the line's `reason` names the count that ran out |
| "A team member will reply shortly." | Someone from the team has the chat, so the receptionist stays quiet | Reply from **Messages** ([6.5](part-6-first-run.md#65-put-the-chat-on-your-website)) |
| Just after a business was created, the chat can't book or doesn't know the hours | The worker hasn't yet put together what the receptionist knows | Wait a few minutes, and check the worker ([7.16](part-7-operations.md#716-worker-crash-and-stuck-calls)) |

The chat writes nothing to the browser's console. Since fork PR #79, the admin logs each message it turns away as `widget.chat_refused`, with the `code`, and each failed answer as an `[admin] exception:` line with the Error ID. When the chat won't open, nothing is logged: look at the answers from `/api/widget/session` and `/api/widget/config` in the browser's **Network** tab ([8.1](#81-where-to-find-the-reason)).

## 8.8 Booking

When the receptionist can't book, it's told why, and tells the caller in its own words. Read the conversation in **Calls** or **Messages**, and find the reason here:

| What the receptionist does | Why | What to do |
| --- | --- | --- |
| It takes a message for every appointment, and **AI settings** shows "Add opening hours to book appointments" | No opening hours | Add them in **AI settings** > **Opening hours** ([6.3](part-6-first-run.md#63-set-up-the-first-business)) |
| It says the service isn't available, or names no services. **Services** shows "No services added yet." | No service has **Bookable** on, or the caller's words don't match a service's name | Add a service, with **Bookable** on ([6.3](part-6-first-run.md#63-set-up-the-first-business)) |
| It notes a preferred time, and the inbox item starts "Appointment request:" | **Appointments** is set to **Takes requests** | **AI settings** > **Appointments** > **Books appointments** |
| It always takes a message | **Appointments** is set to **Doesn't book** | The same |
| It says it can't confirm times right now, and takes a message | The chosen Google calendar isn't in sync: it's "Synchronizing", in error, or hasn't synced in 20 minutes. Or the appointment ends more than 90 days after the last sync | [8.9](#89-google-calendar) |
| It offers odd times, or calls times inside your hours "outside the opening hours" | The business's time zone is wrong. It came from the browser of whoever created the business, or UTC | **AI settings** > **Business timezone** |
| It says the service doesn't fit that day | The whole appointment must fit inside one of the day's opening ranges. A service longer than the range, one that would run over a lunch break, or hours past midnight never fit | Check the service's **Duration** and the hours |
| It says the time is taken, or no times are free | Another appointment overlaps: a business takes one appointment at a time, and no setting changes that. A busy event in the chosen Google calendar blocks its time too | Nothing, or mark the Google event **Free** |
| It asks for the caller's name, or in a chat for a phone number | It needs them to book | Nothing |

- Nothing limits how soon or how far ahead people book: a time a minute away can be booked. The **Booking policy**, which only the command line sets (`lobbystack receptionist set`), isn't enforced and isn't used on calls ([Appendix E](appendix-e-doc-problems.md)). A rule ([6.3](part-6-first-run.md#63-set-up-the-first-business)) is the nearest thing, and the receptionist may not always follow it.
- Closed days can't be entered ([6.3](part-6-first-run.md#63-set-up-the-first-business)). To close one, take the day out of the opening hours for that week, or add a busy event to the chosen Google calendar.
- A blocked contact can't call ([8.5](#85-phone-calls)), but can still book in the website chat.
- Plan limits never stop booking itself: they stop the calls or the chat ([8.5](#85-phone-calls), [8.7](#87-the-website-chat)).

## 8.9 Google Calendar

| What you see | Why | What to do |
| --- | --- | --- |
| **Connect** shows "Request failed." | The admin lacks `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `GOOGLE_REDIRECT_URI`, and its log says `Google Calendar OAuth is not configured.` The card shows even without them | Set all three on the admin and the worker ([3.7](part-3-outside-services.md#37-optional-services)), and deploy |
| "Too many calendar authorization attempts. Please try again later." | More than 20 tries in an hour by one person, 60 by one business, or 30 from one IP address. Or Redis is down | Wait an hour, or check Redis ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)) |
| Google's page says "Error 400: redirect_uri_mismatch" | `GOOGLE_REDIRECT_URI` isn't exactly one of the client's **Authorized redirect URIs** | Use the same `https://<your address>/api/calendar/google/callback` in both ([3.7](part-3-outside-services.md#37-optional-services), step 6) |
| Back in the dashboard, "Unable to complete the Google Calendar connection." | **Cancel** was clicked at Google. Or `GOOGLE_REDIRECT_URI` is on another address than the one you signed in at, such as Railway's. Or Google refused the client, and the admin's log has `Google OAuth token exchange failed with status <n>.` | Connect again, from the dashboard at the address in `GOOGLE_REDIRECT_URI`. Check `GOOGLE_CLIENT_SECRET` |
| A page with only a line such as `{"error":"Google OAuth state is invalid or expired."}` | More than 10 minutes at Google, a reload or **Back**, or a link started by another dashboard user | Open **Integrations** again, and click **Connect** |
| "Google Calendar connected successfully.", then "Needs attention" | A box was left unticked on Google's permission screen | **Reconnect Google**, and tick every box |
| Connected, but no events appear in the calendar | No calendar is chosen | Choose one under **Google calendar** |
| The card says "Synchronizing" and never changes, and the receptionist takes messages instead of booking | The worker lacks one of the three `GOOGLE_` values, so it never syncs | Set them on the worker ([3.7](part-3-outside-services.md#37-optional-services)), and deploy |
| "Needs attention" and **Reconnect Google**, and the email "Calendar connection needs attention" | The sync failed. Usually the Google app is still in Testing, which stops connections after 7 days. Or access was removed in the Google account, the client was deleted or its secret changed, or `ENCRYPTION_KEY` differs on the admin and the worker | If the app is in Testing, **Publish app** ([3.7](part-3-outside-services.md#37-optional-services), step 8). Then **Reconnect Google**. For a deleted client, make a new one, put its values on both services, deploy, and reconnect |
| An appointment's **Calendar** column says "Failed", and the email "Calendar sync failed" arrives | That event couldn't be written | Check that the Google account can still edit the calendar, then reconnect |

- The dashboard never shows Google's reason. Someone technical finds it with `pnpm lobbystack calendar list --json`, as `sync_error` ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)), or in the worker's log, as `calendar.reconcileBusiness failed (attempt <n> of 5)`.
- The "Calendar connection needs attention" email goes out once per connection, so a later failure of the same connection sends none *(not confirmed)*.
- Reconnecting with the same Google account keeps the chosen calendar *(not confirmed)*. Another account needs one chosen again.
- **Disconnect** acts at once, without asking. The receptionist then books without the calendar.
- While the calendar isn't in sync, the receptionist books nothing and takes messages instead ([8.8](#88-booking)).

## 8.10 Language

| What you see | Why | What to do |
| --- | --- | --- |
| Calls open in English for a French or Spanish business, or the other way round | Calls start with the greeting, in the greeting's own language, and a new business's greeting is in English. The notice after the greeting is always in the **Default customer language**, so an opening in two languages means the greeting is in another | Write the **Greeting** in the **Default customer language** ([6.3](part-6-first-run.md#63-set-up-the-first-business)) |
| Calls never open in Serbian, or in another language you want | **Default customer language** offers 13 languages: English, Spanish, French, German, Hindi, Japanese, Korean, Portuguese, Mandarin Chinese, Italian, Ukrainian, Russian and Arabic. Serbian isn't one, though the dashboard has it. The receptionist switches when a caller asks, or clearly speaks another language, and keeps answering in it for the rest of the call | Nothing |
| A business set up from a Serbian dashboard opens calls in English | Onboarding picks the dashboard's language when calls can open in it: English, French or Spanish | **AI settings** > **Default customer language** |
| Texts to callers are in English for a German business | Texts have wording in English, French, Spanish and Serbian only. They follow the contact's preferred language, or else the business's, and use English for any other | Nothing |
| The website chat shows English or French to a visitor whose browser is in another language | The widget's words are in English, French, Spanish and Serbian only, so for any other browser language "Visitor's language" shows the business's. The replies still follow the language the visitor writes in ([website widget](../../features/website-widget.md#know-which-language-the-chat-uses)) | Nothing, or pick the language in **Settings** > **Website widget** |

## 8.11 Knowledge

| What **Knowledge** shows | Why | What to do |
| --- | --- | --- |
| "Queued", for a long time | The worker isn't running | [7.16](part-7-operations.md#716-worker-crash-and-stuck-calls) |
| "Error", with "Knowledge embedding provider is not configured." | The worker has no key for reading documents: `AI_EMBEDDING_API_KEY`, or else `OPENAI_API_KEY` | Set it, and deploy the worker |
| "Error", with "Knowledge embedding provider failed." or "Knowledge embedding provider returned an incomplete result." | OpenAI refused: no credit, or a project that doesn't allow `text-embedding-3-small` | OpenAI's credit and **Limits** page ([3.2](part-3-outside-services.md#32-openai)) |
| "Error", with "We couldn't read the text in this document." or "No readable text was extracted from the document." | A scan or a picture, with no text in it | Paste its text as a **Text** entry |
| "Error", with "Knowledge storage limit reached. 1 MB of text is included on this plan." | The Free plan's limit | Upgrade, or [8.12](#812-a-business-on-the-free-plan-by-mistake) |
| "Error", with "This document couldn't be processed." | Something else | The worker's log, at `knowledge.extractDocument failed` |
| A website import says "Import failed. Please try again." | No `FIRECRAWL_API_KEY` on the worker, Firecrawl refused, or the site gave no readable text | Set the key ([3.7](part-3-outside-services.md#37-optional-services)). The worker's log has `knowledge.crawlWebsite failed` with the reason, except when the key is missing |

What the receptionist reads:

- Documents that show "Ready" and are switched on. On calls, it knows only their titles, and looks up their content when asked, which takes a few seconds ([8.5](#85-phone-calls)). Put what callers ask most into a **Text** entry or the **Business summary**.
- 8 **Text** entries at most. The dashboard gives them all the same priority, so with more than 8, which ones it reads isn't fixed ([Appendix E](appendix-e-doc-problems.md)): keep the important ones to 8 or fewer, and put the rest in a document.
- On calls, the first 50 rules, each up to 4,000 characters, though the dashboard saves up to 10,000.
- The admin and the worker must use the same embedding settings. After a change of `AI_EMBEDDING_MODEL` on both, restart the worker: it reads every document again. A model whose vectors don't have 1,536 numbers fails every document with "Embedding provider returned <n> dimensions; this deployment requires exactly 1536."

## 8.12 A business on the Free plan by mistake

On an instance that doesn't sell plans, a business with these signs was created as a `cloud` business:

- **Settings** > **Plan** says "Free Plan", not "Self-host".
- **Settings** > **Phone Number** says "Dedicated numbers are on paid plans".
- Calls from the browser stop after 30 minutes in a month, the website chat stops answering after 5 chats, and **Knowledge** stops at 1 MB of text.

It was created while the admin's `DEPLOYMENT_MODE` wasn't `self_hosted_standard`: on a server before the override file of [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17, in Way B on your computer ([2.5](part-2-local-development.md#25-way-b-run-everything-in-docker)), or on Railway before the variable was set. A business keeps the mode it was created with ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)), so someone technical moves it:

1. Set `DEPLOYMENT_MODE=self_hosted_standard` on the admin and the worker first, so that new businesses come out right ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker); on a server, [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17). On a server, `docker compose exec admin printenv DEPLOYMENT_MODE` must print it.
2. Back up the database ([7.7](part-7-operations.md#77-back-up-the-database-and-files)).
3. Sign in to the database as `postgres` ([Part 7](part-7-operations.md), "Signing in to the database"), and list each business with its mode and plan:

   ```sql
   select b.id, b.name, b.deployment_mode, a.plan, a.subscription_state
   from businesses b left join billing_accounts a on a.business_id = b.id
   order by b.created_at;
   ```

4. Move the business, with its `id` from that list, which is also its **Business ID** in **Settings** > **API keys**:

   ```sql
   with moved as (
     update businesses set deployment_mode = 'self_hosted_standard', updated_at = now()
     where id = '<business ID>' returning id
   )
   insert into billing_accounts (business_id, billing_key, plan, subscription_state)
   select id, 'business:' || id, 'self_hosted_standard', 'active' from moved
   on conflict (business_id) do update
   set plan = 'self_hosted_standard', subscription_state = 'active', overage_spending_cap_cents = null, updated_at = now();
   ```

   `INSERT 0 1` means it moved. `INSERT 0 0` means no business has that ID, and nothing changed. To move every `cloud` business at once, write `where deployment_mode = 'cloud'` in place of `where id = '<business ID>'`.
5. Reload **Settings** > **Plan**: it says "Self-host". The limits are gone, and the business can get a number ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).

The statement changes two tables because the limits read the business's mode, while the dashboard's plan screens read its billing account (`packages/domain/src/server/usage.ts:68-73`, `apps/admin/src/components/live-setup-guide-surface.tsx:55`). On 2026-10-19 it was run against a throwaway database with every migration up to `0105`, for a business without a billing account, one with a lapsed Starter plan and a spending cap, and an ID that doesn't exist. It hasn't been run on a live instance yet.

On an instance that sells plans, leave businesses `cloud`. To let one business there use the instance without limits, `lobbystack billing managed-plan` puts it on Enterprise; it needs a platform key made with `--access all` ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)).

## 8.13 What to send someone technical

When you ask for help, send:

- What you did, and what you saw: the exact message, or a screenshot.
- When it happened, with your time zone, and whether it happens every time.
- The instance's address, and the business's **Business ID** (**Settings** > **API keys**).
- The error ID, if the screen showed one ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).
- For a call: its page's address in **Calls**, and from its **Details** tab the **Twilio Call SID** and the **Gateway session** ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).
- The version: the `"version"` that `https://<your address>/api/health/live` shows ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)).
- The admin's and the worker's log lines from those minutes ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).

Never send passwords, keys, secrets or the `.env` file, nor the output of `docker compose config`, which prints them all. Log lines can hold callers' phone numbers and email addresses: send only the lines that matter.

**Not yet confirmed:**

- What Railway shows when a build runs out of memory.
- The exact text of `listen EAFNOSUPPORT`, and whether IPv6 switched off with `sysctl` causes it too.
- That browsers drop the sign-in cookie at a plain `http://` address, as the code's cookie settings and the browsers' rules suggest.
- What callers hear when the admin turns a call away with a busy signal.
- Whether a browser lets an `https://` website load the chat from an `http://` address.
- Whether a later failure of the same Google connection sends a new "Calendar connection needs attention" email, and whether reconnecting with the same Google account keeps its calendar.
- That Docker leaves an unhealthy worker running without restarting it.

**Part 8 was checked against:** `apps/admin/instrumentation.ts`, `packages/shared/src/productionSecrets.ts`, `packages/shared/src/brands/resolve.ts`, `apps/admin/src/lib/startup-role-assertion.ts`, `packages/db/src/client.ts`, `apps/worker/src/index.ts`, `apps/worker/src/health.ts`, `packages/providers/src/storage/provider.ts`, `docker-compose.yml`, `Dockerfile.admin`, `apps/admin/src/lib/auth.ts`, `apps/admin/src/components/auth-card.tsx`, `apps/admin/src/lib/turnstile.ts`, `apps/admin/src/lib/verification-flow.ts`, `apps/admin/src/lib/email-verification-policy.ts`, `apps/admin/src/components/accept-invite-surface.tsx`, `apps/admin/src/lib/redis.ts`, `apps/admin/app/api/realtime/route.ts`, `apps/admin/src/lib/realtime-query.ts`, `apps/admin/app/api/voice/live/session/route.ts`, `apps/admin/src/lib/live-web-call.ts`, `apps/admin/src/lib/web-voice-policy.ts`, `apps/admin/src/lib/live-prototype.ts`, `apps/admin/src/lib/live-greeting.ts`, `packages/web-voice/src/useWebVoiceCall.ts`, `apps/admin/app/api/webhooks/openai/live/route.ts`, `apps/admin/app/api/widget/config/route.ts`, `apps/admin/app/api/widget/chat/route.ts`, `apps/admin/src/lib/widget-access.ts`, `apps/admin/src/lib/widget-policy.ts`, `apps/admin/src/components/widget/widget-chat-client.tsx`, `apps/admin/app/embed.js/route.ts`, `packages/embed/src/index.ts`, `packages/agent-core/src/tools.ts`, `packages/agent-core/src/instructions.ts`, `packages/agent-core/src/live/callController.ts`, `packages/agent-core/src/model.ts`, `packages/domain/src/server/booking.ts`, `packages/domain/src/server/receptionistActions.ts`, `packages/domain/src/server/calendar.ts`, `packages/providers/src/google/calendar.ts`, `apps/worker/src/calendarJobs.ts`, `apps/admin/src/components/live-integrations-surface.tsx`, `apps/admin/app/api/calendar/google/callback/route.ts`, `packages/domain/src/server/knowledge.ts`, `packages/domain/src/snapshot.ts`, `apps/admin/src/components/add-knowledge-sheet.tsx`, `packages/providers/src/ai/embeddingProvider.ts`, `apps/worker/src/handlers.ts`, `packages/domain/src/server/usage.ts`, `packages/domain/src/server/billing.ts`, `packages/domain/src/server/smsSender.ts`, `packages/shared/src/billing.ts`, `packages/db/migrations/0094_api_number_claims.sql`, the dashboard's and the website chat's English labels in `apps/admin/public/locales/en/`, and the Better Auth 1.7.7 package the code pins. [8.12](#812-a-business-on-the-free-plan-by-mistake)'s statements were run against PostgreSQL 16 with pgvector, after `pnpm db:migrate`. [8.4](#84-the-dashboard)'s limits on checkouts and the billing portal were checked at `7d20322` against `apps/admin/src/lib/billing-limit.ts`, `fixed-window-limit.ts` and `api-helpers.ts`, `apps/admin/app/api/billing/checkout/route.ts` and `portal/route.ts`, `apps/admin/src/components/live-plan-surface.tsx`, `live-upgrade-plan-provider.tsx`, `onboarding-plan-surface.tsx`, `billing-past-due-banner.tsx` and `promo-code-entry.tsx`, and `apps/admin/public/locales/en/settings.json` (fork PR #74). Its message for a plan change that waits for another was checked at `24e211d` against `packages/domain/src/server/billing.ts`, `apps/admin/src/lib/billing-plans.ts`, `api-helpers.ts`, `live-upgrade-plan-provider.tsx` and `promo-code-entry.tsx` (fork PR #75).
