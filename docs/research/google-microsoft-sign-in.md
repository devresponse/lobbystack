# Plan sign-in with Google and Microsoft

On 2026-10-25 a study planned how people could sign in to the dashboard with a Google account, then a Microsoft one, beside their password. It read the code on `main` at `62517d2` and the published Better Auth 1.7.7 packages, and changed no code. **Its answer: use the Google and Microsoft providers already inside Better Auth, the dashboard's auth library, for about 8 developer-days for Google and 3 more for Microsoft, with no migration.** Nothing is built; [sign in with Google and Microsoft](../roadmap/google-microsoft-sign-in.md) tracks the plan and the eight decisions it waits on. Google's and Microsoft's console steps and review times are as their pages gave them that day.

## Know the answer

- **For people:** "Continue with Google" and "Sign in with Microsoft" buttons on the sign-in and sign-up pages. Gmail and Google Workspace accounts, Microsoft 365 work accounts on a verified domain, and Outlook.com or Hotmail accounts join an existing account on first use; anyone else connects once from **Account settings**, and invited teammates can accept with either.
- **Unchanged:** password sign-in, sessions, businesses, roles, row-level security and the Google Calendar connection.
- **Security:** accounts are matched on each provider's permanent user ID; an existing account is joined automatically only when the provider is the authority for its address; a Microsoft address counts only with Microsoft's domain-verified claim; new accounts still pass Turnstile; no provider tokens are kept.
- **Setup:** two variables per provider on the admin, a Google OAuth client in the Google Cloud project that holds the Calendar client, and a Microsoft Entra app registration in the brand's own tenant. Google's brand verification and Microsoft's publisher verification make their screens name the brand.

## Know how sign-in worked

| Piece | At `62517d2` | What Google sign-in changes |
| --- | --- | --- |
| Auth library | Better Auth at `/api/auth/*`, configured in `apps/admin/src/lib/auth.ts`, writing through the `lobbystack_auth` role | A `socialProviders.google` block and a few account options |
| Sign-in methods | Email and password only; the email-code plugin only verifies addresses and resets passwords | Google becomes a second method |
| Sign-up | `/sign-up/email` needs a Turnstile token on any address but localhost, then emails a 6-digit code | Google sign-up needs the same Turnstile gate |
| Email verification | `REQUIRE_EMAIL_VERIFICATION` is `false` by default; accepting an invitation always needs a verified address that matches it | Google vouches for the address, so a new Google account starts verified |
| Tables | `users`, `accounts`, `sessions` and `verifications`, with forced row-level security that only the auth role passes; `accounts` already has `provider_id`, `account_id` and token columns | One `accounts` row with `provider_id = google`; no migration |
| Sessions | In the database for 30 days, refreshed daily | Unchanged |
| Addresses | Better Auth's base URL is `APP_BASE_URL`; trusted origins add `AUTH_TRUSTED_ORIGINS` | Google returns people to `APP_BASE_URL` only, so sign-in must start there |
| AI app sign-in (MCP) | `/oauth/sign-in` sends people to `/login?returnTo=…` and back | The button carries `returnTo` through Google and back |
| Partner-made accounts | `POST /v1/users` makes an account with no password and an unverified address | Google can't join it until the address is verified |
| Password reset | The emailed code sets or adds a password and verifies the address | The way back in for someone who loses their Google account |

