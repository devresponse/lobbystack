# Sign in with Google and Microsoft

People would sign in to the dashboard with a Google or Microsoft account beside their password, through the providers already inside Better Auth, the dashboard's auth library. A study on 2026-10-25 planned it ([the study](../research/google-microsoft-sign-in.md)).

- **Status:** not started; waiting on the maintainer's decisions below.
- **Effort:** about 8 developer-days for Google in two pull requests, and about 3 more for Microsoft in the same two, about 11 in all. A minimal Google-only first version is 4 to 5 days; Microsoft added after Google has shipped is about 4.
- **Footprint:** no migration and no new package; two variables per provider on the admin; one new email from the worker.

## Know what it would do

- **The sign-in and sign-up pages** get "Continue with Google" and "Sign in with Microsoft" above the email form, in English, French, Spanish and Serbian. Only the sign-up page creates accounts, after Turnstile.
- **An existing account is joined automatically** for Gmail and Google Workspace addresses, Microsoft 365 work accounts on a verified domain, and Outlook.com, Hotmail, Live and MSN accounts. Anyone else signs in with their password once and connects the provider from **Account settings**.
- **Account settings** gets a **Sign-in methods** card with Connect and Disconnect. Disconnect shows only while another way in remains, and connecting a provider emails the account's address.
- **Invitations and AI app sign-in** work with either provider, with no new screen.
- **Nothing else changes:** password sign-in, sessions, businesses, roles, row-level security, and the Google Calendar connection, which keeps its own OAuth client.

## Build it this way

- Better Auth's `socialProviders.google` and `microsoft` blocks in `apps/admin/src/lib/auth.ts`, each on only while its variables are set: `GOOGLE_SIGN_IN_CLIENT_ID` and `GOOGLE_SIGN_IN_CLIENT_SECRET`; `MICROSOFT_SIGN_IN_CLIENT_ID`, `MICROSOFT_SIGN_IN_CLIENT_SECRET` and an optional `MICROSOFT_SIGN_IN_TENANT`.
- A linking guard on Better Auth's `user.validateUserInfo` hook: match on the provider's permanent ID (`sub` or `oid`), join an existing account automatically only when the provider is the authority for its address, and count a Microsoft address only with Microsoft's `xms_edov` claim.
- No refresh tokens or extra scopes; a database hook drops the provider's tokens before saving; rate limits on the new routes; Turnstile on social sign-ups.
- Sign-in starts on the `APP_BASE_URL` address, which the redirect URIs `https://<dashboard address>/api/auth/callback/google` and `/api/auth/callback/microsoft` name.

## Follow the plan

| Work | Google | Microsoft | Pull request |
| --- | --- | --- | --- |
| The server: provider settings, the pages' "is it on" answer, Turnstile, rate limits, the token hook | 1 | 0.5 | 1 |
| The linking guard, with a unit test for each rule | 0.5 | 0.5 | 1 |
| The buttons, `returnTo` and the error messages in four languages | 1.5 | 0.75, with its settings card | 1 |
| Telemetry for social sign-ins and sign-ups | 0.5 | | 1 |
| Database and browser tests | 2 | 0.75 | 1 |
| The **Sign-in methods** card and the "connected" email | 1.5 | | 2 |
| Docs: a features page, the deployment guide, the changelog and the route catalog | 1 | 0.5 | 1 and 2 |
| **Developer-days** | **8** | **3** | |

The maintainer's part, outside the code: a sign-in OAuth client in the Google Cloud project that holds the Calendar client, and Google's brand verification, which can take up to 3 business days when reviewed by hand; an app registration in the brand's own Microsoft Entra tenant, with the `email`, `xms_pdl` and `xms_edov` claims and a secret that expires within 24 months; and, if Microsoft 365 businesses are a target, publisher verification through a Microsoft AI Cloud Partner Program account. Before launch, look for accounts stored with capital letters, which Better Auth wouldn't find: `select count(*) from users where email <> lower(email)`.

## Decide these

| # | Question | Recommended |
| --- | --- | --- |
| 1 | May the sign-in page create new accounts, skipping the sign-up page's Turnstile and terms? | No: send newcomers to the sign-up page |
| 2 | May Connect accept a provider address that differs from the account's? | Not in the first version; Better Auth warns it can enable takeovers |
| 3 | Which address will the production dashboard use, such as `app.alloplace.com`? | Needed first: both redirect URIs and Google's brand verification depend on it |
| 4 | Verify the Google brand before launch, so Google shows the brand's name and logo, or launch with the domain shown? | Open; the domain alone reads fine when it's the brand's own |
| 5 | Should the email that sets up a partner-made account say Google and Microsoft work once the address is verified? | Open |
| 6 | Offer Microsoft to personal and work accounts, or to work accounts only? | Both, through Microsoft's `common` address |
| 7 | Apply for Microsoft publisher verification before launch? | Yes if Microsoft 365 businesses are a target: without it Microsoft shows "unverified" and some organizations block sign-in |
| 8 | Build Microsoft with Google, about 11 days, or after Google ships, about 4 more then? | Together: each provider stays off until its variables are set, so Google can go live while Microsoft's registration finishes |

## Know the risks

None blocks the plan. Google's brand review can stall. Microsoft tokens may arrive without `xms_edov`, which makes sign-ins refused, never wrongly joined. Some organizations let their staff approve only verified publishers' apps. Better Auth has marked `validateUserInfo` for renaming, so the version stays pinned and the linking tests run on every upgrade. The [study](../research/google-microsoft-sign-in.md#know-the-risks) lists each risk with its mitigation.
