# Appendix D. Deployment worksheet

Copy these tables into a document of your own, one copy per instance, and fill them in as you go. Write a value in the **Test** and **Production** columns only when the **Kept** column says **Here**. For everything marked **Password manager**, write only the name of the entry that holds it, such as "LobbyStack production: Railway", never the value: a worksheet gets printed, shared and left in folders ([1.2](part-1-prepare.md#12-your-worksheet-and-keeping-secrets-safe)).

**The instance**

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| Whether it sells plans: `DEPLOYMENT_MODE`, `self_hosted_standard` or `cloud` | [1.3](part-1-prepare.md#13-decide-these-before-any-data-exists) | Here | | |
| The address, `APP_BASE_URL` | [3.1](part-3-outside-services.md#31-choose-your-addresses) | Here | | |
| Where the domain is registered, and when it renews | [3.1](part-3-outside-services.md#31-choose-your-addresses), [7.25](part-7-operations.md#725-routine-maintenance-calendar) | Here | | |
| The brand: none, a brand in the code, or your own; and `BRAND_PRESET`, if set | [3.6](part-3-outside-services.md#36-your-brand) | Here | | |
| The fork on GitHub, `github.com/<owner>/lobbystack`, and the branch it deploys | [1.4](part-1-prepare.md#14-get-the-code), [5.2](part-5-production.md#52-production-on-railway) | Here | `main` | `production` |
| On Railway: the workspace and the project's name | [4.2](part-4-test-environment.md#42-create-the-account-and-the-project) | Here | | |
| On a server: the provider, the plan, and the server's IPv4 address | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 1 and 3 | Here | | |
| The password manager entry for this environment | [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets); [5.2](part-5-production.md#52-production-on-railway), step 3 | Here | | |
| Who holds the master copy of that entry, and who else can open it | [1.2](part-1-prepare.md#12-your-worksheet-and-keeping-secrets-safe) | Here | | |

**Passwords and secrets**

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| The 13 values: the five database passwords, Redis's, and the seven secrets | [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets) | Password manager | | |
| On a server: the whole `.env` file | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 25 | Password manager | | |
| A second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET`, kept somewhere else | [5.2](part-5-production.md#52-production-on-railway), step 3 | Password manager | | |

**OpenAI** ([3.2](part-3-outside-services.md#32-openai))

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| The organization, and the project's name | Steps 3 and 5 | Here | | |
| The project ID, `proj_…` | Step 6 | Here | | |
| The API key, `sk-…` (`OPENAI_API_KEY`) | Steps 7 to 11 | Password manager | | |
| The monthly limit, and whether it's a hard limit | Steps 12 and 13 | Here | | |
| The webhook's signing secret, `whsec_…` (`OPENAI_WEBHOOK_SECRET`) | Steps 14 to 16, after [4.7](part-4-test-environment.md#47-use-your-own-domain-optional) | Password manager | | |

**Twilio** ([3.3](part-3-outside-services.md#33-twilio))

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| The subaccount's name | Step 4 | Here | | |
| Its Account SID, `AC…` (`TWILIO_ACCOUNT_SID`) | Step 5 | Here | | |
| Its Auth Token (`TWILIO_AUTH_TOKEN`) | Step 5 | Password manager | | |
| The trunk's name, and its Trunk SID, `TK…` (`TWILIO_SIP_TRUNK_SID`) | Steps 7 and 9 | Here | | |
| The business profile: sent on, approved on | Step 3 | Here | | |
| US texting (A2P 10DLC): the brand and the campaign, sent on, approved on | Step 14 | Here | | |
| The numbers bought, each with its business | [6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls), [7.21](part-7-operations.md#721-buy-change-and-release-numbers) | Here | | |
| Only if you sell plans: the shared number (`TWILIO_ALERT_SMS_FROM`), and its verification | Steps 18 and 19 | Here | | |

**Email** ([3.4](part-3-outside-services.md#34-email))

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| The email service, and the sending domain | [3.4](part-3-outside-services.md#34-email) | Here | | |
| The server, port and `SMTP_SECURE` (`SMTP_HOST`, `SMTP_PORT`) | [3.4](part-3-outside-services.md#34-email) | Here | | |
| The user name (`SMTP_USERNAME`) | [3.4](part-3-outside-services.md#34-email) | Here | | |
| The password, such as Resend's `re_…` key (`SMTP_PASSWORD`) | [3.4](part-3-outside-services.md#34-email) | Password manager | | |
| The sender (`EMAIL_FROM`), and where replies and feedback go (`EMAIL_REPLY_TO`, `FEEDBACK_TO_EMAIL`) | [3.4](part-3-outside-services.md#34-email) | Here | | |

**Turnstile** ([3.5](part-3-outside-services.md#35-cloudflare-turnstile))

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| The widget's name, and its host names | Step 4 | Here | | |
| The site key (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`). It's shown on every sign-up page, so it isn't secret | Step 7 | Here | | |
| The secret key (`TURNSTILE_SECRET_KEY`) | Step 7 | Password manager | | |

**Optional services** ([3.7](part-3-outside-services.md#37-optional-services))

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| Google Cloud: the project, and whether the app is published | Google Calendar | Here | | |
| The client's ID (`GOOGLE_CLIENT_ID`) | Google Calendar | Here | | |
| The client's secret (`GOOGLE_CLIENT_SECRET`) | Google Calendar | Password manager | | |
| The map key, `AIza…` (`GOOGLE_MAPS_EMBED_API_KEY`), and the websites it's limited to. Anyone can see it in the page, so it isn't secret | The map on public profile pages | Here | | |
| The Firecrawl key, `fc-…` (`FIRECRAWL_API_KEY`) | Website import | Password manager | | |
| PostHog: the project, its region, and its project token, `phc_…`, which the dashboard's pages show | Errors, analytics and logs | Here | | |
| Only if you sell plans, Polar: the organization ID, sandbox or live | Selling plans, step 4 | Here | | |
| The brand whose `billing.json` it sells, `pnpm billing`'s `--brand` | Selling plans, step 2 | Here | | |
| LobbyStack's two Polar tokens, the admin's and the worker's (one on a server), and when each ends | Selling plans, step 3; [7.25](part-7-operations.md#725-routine-maintenance-calendar) | Password manager; the end dates here | | |
| The operator's platform key that `pnpm billing` signs in with | Selling plans, step 5; [6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line) | Password manager | | |
| Polar's setup token, and a read token for a later `verify` | Selling plans, steps 6 and 8 | Nowhere: make one for each run, and delete it after | | |
| Polar's webhook secret (`POLAR_WEBHOOK_SECRET`) | Selling plans, steps 7 and 8 | Password manager | | |

**Backups and watching** ([5.2](part-5-production.md#52-production-on-railway), [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose))

| What | From | Kept | Test | Production |
| --- | --- | --- | --- | --- |
| On Railway: the backup schedule on `Postgres` | [5.2](part-5-production.md#52-production-on-railway), step 16 | Here | | |
| On Railway: the backup bucket at Cloudflare, and its S3 address | [5.2](part-5-production.md#52-production-on-railway), steps 17 and 19 | Here | | |
| That bucket's key: its Access Key ID and Secret Access Key | [5.2](part-5-production.md#52-production-on-railway), step 19 | Password manager | | |
| The end date of that key's token, if it has one | [5.2](part-5-production.md#52-production-on-railway), step 19; [7.25](part-7-operations.md#725-routine-maintenance-calendar) | Here | | |
| On a server: the backups' hour, and where the weekly downloads are kept | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 27 and 28 | Here | | |
| The uptime check: the service, and who gets its alerts | [5.2](part-5-production.md#52-production-on-railway), step 24 | Here | | |
| The spending alerts: at Railway or the server's provider, OpenAI and Twilio | [5.2](part-5-production.md#52-production-on-railway), step 26 | Here | | |

**People** ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users), [7.19](part-7-operations.md#719-manage-operators-api-keys-and-platform-keys))

| What | Kept | Test | Production |
| --- | --- | --- | --- |
| Who answers the alerts, and who stands in | Here | | |
| Where each business's contact person is listed, outside LobbyStack | Here | | |
| Who has a login at Railway or on the server, on GitHub, at each provider, and in the password manager | Here | | |

**Releases** ([7.1](part-7-operations.md#71-release-a-new-version), step 10)

| Date | Commit | What changed | Released by |
| --- | --- | --- | --- |
| | | | |
| | | | |
| | | | |