The Google Calendar connection is separate: it has its own OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`), stores tokens per business encrypted with `ENCRYPTION_KEY`, and never signs anyone in.

## Compare the ways to add it

| Option | What changes | Effort | Verdict |
| --- | --- | --- | --- |
| A. Better Auth's own providers, with a full-page redirect | A provider block, a linking guard, the buttons, error messages and a sign-in methods card | About 8 days for Google, 4 to 5 for a minimal version | **Recommended** |
| B. A plus Google One Tap | Google's script on the sign-in pages, Better Auth's `oneTap` plugin, page-security changes, and a second sign-in path to secure | 2 to 3 days on top of A | Later, if sign-in friction shows up in analytics |
| C. Single sign-on per business | Better Auth's SSO package, per-business provider settings, domain verification, an admin screen | 2 to 4 weeks | Not now: small businesses rarely ask for it |
| D. A hosted identity service (Firebase Authentication, Auth0, Clerk, WorkOS) | Replace or front Better Auth, move users and sessions, rework the AI app sign-in | 4 to 8 weeks, plus per-user fees and personal data held by another company | Not recommended |
| E. Copy the Calendar's own OAuth code | A second hand-written flow that also creates sessions and links accounts | 5 to 8 days | No: it rebuilds security code Better Auth maintains |

Microsoft compares the same way: its Better Auth provider is option A, Microsoft's MSAL library would be a hand-written flow like E, and Entra External ID is a hosted service like D. Apple and other providers could follow, since Better Auth 1.7.7 ships them too.

## Link accounts safely

The one real risk is joining a provider's identity to the wrong account, so linking follows Google's own rule: trust an address only when the provider is its authority.

1. The provider's user ID (Google's `sub`, Microsoft's `oid`) is already linked: sign that account in, whatever either side's address is now.
2. Not linked, but an account has the same address: join automatically only when the account's own address is verified, the provider vouches for the address (Google's `email_verified`, Microsoft's `xms_edov`), and the provider is the authority for it. For Google that means a `@gmail.com` address or a Workspace `hd` claim; for Microsoft, a work account on a domain its organization verified, or a personal account on outlook.com, hotmail.com, live.com or msn.com.
3. Otherwise nothing is joined: the person signs in with their password and clicks **Connect Google** or **Connect Microsoft** in **Account settings**, where being signed in is the proof. The provider's address must still match.
4. No account has the address: one is created only from the sign-up page, after Turnstile and with the terms shown. It starts verified and without a password.

A guard on Better Auth's `user.validateUserInfo` hook, which sees the provider's raw claims before any user is created or linked, enforces these rules: about 40 lines for Google and 25 more for Microsoft.

| Concern | What the plan does |
| --- | --- |
| Forged or replayed returns | State in the database plus a signed 5-minute cookie, PKCE, and a server-to-server code exchange, all built into Better Auth |
| A provider changing the account's address | Never: `overrideUserInfoOnSignIn` stays off |
| Provider tokens at rest | No refresh token and no Calendar permissions; a database hook drops the access and ID tokens before saving |
| A link the owner didn't make | An email to the account's address whenever a provider is connected |
| Locking oneself out | **Disconnect** shows only while another way in remains; **Forgot password** adds a password to a provider-only account |
| Bots | New accounts only through the sign-up page's Turnstile, and rate limits on the new routes |
| Open redirects | `callbackURL` must be a local path (`getSafeReturnTo`) on a trusted origin |

Businesses, roles and row-level security don't change: a provider only decides who the person is, and memberships still decide what they see. Invitations already need a verified address that matches, so a teammate invited at their Google address can join in two clicks.

## Know how Microsoft differs

| Point | Google | Microsoft |
| --- | --- | --- |
| Account key | `sub` | `oid` |
| Is the address vouched for? | Yes, `email_verified` in every token | Not by default: an organization's admin can put any address on an account, the weakness behind the "nOAuth" takeovers. The optional claim `xms_edov` says whether the address's domain is verified |
| Joined automatically | A Gmail or Workspace address | A work account whose organization verified the domain, or a personal account on Microsoft's own domains |
| Consent screen | The brand's name once Google verifies it | "Unverified" until publisher verification, then a verified badge |
| Organization approval | Not needed for sign-in | An organization can require an admin to approve new apps, or allow only verified publishers |
| Secret | No expiry | Expires, at most 24 months after it's made |
| Callback | `/api/auth/callback/google` | `/api/auth/callback/microsoft` |

Better Auth's Microsoft provider uses Microsoft's `common` address, which takes personal and work accounts, and keys on `oid`. By default it asks for `User.Read` and a refresh token and fetches the profile photo; the plan asks only for `openid`, `profile` and `email` and turns the photo off. It counts an address as verified only from claims Microsoft doesn't send by default, so left alone every Microsoft address would be unverified; the plan maps `xms_edov` onto that flag. Personal accounts carry Microsoft's fixed tenant ID `9188040d-6c67-4c5b-b112-36a304b66dad` in `tid`.

## Set it up

**Google,** in the Google Cloud project that already holds the Calendar client, so both share one consent screen while sign-in keeps its own secret:

- **Branding:** the brand's name (it can't contain "Google"), a support email, the home page, privacy and terms addresses, and the authorized domains.
- **Audience:** External and In production. `openid`, `email` and `profile` aren't sensitive, so sign-in shows no unverified-app warning and doesn't count toward the 100-user cap that applies to Calendar's scopes.
- **Clients:** a Web application client per environment with the redirect URI `https://<dashboard address>/api/auth/callback/google`, and a separate one for `http://localhost:13000/api/auth/callback/google`.
- **Brand verification:** until it passes, Google's account chooser names only the dashboard's domain, which reads `…up.railway.app` on a Railway address. It needs a public home page, the privacy policy on the same domain and the domain verified in Search Console; a manual review usually takes 2 to 3 business days. One Google Cloud project carries one brand.

**Microsoft,** as one app registration per environment in the brand's own Entra tenant, made with a work account of that tenant, since Microsoft can't publisher-verify an app registered with a personal account:

- Supported account types **Any Entra ID Tenant + Personal Microsoft accounts**, and the redirect URI `https://<dashboard address>/api/auth/callback/microsoft`.
- A client secret of at most 24 months, with its expiry on the calendar.
- Optional ID token claims `email`, `xms_pdl` and `xms_edov`; one integration guide reports that `xms_edov` appears only alongside `xms_pdl`.
- Microsoft Graph `openid`, `profile` and `email` only, with the default `User.Read` removed.
- Publisher verification needs a Microsoft AI Cloud Partner Program account verified for the business behind the brand. Without it, Microsoft marks the app "unverified", and organizations that allow only verified publishers show their staff "Need admin approval".

**Variables,** all on the admin: `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET`, `MICROSOFT_SIGN_IN_CLIENT_ID`, `MICROSOFT_SIGN_IN_CLIENT_SECRET` and an optional `MICROSOFT_SIGN_IN_TENANT` (empty means `common`; `organizations` takes work accounts only). The names are new on purpose, so Calendar keeps `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Each provider stays off while its variables are empty, and removing them switches it off again; people who only used that provider get back in with **Forgot password**. Sign-in has to start on the `APP_BASE_URL` address, since the provider returns there and the state cookie lives where sign-in began.

## Know the risks

| Risk | Mitigation |
| --- | --- |
| Google's brand review rejects or stalls, as developers report when the home page's name and the consent screen's differ | The same app name on both; until it passes, Google shows the domain |
| Microsoft tokens arrive without `xms_edov` | Every Microsoft address then counts as unverified: sign-ins are refused with a message, never joined wrongly, and the checks on the demo catch it before launch |
| Organizations that let staff approve only verified publishers' apps, or only with an admin's approval | Publisher verification, and a hint on the sign-in page to use email until the admin approves |
| The Microsoft secret expires | A calendar reminder and the renewal steps in the deployment guide; only Microsoft sign-in stops |
| Throwaway Google or Microsoft accounts on the Free plan | Turnstile on social sign-ups and the existing limits |
| Better Auth changes the hooks this relies on: `validateUserInfo` is marked for renaming | The version stays pinned at 1.7.7, and the linking tests run on every upgrade |
| Accounts stored with capital letters in `users.email`, which Better Auth looks up in lowercase | Before launch, run `select count(*) from users where email <> lower(email)` and lowercase any rows found |
| Sign-in started on another host name, such as a service's Railway name beside its custom domain, ends with "try again" | Send people to the `APP_BASE_URL` address, and say so in the deployment guide's troubleshooting part |
