# LobbyStack route catalog

Every page and HTTP route in the LobbyStack code, written against **https://demo.alloplace.com**, as the starting point for its documentation.

| | |
|---|---|
| Base URL | `https://demo.alloplace.com` |
| Code | `devresponse/lobbystack`, branch `main` at `da1f548` (2026-10-24). First written at `d18f916` (2026-10-18); the routes fork PRs #50 to #76 added or changed were brought up to `da1f548` on 2026-10-24 (section 16) |
| How it was made | Read from the code, including every entry file and the files it calls. No route was tried against the live site. |
| What runs at the base URL | `apps/admin`: the dashboard, sign-in pages, public business pages, the website widget, every HTTP API and the MCP server |
| Also listed | The worker's internal routes (section 14) and the marketing site's pages (section 15). Neither is served at demo.alloplace.com. |

This catalog was written in the project's notes and moved into the repository on 2026-10-24. Change it in the same pull request as a route, and see section 16 for where each list comes from.

## Contents

- [1. Counts](#1-counts)
- [2. How to read this catalog](#2-how-to-read-this-catalog)
- [3. Dashboard pages](#3-dashboard-pages)
- [4. Onboarding pages](#4-onboarding-pages)
- [5. Sign-in and account pages](#5-sign-in-and-account-pages)
- [6. Public business page and website widget](#6-public-business-page-and-website-widget)
- [7. Browser calls](#7-browser-calls)
- [8. Dashboard API](#8-dashboard-api)
- [9. Public API (v1)](#9-public-api-v1)
- [10. MCP server and OAuth discovery](#10-mcp-server-and-oauth-discovery)
- [11. Sign-in service (Better Auth)](#11-sign-in-service-better-auth)
- [12. Inbound webhooks](#12-inbound-webhooks)
- [13. Health, operations and static files](#13-health-operations-and-static-files)
- [14. Worker (internal)](#14-worker-internal)
- [15. Marketing site (separate)](#15-marketing-site-separate)
- [16. Keeping this catalog current](#16-keeping-this-catalog-current)
- [17. Things that look unintended](#17-things-that-look-unintended)

## 1. Counts

| Area | Route files | Method and path pairs | Section |
|---|---|---|---|
| Dashboard pages | 32 pages |  | 3 |
| Onboarding pages | 10 pages |  | 4 |
| Sign-in and account pages | 12 pages, each in 4 languages |  | 5 |
| Public business page, widget chat window and loader | 2 pages, 1 route | 1 | 6 |
| Website widget API | 6 | 7 | 6 |
| Browser calls | 2 | 4 | 7 |
| Dashboard API | 79 | 126 | 8 |
| Public API (v1) | 71 (one catches unknown paths) | 99: 98 operations and the OpenAPI document | 9 |
| MCP server | 1 | 3 (18 tools) | 10 |
| OAuth discovery and redirects | 6 | 10 | 10 |
| Sign-in service (Better Auth) | 2 | 20 in use, 21 served but unused, 20 turned off | 11 |
| Inbound webhooks | 5 | 5 | 12 |
| Health and operations | 3 | 3 | 13 |
| Worker (internal, not at the base URL) | 1 server | 4 | 14 |

In all, `apps/admin` has 56 page files and 176 route files, which answer 262 method and path pairs (Better Auth's endpoints counted once, as its catch-all route).

Every table also names the **entry file** of each route, the file that receives the request, and a summary of each entry file follows its table: 176 route files, 56 pages, 9 layouts and 1 not-found page in `apps/admin`, the widget loader script, the worker's 2 route files, and the marketing site's 31 pages and files.

## 2. How to read this catalog

- **Addresses** are full URLs on `https://demo.alloplace.com`. A name in braces is a value you fill in, such as `{callId}`. `{locale}` is one of `en`, `fr`, `es` or `sr`.
- **Which business.** Dashboard pages and the dashboard API act on the signed-in person's active business, which the workspace menu switches (`POST /api/businesses/switch`). An API call can name another business with `?businessId=` or an `x-business-id` header. Rows marked "Needs `businessId`" answer 400 unless it is named that way. Where a row says so, the request body works too, and those routes answer 500 instead of 400 when it is missing. `POST /api/knowledge` takes it only in the body.
- **Sessions.** The dashboard API works with the sign-in cookie only; a signed-out call answers 401.
- **Cross-site protection.** The dashboard API refuses POST, PUT, PATCH and DELETE whose Origin (or Referer) isn't the app's own address. These are exempt: `/api/auth`, `/api/webhooks`, `/api/health`, `/api/voice`, `/api/widget/...`, `/api/v1/...`, `/api/mcp` and `/api/storage/local`.
- **Maintenance mode.** With `LOBBYSTACK_MAINTENANCE_MODE=true`, every webhook, every API call except GET or HEAD on the two health checks, and every POST, PUT, PATCH or DELETE answers 503 with `Retry-After: 60`.
- **Docs today** names the page under `mintlify/` that already covers the route; `mintlify/fr/` and `mintlify/es/` hold the same pages in French and Spanish. "None yet" means nothing covers it.
- **Entry file** is the file that receives the request, written as a path from the repository root. For a page it is the `page.tsx` that Next.js renders for that address; for an API route it is the `route.ts` whose exported function (`GET`, `POST` and so on) answers the method. After each table, **Entry files** summarizes every file in it: what the file is for, then how it handles each of its routes, with the files that hold the rest of the logic.

**Who** says who may use a page or route, with these labels. The public API, the MCP server, the widget and the webhooks use keys, tokens or signatures instead, and each section says which. In the code the roles are `viewer`, `scheduler`, `business_admin` and `business_owner`, and the entry file summaries use those names.

| Label | Meaning |
|---|---|
| Public | No sign-in needed |
| Signed in | Any signed-in account |
| Member | Any member of the business, from Viewer up |
| Scheduler+ | Scheduler, Admin or Owner |
| Admin+ | Admin or Owner |
| Demo operator | Only the account whose email is in `PROSPECT_DEMO_OPERATOR_EMAIL` |

### What runs before an entry file

Every request to the admin app passes through these first, so the entry file summaries don't repeat them.

1. **`apps/admin/proxy.ts`** (the Next.js proxy, formerly middleware) runs for every address except build files, images, `locales/`, `brand/` and the logo. It answers 503 in maintenance mode, redirects (308) language-free sign-in addresses to a language, sets the cache and security headers, passes the chosen language and the path on to the app in request headers, and refuses with 403 a POST, PUT, PATCH or DELETE under `/api/` whose Origin or Referer isn't one of the app's own addresses (the exemptions are under Cross-site protection above).
2. **A root layout** wraps every page. Each route group has its own: `(dashboard)/layout.tsx` (sign-in and onboarding checks, then the dashboard shell), `(onboarding)/layout.tsx`, `(public)/[locale]/layout.tsx` (the prerendered sign-in pages), `(sensitive)/[locale]/layout.tsx` (pages that carry tokens, rendered per request), `(profile)/layout.tsx` (the public business page) and `(app)/layout.tsx` (the widget's chat window). Sections 3 to 6 summarize them. `apps/admin/app/error.tsx` and `apps/admin/app/global-error.tsx` show the error screen when a page fails.
3. **Dashboard API helpers** in `apps/admin/src/lib/api-helpers.ts`, used by the routes in section 8:
   - `requireApiSession` reads the sign-in cookie through Better Auth: 401 without a session, 503 when the sign-in service fails.
   - `requireOperatorBusiness` adds the business the request acts on: `?businessId=` or the `x-business-id` header, else the account's active business; 400 `business_required` when there is none. It doesn't check membership by itself.
   - `withOperatorTransaction` runs both, then opens a database transaction carrying the business's row-level security context (`withBusinessTransaction` in `packages/db`) and checks membership (`requireBusinessMembership` in `packages/domain`), with an optional minimum role.
   - `requireProspectDemoOperator` lets through only the account whose email is `PROSPECT_DEMO_OPERATOR_EMAIL` (503 when that is unset, 403 for anyone else).
   - `asApiResponse` turns an error into JSON: an error with a status below 500 keeps it (`{ error, code }`); anything else answers 500 "Request failed." with an `errorId` that is sent to error tracking.
   - `createDomainContext()` in `apps/admin/src/lib/domain-context.ts` gives the `packages/domain` functions the app's database role and the embeddings provider; `createWorkerDomainContext()` uses the worker's database role instead.
4. **The public API wrapper.** Every `/api/v1` route file hands its methods to `v1.<operationId>` in `apps/admin/src/lib/public-api/routes.ts`, which runs `handleApiRequest` in `apps/admin/src/lib/public-api/http.ts`. That checks the key, its scope, the business, the rate limit and the `Idempotency-Key`, runs the operation, turns errors into the API's error format and logs a `public_api.request` line (section 9).

## 3. Dashboard pages

Each needs a signed-in account whose business has finished onboarding. A signed-out visitor goes to `/{locale}/login`, and a business still onboarding goes to its current step (section 4). Every member can open every page; **Who** says what each role can do there, following the API rules in section 8. The sidebar has three groups: General, Agent and Manage.

| Address | Page | Where to find it | Who | Docs today | Entry file |
|---|---|---|---|---|---|
| `https://demo.alloplace.com/` | Home: 30-day totals for calls, messages and appointments, live calls, items that need action, upcoming appointments | Sidebar > General > Home | Member | `dashboard/home.mdx` | `apps/admin/app/(dashboard)/page.tsx` |
| `https://demo.alloplace.com/calls` | Calls: every call, with search | Sidebar > General > Calls | Member | `dashboard/calls.mdx` | `apps/admin/app/(dashboard)/calls/page.tsx` |
| `https://demo.alloplace.com/calls/{callId}` | Call detail: transcript, recording, follow-ups | A row on Calls, or a call on Home | Member; Scheduler+ marks follow-ups done | `dashboard/calls.mdx` | `apps/admin/app/(dashboard)/calls/[callId]/page.tsx` |
| `https://demo.alloplace.com/messages` | Messages: texts and website chats, replies, taking over from the AI | Sidebar > General > Messages | Member reads; Scheduler+ replies and takes over | `dashboard/messages.mdx` | `apps/admin/app/(dashboard)/messages/page.tsx` |
| `https://demo.alloplace.com/contacts` | Contacts: the people the receptionist has talked to, with search | Sidebar > General > Contacts | Member | `dashboard/contacts.mdx` | `apps/admin/app/(dashboard)/contacts/page.tsx` |
| `https://demo.alloplace.com/contacts/{contactId}` | Contact detail: history, text blocking, keypad PIN, delete | A row on Contacts | Member reads; Admin+ blocks texts, sets the PIN, deletes | `dashboard/contacts.mdx` | `apps/admin/app/(dashboard)/contacts/[contactId]/page.tsx` |
| `https://demo.alloplace.com/appointments` | Appointments: current bookings, with cancel | No link in the app; open it by address | Member; Scheduler+ cancels | `dashboard/appointments.mdx` | `apps/admin/app/(dashboard)/appointments/page.tsx` |
| `https://demo.alloplace.com/agent` | AI settings: greeting, voice, booking, language, time zone, opening hours, appointment changes | Sidebar > Agent > AI settings | Member reads; Admin+ saves | `agent/overview.mdx`, `agent/ai-settings/overview.mdx`, `agent/ai-settings/appointment-changes.mdx` | `apps/admin/app/(dashboard)/agent/page.tsx` |
| `https://demo.alloplace.com/agent/basic-settings` | The same screen as AI settings | The "no opening hours" alert links to `#opening-hours` here | Member reads; Admin+ saves | `agent/ai-settings/overview.mdx` | `apps/admin/app/(dashboard)/agent/basic-settings/page.tsx` |
| `https://demo.alloplace.com/agent/integrations` | Old address; redirects to `/agent` | Nowhere | Signed in | None yet | `apps/admin/app/(dashboard)/agent/integrations/page.tsx` |
| `https://demo.alloplace.com/agent/knowledge` | Knowledge: website imports, documents, snippets | Sidebar > Agent > Knowledge | Member reads; Admin+ changes | `agent/knowledge.mdx` | `apps/admin/app/(dashboard)/agent/knowledge/page.tsx` |
| `https://demo.alloplace.com/agent/services` | Services: what callers can book, and which staff do it | Sidebar > Agent > Services | Member reads; Admin+ changes | `agent/services.mdx` | `apps/admin/app/(dashboard)/agent/services/page.tsx` |
| `https://demo.alloplace.com/agent/rules` | Rules: standing instructions for the receptionist | Sidebar > Agent > Rules | Member reads; Admin+ changes | `agent/rules.mdx` | `apps/admin/app/(dashboard)/agent/rules/page.tsx` |
| `https://demo.alloplace.com/analytics` | Analytics: calls, messages, appointments, response time, channels and outcomes over a chosen period | Sidebar > Manage > Analytics | Member | `dashboard/analytics.mdx` | `apps/admin/app/(dashboard)/analytics/page.tsx` |
| `https://demo.alloplace.com/integrations` | Integrations: Google Calendar, plus Twilio and Polar status | Sidebar > Manage > Integrations | Member reads; Admin+ connects and changes | `integrations/overview.mdx`, `integrations/google-calendar.mdx` | `apps/admin/app/(dashboard)/integrations/page.tsx` |
| `https://demo.alloplace.com/integrations/webhooks` | Webhooks: endpoints that receive events, and their deliveries | Integrations > Webhooks > Manage | Admin+ | `integrations/webhooks.mdx`, `api/webhooks.mdx` | `apps/admin/app/(dashboard)/integrations/webhooks/page.tsx` |
| `https://demo.alloplace.com/settings` | Redirects to `/settings/usage` | Nowhere | Signed in | None yet | `apps/admin/app/(dashboard)/settings/page.tsx` |
| `https://demo.alloplace.com/settings/usage` | Included usage: voice minutes, SMS alerts, transfer attempts and knowledge storage, until the monthly reset | Sidebar > Manage > Settings (first tab, Usage) | Member | `billing/usage.mdx` | `apps/admin/app/(dashboard)/settings/usage/page.tsx` |
| `https://demo.alloplace.com/settings/plan` | Plan: current plan, checkout, spending cap, billing portal | Settings > Plan | Member reads; Admin+ changes | `billing/plans.mdx` | `apps/admin/app/(dashboard)/settings/plan/page.tsx` |
| `https://demo.alloplace.com/settings/team` | Team: the business name, members and invitations | Settings > Team | Member reads; Admin+ renames, invites and removes (roles change only through the API) | `settings/team.mdx` | `apps/admin/app/(dashboard)/settings/team/page.tsx` |
| `https://demo.alloplace.com/settings/phone-number` | Phone number: the receptionist's number, replace or release it | Settings > Phone Number | Member reads; Admin+ replaces and releases | `settings/phone-number.mdx` | `apps/admin/app/(dashboard)/settings/phone-number/page.tsx` |
| `https://demo.alloplace.com/settings/appearance` | Preferences: language, time format, product analytics switch | Settings > Preferences | Member; Admin+ for the analytics switch | `settings/overview.mdx` | `apps/admin/app/(dashboard)/settings/appearance/page.tsx` |
| `https://demo.alloplace.com/settings/notifications` | Notifications: your email and SMS alerts and daily summary | Settings > Notifications | Member (each person sets their own) | `settings/notifications.mdx` | `apps/admin/app/(dashboard)/settings/notifications/page.tsx` |
| `https://demo.alloplace.com/settings/api-keys` | API keys, and the Business ID with a Copy button | Settings > API keys | Admin+ | `api/authentication.mdx` | `apps/admin/app/(dashboard)/settings/api-keys/page.tsx` |
| `https://demo.alloplace.com/settings/connected-apps` | Connected apps: AI assistants connected over OAuth (MCP) | Settings > Connected apps | Admin+ | `ai/mcp.mdx` | `apps/admin/app/(dashboard)/settings/connected-apps/page.tsx` |
| `https://demo.alloplace.com/settings/widget` | Website widget: keys, allowed websites, look, install snippet | Sidebar > Manage > Website widget, or Settings > Website widget | Member reads; Admin+ creates and edits (creating also needs `WIDGET_KEY_ISSUANCE_ENABLED=true`) | `settings/widget.mdx` | `apps/admin/app/(dashboard)/settings/widget/page.tsx` |
| `https://demo.alloplace.com/settings/profile` | Public profile: edit and publish the `/profile/{slug}` page | Settings > Public profile | Member reads; Admin+ edits and publishes | `settings/public-profile.mdx` | `apps/admin/app/(dashboard)/settings/profile/page.tsx` |
| `https://demo.alloplace.com/settings/qrcode` | QR code: printable signs that open the public profile | Settings > QR code | Member | `settings/qr-code.mdx` | `apps/admin/app/(dashboard)/settings/qrcode/page.tsx` |
| `https://demo.alloplace.com/settings/account` | Account: your name, email, password and personal phone | User menu > Account | Signed in (your own account) | `settings/account.mdx` | `apps/admin/app/(dashboard)/(account)/settings/account/page.tsx` |
| `https://demo.alloplace.com/setup-guide` | Setup guide: read the rest of the website, add sources, hear the agent, connect a number | Sidebar "Getting started" card > Open setup guide | Admin+ | `quickstart.mdx` | `apps/admin/app/(dashboard)/setup-guide/page.tsx` |
| `https://demo.alloplace.com/affiliate` | Affiliate program: referral link, clicks, commissions, payout email | Gift icon in the top bar | Signed in (your own affiliate profile) | `billing/affiliate-program.mdx` | `apps/admin/app/(dashboard)/affiliate/page.tsx` |
| `https://demo.alloplace.com/demos` | Prospect demos: create, publish, rotate and revoke demo links | No link in the app; open it by address | Demo operator | None yet | `apps/admin/app/(dashboard)/demos/page.tsx` |

### Entry files

The three layouts the dashboard pages pass through come first, then each page in the order of the table.

**`apps/admin/app/(dashboard)/layout.tsx`**

Root layout for every signed-in dashboard page. It turns away signed-out visitors and businesses still onboarding, then renders the HTML document and `DashboardShell` (sidebar, workspace switcher, past-due banner, test-call and feedback bar, user menu) around each page.

- Every dashboard page: It reads the proxy's locale (`localeFromRequestHeaders`) and the Better Auth session (`getSession`); without a session it redirects to `/{locale}/login`. `getActiveOnboardingState` reads the onboarding stage of the user's active business, or of a fallback membership; any stage but `complete` redirects to `resolveOnboardingRoute(stage)` (`/onboarding/business` for a user with no business). It then renders `RootDocument` (branding, preloaded `DASHBOARD_NAMESPACES` translations, client providers) and `DashboardShell`. The shell's sidebar links Home, Calls, Messages, Contacts, four `/agent` pages, Analytics, Integrations, Widget and Settings. It loads `GET /api/businesses`, `GET /api/billing` and, for business_owner and business_admin, `GET /api/setup`.

Related files: `apps/admin/src/components/dashboard-shell.tsx`, `apps/admin/src/app/root-document.tsx`, `packages/domain/src/server/onboarding.ts`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(dashboard)/agent/layout.tsx`**

Wraps every receptionist settings page (`/agent`, knowledge, services, rules) in one shared header. It has no tabs: the dashboard sidebar's agent group is the navigation between these pages.

- The pages under `/agent`: Renders `AgentShell` (`apps/admin/src/components/agent-shell.tsx`), a client component. It picks the section from the path (`/knowledge`, `/services`, `/rules`, otherwise basic settings) and shows a `PageHeader` with that section's translated title and description. It wraps the page in `NestedPageSurfaceProvider`, which hides each page's own `PageSurface` header so the shell's header is the only one. It checks nothing and loads no data.

Related files: `apps/admin/src/components/agent-shell.tsx`, `apps/admin/src/components/page-surface.tsx`.

**`apps/admin/app/(dashboard)/settings/layout.tsx`**

Wraps the settings pages under `apps/admin/app/(dashboard)/settings/` in a settings header and a row of tab links. `/settings/account` sits in the `(account)` route group instead, so this layout does not wrap it.

- The pages under `/settings`: Renders `SettingsShell` (`apps/admin/src/components/settings-shell.tsx`), a client component: a `PageHeader` and a scrollable pill navigation with 11 links, in English Usage, Plan (`/settings/plan`), Team (`/settings/team`), Phone Number, Preferences (`/settings/appearance`), Notifications, API keys, Connected apps, Website widget, Public profile (`/settings/profile`) and QR code (`/settings/qrcode`). A link is active when the path equals it or starts with it plus `/`. The page goes inside `NestedPageSurfaceProvider`, which hides each page's own `PageSurface` header. It checks nothing and loads no data.

Related files: `apps/admin/src/components/settings-shell.tsx`, `apps/admin/src/components/page-surface.tsx`.

**`apps/admin/app/(dashboard)/page.tsx`**

Home page of the dashboard. It gives operators the current picture for the active business: headline numbers, follow-ups that need action, upcoming appointments, monthly calls and recent calls.

- `GET /`: Renders `LiveOverviewSurface` (`apps/admin/src/components/live-overview-surface.tsx`). It loads `GET /api/dashboard` (KPIs with deltas, monthly calls, recent calls, follow-ups, upcoming appointments) and refetches it on realtime call, message, appointment and conversation events (`subscribeRealtimeQuery`). A voice-message follow-up links to `/calls/[callId]`. `CancelAppointmentButton`, shown to scheduler and up, cancels an appointment or approves a caller's cancellation request with `POST /api/appointments/[appointmentId]/cancel`. `DashboardActivationCard` loads `GET /api/activation` and, for a cloud business without a dedicated number, offers a test call, the upgrade dialog or a link to `/settings/phone-number`.

Related files: `apps/admin/src/components/live-overview-surface.tsx`, `apps/admin/src/components/dashboard-activation-card.tsx`, `apps/admin/src/components/cancel-appointment-button.tsx`, `apps/admin/app/api/dashboard/route.ts`.

**`apps/admin/app/(dashboard)/calls/page.tsx`**

The call log for the active business: phone and web calls with caller, purpose and time, a live count of calls in progress, and inline recording playback.

- `GET /calls`: Renders `LiveCallsSurface` (`apps/admin/src/components/live-calls-surface.tsx`). It loads `GET /api/calls` with `limit`, `offset` and `search` (server-side paging, 10 rows by default, search sent once typing pauses for 300 ms) and polls `GET /api/calls/active` every 5 s for the live count, shown as unavailable when that fails or is older than 15 s. The list refetches on realtime call, recording and conversation events, the count on call events. The play button fetches `GET /api/calls/[callId]/recording` and plays it in place. Each request times out after 5 s. Clicking a row opens `/calls/[callId]`.

Related files: `apps/admin/src/components/live-calls-surface.tsx`, `apps/admin/app/api/calls/route.ts`, `apps/admin/app/api/calls/active/route.ts`, `apps/admin/src/lib/realtime-query.ts`.

**`apps/admin/app/(dashboard)/calls/[callId]/page.tsx`**

One call's detail page, opened from the call log, a contact's activity or a home-page follow-up. It shows the caller, event timeline, transcript, recording and open follow-ups.

- `GET /calls/{callId}`: The page awaits `params` and passes `callId` to `LiveCallDetailSurface` (`apps/admin/src/components/live-call-detail-surface.tsx`). It loads `GET /api/calls/[callId]` with `businessId` (call, contact, timeline, transcript, recording state, follow-ups) and refetches on realtime call, recording and conversation events. The ID field shows `legacyConvexId` when the call has one. An available recording comes from `GET /api/calls/[callId]/recording`. Mark done sends `PATCH /api/calls/[callId]` with `action: "complete_follow_up"` and `inboxItemId`, which needs scheduler or higher (`completeVoiceFollowUpTasks`). A failed load shows a not-found message; the page never calls `notFound()`.

Related files: `apps/admin/src/components/live-call-detail-surface.tsx`, `apps/admin/app/api/calls/[callId]/route.ts`, `apps/admin/app/api/calls/[callId]/recording/route.ts`, `packages/domain/src/server/voice.ts`.

**`apps/admin/app/(dashboard)/messages/page.tsx`**

The shared inbox for text messages and website chats: conversations on one side, the open thread on the other. Operators reply, and in website chats take over from the AI or hand back to it.

- `GET /messages`: Renders `LiveMessagesSurface` (`apps/admin/src/components/live-messages-surface.tsx`). It loads conversations with `GET /api/messages` (`limit=50`, `offset`, `channel` of all, web_chat or sms, `search`; Load more fetches the next page) and the open thread with `GET /api/messages?conversationId=` (messages, `newerConversationId`, `smsReplyHold`). Both refetch on realtime message and conversation events. Send posts `conversationId`, `body` and `channel` to `POST /api/messages`; Take over, Join chat and Resume AI send `PATCH /api/messages` with `automationState` (`human_handoff` or `ai_active`). Both writes need scheduler or higher (`appendMessage`, `setAutomationState`). A closed chat or an SMS hold disables the composer and says why.

Related files: `apps/admin/src/components/live-messages-surface.tsx`, `apps/admin/app/api/messages/route.ts`, `packages/domain/src/server/conversations.ts`.

**`apps/admin/app/(dashboard)/contacts/page.tsx`**

The contact list for the active business: each contact's channels, activity counts, appointments and last interaction. business_owner and business_admin can block or delete contacts here.

- `GET /contacts`: Renders `LiveContactsSurface` (`apps/admin/src/components/live-contacts-surface.tsx`). It loads `GET /api/contacts` with `businessId`, `limit`, `offset` and `search` (server-side paging; each change to the search box sends a request) and refetches on realtime `call.completed`, `message.upserted` and `conversation.updated` events. Clicking a row opens `/contacts/[contactId]`. For business_owner and business_admin (client check; the domain functions also require business_admin) the row menu blocks or unblocks the contact with `PATCH /api/contacts/[contactId]` and `smsBlocked`, which sets `operatorBlockedAt`, or deletes it with `DELETE /api/contacts/[contactId]`, each after a confirmation. A failed delete shows the server's message.

Related files: `apps/admin/src/components/live-contacts-surface.tsx`, `apps/admin/app/api/contacts/[contactId]/route.ts`, `packages/domain/src/server/sms.ts`, `packages/domain/src/server/contacts.ts`.

**`apps/admin/app/(dashboard)/contacts/[contactId]/page.tsx`**

One contact's profile, opened from the contact list. It shows the contact's details, channels, SMS consent, calls, messages and appointments, and lets business_owner and business_admin block, delete or set a keypad passcode.

- `GET /contacts/{contactId}`: The page awaits `params` and passes `contactId` to `LiveContactDetailSurface` (`apps/admin/src/components/live-contact-detail-surface.tsx`). It loads `GET /api/contacts/[contactId]` with `businessId` (contact, channels, passcode status, calls, messages, appointments, activity counts); a failed load shows a not-found message linking back to `/contacts`. The activity tab links each call to `/calls/[callId]`. For business_owner and business_admin (client check): block or unblock with `PATCH /api/contacts/[contactId]` and `smsBlocked`, delete with `DELETE /api/contacts/[contactId]` (then back to `/contacts`), and set or clear the keypad passcode callers type to change appointments with `PUT` or `DELETE /api/contacts/[contactId]/passcode`.

Related files: `apps/admin/src/components/live-contact-detail-surface.tsx`, `apps/admin/src/components/contact-passcode-section.tsx`, `apps/admin/app/api/contacts/[contactId]/route.ts`, `apps/admin/app/api/contacts/[contactId]/passcode/route.ts`.

**`apps/admin/app/(dashboard)/appointments/page.tsx`**

A table of the business's appointments with time, customer, service, staff, status and calendar sync state, with a cancel action for scheduler and up. No navigation link points here.

- `GET /appointments`: Renders `LiveAppointmentsSurface` (`apps/admin/src/components/live-appointments-surface.tsx`). It loads `GET /api/appointments` with `businessId`, refetches on realtime `appointment.updated` events and on the Refresh button, and shows each time in the appointment's own time zone. `CancelAppointmentButton`, shown to scheduler and up (client check; `cancelAppointment` also requires scheduler), confirms and sends `POST /api/appointments/[appointmentId]/cancel`; an `already_cancelled` answer counts as success. The appointment list and the home page data then reload.

Related files: `apps/admin/src/components/live-appointments-surface.tsx`, `apps/admin/src/components/cancel-appointment-button.tsx`, `apps/admin/app/api/appointments/route.ts`, `packages/domain/src/server/booking.ts`.

**`apps/admin/app/(dashboard)/agent/page.tsx`**

The receptionist's basic settings, the first page of the sidebar's agent group. Operators set how the AI receptionist greets callers, describes the business, transfers calls, books and changes appointments, and when the business is open.

- `GET /agent`: Renders `LiveAgentBasicSettingsSurface` (`apps/admin/src/components/live-agent-basic-settings-surface.tsx`), the same component as `/agent/basic-settings`. It loads `GET /api/agent` (default caller language, time zone, receptionist profile) and `GET /api/hours`. Each setting saves on its own with `PATCH /api/agent`: greeting, business summary (typed, or `regenerateSummary`), `locale`, time zone, transfer number, booking mode and appointment change policy (cancel, reschedule, verification mode). Opening hours save with `PUT /api/hours`. Only business_owner and business_admin can edit (client check); both APIs require business_admin. An alert warns when instant booking has no opening hours.

Related files: `apps/admin/src/components/live-agent-basic-settings-surface.tsx`, `apps/admin/src/components/business-hours-section.tsx`, `apps/admin/app/api/agent/route.ts`, `apps/admin/app/api/hours/route.ts`.

**`apps/admin/app/(dashboard)/agent/basic-settings/page.tsx`**

A second address for the receptionist's basic settings, rendering the same page as `/agent`. The dashboard's link to the opening-hours editor points here (`/agent/basic-settings#opening-hours`).

- `GET /agent/basic-settings`: Renders `LiveAgentBasicSettingsSurface` (`apps/admin/src/components/live-agent-basic-settings-surface.tsx`), exactly like `GET /agent`. It loads `GET /api/agent` (default caller language, time zone, receptionist profile) and `GET /api/hours`. Each setting saves on its own with `PATCH /api/agent`: greeting, business summary (typed, or `regenerateSummary`), `locale`, time zone, transfer number, booking mode and appointment change policy (cancel, reschedule, verification mode). Opening hours save with `PUT /api/hours`. Only business_owner and business_admin can edit (client check); both APIs require business_admin. An alert warns when instant booking has no opening hours. Its button links here (`HOURS_EDITOR_HREF`).

Related files: `apps/admin/src/components/live-agent-basic-settings-surface.tsx`, `apps/admin/src/components/business-hours-section.tsx`, `apps/admin/app/api/agent/route.ts`, `apps/admin/app/api/hours/route.ts`.

**`apps/admin/app/(dashboard)/agent/integrations/page.tsx`**

An address with no content of its own: it sends the visitor to the receptionist's basic settings at `/agent`. Nothing in the admin app links here.

- `GET /agent/integrations`: The page calls `redirect("/agent")` from `next/navigation` while rendering, so the visitor lands on the receptionist's basic settings at `/agent`. It reads nothing from the request and loads no data. Google Calendar and webhook settings are on the `/integrations` pages.

Related files: `apps/admin/app/(dashboard)/agent/page.tsx`, `apps/admin/src/components/live-integrations-surface.tsx`.

**`apps/admin/app/(dashboard)/agent/knowledge/page.tsx`**

The receptionist's knowledge base: uploaded documents, imported website pages and typed text entries, listed together. business_owner and business_admin add, pause and delete sources here, and cancel a running website import.

- `GET /agent/knowledge`: Renders `LiveKnowledgeSurface` (`apps/admin/src/components/live-knowledge-surface.tsx`). It loads `GET /api/knowledge` (polled every 1.5 s while a document is pending or processing) and `GET /api/knowledge/snippets`; opening a document row loads its text with `GET /api/knowledge/[documentId]`. business_owner and business_admin (client check; the domain functions also require business_admin) can upload a file (`uploadKnowledgeDocument`: `POST /api/uploads`, a PUT to the returned storage URL, `PUT /api/uploads`), import a website (`POST /api/knowledge`, `sourceType: "website"`), add text (`POST /api/knowledge/snippets`), edit, pause or delete it (`PATCH`, `DELETE /api/knowledge/snippets/[snippetId]`), pause or delete a document (`PATCH`, `DELETE /api/knowledge/[documentId]`), and cancel a running import (`action: "cancel"`). `?setup=upload`, `website` or `text` opens that form.

Related files: `apps/admin/src/components/live-knowledge-surface.tsx`, `apps/admin/src/lib/storage-upload.ts`, `apps/admin/app/api/knowledge/[documentId]/route.ts`, `packages/domain/src/server/knowledge.ts`.

**`apps/admin/app/(dashboard)/agent/services/page.tsx`**

The receptionist's service catalog: the services callers can ask about and book, with durations and descriptions. business_owner and business_admin add, edit, pause and delete services here.

- `GET /agent/services`: Renders `LiveServicesSurface` (`apps/admin/src/components/live-services-surface.tsx`). It loads `GET /api/catalog` with `limit=100`, then searches and pages the result in the browser. business_owner and business_admin (client check; the domain functions also require business_admin) get the editing controls: add a service with `POST /api/catalog` (`name`, a slug made from the name, `durationMinutes`, `description`, `active`), edit it with `PATCH /api/catalog/[serviceId]`, pause or resume it with `PATCH` and `active`, and delete it with `DELETE /api/catalog/[serviceId]` after a confirmation. `?setup=service` opens the add dialog (`useSetupAction`).

Related files: `apps/admin/src/components/live-services-surface.tsx`, `apps/admin/app/api/catalog/route.ts`, `packages/domain/src/server/catalog.ts`, `apps/admin/src/lib/use-setup-action.ts`.

**`apps/admin/app/(dashboard)/agent/rules/page.tsx`**

Business rules for the receptionist, kept as an ordered list of titled instructions; the receptionist's instructions list them in that priority order. business_owner and business_admin write, reorder, pause and delete them.

- `GET /agent/rules`: Renders `RulesSurface` (`apps/admin/src/components/rules-surface.tsx`). It loads `GET /api/rules` and lists rules by `sortOrder`, with search and pages of 10 in the browser. business_owner and business_admin (client check; the domain functions also require business_admin) can add a rule with `POST /api/rules` (`title`, `content`), edit or pause it with `PATCH /api/rules` (`ruleId` plus the changed fields or `active`), move it up or down with `PATCH /api/rules` and the full `ruleIds` order, and delete it with `DELETE /api/rules` and a JSON body holding `ruleId`. `?setup=rule` opens the add dialog.

Related files: `apps/admin/src/components/rules-surface.tsx`, `apps/admin/app/api/rules/route.ts`, `packages/domain/src/server/rules.ts`, `packages/agent-core/src/instructions.ts`.

**`apps/admin/app/(dashboard)/analytics/page.tsx`**

Analytics for the active business over a chosen date range: calls, messages, appointments and agent response time against the previous period, plus call outcomes and channel shares.

- `GET /analytics`: Renders `LiveAnalyticsSurface` (`apps/admin/src/components/live-analytics-surface.tsx`). It loads `GET /api/analytics` with `businessId`, `from`, `to` and `granularity`, sending the picked calendar days as UTC days. The range comes from presets (last 30 days by default) or a calendar. Granularity defaults to weekly and drops to a coarser one when the range is longer than the API serves (hourly up to 20 days, daily up to a year). It refetches on realtime call, message and appointment events. The page shows an overview chart, four metric cards with deltas, an outcomes list and channel percentages.

Related files: `apps/admin/src/components/live-analytics-surface.tsx`, `apps/admin/app/api/analytics/route.ts`, `apps/admin/src/lib/analytics-channels.ts`.

**`apps/admin/app/(dashboard)/integrations/page.tsx`**

The Integrations page: the Google Calendar connection for appointment sync, and the way in to webhooks. Only business_owner and business_admin can use it (client check).

- `GET /integrations`: Renders `LiveIntegrationsSurface` (`apps/admin/src/components/live-integrations-surface.tsx`). For business_owner and business_admin it loads `GET /api/integrations` (calendar connections and options; polled every 2 s while syncing); other roles see disabled buttons and nothing loads. Connect or Reconnect calls `GET /api/calendar/google/start` and sends the browser to the returned Google URL. A return with `?calendar=google&status=success` shows a toast and opens the calendar dialog; any other status shows an error toast. In the dialog, picking a calendar sends `PATCH /api/integrations` (requires business_admin), Refresh calendars sends `POST`, and Disconnect sends `DELETE` with `connectionId`. `?setup=calendar` opens the dialog.

Related files: `apps/admin/src/components/live-integrations-surface.tsx`, `apps/admin/app/api/integrations/route.ts`, `apps/admin/app/api/calendar/google/start/route.ts`.

**`apps/admin/app/(dashboard)/integrations/webhooks/page.tsx`**

Outgoing webhook endpoints for the business: where events go, which events, signing secrets and the delivery log. Only business_owner and business_admin can manage them.

- `GET /integrations/webhooks`: Renders `LiveWebhooksSurface` (`apps/admin/src/components/live-webhooks-surface.tsx`). Other roles see a restricted notice and nothing loads (client check; the domain functions also require business_admin). Otherwise it loads `GET /api/webhook-endpoints`. Create sends `POST /api/webhook-endpoints` (`url`, `description`, `events`, all preselected) and shows the signing secret once. Per endpoint, the switch and Edit send `PATCH /api/webhook-endpoints/[endpointId]` and Delete sends `DELETE`; Rotate secret posts to `/api/webhook-endpoints/[endpointId]/rotate-secret` and shows the new secret; Send test posts to `/api/webhook-endpoints/[endpointId]/test`. The open log polls `/api/webhook-endpoints/[endpointId]/deliveries` every 10 s, and Resend posts to `/api/webhook-deliveries/[deliveryId]/resend`.

Related files: `apps/admin/src/components/live-webhooks-surface.tsx`, `apps/admin/app/api/webhook-endpoints/route.ts`, `packages/domain/src/server/publicApi/webhooks.ts`.

**`apps/admin/app/(dashboard)/settings/page.tsx`**

The bare settings address. It has no content of its own and sends the visitor to the usage tab, the first tab of the settings navigation.

- `GET /settings`: The page calls `redirect("/settings/usage")` from `next/navigation` while rendering. It reads nothing from the request and loads no data. The sidebar's Settings item links to `/settings/usage` directly.

Related files: `apps/admin/app/(dashboard)/settings/usage/page.tsx`, `apps/admin/src/components/settings-shell.tsx`.

**`apps/admin/app/(dashboard)/settings/usage/page.tsx`**

The Usage tab, where `/settings` and the sidebar's Settings link land. It shows this billing period's voice minutes, outbound call attempts, alert SMS segments and knowledge storage against the plan's allowance.

- `GET /settings/usage`: Renders `LiveUsageSurface` (`apps/admin/src/components/live-usage-surface.tsx`). It loads `GET /api/billing` and reads `effectivePlan`, `limits`, `usageStatus` and `knowledgeStorageBytesUsed`. Allowances come from `limits`, the plan in force as the billing catalog has it (a promo plan's own allowances included); a meter turns red with a notice when that usage is blocked. The reset date is the account's `currentPeriodEnd`, or else the last day of the current month. A self-hosted plan shows a notice instead of meters. A failed load offers a Retry button.

Related files: `apps/admin/src/components/live-usage-surface.tsx`, `apps/admin/app/api/billing/route.ts`.

**`apps/admin/app/(dashboard)/settings/plan/page.tsx`**

The Plan tab: the current plan and what it includes, upgrade and subscription management, the overage spending cap, and recent transactions.

- `GET /settings/plan`: Renders `LivePlanSurface` (`apps/admin/src/components/live-plan-surface.tsx`). It loads `GET /api/billing` (account, effective plan, usage status, transactions, and `permissions` from `billingAccess`, all of which need business_admin and up). Returning from checkout with `?checkout=success&requestId=` polls `GET /api/billing/checkout` every 1.5 s until `synced`, then reloads billing and clears the query. The plan card shows a promo plan by its own name, discount and ending date when the business has one. With `hasCheckoutAccess`, Upgrade opens the upgrade dialog (`POST /api/billing/checkout`, then polling for the checkout URL, or, for a Starter business moving to Pro, until the `changed` request has synced; a refused change shows its reason, and a refusal about the payer's email opens `BillingEmailForm` to try again with a billing email). **Have a promo code?** (`PromoCodeEntry`) checks a code with `POST /api/billing/promo` and buys its plan through the same checkout. With `hasCustomerPortalAccess`, Manage subscription sends `POST /api/billing/portal` and follows the returned `url`. On starter and pro, `SpendingCapSection` sets or removes the cap with `POST /api/billing` and `capCents` when `hasBillingManagementAccess`.

Related files: `apps/admin/src/components/live-plan-surface.tsx`, `apps/admin/src/components/billing-spending-cap.tsx`, `apps/admin/src/components/live-upgrade-plan-provider.tsx`, `packages/domain/src/server/billingAccess.ts`.

**`apps/admin/app/(dashboard)/settings/team/page.tsx`**

The Team tab of settings: the workspace name, its members and pending invitations. business_owner and business_admin rename the business, invite people as admin or viewer, and remove members or cancel invitations.

- `GET /settings/team`: Renders `LiveTeamSurface` (`apps/admin/src/components/live-team-surface.tsx`). It loads `GET /api/team` with `businessId` (members and invitations; only pending invitations show) and takes the business name from `GET /api/businesses`. For business_owner and business_admin (client check): rename with `PATCH /api/businesses` and `name`; invite with `POST /api/team` (`businessId`, lowercased `email`, `role` of `business_admin` or `viewer`); remove a member or cancel an invitation with `DELETE /api/team` and a JSON body holding `membershipId` or `invitationId`. A business_owner member has no remove action.

Related files: `apps/admin/src/components/live-team-surface.tsx`, `apps/admin/app/api/team/route.ts`, `apps/admin/app/api/businesses/route.ts`.

**`apps/admin/app/(dashboard)/settings/phone-number/page.tsx`**

The Phone number tab: the business's dedicated receptionist number. business_owner and business_admin get a first number or make their one allowed change, or are sent to upgrade when the plan includes no number.

- `GET /settings/phone-number`: Renders `LivePhoneNumberSettingsSurface` (`apps/admin/src/components/live-phone-number-settings-surface.tsx`). It loads `GET /api/phone-numbers` (polled every second while a claim runs) and `GET /api/billing` for the plan's included numbers. A number scheduled for reclaim shows a banner. For business_owner and business_admin (client check) the action opens `PhoneNumberChooser`: a first number uses `GET /api/onboarding/phone-numbers/suggestion`, `POST /api/onboarding/phone-numbers/search` and `POST /api/onboarding/phone-numbers/claim`; a change uses `POST /api/phone-numbers/replacement/search` and `POST /api/phone-numbers/replacement/claim`. Either polls its `claim/[claimId]` route every second for up to two minutes. Change is disabled once `replacement.usedAt` is set; a plan without numbers gets an upgrade button instead.

Related files: `apps/admin/src/components/live-phone-number-settings-surface.tsx`, `apps/admin/src/components/phone-number-chooser.tsx`, `apps/admin/app/api/phone-numbers/route.ts`.

**`apps/admin/app/(dashboard)/settings/appearance/page.tsx`**

The Preferences tab: the operator's interface language and time format, and the business's product-analytics switch. Unlike most dashboard pages, the page file is itself the client component.

- `GET /settings/appearance`: The page file is a client component. Language goes through `setLocale` (`LocaleProvider` in `apps/admin/src/components/replacement-locale-provider.tsx`): it stores the choice in local storage and the locale cookie, switches the interface, and saves it with `PATCH /api/preferences/locale`, rolling back with an error toast on failure. Time format (24-hour or AM/PM) stays in browser local storage (`AppearanceProvider`). The telemetry switch loads `GET /api/preferences/appearance` and saves the business's `telemetryEnabled` with `PATCH /api/preferences/appearance`, optimistically, restoring the old value on error. It is disabled unless the API reports `canManageTenant` (business_admin and up), and the PATCH requires business_admin.

Related files: `apps/admin/src/components/replacement-locale-provider.tsx`, `apps/admin/src/components/appearance-provider.tsx`, `apps/admin/app/api/preferences/appearance/route.ts`, `apps/admin/app/api/preferences/locale/route.ts`.

**`apps/admin/app/(dashboard)/settings/notifications/page.tsx`**

The Notifications tab: how the signed-in operator hears about events in this business, by email and SMS, event by event.

- `GET /settings/notifications`: Renders `LiveNotificationSettingsSurface` (`apps/admin/src/components/live-notification-settings-surface.tsx`). It loads `GET /api/notification-preferences` with `businessId`: the user's own preferences for this business. Every switch or checkbox saves the whole object with `PUT /api/notification-preferences`. Rows cover voice messages and paused SMS, plus system issues (SMS failures, calendar sync, failed transfers, disabled webhooks); a channel's column shows only while that channel is on. Turning SMS on without a verified phone or recorded consent opens `SmsPhoneVerificationDialog` (`POST /api/account/phone-verification`, then `POST /api/account/phone-verification/check`). The SMS switch is disabled when no sender is configured.

Related files: `apps/admin/src/components/live-notification-settings-surface.tsx`, `apps/admin/src/components/sms-phone-verification-dialog.tsx`, `apps/admin/app/api/notification-preferences/route.ts`.

**`apps/admin/app/(dashboard)/settings/api-keys/page.tsx`**

The API keys tab, where business_owner and business_admin create and revoke keys for the public API and copy the business ID that API requests send.

- `GET /settings/api-keys`: Renders `LiveApiKeysSurface` (`apps/admin/src/components/live-api-keys-surface.tsx`). Other roles see a restricted notice and nothing loads (client check; the domain functions also require business_admin). For business_owner and business_admin it loads `GET /api/api-keys` with `businessId` (name, prefix, scopes, creator, last use, revocation). A panel shows the business ID with a copy button and names the `LobbyStack-Business` header (`BUSINESS_HEADER`). Create sends `POST /api/api-keys` with `name` and `scopes` chosen from `offeredApiKeyScopes` (five read scopes preselected) and shows the full key once (`SecretReveal`). Revoke confirms, then sends `DELETE /api/api-keys/[apiKeyId]`.

Related files: `apps/admin/src/components/live-api-keys-surface.tsx`, `apps/admin/app/api/api-keys/route.ts`, `packages/domain/src/server/publicApi/apiKeys.ts`.

**`apps/admin/app/(dashboard)/settings/connected-apps/page.tsx`**

The Connected apps tab: MCP clients the business authorized through OAuth, with their access scopes and last use. business_owner and business_admin can revoke them.

- `GET /settings/connected-apps`: Renders `LiveConnectedAppsSurface` (`apps/admin/src/components/live-connected-apps-surface.tsx`). Roles other than business_owner and business_admin see a restricted notice and nothing loads (client check; the domain functions also require business_admin). Otherwise it loads `GET /api/oauth-grants` with `businessId` and lists each app's name and client ID, scopes, who granted it and when, and last use. Revoke asks for confirmation, then sends `DELETE /api/oauth-grants/[grantId]` (`revokeOAuthGrant`) and reloads the list.

Related files: `apps/admin/src/components/live-connected-apps-surface.tsx`, `apps/admin/app/api/oauth-grants/route.ts`, `packages/domain/src/server/oauth/grants.ts`.

**`apps/admin/app/(dashboard)/settings/widget/page.tsx`**

The Website widget page, linked from both the sidebar and the settings tabs: website chat widget keys with their allowed sites, look and lead-form options, the embed snippet, and widget chat alert preferences.

- `GET /settings/widget`: Renders `LiveWidgetSettingsSurface` (`apps/admin/src/components/live-widget-settings-surface.tsx`). It loads `GET /api/billing` (for `widgetIssuanceEnabled`) and `GET /api/widget-keys`. When issuance is enabled, a form creates a key with `POST /api/widget-keys` (`label`, `allowedOrigins`, `config`: color, position, title, subtitle, greeting, `localeOverride`, `leadForm`, `liveChat`), then shows the key and its embed snippet (`widgetEmbedSnippet`) to copy; otherwise a notice says new widgets are not available yet. Each key's edits, pause, resume and revoke go to `PATCH /api/widget-keys` with `id`. Both writes require business_admin. Below, notification preferences show only the widget chat and live chat request events.

Related files: `apps/admin/src/components/live-widget-settings-surface.tsx`, `apps/admin/app/api/widget-keys/route.ts`, `apps/admin/src/components/live-notification-settings-surface.tsx`.

**`apps/admin/app/(dashboard)/settings/profile/page.tsx`**

The Public profile tab: the business's public profile at `/profile/<slug>`, what it shows and whether it is published. Every member can view the settings; business_admin and up change and publish them.

- `GET /settings/profile`: Renders `LivePublicProfileSettingsSurface` (`apps/admin/src/components/live-public-profile-settings-surface.tsx`). It loads `GET /api/business-profile` (slug, settings, active widget keys, public `url`, `canEdit`) without refetching on window focus. The form covers publishing, category, description, public email, address, the phone, hours, services and map toggles, and which chat widget key the page embeds. Saving validates with `publicProfileSettingsSchema` in the browser, then sends `PUT /api/business-profile`, which requires business_admin; errors show by field or under the form. The form is read-only when `canEdit` is false. Buttons copy the public link or open it in a new tab.

Related files: `apps/admin/src/components/live-public-profile-settings-surface.tsx`, `apps/admin/app/api/business-profile/route.ts`.

**`apps/admin/app/(dashboard)/settings/qrcode/page.tsx`**

The QR code tab: printable signs with a QR code that opens the business's public page, built entirely in the browser.

- `GET /settings/qrcode`: Renders `LiveQrCodeSettingsSurface` (`apps/admin/src/components/live-qr-code-settings-surface.tsx`). It loads `GET /api/business-profile` for the public `url`, slug, business name, publish state and linked chat widget. The operator picks a template, sheet size, mark, sign language (its `settings` translations load from `/locales/`) and an optional message, then prints with `window.print()` or downloads a PNG or SVG drawn in the browser (`qrCodePng`, `qrCodeSvgFile`). When the public page is unpublished, an alert says so and, for users with `canEdit`, links to `/settings/profile`. Nothing is saved.

Related files: `apps/admin/src/components/live-qr-code-settings-surface.tsx`, `apps/admin/src/lib/qr-code-files.ts`, `apps/admin/src/lib/qr-code.ts`.

**`apps/admin/app/(dashboard)/(account)/settings/account/page.tsx`**

The signed-in user's account security page, opened from the user menu: change the sign-in email or password. It sits in the `(account)` route group, so the settings tabs do not wrap it.

- `GET /settings/account`: Renders `LiveAccountSurface` (`apps/admin/src/components/live-account-surface.tsx`). It loads `GET /api/account` and passes the user's email to `AccountSecurityForms` (`apps/admin/src/components/account-security-forms.tsx`). Change email posts `newEmail` and a `callbackURL` of `/settings/account?emailChanged=true` to Better Auth at `POST /api/auth/change-email`, which queues a confirmation email. Change password first checks that the two new entries match, then posts `currentPassword`, `newPassword` and `revokeOtherSessions: true` to `POST /api/auth/change-password`. Better Auth's error message shows in the dialog.

Related files: `apps/admin/src/components/live-account-surface.tsx`, `apps/admin/src/components/account-security-forms.tsx`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(dashboard)/setup-guide/page.tsx`**

The setup checklist that follows onboarding, opened from the sidebar card: a deeper website scan, more knowledge sources, a test call and a phone number. Only business_owner and business_admin can use it.

- `GET /setup-guide`: Renders `LiveSetupGuideSurface` (`apps/admin/src/components/live-setup-guide-surface.tsx`). The browser sends roles other than business_owner and business_admin to `/`, and everyone once every step is complete or skipped. It loads `GET /api/setup` (steps; polled every 2 s for a minute after a test call ends; requires business_admin), `GET /api/billing` and `GET /api/hours`. Step actions: the full scan sends `PATCH /api/knowledge/[documentId]` with `action: "expand"`, then opens `/agent/knowledge`; sources opens `/agent/knowledge?setup=upload`; the test call starts a browser call (`startTestCall`); phone number opens `/settings/phone-number`, or the upgrade dialog when the plan includes no number. Skip sends `PATCH /api/setup` with `stepId` and `skipped: true`; Skip setup skips every open step, then goes to `/`.

Related files: `apps/admin/src/components/live-setup-guide-surface.tsx`, `apps/admin/app/api/setup/route.ts`, `apps/admin/src/components/dashboard-setup-guide-card.tsx`.

**`apps/admin/app/(dashboard)/affiliate/page.tsx`**

The signed-in user's affiliate program page, opened from the gift icon in the dashboard's utility bar. It shows the referral link, program terms, earnings and payouts, and lets the user set a PayPal payout email.

- `GET /affiliate`: Renders `LiveAffiliateSurface` (`apps/admin/src/components/live-affiliate-surface.tsx`). It loads `GET /api/affiliate`, which belongs to the signed-in user rather than a business and creates the user's affiliate profile on first visit. It answers the profile (referral code and link, payout email), stats, clicks, attributions, commissions and payouts. The browser works out eligible commissions (pending, not voided, past `clearsAt`) for six stat cards, beside commissions and payouts tables. Copy puts the referral link on the clipboard. The settings tab saves the PayPal address with `PATCH /api/affiliate` and `payoutEmail`, then reloads.

Related files: `apps/admin/src/components/live-affiliate-surface.tsx`, `apps/admin/app/api/affiliate/route.ts`.

**`apps/admin/app/(dashboard)/demos/page.tsx`**

An internal tool for preparing prospect demos: the operator builds a demo receptionist from a business's website and shares a private demo link. Nothing links here, and every call it makes needs the prospect-demo operator account.

- `GET /demos`: Renders `LiveDemosSurface` (`apps/admin/src/components/live-demos-surface.tsx`). It loads `GET /api/demos` on mount and on Refresh. The form creates a demo with `POST /api/demos` (`name`, `websiteUrl`, `greeting`, `locale` as `fr` or `en` from the interface language, `suggestedPrompts` one per line). Each demo card sends `POST /api/demos/[demoId]` with `action` `rotate` (returns a new token), `publish` (enabled once the token is known and the website import, snapshot, greeting and prompts are ready) or `revoke`. Tokens live only in page memory; Open link opens `/demo#prospect_demo_token=...` in a new tab. The API admits only the `PROSPECT_DEMO_OPERATOR_EMAIL` user (`requireProspectDemoOperator`: 503 when unset, 403 for anyone else).

Related files: `apps/admin/src/components/live-demos-surface.tsx`, `apps/admin/app/api/demos/route.ts`, `apps/admin/app/api/demos/[demoId]/route.ts`, `apps/admin/src/lib/api-helpers.ts`.

## 4. Onboarding pages

A new account lands here, and the dashboard keeps sending it back until its business finishes onboarding. Earlier steps can be reopened; an address past the current step sends you to the current step. A business on the free plan is shown the plan step instead of the number step. The quoted titles are the English ones, and `{{appName}}` is the deployment's name (AlloPlace on demo.alloplace.com).

| Address | Page | Onboarding stage | Who | Docs today | Entry file |
|---|---|---|---|---|---|
| `https://demo.alloplace.com/onboarding/brand` | "Make this app your own": the app's name and logo | Before the first business, only on a deployment with no brand file. demo.alloplace.com has one (AlloPlace), so it never shows there. | The deployment's first owner | None yet | `apps/admin/app/(onboarding)/onboarding/brand/page.tsx` |
| `https://demo.alloplace.com/onboarding/business` | "First, what is the name of your business?" | `create_business`. `?create=true` starts another business (workspace menu > Create Business). | Signed in | `getting-started/account-setup.mdx` | `apps/admin/app/(onboarding)/onboarding/business/page.tsx` |
| `https://demo.alloplace.com/onboarding/website` | "Now let's train {{appName}} on your website" | `website` | Signed in; saving needs Admin+ | `getting-started/account-setup.mdx` | `apps/admin/app/(onboarding)/onboarding/website/page.tsx` |
| `https://demo.alloplace.com/onboarding/knowledge` | "Add training documents" | `knowledge` | Signed in; saving needs Admin+ | `getting-started/account-setup.mdx` | `apps/admin/app/(onboarding)/onboarding/knowledge/page.tsx` |
| `https://demo.alloplace.com/onboarding/greeting` | "How should we greet your callers?" | `greeting` | Signed in; saving needs Admin+ | `getting-started/account-setup.mdx` | `apps/admin/app/(onboarding)/onboarding/greeting/page.tsx` |
| `https://demo.alloplace.com/onboarding/plan` | "Choose your plan" | `plan` | Signed in; saving needs Admin+ | `billing/plans.mdx` | `apps/admin/app/(onboarding)/onboarding/plan/page.tsx` |
| `https://demo.alloplace.com/onboarding/number` | "Pick your AI's phone number" | `phone_number` and `phone_number_claiming` | Signed in; saving needs Admin+ | `getting-started/claim-your-number.mdx` | `apps/admin/app/(onboarding)/onboarding/number/page.tsx` |
| `https://demo.alloplace.com/onboarding/attribution` | "How did you hear about {{appName}}?" Answering it finishes onboarding. | `attribution`, then `complete` (the dashboard) | Signed in; saving needs Admin+ | `getting-started/account-setup.mdx` | `apps/admin/app/(onboarding)/onboarding/attribution/page.tsx` |
| `https://demo.alloplace.com/onboarding/verify-phone` | Old address; sends you to your current step | None (phone verification left onboarding) | Signed in | None yet | `apps/admin/app/(onboarding)/onboarding/verify-phone/page.tsx` |
| `https://demo.alloplace.com/onboarding/verify-phone/code` | Old address; sends you to your current step | None | Signed in | None yet | `apps/admin/app/(onboarding)/onboarding/verify-phone/code/page.tsx` |

### Entry files

The two onboarding layouts come first, then each page in the order of the table.

**`apps/admin/app/(onboarding)/layout.tsx`**

Root layout of the `(onboarding)` route group, which holds only the `/onboarding/...` pages. It keeps signed-out visitors out of onboarding and renders the HTML document in the request's language with the deployment's current name and logo.

- Every onboarding page (the root layout): Rendered per request (`force-dynamic`). It reads the language the proxy negotiated from the request headers (`localeFromRequestHeaders`) and the Better Auth session (`getSession` in `apps/admin/src/lib/auth.ts`). Without a session it redirects to the localized login page, for example `/en/login`, with no `returnTo`. Otherwise it renders `RootDocument` (`apps/admin/src/app/root-document.tsx`): `<html lang>`, the shared providers, the current branding from `loadBranding`, and the `common`, `onboarding`, `auth`, `settings` and `nav` translations that `routeNamespaces` picks for onboarding paths. Metadata comes from `generateBrandingMetadata`.

Related files: `apps/admin/src/app/root-document.tsx`, `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/locale-request.ts`, `apps/admin/src/lib/route-namespaces.ts`.

**`apps/admin/app/(onboarding)/onboarding/layout.tsx`**

Wraps every onboarding step in the shared onboarding frame (step title, sign-out button and progress dots), so all steps share one look and the same navigation.

- Every onboarding page (the step shell): Renders the client component `OnboardingRouteShell` (`apps/admin/src/components/onboarding-route-shell.tsx`) around the page. It picks the step from the path, shows its title and description from the `onboarding` translations, and offers Sign out (`useSignOut`: `POST /api/auth/sign-out`, then the localized `/login`). It loads workspaces with `GET /api/businesses` and draws eight progress dots (step 1 is sign-up) that link to steps up to the active business's stored stage; on `/onboarding/number` it also reads `GET /api/phone-numbers?businessId=` to pick the title. It makes no server-side check: each page enforces the step order.

Related files: `apps/admin/src/components/onboarding-route-shell.tsx`, `apps/admin/src/components/replacement-onboarding-shell.tsx`, `apps/admin/src/hooks/use-sign-out.ts`, `apps/admin/src/hooks/use-active-business.ts`.

**`apps/admin/app/(onboarding)/onboarding/brand/page.tsx`**

Asks a fresh deployment's first owner, before they name their business, for the product name and logo shown across the deployment. Everyone else is sent on to their current step.

- `GET /onboarding/brand`: It does not call `requireOnboardingStage`. Signed out, it redirects to `/login`. It then calls `asksInitialBranding` (`apps/admin/src/lib/onboarding-branding.ts`): false when a brand file sets the branding, else `canSaveInitialBranding`, true only while nothing is saved and the user is an active `business_owner` of every business. When false it redirects to the user's current step. `OnboardingBrandSurface` posts the name and a base64 logo to `POST /api/branding/initial`, or `{}` on Skip to keep the default and end the choice, then goes to `/onboarding/business`. On `branding_already_saved` or `branding_not_allowed` it reloads `GET /api/branding` and offers Continue.

Related files: `apps/admin/src/components/onboarding-brand-surface.tsx`, `apps/admin/src/lib/onboarding-branding.ts`, `packages/domain/src/server/branding.ts`, `apps/admin/app/api/branding/initial/route.ts`.

**`apps/admin/app/(onboarding)/onboarding/business/page.tsx`**

Step 2: the owner names their business. It creates the first workspace for a new signup, renames the workspace of a claimed prospect demo, and with `?create=true` creates another workspace.

- `GET /onboarding/business`: `requireOnboardingStage` admits every signed-in user, since this is the earliest step (signed out: `/login`). A user with no business whom `asksInitialBranding` selects is redirected to `/onboarding/brand`. `OnboardingBusinessSurface` loads `GET /api/businesses`. With a business and no `?create=true`, it prefills the active business's name, then calls `PATCH /api/businesses?businessId=` with the name and `POST /api/onboarding/stage?businessId=` with `{ to: "website" }` (ignored when the business is already further along). Otherwise it calls `POST /api/businesses` with the name, the browser's time zone, `businessType: "service_company"` and the stored referral code; the new business starts on `website` as the active business. Either way it then goes to `/onboarding/website`.

Related files: `apps/admin/src/components/onboarding-business-surface.tsx`, `apps/admin/src/lib/onboarding-route.ts`, `apps/admin/app/api/businesses/route.ts`, `packages/domain/src/server/tenancy.ts`.

**`apps/admin/app/(onboarding)/onboarding/website/page.tsx`**

Step 3: the owner gives the business's website so the AI receptionist can learn from it, or skips. The site is imported in the background while later steps go on.

- `GET /onboarding/website`: `requireOnboardingStage` sends signed-out visitors to `/login` and businesses before `website` back to their step, so a claimed prospect demo still on `create_business` returns to `/onboarding/business`. `OnboardingWebsiteSurface` prefills the saved `websiteUrl` from `GET /api/businesses`. Continue calls `POST /api/knowledge` with the URL, `sourceType: "website"` and `onboarding: true`; `createKnowledgeDocument` (`packages/domain/src/server/knowledge.ts`) saves it as the business website, moves a business still on `website` to `knowledge`, and queues a sample crawl (`knowledge.crawlWebsite` outbox event). Skip calls `POST /api/onboarding/stage?businessId=` with `{ to: "knowledge" }`. Both go to `/onboarding/knowledge`.

Related files: `apps/admin/src/components/onboarding-website-surface.tsx`, `apps/admin/src/lib/onboarding-route.ts`, `packages/domain/src/server/knowledge.ts`, `apps/admin/app/api/knowledge/route.ts`.

**`apps/admin/app/(onboarding)/onboarding/knowledge/page.tsx`**

Step 4: the owner gives the AI receptionist more to learn from by uploading documents or pasting text, while the website import from step 3 runs.

- `GET /onboarding/knowledge`: `requireOnboardingStage` sends signed-out visitors to `/login` and businesses before `knowledge` back to their step. `OnboardingKnowledgeSurface` lists uploads from `GET /api/knowledge?businessId=`, polling every 2 seconds while a website import runs. Each file up to 10 MB goes through `uploadKnowledgeDocument` (`apps/admin/src/lib/storage-upload.ts`): `POST /api/uploads`, a PUT to the returned storage URL, then `PUT /api/uploads` to finalize it. Continue saves pasted text with `POST /api/knowledge/snippets?businessId=`, then calls `POST /api/onboarding/stage?businessId=` with `{ to: "greeting" }`; Skip makes only the stage call. Both go to `/onboarding/greeting`.

Related files: `apps/admin/src/components/onboarding-knowledge-surface.tsx`, `apps/admin/src/lib/storage-upload.ts`, `apps/admin/src/lib/onboarding-route.ts`, `apps/admin/app/api/uploads/route.ts`.

**`apps/admin/app/(onboarding)/onboarding/greeting/page.tsx`**

Step 5: the owner writes the AI receptionist's greeting. The page also shows the progress of the website import started in step 3.

- `GET /onboarding/greeting`: `requireOnboardingStage` sends a signed-out visitor to `/login` and a business whose stage comes before `greeting` back to its step; later stages may revisit. `OnboardingGreetingSurface` prefills the greeting from `GET /api/agent` and polls `GET /api/knowledge?businessId=` every 2 seconds while a website import runs. Continue calls `PATCH /api/agent` with the greeting and a `locale` of `fr` when the interface language is French, else `en` (this also sets the business's `defaultLocale`), then `POST /api/onboarding/stage?businessId=` with `{ to: "plan" }`, and goes to `/onboarding/plan`.

Related files: `apps/admin/src/components/onboarding-greeting-surface.tsx`, `apps/admin/src/lib/onboarding-route.ts`, `apps/admin/app/api/agent/route.ts`, `apps/admin/app/api/onboarding/stage/route.ts`.

**`apps/admin/app/(onboarding)/onboarding/plan/page.tsx`**

Step 6: the owner picks a plan. Free skips the number step, Starter and Pro go through a Polar checkout, Enterprise opens an email to sales, and a business already on a paid plan just continues.

- `GET /onboarding/plan`: `requireOnboardingStage` sends signed-out visitors to `/login` and businesses before `plan` back to their step. `OnboardingPlanSurface` reads `GET /api/billing?businessId=`. Free posts `{ to: "attribution" }` to `POST /api/onboarding/stage` and goes to `/onboarding/attribution`. The plan cards and the comparison come from `plans` in the billing answer, the billing catalog's once a `billing.json` is applied, in its currency. A promo link's code waits from sign-up in `PromoCodeEntry`, which checks it with `POST /api/billing/promo`. Starter or Pro calls `POST /api/billing/checkout` (the worker's `billing.createCheckout` job makes the Polar checkout), polls `GET /api/billing/checkout?requestId=` every 1.5 seconds and opens the returned `checkoutUrl`; when Polar already has the payer's email for another business, `BillingEmailForm` asks for a billing email and starts again with it (fork PR #72). Polar returns to `?checkout=success&requestId=`; once that request is `synced`, the page posts `{ to: "phone_number" }` and replaces to `/onboarding/number`. A business already on a paid plan sees one Continue button doing the same. Enterprise opens a `mailto:` to the brand's sales address (`contactEmailFor(brandLinks(), "sales")`).

Related files: `apps/admin/src/components/onboarding-plan-surface.tsx`, `apps/admin/src/lib/onboarding-route.ts`, `apps/admin/app/api/billing/checkout/route.ts`, `apps/worker/src/handlers.ts`.

**`apps/admin/app/(onboarding)/onboarding/number/page.tsx`**

Step 7: the owner picks and claims the business's phone number, or skips it for later. A business whose plan includes no number, such as Free, is held at the plan step instead.

- `GET /onboarding/number`: `requireOnboardingStage` sends signed-out visitors to `/login` and businesses before `phone_number` back to their step; for a business whose plan in force includes no number (Free, a lapsed subscription, or a promo plan without one) the number stages count as `plan`. `OnboardingNumberSurface` reads `GET /api/phone-numbers?businessId=`, every second during a claim. A business that already has a number goes on to `/onboarding/attribution`. Otherwise `PhoneNumberChooser` loads `GET /api/onboarding/phone-numbers/suggestion`, searches with `POST /api/onboarding/phone-numbers/search`, claims with `POST /api/onboarding/phone-numbers/claim` and polls `GET /api/onboarding/phone-numbers/claim/[claimId]` for up to two minutes, then goes to `/onboarding/attribution` (`/settings/phone-number` once onboarding is complete). Skip calls `POST /api/onboarding/phone-numbers/skip`, which moves the stage to `attribution`, and goes there.

Related files: `apps/admin/src/components/onboarding-number-surface.tsx`, `apps/admin/src/components/phone-number-chooser.tsx`, `apps/admin/src/lib/onboarding-route.ts`, `packages/domain/src/server/phoneNumbers.ts`.

**`apps/admin/app/(onboarding)/onboarding/attribution/page.tsx`**

Step 8, the last onboarding step: the owner says how they heard about the product. Submitting or skipping records the answer, credits a stored affiliate referral, and marks onboarding complete.

- `GET /onboarding/attribution`: `requireOnboardingStage` (`apps/admin/src/lib/onboarding-route.ts`) sends a signed-out visitor to `/login` and a business whose stage (`getActiveOnboardingState` in `packages/domain/src/server/onboarding.ts`) comes before `attribution` back to its step; finished businesses may return. `OnboardingAttributionSurface` offers 15 sources. Finish, or Skip with a null source, posts the source and the referral code saved at sign-up to `POST /api/onboarding/attribution?businessId=`. There `submitOnboardingAttribution` credits the referral while the stage is `attribution`, saves the source, sets the stage to `complete` and queues a check-in email for a day later. The surface then clears the saved code and goes to `/`.

Related files: `apps/admin/src/components/onboarding-attribution-surface.tsx`, `apps/admin/src/lib/onboarding-route.ts`, `packages/domain/src/server/onboarding.ts`, `apps/admin/app/api/onboarding/attribution/route.ts`.

**`apps/admin/app/(onboarding)/onboarding/verify-phone/page.tsx`**

Leftover address from the removed personal phone verification step. It renders nothing and forwards the visitor to their current onboarding step, so old links keep working.

- `GET /onboarding/verify-phone`: Calls `requireOnboardingStage("/onboarding/verify-phone")` from `apps/admin/src/lib/onboarding-route.ts`. A signed-out visitor goes to `/login`. The path has no stage in the helper's route map, so every signed-in visitor is redirected to the step for their active business's stage (`resolveOnboardingRoute` in `packages/domain/src/server/onboarding.ts`), or to `/` once onboarding is complete. Businesses still stored on the old `verify_phone` or `verify_phone_code` stages count as `plan`. The page returns `null` and calls no API.

Related files: `apps/admin/src/lib/onboarding-route.ts`, `packages/domain/src/server/onboarding.ts`.

**`apps/admin/app/(onboarding)/onboarding/verify-phone/code/page.tsx`**

Leftover address from the removed phone verification code step. Like `/onboarding/verify-phone`, it renders nothing and forwards the visitor to their current onboarding step.

- `GET /onboarding/verify-phone/code`: Calls `requireOnboardingStage("/onboarding/verify-phone/code")` from `apps/admin/src/lib/onboarding-route.ts`. A signed-out visitor goes to `/login`. The path has no stage in the helper's route map, so every signed-in visitor is redirected to the step for their active business's stage (`resolveOnboardingRoute` in `packages/domain/src/server/onboarding.ts`), or to `/` once onboarding is complete. Businesses still stored on the old `verify_phone` or `verify_phone_code` stages count as `plan`. The page returns `null` and calls no API.

Related files: `apps/admin/src/lib/onboarding-route.ts`, `packages/domain/src/server/onboarding.ts`.

## 5. Sign-in and account pages

Public pages, each in four languages. An address without a language, such as `https://demo.alloplace.com/login`, answers 308 and redirects to the language chosen by `?lng=`, then the language cookie, then the browser's Accept-Language. Adding `?lng=` to an address with a language redirects to that language and remembers it in a cookie. Pages that carry a token are never cached.

| Address | Page | Who | Docs today | Entry file |
|---|---|---|---|---|
| `https://demo.alloplace.com/{locale}/login` | Sign in. `?returnTo=` says where to go afterwards. | Public | `getting-started/account-setup.mdx` | `apps/admin/app/(public)/[locale]/login/page.tsx` |
| `https://demo.alloplace.com/{locale}/signup` | Create an account. Sign-up needs a Cloudflare Turnstile check (`TURNSTILE_SECRET_KEY`; only a local app skips it). `?returnTo=`; `?ref=` or `?via=` records an affiliate referral. | Public | `getting-started/account-setup.mdx`, `billing/affiliate-program.mdx` | `apps/admin/app/(public)/[locale]/signup/page.tsx` |
| `https://demo.alloplace.com/{locale}/forgot-password` | Get a reset code by email, then choose a new password with it | Public | `settings/account.mdx` | `apps/admin/app/(public)/[locale]/forgot-password/page.tsx` |
| `https://demo.alloplace.com/{locale}/reset-password` | Choose a new password from an emailed reset link (`?token=`) | Public (with a reset token) | `settings/account.mdx` | `apps/admin/app/(public)/[locale]/reset-password/page.tsx` |
| `https://demo.alloplace.com/{locale}/reset-password/{token}` | The same, with the token in the path | Public (with a reset token) | `settings/account.mdx` | `apps/admin/app/(sensitive)/[locale]/reset-password/[token]/page.tsx` |
| `https://demo.alloplace.com/{locale}/verify-email` | Confirm your email with the code sent to it. With `?token=` (an emailed link) it forwards to `/api/auth/verify-email`. | Public | `quickstart.mdx` | `apps/admin/app/(sensitive)/[locale]/verify-email/page.tsx` |
| `https://demo.alloplace.com/{locale}/confirm-email-change` | Confirm a new sign-in email (`?token=` and `?email=`) | Public (with the emailed link) | `settings/account.mdx` | `apps/admin/app/(public)/[locale]/confirm-email-change/page.tsx` |
| `https://demo.alloplace.com/{locale}/accept-invite` | Join a business from an invitation (`?token=`) | Public; joining needs the invited, verified email signed in | `settings/team.mdx` | `apps/admin/app/(public)/[locale]/accept-invite/page.tsx` |
| `https://demo.alloplace.com/{locale}/demo` | A prospect demo: try a receptionist built from a business's website. The token travels after `#prospect_demo_token=`, so it never reaches the server log. | Public (with a demo token) | None yet | `apps/admin/app/(public)/[locale]/demo/page.tsx` |
| `https://demo.alloplace.com/{locale}/demo/{token}` | Old demo link; moves the token after `#` and opens `/{locale}/demo` | Public (with a demo token) | None yet | `apps/admin/app/(sensitive)/[locale]/demo/[token]/page.tsx` |
| `https://demo.alloplace.com/{locale}/claim-demo` | Turn a prospect demo into your own business | Public page; claiming needs sign-in | None yet | `apps/admin/app/(public)/[locale]/claim-demo/page.tsx` |
| `https://demo.alloplace.com/{locale}/oauth/consent` | Connect an AI assistant (MCP client): pick the business and the permissions it gets | Signed in; approving needs Admin+ of the chosen business | `ai/mcp.mdx`, `ai/connect-claude.mdx` | `apps/admin/app/(sensitive)/[locale]/oauth/consent/page.tsx` |

`/{locale}/oauth/consent` is the one page here with no language-free address: `/oauth/consent` is a redirect route instead (section 10).

### Entry files

The two layouts come first: `(public)` for pages that are the same for everyone, `(sensitive)` for pages that carry a token. Then each page in the order of the table.

**`apps/admin/app/(public)/[locale]/layout.tsx`**

Root layout of the `(public)` route group: the language-prefixed login, sign-up, password, email-change, invitation and demo pages, prerendered at build time for each interface language so shared caches can serve them.

- The pages under `/{locale}` that are the same for everyone: Static only (`dynamic = "error"`): `generateStaticParams` builds `en`, `fr`, `es` and `sr`, `dynamicParams = false` returns 404 for other values, and an unsupported `locale` also gets `notFound()`. Metadata and branding come from `buildTimeBrandingSnapshot()` (`apps/admin/src/lib/branding.ts`), the build's brand file; when none matched, `BrandingProvider` asks `GET /api/branding` in the browser. It renders `RootDocument` with the path locale and the public namespaces (`common`, `auth`, `onboarding`, `demos`, `widget`). Its pages read tokens and the session in the browser. The proxy lets shared caches keep these pages (`s-maxage=300`) unless the address carries a token.

Related files: `apps/admin/src/app/root-document.tsx`, `apps/admin/src/lib/branding.ts`, `apps/admin/src/components/branding-provider.tsx`, `apps/admin/proxy.ts`.

**`apps/admin/app/(sensitive)/[locale]/layout.tsx`**

Root layout of the `(sensitive)` route group: language-prefixed pages that must read the request (a token, a signed query or the session), so they render per request with the deployment's current name and logo.

- The pages under `/{locale}` that carry a token: Rendered per request (`force-dynamic`). It reuses the public layout's `generateStaticParams` (`en`, `fr`, `es`, `sr`) with `dynamicParams = false`, so other locales get 404, and calls `notFound()` for an unsupported `locale` as well. It renders `RootDocument` (`apps/admin/src/app/root-document.tsx`) with the path locale, the public translation namespaces (`common`, `auth`, `onboarding`, `demos`, `widget`) and no build-time branding, so `loadBranding` runs per request; metadata comes from `generateBrandingMetadata`. Its pages are `/[locale]/oauth/consent`, `/[locale]/reset-password/[token]`, `/[locale]/demo/[token]` and `/[locale]/verify-email`.

Related files: `apps/admin/src/app/root-document.tsx`, `apps/admin/app/(public)/[locale]/layout.tsx`, `apps/admin/src/lib/branding.ts`, `apps/admin/src/lib/route-namespaces.ts`.

**`apps/admin/app/(public)/[locale]/login/page.tsx`**

Email and password sign-in for operators. It also finishes email verification for an unverified account and sends the person back to a safe `returnTo`, which the invitation, demo-claim and MCP OAuth flows set.

- `GET /{locale}/login`: Prerendered. `GuestAuthCard` (`apps/admin/src/components/guest-auth-card.tsx`) calls `GET /api/auth/get-session` (10-second timeout); a signed-in visitor goes to `returnTo` if `getSafeReturnTo` accepts it, else `/` (also when it points at login or signup). `AuthCard` posts `{ email, password }` to Better Auth's `POST /api/auth/sign-in/email`. An `EMAIL_NOT_VERIFIED` answer opens the code form: `POST /api/auth/email-otp/verify-email`, then sign-in again; resending uses `POST /api/auth/email-otp/send-verification-otp`, with Turnstile after `CHALLENGE_FAILED`. Success records `web.auth.login_succeeded` and loads `returnTo` (same-origin path) or `/`. Links to sign-up keep `returnTo`.

Related files: `apps/admin/src/components/guest-auth-card.tsx`, `apps/admin/src/components/auth-card.tsx`, `apps/admin/src/lib/auth-return-to.ts`, `apps/admin/src/lib/oauth-pages.ts`.

**`apps/admin/app/(public)/[locale]/signup/page.tsx`**

Account creation, step 1 of onboarding: email and password sign-up behind Cloudflare Turnstile when configured, email verification with a six-digit code, then sign-in. It also records affiliate referral links and honors `returnTo`.

- `GET /{locale}/signup`: Prerendered. `GuestAuthCard` first calls `GET /api/auth/get-session` and sends a signed-in visitor to the safe `returnTo` or `/`. `AuthCard` (`apps/admin/src/components/auth-card.tsx`) stores a `?ref=` or `?via=` referral code and reports it to `POST /api/affiliate/click`. Submit waits for a Turnstile token when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set, then calls `POST /api/auth/sign-up/email` (the sign-up hook in `apps/admin/src/lib/auth.ts` verifies the token). A null `token` in the answer opens the code form: `POST /api/auth/email-otp/verify-email`, then `POST /api/auth/sign-in/email`; resending uses the app's `POST /api/auth/email-otp/send-verification-otp`, with Turnstile after a `CHALLENGE_FAILED`. Success goes to `returnTo` (same-origin local paths only) or `/`.

Related files: `apps/admin/src/components/guest-auth-card.tsx`, `apps/admin/src/components/auth-card.tsx`, `apps/admin/app/api/auth/email-otp/send-verification-otp/route.ts`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(public)/[locale]/forgot-password/page.tsx`**

Password recovery by emailed code, the current reset flow: the person asks for a code, enters it with a new password, and is signed in.

- `GET /{locale}/forgot-password`: Prerendered; the page file is itself a client component and renders `ForgotPasswordForm` in two steps. Request posts the lowercased email to Better Auth's `POST /api/auth/email-otp/request-password-reset`. Verify posts `{ email, otp, password }` to `POST /api/auth/email-otp/reset-password`; error codes map to invalid-password or invalid-code messages. After a reset it signs in with `POST /api/auth/sign-in/email` and replaces to `/`, or to the localized `/login` if that sign-in fails. It uses no Turnstile and ignores `returnTo`.

Related files: `apps/admin/src/components/forgot-password-form.tsx`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(public)/[locale]/reset-password/page.tsx`**

Sets a new password from an older reset link that carries its token as `?token=`. Current resets use the emailed code on `/[locale]/forgot-password`.

- `GET /{locale}/reset-password`: Prerendered; the page file is a client component that reads `token` from the query with `useSearchParams` inside `Suspense` and renders `PasswordResetForm`. Without a token the form shows the invalid-code message and disables submit. With one it checks the password with `meetsPasswordRequirements` and calls Better Auth's `POST /api/auth/reset-password` with `{ newPassword, token }`; success shows a confirmation, any refusal the invalid-code message. It links back to the localized `/login` and does not sign the user in. The proxy sends `Cache-Control: private, no-store` for `?token=` addresses.

Related files: `apps/admin/src/components/password-reset-form.tsx`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(sensitive)/[locale]/reset-password/[token]/page.tsx`**

Sets a new password from an older reset link that carries its token in the path. Current resets use the emailed code on `/[locale]/forgot-password`; the component keeps this for links issued before that flow returned.

- `GET /{locale}/reset-password/{token}`: Rendered per request. The page passes the `token` path segment to `PasswordResetForm` (`apps/admin/src/components/password-reset-form.tsx`). The form checks the new password with `meetsPasswordRequirements`, then calls Better Auth's `POST /api/auth/reset-password` with `{ newPassword, token }`. Success shows a confirmation; any refusal shows the invalid-code message. A link leads back to the localized `/login`; the page never signs the user in. The proxy sends `Cache-Control: private, no-store` for this address.

Related files: `apps/admin/src/components/password-reset-form.tsx`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(sensitive)/[locale]/verify-email/page.tsx`**

Landing page for email verification links. With a token it hands the request to Better Auth's verification endpoint; without one it says the link is invalid.

- `GET /{locale}/verify-email`: Rendered per request. When `?token=` is present, the page redirects on the server to Better Auth's `GET /api/auth/verify-email` with the token and a `callbackURL`: the request's own `callbackURL` if `getSafeReturnTo` (`apps/admin/src/lib/auth-return-to.ts`) accepts it as a local path, else `/[locale]/login?verified=true`. Without a token it renders `VerifyEmailStatus`, a missing-token message with a link to the localized `/login`. The proxy sends `Cache-Control: private, no-store` when the address carries a token.

Related files: `apps/admin/src/components/verify-email-status.tsx`, `apps/admin/src/lib/auth-return-to.ts`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(public)/[locale]/confirm-email-change/page.tsx`**

Confirms a new email address. `apps/admin/src/lib/auth.ts` points Better Auth's email-change verification link here with `token` and `email`, and the change completes only when the person presses Confirm.

- `GET /{locale}/confirm-email-change`: Prerendered; `ConfirmEmailChangeSurface` reads `token` and `email` from the query in the browser and checks the session with `GET /api/auth/get-session` (retried after a 429) only to choose the back link: `/settings/usage` when signed in, else the localized `/login`. Nothing is confirmed on load. Confirm calls Better Auth's `GET /api/auth/verify-email?token=`; an answer with `status` and `user.email` shows success with that address, anything else the invalid-link message. Without both parameters the button stays disabled. The proxy sends `Cache-Control: private, no-store` because of the token.

Related files: `apps/admin/src/components/confirm-email-change-surface.tsx`, `apps/admin/src/lib/public-auth-session.ts`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/(public)/[locale]/accept-invite/page.tsx`**

Lets an invited person join a business team from the emailed link: it previews the invitation, asks them to sign in or sign up, then accepts it.

- `GET /{locale}/accept-invite`: Prerendered. `AcceptInviteSurface` reads `?token=` in the browser, checks the session with `GET /api/auth/get-session` (retried after a 429), and previews the invitation with `GET /api/team/accept?token=` (business name, email, expiry and status). Signed-out visitors get login and sign-up links whose `returnTo` is this page with its token. Signed in, Accept calls `POST /api/team/accept` with `{ token }`. A 403 (wrong or unverified account) shows a message and a Switch account button that signs out with `POST /api/auth/sign-out` and opens the login link. Success shows toasts, including handover notes about turned-off webhooks and calendars, and replaces to `/settings/team`.

Related files: `apps/admin/src/components/accept-invite-surface.tsx`, `apps/admin/app/api/team/accept/route.ts`, `apps/admin/src/lib/auth-return-to.ts`.

**`apps/admin/app/(public)/[locale]/demo/page.tsx`**

Public page where a prospect talks in the browser to the AI receptionist of a demo business an operator set up for them, then claims it by signing up. The demo token travels in the address fragment.

- `GET /{locale}/demo`: Prerendered, with `noindex` and `no-referrer` metadata. `DemoSurface` (`apps/admin/src/components/demo-surface.tsx`) reads `prospect_demo_token` from the fragment (none: invalid state), switches to the light theme, and polls `POST /api/demo/preview` every 1.5 seconds while `preparing`. An `active` demo shows suggested prompts and `DemoVoiceClient`, which starts a WebRTC call with `POST /api/voice/live/session` carrying `prospectDemoToken`. The claim button saves the token in `sessionStorage` and links to `/[locale]/signup?returnTo=/[locale]/claim-demo`. Other states (`preparing`, `claimed`, `revoked`, `expired`, `invalid`) show a message. Text follows the demo's `locale`.

Related files: `apps/admin/src/components/demo-surface.tsx`, `apps/admin/src/components/demo-voice-client.tsx`, `packages/domain/src/server/demos.ts`, `apps/admin/app/api/demo/preview/route.ts`.

**`apps/admin/app/(sensitive)/[locale]/demo/[token]/page.tsx`**

Compatibility address for prospect demo links that carry the token in the path. It moves the token into the address fragment and opens the demo page, so the token is not sent to the server again.

- `GET /{locale}/demo/{token}`: Rendered per request, with `robots: noindex, nofollow` and `referrer: no-referrer` metadata. `DemoTokenCompatibilityRoute` (`apps/admin/src/components/demo-token-compatibility-route.tsx`) reads `locale` and `token` from the route and calls `window.location.replace` with `secureDemoRedirect` (`apps/admin/src/lib/demo-token.ts`), which builds `/[locale]/demo#prospect_demo_token=<token>`; replacing also drops the token address from history. It calls no API. The proxy sends `Cache-Control: private, no-store` for this address.

Related files: `apps/admin/src/components/demo-token-compatibility-route.tsx`, `apps/admin/src/lib/demo-token.ts`, `apps/admin/src/components/demo-surface.tsx`.

**`apps/admin/app/(public)/[locale]/claim-demo/page.tsx`**

Turns a prospect demo into the signed-in user's own workspace, then starts onboarding at the business step. The demo page's claim button reaches it through sign-up.

- `GET /{locale}/claim-demo`: Prerendered, with `noindex` and `no-referrer` metadata. `ClaimDemoSurface` takes the token from `#prospect_demo_token`, `?token=` or `sessionStorage`, keeps it in `sessionStorage` and strips it from the address. It polls `POST /api/demo/preview` every 1.5 seconds while the demo is `preparing`. For an `active` or `claimed` demo it calls `POST /api/demo/claim` once: 401 replaces to the localized login with `returnTo=/[locale]/claim-demo`; success clears the stored token and replaces to `/onboarding/business` (`claimProspectDemo` makes the user owner, sets the stage to `create_business` and makes it the active business). Other states, or another user's claim, show an unavailable message; other errors offer Retry.

Related files: `apps/admin/src/components/claim-demo-surface.tsx`, `packages/domain/src/server/demos.ts`, `apps/admin/app/api/demo/claim/route.ts`.

**`apps/admin/app/(sensitive)/[locale]/oauth/consent/page.tsx`**

Consent screen for MCP clients authorizing through Better Auth's OAuth provider: the signed-in user picks the business the app may use and which requested permissions it gets, or denies. Better Auth's consent hop `/oauth/consent` redirects here in the person's language.

- `GET /{locale}/oauth/consent`: The page needs `client_id` and Better Auth's `sig` in the query, else it shows an invalid-request screen. A signed-out visitor goes to `/oauth/sign-in` with the same query, which redirects to the localized login with `returnTo` set to the original `/api/auth/oauth2/authorize` request. It loads the client name through Better Auth's `getOAuthClientPublic` (failure: invalid), the businesses where the user is business_admin or business_owner (`listGrantableBusinesses`) and the requested grantable scopes. `OAuthConsentSurface` posts the choice, business and scopes to `POST /api/oauth/consent` and follows the returned `url`; with no grantable business only Deny is offered.

Related files: `apps/admin/src/components/oauth-consent-surface.tsx`, `apps/admin/src/lib/oauth-pages.ts`, `packages/domain/src/server/oauth/grants.ts`, `apps/admin/app/api/oauth/consent/route.ts`.

## 6. Public business page and website widget

| Method | Address | What it is | Who | Docs today | Entry file |
|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/profile/{slug}` | The business's public page: name, hours, services, call and chat buttons. A published page is public. An unpublished one shows only to signed-in members of the business, as a preview; anyone else gets 404. Slugs are at most 120 characters. | Public | `settings/public-profile.mdx` | `apps/admin/app/(profile)/profile/[slug]/page.tsx` |
| GET | `https://demo.alloplace.com/embed.js` | The widget loader that goes on a website. `?key=<widget key>` adds the look saved in the dashboard (cached 60 s); without a key it is cached for 10 minutes. | Public | `settings/widget.mdx` | `apps/admin/app/embed.js/route.ts` |
| GET | `https://demo.alloplace.com/embed/embed.js` | The same loader as a static file, without the saved look | Public | `settings/widget.mdx` | `apps/admin/public/embed/embed.js` (built from `packages/embed`) |
| GET | `https://demo.alloplace.com/embed/{key}` | The chat window the loader opens in an iframe. `?color=` paints it before its settings load; `?locale=` sets its language. | Public (the key must be active) | `settings/widget.mdx` | `apps/admin/app/(app)/embed/[key]/page.tsx` |

### Entry files for the pages and the loader

**`apps/admin/app/(profile)/layout.tsx`**

Root layout of the `(profile)` route group, whose only page is a business's public page at `/profile/[slug]`. It gives that server-rendered page a bare document, without the dashboard's providers, translations or analytics.

- `/profile/{slug}`: Public. It renders per request (`force-dynamic`). It reads the locale the proxy negotiated with `localeFromRequestHeaders` (`apps/admin/src/lib/locale-request.ts`), sets it as the document's `lang` through `localeTag`, and renders the page in a plain `body` with the global stylesheet. It loads no data, calls no API and writes nothing.

Related files: `apps/admin/src/lib/locale-request.ts`, `apps/admin/src/lib/locale.ts`.

**`apps/admin/app/(profile)/profile/[slug]/page.tsx`**

The public page visitors and search engines reach at `/profile/<slug>`: a business's name, open status, hours, services, contact details, map and, when set up, its website chat inline. Members of the business also see an unpublished page as a preview.

- `GET /profile/{slug}`: Public. `loadProfile` (memoized with React `cache`, shared with `generateMetadata`) rejects slugs over 120 characters and calls `getPublicBusinessProfile` (`packages/domain/src/server/publicProfiles.ts`) as the worker. A published page resolves through `app.resolve_public_profile`; an unpublished one shows only to a signed-in active member (`getSession`) as a preview, kept out of search results. Otherwise it calls `notFound()`. `ProfilePage` (`apps/admin/src/components/public-profile/profile-page.tsx`) renders it. With an active widget key, a published page loads `/embed.js?key=<key>` into its chat panel, which then uses the widget API; without a key, a business with a phone number shows a call panel. Nothing is written.

Related files: `packages/domain/src/server/publicProfiles.ts`, `apps/admin/src/components/public-profile/profile-page.tsx`, `apps/admin/src/lib/public-profile-page.ts`, `packages/embed/src/index.ts`.

**`apps/admin/app/(profile)/profile/[slug]/not-found.tsx`**

What `/profile/<slug>` shows when the page finds no profile the visitor may see, such as an unknown slug or a page that isn't published (unless a signed-in member previews it). It shows a short translated message and the deployment's brand.

- `/profile/{slug}` when there is no page to show: Public. Next.js renders it when `page.tsx` calls `notFound()`. It reads the negotiated locale (`localeFromRequestHeaders`) and the deployment's branding (`loadBranding`), then shows the `profile` namespace's `notFound.title` and `notFound.body` through `serverTranslator`, above a footer linking the brand logo and name to `brandLinks().siteUrl`. It reads no business data and writes nothing. For this case the page's `generateMetadata` sets the not-found title and keeps the page out of search results.

Related files: `apps/admin/src/lib/server-translation.ts`, `apps/admin/src/lib/branding.ts`, `apps/admin/app/(profile)/profile/[slug]/page.tsx`.

**`apps/admin/app/(app)/layout.tsx`**

Root layout of the `(app)` route group, whose only page is the website widget's chat at `/embed/[key]`. It gives the chat iframe a light document: queries, translations and branding, without the saved language preference or product analytics.

- `/embed/{key}`: Public. It renders per request (`force-dynamic`). It reads the locale the proxy negotiated (under `/embed/` the proxy takes it from `?locale=`) and the pathname header, then renders `WidgetDocument` (`apps/admin/src/app/widget-document.tsx`): `<html lang>` around `BaseProviders` with the branding from `loadBranding`, React Query, i18next and the route's translation namespaces from `routeNamespaces` (`common` and `widget` for `/embed/`). Its `generateMetadata` is `generateBrandingMetadata`: the deployment's name and logo. It loads no business data and writes nothing.

Related files: `apps/admin/src/app/widget-document.tsx`, `apps/admin/src/app/base-providers.tsx`, `apps/admin/src/lib/route-namespaces.ts`.

**`apps/admin/app/(app)/embed/[key]/page.tsx`**

The website widget's chat, which the loader (`/embed.js`) opens in an iframe on a customer's site or on a business's profile page. It holds the chat, the lead form and, when enabled, the voice call button.

- `GET /embed/{key}`: Public; the proxy's headers let any site frame it. It reads the `key` segment and a `?color=` hex value (the bubble's color), then renders `WidgetChatClient` (`apps/admin/src/components/widget/widget-chat-client.tsx`) with the decoded key; an empty key renders nothing. The client waits for the loader's `session` message (token, parent origin, visitor ID), accepted only from the parent window at that origin, then calls `/api/widget/config`, `/api/widget/history`, `/api/widget/stream`, `/api/widget/chat` and `/api/widget/lead` with `Authorization: Bearer <token>` and `X-Widget-Parent-Origin`, and, when `voiceEnabled`, starts calls through `/api/voice/live/session`. Messages render through `renderSafeMarkdown`, which escapes HTML first.

Related files: `apps/admin/src/components/widget/widget-chat-client.tsx`, `packages/embed/src/index.ts`, `apps/admin/src/lib/widget-markdown.ts`, `packages/web-voice/src/useWebVoiceCall.ts`.

**`apps/admin/app/embed.js/route.ts`**

Serves the widget loader script that customers paste onto their sites and profile pages load. With `?key=`, it prepends the bubble color, position and chat language saved in the dashboard, so a change there reaches sites without a new snippet.

- `GET /embed.js`: Public. The proxy leaves caching to the route. It reads `public/embed/embed.js`, which the build copies from `packages/embed` with `scripts/copy-widget-embed.mjs`. For a `?key=` of up to 200 base64url characters, `loadWidgetAppearance` (`apps/admin/src/lib/widget-keys.ts`) resolves the active key by hash and reads its saved `color` and `position` plus the chat language (`localeOverride`, else the business default); the route prepends a line storing them in `window.__lobbyStackWidgetAppearance[key]`. A failed lookup serves the plain loader. Answers 200 JavaScript with `nosniff`, cached 60 seconds when keyed and longer otherwise; without the file it serves a stub comment.

Related files: `packages/embed/src/index.ts`, `apps/admin/src/lib/widget-keys.ts`, `scripts/copy-widget-embed.mjs`.

**`apps/admin/public/embed/embed.js`**

The website widget's loader as a plain static file. It is a build output, not source: Vite compiles `packages/embed/src/index.ts` and `scripts/copy-widget-embed.mjs` copies `packages/embed/dist/embed.js` here (both `pnpm widget:embed:build` and `pnpm build` run it).

- `GET /embed/embed.js`: Next.js serves the file straight from `apps/admin/public/` with no route code, and `apps/admin/next.config.ts` marks it `Cache-Control: public, max-age=31536000, immutable`. The proxy runs on `/embed/` addresses too and sets `private, no-store`, which most likely wins (section 17). On a website, the script reads its own tag (`data-widget-key` or a `key` in its `src`, `data-position`, `data-color`, `data-locale`, `data-inline-target`), adds the chat bubble and an iframe that opens `/embed/{key}`, talks to that iframe with `postMessage`, and exposes `window.LobbyStack` with `open`, `close` and `toggle`. `/embed.js` (`apps/admin/app/embed.js/route.ts`) serves this same file with the key's saved look added in front.

Related files: `packages/embed/src/index.ts`, `scripts/copy-widget-embed.mjs`, `apps/admin/next.config.ts`.

### Widget API

The chat window calls these. **Widget session** means `Authorization: Bearer <token from POST /api/widget/session>` plus `X-Widget-Parent-Origin: <the website's origin>`, which must match the website the session started on. Docs today: `settings/widget.mdx`.

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| OPTIONS | `https://demo.alloplace.com/api/widget/session` | Cross-site preflight for the call below | Public | `apps/admin/app/api/widget/session/route.ts` |
| POST | `https://demo.alloplace.com/api/widget/session` | Start a widget session: send `widgetKey` and `visitorId`, get a session token. The browser's Origin must be one of the key's allowed websites. Limited per business, key, visitor and IP. | Public (allowed websites only) | `apps/admin/app/api/widget/session/route.ts` |
| GET | `https://demo.alloplace.com/api/widget/config` | The widget's settings, and whether its call button shows | Widget session | `apps/admin/app/api/widget/config/route.ts` |
| POST | `https://demo.alloplace.com/api/widget/chat` | Send the visitor's message and get the receptionist's reply. Answers 402 once the month's chat limit is reached. | Widget session | `apps/admin/app/api/widget/chat/route.ts` |
| GET | `https://demo.alloplace.com/api/widget/history` | The visitor's chat so far (`?chat=` keeps a chat that went quiet open) | Widget session | `apps/admin/app/api/widget/history/route.ts` |
| POST | `https://demo.alloplace.com/api/widget/lead` | Save the visitor's name, email or phone | Widget session | `apps/admin/app/api/widget/lead/route.ts` |
| GET | `https://demo.alloplace.com/api/widget/stream` | Live updates for the open chat (a team member's reply, a hand-off), as Server-Sent Events | Widget session | `apps/admin/app/api/widget/stream/route.ts` |

#### Entry files

**`apps/admin/app/api/widget/session/route.ts`**

Issues the website widget's session token. The loader script on a customer's site, or on a business's profile page, posts the widget key and visitor ID here and passes the token to the chat iframe, which sends it to the other widget routes.

- `POST /api/widget/session`: No login. `readJson` and `widgetSessionRequestSchema` (`widgetKey`, GUID `visitorId`; 400 `widget_session_input_invalid`); a request without an Origin header gets 403 `widget_origin_required`. `resolveWidgetAccess` (`apps/admin/src/lib/widget-access.ts`) hashes the key and resolves it with `app.resolve_business_by_widget_key`, which returns only active keys of active businesses (404 `widget_key_invalid`). The Origin must be one of the key's websites exactly (no implicit localhost or dashboard origin), or the deployment's own origin when the business's published profile page uses this key (403 `widget_origin_denied`). `enforceWidgetRateLimits` (`session`, plus 60 per minute per business; 429/503). `registerWidgetVisitor` upserts `widget_visitors` and `touchWidgetKeyLastUsed` sets `last_used_at`. `createWidgetSessionToken` signs a one-hour HMAC-SHA256 token (`WIDGET_SESSION_SECRET`, else `BETTER_AUTH_SECRET`) holding key, business, visitor and origin. Answers 200 `{ token, expiresAt, visitorId }`; unexpected errors get 500 `widget_session_failed` with `errorId`.
- `OPTIONS /api/widget/session`: Answers 204 with CORS headers for any Origin: it echoes the Origin in `access-control-allow-origin` and allows `POST, OPTIONS` and `content-type`, with `cache-control: no-store`. POST responses carry the same headers, refusals included, so the loader on the customer's site can read the error `code` and show why the widget can't load.

Related files: `apps/admin/src/lib/widget-access.ts`, `apps/admin/src/lib/widget-keys.ts`, `apps/admin/src/lib/widget-policy.ts`, `packages/embed/src/index.ts`.

**`apps/admin/app/api/widget/config/route.ts`**

Gives the widget iframe its settings once it has a session: the key's chat configuration, the business's name, language and greeting, plan allowances, and whether to show the call button.

- `GET /api/widget/config`: Widget session token: `resolveWidgetSessionAccess` (`apps/admin/src/lib/widget-access.ts`) verifies the Bearer token's HMAC signature and expiry (401 `widget_session_invalid`), requires `X-Widget-Parent-Origin` equal to the token's origin (403 `widget_origin_denied`), reloads the key (403 `widget_disabled` unless active) and re-checks the origin against its websites or the published profile page. `enforceWidgetRateLimits` (`config`, 429/503). It reads `getCachedBusinessSnapshot`, `getWidgetChatAllowance` and `getWebVoiceBillingAllowance` in parallel and writes nothing. Answers 200 `{ key, business, config, billing, greeting, snapshotPresent, businessSlug, voiceEnabled }`; `voiceEnabled` needs a phone number, `LIVE_PROTOTYPE_ENABLED`, `OPENAI_API_KEY` and minutes left.

Related files: `apps/admin/src/lib/widget-access.ts`, `apps/admin/src/lib/widget-keys.ts`, `packages/domain/src/server/billing.ts`, `packages/domain/src/server/snapshotCache.ts`.

**`apps/admin/app/api/widget/chat/route.ts`**

The website chat's message endpoint. The widget iframe posts each visitor message here; the route saves it, alerts the team, and streams the receptionist's reply unless a team member has the chat.

- `POST /api/widget/chat`: Widget session token. `widgetChatRequestSchema.parse` (`visitorId`, `messageId`, `content`, optional `locale`); `resolveWidgetSessionAccess` (`apps/admin/src/lib/widget-access.ts`) checks the Bearer token and `X-Widget-Parent-Origin` (401/403); the visitor must match the token's (403 `widget_visitor_mismatch`); `enforceWidgetRateLimits` (`chat`, 429/503). `getOrCreateWidgetConversation` (`packages/domain/src/server/conversations.ts`) finds or opens the visitor's `web_chat` conversation, closing one idle for a day; `returnQuietTeamChat` gives the AI back a chat the team left quiet for 10 minutes. `appendMessage` saves the message and `queueOperatorAlert` queues one `widgetChat` alert per chat per day. Only after that, when the AI is to answer, can it refuse: 503 `ai_provider_unavailable` without a model, 402 `chat_ai_limit_reached` when `reserveWidgetChatUsageInTransaction` refuses the conversation. The 200 stream runs `createReceptionistAgent` over the last 20 messages (with the team-request tool when live chat is on), saves the reply and ends with `automationState` metadata; a team-held chat gets no reply. Each reply, and each failed one, leaves an AI debug trace (`recordAiTrace`); a trace that can't be saved never fails the chat.

Related files: `apps/admin/src/lib/widget-access.ts`, `packages/domain/src/server/conversations.ts`, `packages/domain/src/server/widgetLiveChat.ts`, `packages/agent-core/src/agent.ts`.

**`apps/admin/app/api/widget/history/route.ts`**

Loads the visitor's current website chat into the widget iframe: its messages, who has the chat, and whether the visitor waits for a team member. The widget calls it on load and whenever a live update arrives.

- `GET /api/widget/history`: Widget session token: `resolveWidgetSessionAccess` (Bearer token plus matching `X-Widget-Parent-Origin`; 401/403), then `enforceWidgetRateLimits` (`history`, 429/503). A token whose visitor ID isn't a UUID gets `{ messages: [] }`. `findCurrentWidgetChat` (`packages/domain/src/server/conversations.ts`) looks up the visitor's open `web_chat` conversation without creating one; none, or one idle for a day that `?chat=` doesn't name, also gets an empty list. `loadWidgetChatView` (`packages/domain/src/server/widgetLiveChat.ts`) reads the newest 200 messages and who has the chat. Answers 200 `{ conversationId, idle, automationState, waitingForTeam, teamMemberName, messages }`; team replies carry `fromTeam` and the member's first name. Read-only.

Related files: `apps/admin/src/lib/widget-access.ts`, `packages/domain/src/server/conversations.ts`, `packages/domain/src/server/widgetLiveChat.ts`.

**`apps/admin/app/api/widget/lead/route.ts`**

Saves the details a visitor enters in the widget's lead form (name, email, phone), so the business gets a contact linked to that visitor and their chats.

- `POST /api/widget/lead`: `widgetLeadRequestSchema` validates the body (400 `invalid_email`, `invalid_phone` or `widget_lead_input_invalid`); `resolveWidgetSessionAccess` checks the widget session token (401/403); the visitor must match it (403 `widget_visitor_mismatch`); `enforceWidgetRateLimits` (`lead`, 429/503). A phone is normalized to E.164 in the country of the business's active number, then the browser language's (400 `invalid_phone`). `registerWidgetVisitor` (`packages/domain/src/server/conversations.ts`) gives a visitor without a contact the one matching that email or phone, left unchanged, or a new one (emitting `contact.created`), updates `widget_visitors`, and on a first link attaches the visitor's contact-less chats. Answers 200 `{ ok, contactId, visitorId }`.

Related files: `packages/domain/src/server/conversations.ts`, `apps/admin/src/lib/widget-access.ts`, `apps/admin/src/lib/phone.ts`.

**`apps/admin/app/api/widget/stream/route.ts`**

Live updates for an open website chat. The widget iframe keeps this server-sent event stream open so it reloads its history as soon as a team member writes or the chat changes hands.

- `GET /api/widget/stream`: Widget session token: `resolveWidgetSessionAccess` (401/403); a token without a UUID visitor gets 400 `widget_visitor_required`; `enforceWidgetRateLimits` (`stream`, 429/503). Without `REDIS_URL` or past 1,000 open streams per process: 503 `widget_stream_unavailable`. `findWidgetConversationId` needs an open `web_chat` conversation (404 `widget_conversation_not_found`). The 200 `text/event-stream` subscribes through `listenToBusinessRealtime` (`apps/admin/src/lib/realtime-hub.ts`) to the business's Redis channel and sends `ready`, then `message` for an outbound message not written by the AI in this chat and `conversation` for changes to it, with empty data. Keepalives go every 15 seconds; it closes after 10 minutes or when Redis drops.

Related files: `apps/admin/src/lib/realtime-hub.ts`, `apps/admin/src/lib/widget-access.ts`, `packages/domain/src/server/conversations.ts`.

## 7. Browser calls

Calls to the receptionist from a browser, over WebRTC to GPT-Live. They need `LIVE_PROTOTYPE_ENABLED=true` and `OPENAI_API_KEY` on the admin and the worker.

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| OPTIONS | `https://demo.alloplace.com/api/voice/live/session` | Cross-site preflight for the marketing site's demo call | Public | `apps/admin/app/api/voice/live/session/route.ts` |
| POST | `https://demo.alloplace.com/api/voice/live/session` | Start a browser call to the receptionist: send the WebRTC offer (`sdp`) and a `widgetId`. See the four ways in below. | Depends on the way in | `apps/admin/app/api/voice/live/session/route.ts` |
| OPTIONS | `https://demo.alloplace.com/api/voice/live/session/end` | Cross-site preflight | Public | `apps/admin/app/api/voice/live/session/end/route.ts` |
| POST | `https://demo.alloplace.com/api/voice/live/session/end` | End a call whose audio never connected: send `sessionId` and the `endToken` the start call returned | Whoever holds the end token | `apps/admin/app/api/voice/live/session/end/route.ts` |

The four ways in to `POST /api/voice/live/session`:

| Way in | What the request carries | Who |
|---|---|---|
| Dashboard test call (`widgetId` = `lobbystack-dashboard-test-call`) | The sign-in cookie, from the dashboard's own origin | Admin+ |
| Website widget | Widget session headers (section 6); the website must be one of the key's allowed sites, or the business's published profile page | A visitor on an allowed website |
| Prospect demo (`lobbystack-prospect-demo`) | `prospectDemoToken` and `businessSlug` | Whoever holds the demo link |
| Public demo (`lobbystack-landing`) | `businessSlug` equal to `WEB_CALL_PUBLIC_BUSINESS_SLUG`, from an origin listed in `WEB_CALL_ALLOWED_ORIGINS` | The marketing site's visitors |

Docs today: `quickstart.mdx` covers the test call ("Hear your agent") and `settings/widget.mdx` the widget's call button. The prospect demo and the public demo have none yet.

### Entry files

**`apps/admin/app/api/voice/live/session/route.ts`**

Starts a browser voice call on GPT-Live over WebRTC. The dashboard's test call, the website widget's call button, prospect demo pages and the landing site's demo post their SDP offer here and get OpenAI's answer, an end token and the call's time limit.

- `POST /api/voice/live/session`: `requireLivePrototype` (404 unless `LIVE_PROTOTYPE_ENABLED=true`); the body needs `sdp` and an allowed `widgetId` (400 `invalid_request`). `resolveLiveWebCallAccess` (`apps/admin/src/lib/live-web-call.ts`) accepts four callers, else 403: `lobbystack-dashboard-test-call` from a configured app Origin, Admin+ via `withOperatorTransaction`; a widget session Bearer token with matching `X-Widget-Parent-Origin`, an active key and an allowed origin; `prospectDemoToken` plus `businessSlug` (`lobbystack-prospect-demo`, unbilled, intake-only); `businessSlug` equal to `WEB_CALL_PUBLIC_BUSINESS_SLUG` from an Origin in `WEB_CALL_ALLOWED_ORIGINS`. Then rate limits (429/503), minutes (402), the snapshot (409) and the widget's phone number (403). `client.live.create` sends `buildBrowserSessionConfig` (client delegation) with the offer (refusal: 502). `startLiveWebCall` records the call and reserves minutes; `attachWorkerToLiveSession` posts to the worker's `/internal/live/attach`; if a later step fails, the session is ended and a recorded call finishes as `setup_failed` with OpenAI's 15-second charge. Answers 201 `{ sessionId, endToken, sdp, maxDurationMs }`, plus `greeting`, the recorded greeting's words for the captions, when one plays (fork PR #52). The session's starting instructions go to the call's AI debug trace without holding the call up (`recordAiTrace`, ADR 0009).
- `OPTIONS /api/voice/live/session`: Preflight for the landing site's cross-origin demo. It answers 204 with `publicCallCorsHeaders` (`apps/admin/src/lib/live-web-call.ts`): an Origin listed in `WEB_CALL_ALLOWED_ORIGINS` gets `access-control-allow-origin`, methods `POST, OPTIONS`, the `content-type` header and a 600-second max age; any other Origin gets no CORS headers. POST responses, refusals and errors included, carry the same headers.

Related files: `apps/admin/src/lib/live-web-call.ts`, `apps/admin/src/lib/live-prototype.ts`, `packages/domain/src/server/liveCalls.ts`, `packages/agent-core/src/live/session.ts`.

**`apps/admin/app/api/voice/live/session/end/route.ts`**

Ends a browser GPT-Live call whose audio channel never opened, so the browser can't send `session.close` itself. `useWebVoiceCall` (`packages/web-voice`) calls it with the end token from the start response.

- `POST /api/voice/live/session/end`: Anyone with the start response's end token. `requireLivePrototype` (404 `live_prototype_disabled`) and `readJson` (400 `invalid_json`) run first; `sessionId` and `endToken` must be 1 to 128 characters (400 `invalid_request`). `verifyLiveSessionEndToken` (`apps/admin/src/lib/live-web-call.ts`) recomputes the HMAC-SHA256 of `live-session-end:<sessionId>` under `INTERNAL_SERVICE_SECRET` and compares in constant time (403 `forbidden`). `endLiveBrowserSession` (`apps/admin/src/lib/live-prototype.ts`) posts to the worker's `/internal/live/end`, which sends `session.close` over the call's sideband or a new one; a failure is only logged. Answers 204. The worker records the end when OpenAI reports the session closed.
- `OPTIONS /api/voice/live/session/end`: Answers 204 with the same `publicCallCorsHeaders` as the start route: only an Origin in `WEB_CALL_ALLOWED_ORIGINS` gets CORS headers allowing `POST, OPTIONS`. POST responses carry them too.

Related files: `apps/admin/src/lib/live-web-call.ts`, `apps/admin/src/lib/live-prototype.ts`, `apps/worker/src/liveCalls.ts`, `packages/web-voice/src/useWebVoiceCall.ts`.

## 8. Dashboard API

The routes the dashboard's own screens call: 125 method and path pairs in 78 route files. They take the sign-in cookie (section 2 covers which business they act on). They are internal to the app rather than a published contract; integrations should use the public API in section 9. Nothing under `mintlify/` documents these routes directly; the page docs in section 3 cover the screens that use them.

### Account and preferences

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/account` | Your account and the businesses you belong to | Signed in | `apps/admin/app/api/account/route.ts` |
| POST | `https://demo.alloplace.com/api/account/phone-verification` | Text a code to your personal phone, for SMS alerts (answers 202 with an `attemptId`) | Member | `apps/admin/app/api/account/phone-verification/route.ts` |
| GET | `https://demo.alloplace.com/api/account/phone-verification` | Where a phone verification stands (`?attemptId=`) | Member | `apps/admin/app/api/account/phone-verification/route.ts` |
| POST | `https://demo.alloplace.com/api/account/phone-verification/check` | Check the code you were texted | Member | `apps/admin/app/api/account/phone-verification/check/route.ts` |
| GET | `https://demo.alloplace.com/api/preferences/locale` | Your interface language | Signed in | `apps/admin/app/api/preferences/locale/route.ts` |
| PATCH | `https://demo.alloplace.com/api/preferences/locale` | Change your interface language (`en`, `fr`, `es` or `sr`) | Signed in | `apps/admin/app/api/preferences/locale/route.ts` |
| GET | `https://demo.alloplace.com/api/preferences/appearance` | The business's product analytics switch, and whether you may change it | Member | `apps/admin/app/api/preferences/appearance/route.ts` |
| PATCH | `https://demo.alloplace.com/api/preferences/appearance` | Turn product analytics on or off for the business | Admin+ | `apps/admin/app/api/preferences/appearance/route.ts` |
| GET | `https://demo.alloplace.com/api/notification-preferences` | Your alert settings for this business | Member | `apps/admin/app/api/notification-preferences/route.ts` |
| PUT | `https://demo.alloplace.com/api/notification-preferences` | Change your alerts: email, SMS, per event, daily summary. SMS needs a verified phone and an alert sender. Needs `businessId`. | Member | `apps/admin/app/api/notification-preferences/route.ts` |

#### Entry files

**`apps/admin/app/api/account/route.ts`**

Gives the account settings screen (`live-account-surface.tsx`) the signed-in user, the current session and every business the user belongs to.

- `GET /api/account`: Any signed-in user: `requireApiSession` only, with no business or role check. Calls `listUserBusinesses` (`packages/domain/src/server/tenancy.ts`), which reads `app.list_user_businesses` and flags the user's active business. Changes nothing. Answers 200 with `user` (the session's user object), `session` (`id` and ISO `expiresAt`) and `businesses` (ID, name, slug, role, time zone, type, default locale, website, onboarding stage, creation time and `active`).

Related files: `packages/domain/src/server/tenancy.ts`, `apps/admin/src/components/live-account-surface.tsx`.

**`apps/admin/app/api/account/phone-verification/route.ts`**

Starts, resends and polls verification of the operator's own mobile number for SMS alerts. The notification settings screen calls it through `sms-phone-verification-dialog.tsx`.

- `POST /api/account/phone-verification`: Any member of the target business: `requireOperatorBusiness`, then `requireBusinessMembership` inside `startOperatorPhoneVerification` (`packages/domain/src/server/phoneVerification.ts`). Reads `phoneNumber` and `locale`; a number `normalizePhoneNumber` or `inferPhoneCountry` rejects answers 422 `phone_number_invalid`. The domain needs an alert SMS sender (409 `sms_sender_missing`) that can text the number (422 `phone_unreachable`), cancels the user's open attempts, reserves an `onboarding_phone_verifications` row through `app.reserve_phone_verification_attempt` (429 on cooldown or hourly limits) and queues a `phoneVerification.sendCode` outbox event. Answers 202 `{ attemptId, phoneE164 }`.
- `GET /api/account/phone-verification`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `getOperatorPhoneVerification` (phoneVerification.ts). Needs `?attemptId=` (400 `attempt_required`) and reads that attempt only if it belongs to this user and business, else 404 `verification_not_found`. Changes nothing. Answers 200 `{ attempt: { id, status, expiresAt } }`, where `status` is `sending`, `sent`, `approved`, `expired`, `failed` or `canceled`; the code is never returned.

Related files: `packages/domain/src/server/phoneVerification.ts`, `apps/admin/src/components/sms-phone-verification-dialog.tsx`, `apps/admin/src/lib/phone.ts`.

**`apps/admin/app/api/account/phone-verification/check/route.ts`**

Checks the six-digit code the operator types in the SMS phone verification dialog. A correct code verifies the phone on their account and turns on their SMS alerts for the business.

- `POST /api/account/phone-verification/check`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `checkOperatorPhoneVerificationCode` (`packages/domain/src/server/phoneVerification.ts`). Needs string `attemptId` and `code` (400 `verification_code_required`); a code that isn't six digits answers 400 `verification_code_invalid`. The domain locks the attempt and counts the check. A match runs `app.complete_phone_verification` (sets `users.phone` and `phone_verified_at`), upserts `operator_notification_preferences` with texts on and consent recorded, and adds an `sms_consent_events` row. The fifth wrong code locks the attempt. Answers 200 `{ approved, status }`, with `remainingAttempts` after a wrong code.

Related files: `packages/domain/src/server/phoneVerification.ts`, `packages/domain/src/server/notifications.ts`, `apps/admin/src/components/sms-phone-verification-dialog.tsx`.

**`apps/admin/app/api/preferences/locale/route.ts`**

Reads and saves the signed-in user's interface language for the dashboard's locale provider (`replacement-locale-provider.tsx`).

- `GET /api/preferences/locale`: Any signed-in user: `requireApiSession`, no business needed. Reads `users.preferredLocale` through the auth database role (`getAuthDatabase()` in `apps/admin/src/lib/auth.ts`). Changes nothing. Answers 200 `{ locale }`, `en` when unset.
- `PATCH /api/preferences/locale`: Any signed-in user: `requireApiSession`. `locale` must pass `isInterfaceLocale` (400 listing the supported locales). Updates the user's `preferredLocale` through the auth database role. Answers 200 `{ locale }`.

Related files: `apps/admin/src/lib/auth.ts`, `apps/admin/src/components/replacement-locale-provider.tsx`.

**`apps/admin/app/api/preferences/appearance/route.ts`**

Reads and sets the workspace's opt-in to browser product telemetry for the appearance settings page and `product-analytics.tsx`, and tells them whether the caller may change it and which deployment mode runs.

- `GET /api/preferences/appearance`: Any member: `withOperatorTransaction`, whose callback calls `requireBusinessMembership` again to learn the role. Reads `businesses.telemetryEnabled` (404 when the business is missing). Changes nothing. Answers 200 `{ telemetryEnabled, canManageTenant, deploymentMode }`: `canManageTenant` is true for business_admin and higher, and `deploymentMode` comes from `DEPLOYMENT_MODE` through `runtimeDeploymentMode()` (`apps/admin/src/lib/deployment-mode.ts`).
- `PATCH /api/preferences/appearance`: Requires business_admin or higher, through `minimumRole` on `withOperatorTransaction`. Needs a boolean `telemetryEnabled` (400). Updates `businesses.telemetryEnabled`. Answers 200 `{ telemetryEnabled }`.

Related files: `apps/admin/src/lib/deployment-mode.ts`, `apps/admin/src/components/product-analytics.tsx`, `apps/admin/app/(dashboard)/settings/appearance/page.tsx`.

**`apps/admin/app/api/notification-preferences/route.ts`**

Reads and saves the signed-in operator's own alert settings for one business (email, texts, per-event switches, daily summary) on the notification settings screen (`live-notification-settings-surface.tsx`).

- `GET /api/notification-preferences`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `getNotificationPreferences` (`packages/domain/src/server/notifications.ts`). `hasVerifiedPhone` (`apps/admin/src/lib/verified-phone.ts`) checks the user's phone through the auth database role. Changes nothing. Answers 200 with `emailEnabled`, `smsEnabled`, `smsConsent`, `eventPreferences`, `dailySummaryEnabled`, `dailySummarySendTime`, `canUseSms` and `smsUnavailableReason`; texts read as off until they can be sent.
- `PUT /api/notification-preferences`: Any member, checked inside `setNotificationPreferences` (notifications.ts); the route runs `requireApiSession`. Needs `?businessId=` or `x-business-id` and boolean `emailEnabled` and `smsEnabled` (400); a daily summary needs an `HH:mm` time (400). Turning on any text first requires a verified phone and an alert SMS sender (400). Upserts the user's `operator_notification_preferences` row and, when `smsConsent` changes their consent, adds an `sms_consent_events` row. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/notifications.ts`, `apps/admin/src/lib/verified-phone.ts`, `apps/admin/src/components/live-notification-settings-surface.tsx`.

### Businesses and team

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/businesses` | The businesses you belong to | Signed in | `apps/admin/app/api/businesses/route.ts` |
| POST | `https://demo.alloplace.com/api/businesses` | Create a business (`name`, `timezone`, `businessType`; optional `slug` and `referralCode`). Onboarding's first step uses it. | Signed in | `apps/admin/app/api/businesses/route.ts` |
| PATCH | `https://demo.alloplace.com/api/businesses` | Change the business: name, time zone, type, language, website | Admin+ | `apps/admin/app/api/businesses/route.ts` |
| POST | `https://demo.alloplace.com/api/businesses/switch` | Make another business the active one | Signed in, as a member of that business | `apps/admin/app/api/businesses/switch/route.ts` |
| GET | `https://demo.alloplace.com/api/team` | Members and pending invitations | Member | `apps/admin/app/api/team/route.ts` |
| POST | `https://demo.alloplace.com/api/team` | Invite someone by email as Admin, Scheduler or Viewer (20 invitations an hour per account). Needs `businessId` (query, header or body; 500 without it). | Admin+ | `apps/admin/app/api/team/route.ts` |
| PATCH | `https://demo.alloplace.com/api/team` | Change a member's role. The last owner can't be demoted. Needs `businessId`. | Admin+ | `apps/admin/app/api/team/route.ts` |
| DELETE | `https://demo.alloplace.com/api/team` | Remove a member or revoke an invitation. The last owner can't be removed. Needs `businessId`. | Admin+ | `apps/admin/app/api/team/route.ts` |
| GET | `https://demo.alloplace.com/api/team/accept` | Preview an invitation (`?token=`) | Public | `apps/admin/app/api/team/accept/route.ts` |
| POST | `https://demo.alloplace.com/api/team/accept` | Accept an invitation (`token`) | Signed in with the invited, verified email | `apps/admin/app/api/team/accept/route.ts` |

#### Entry files

**`apps/admin/app/api/businesses/route.ts`**

Lists the user's businesses for the workspace switcher and active-business hook, creates a business at the onboarding business step, and edits the active business from team settings and onboarding.

- `GET /api/businesses`: Any signed-in user: `requireApiSession`, no business needed. Calls `listUserBusinesses` (`packages/domain/src/server/tenancy.ts`). Changes nothing. Answers 200 `{ businesses }`, each with the user's role and an `active` flag.
- `POST /api/businesses`: Any signed-in user: `requireApiSession`. Needs `name`, `timezone` and `businessType` (400); a supplied `slug` must be a nonempty string (400). `createBusiness` (tenancy.ts) answers 403 when the user already owns 10, then inserts the `businesses` row (an unknown time zone becomes UTC), an owner membership, a staff row and a receptionist profile, queues `snapshot.refresh` and makes it the active business. A `referralCode` calls `attributeBusiness` (`packages/domain/src/server/affiliates.ts`), which records the affiliate attribution. Answers 201 `{ businessId, membershipId }`.
- `PATCH /api/businesses`: Requires business_admin or higher, checked by `requireBusinessAdmin` inside `updateBusiness` (tenancy.ts); `requireOperatorBusiness` picks the business. Passes `name`, `timezone`, `businessType`, `defaultLocale` and `websiteUrl` to `updateBusinessInTransaction`, which updates `businesses`, copies a new time zone to staff and queues `snapshot.refresh`. An invalid time zone answers 400 `invalid_timezone`. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/tenancy.ts`, `packages/domain/src/server/affiliates.ts`, `apps/admin/src/components/onboarding-business-surface.tsx`, `apps/admin/src/hooks/use-active-business.ts`.

**`apps/admin/app/api/businesses/switch/route.ts`**

Switches the user's active business from the workspace switcher (`layout/workspace-switcher.tsx`); requests that name no business then default to it.

- `POST /api/businesses/switch`: Any signed-in user who is an active member of the target: `requireApiSession`, then `requireBusinessMembership` inside `switchWorkspace` (`packages/domain/src/server/tenancy.ts`), else 403. Needs `businessId` in the body (400). Sets `users.activeBusinessId`, which `requireOperatorBusiness` falls back to when a request names no business. Answers 200 `{ ok: true, businessId }`.

Related files: `packages/domain/src/server/tenancy.ts`, `apps/admin/src/components/layout/workspace-switcher.tsx`.

**`apps/admin/app/api/team/route.ts`**

Backs team settings (`live-team-surface.tsx`): lists members and invitations, invites people by email, changes roles, removes members and cancels invitations.

- `GET /api/team`: Any member: `withOperatorTransaction` with no `minimumRole`. Reads members through `app.list_business_members`, since RLS hides other users' rows, and every `business_invitations` row of the business, whatever its status. Changes nothing. Answers 200 `{ members, invitations }` with ISO `joinedAt` and `invitedAt`.
- `POST /api/team`: Requires business_admin or higher, checked by `requireBusinessAdmin` inside `inviteMember` (`packages/domain/src/server/tenancy.ts`); the route runs `requireApiSession`. Takes `businessId` from the body, `?businessId=` or `x-business-id`, and needs `email` and a `role` of business_admin, scheduler or viewer. `enforceFixedWindow` allows 20 invitations per user per hour (429; 503 when Redis is missing in production or fails). Inserts a `business_invitations` row valid for seven days and queues an `email.send` outbox event in the inviter's language. Answers 201 `{ invitationId, token }`.
- `PATCH /api/team`: Requires business_admin or higher, checked inside `updateMemberRole` (tenancy.ts). Needs `?businessId=` or `x-business-id`, `membershipId` and a `role` of business_admin, scheduler or viewer (400). Under the team lock it changes the role, refusing the last owner, and revokes the member's API keys when the new role is below business_admin. Answers 200 `{ ok: true }`.
- `DELETE /api/team`: Requires business_admin or higher, checked inside `removeMember` or `revokeInvitation` (tenancy.ts). Needs `?businessId=` or `x-business-id` and a `membershipId` or `invitationId` (400). Removing a member, never the last owner, revokes the pending invitations they sent or received and their API keys and marks the membership `removed`; otherwise the pending invitation becomes `revoked`. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/tenancy.ts`, `apps/admin/src/lib/fixed-window-limit.ts`, `apps/admin/src/components/live-team-surface.tsx`.

**`apps/admin/app/api/team/accept/route.ts`**

Backs the accept-invite page (`accept-invite-surface.tsx`): previews an invitation from its link token, then adds the signed-in user to the business or hands the business over to them.

- `GET /api/team/accept`: No session needed. Reads `?token=` and answers `{ invitation: null }` without one. Hashes it with SHA-256 and calls `previewInvitation` (`packages/domain/src/server/tenancy.ts`), which finds the business through `app.resolve_business_by_invitation`. Changes nothing. Answers 200 `{ invitation }` with `businessName`, `email`, `expired` and `status`, or null for an unknown token.
- `POST /api/team/accept`: Any signed-in user: `requireApiSession`. Hashes the body's `token` and calls `acceptInvitation` (tenancy.ts). The session email must be verified and match the invitation (403); a claim link whose sender is no longer an owner answers 409. It marks the invitation accepted and adds the membership with the invited role. A claim link instead makes the user owner, removes the sender with their invitations and API keys, turns off their webhooks and calendars and switches the active business. Answers 200 `{ businessId, role }`, plus `turnedOff` after a handover.

Related files: `packages/domain/src/server/tenancy.ts`, `apps/admin/src/components/accept-invite-surface.tsx`.

### Home and activity

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/dashboard` | Home: 30-day totals against the 30 days before, calls per month, recent calls, items that need action, upcoming appointments | Member | `apps/admin/app/api/dashboard/route.ts` |
| GET | `https://demo.alloplace.com/api/activation` | Whether the receptionist is ready: plan, number, test calls heard, website import | Member | `apps/admin/app/api/activation/route.ts` |
| GET | `https://demo.alloplace.com/api/setup` | The setup guide's steps and where each stands | Admin+ | `apps/admin/app/api/setup/route.ts` |
| PATCH | `https://demo.alloplace.com/api/setup` | Skip a setup guide step, or bring it back (`stepId`, `skipped`) | Admin+ | `apps/admin/app/api/setup/route.ts` |
| GET | `https://demo.alloplace.com/api/analytics` | Analytics for a period: `days` (default 30), or `from` and `to`, and `granularity` (`hour`, `day`, `week`, `month` or `year`) | Member | `apps/admin/app/api/analytics/route.ts` |
| GET | `https://demo.alloplace.com/api/realtime` | Live updates for the dashboard as Server-Sent Events. Needs `?businessId=` and `REDIS_URL` (503 without it). | Member | `apps/admin/app/api/realtime/route.ts` |

#### Entry files

**`apps/admin/app/api/dashboard/route.ts`**

Feeds the dashboard home (`live-overview-surface.tsx`): 30-day KPIs against the 30 days before, a 12-month call chart, recent calls, items needing action and upcoming appointments.

- `GET /api/dashboard`: Any member: `withOperatorTransaction` with no `minimumRole`. Runs `dashboardAggregatesQuery` (`packages/db/src/dashboard-aggregates.ts`) for period counts, average durations and monthly buckets, then `listRecentCalls` and `listUpcomingAppointments` (five each, `packages/domain/src/server/operatorActivity.ts`), a count of calls with status `started`, open `human_handoff` conversations and `listOpenVoiceFollowUps` (voice.ts). Changes nothing. Answers 200 `{ businessId, kpis, liveCalls, monthlyCalls, recentCalls, actionRequired, upcoming }`; `actionRequired` merges follow-ups and hand-offs, newest six.

Related files: `packages/db/src/dashboard-aggregates.ts`, `packages/domain/src/server/operatorActivity.ts`, `packages/domain/src/server/voice.ts`, `apps/admin/src/components/live-overview-surface.tsx`.

**`apps/admin/app/api/activation/route.ts`**

Feeds the dashboard activation card (`dashboard-activation-card.tsx`): what the agent learned from the website, whether the operator has heard a test call, and whether the business can answer real phone calls yet.

- `GET /api/activation`: Any member: `withOperatorTransaction` with no `minimumRole`. In that transaction it reads the business's `deploymentMode`, the `billing_accounts` plan, the limits of the plan in force (`loadBusinessPlanLimits`) and any active `phone_numbers` row with no reclaim scheduled, then calls `countOperatorTestCallsHeard` and `currentWebsiteIngestion` (`packages/domain/src/server/activation.ts`). Changes nothing. Answers 200 `{ deploymentMode, plan, numberIncluded, hasDedicatedNumber, completedWebCalls, websiteImport }`, where `numberIncluded` says whether the plan in force includes a number (a promo plan can include none, and a catalog can give Free one); `websiteImport` holds the crawl's status, URL and imported and indexed counts, or null.

Related files: `packages/domain/src/server/activation.ts`, `apps/admin/src/components/dashboard-activation-card.tsx`.

**`apps/admin/app/api/setup/route.ts`**

Feeds the setup guide card on the dashboard and the setup guide page with the steps left after onboarding, and lets an admin skip a step or bring it back.

- `GET /api/setup`: Requires business_admin or higher, through `minimumRole` on `withOperatorTransaction`. `loadSetupGuideInTransaction` (`packages/domain/src/server/activation.ts`) rates `fullScan`, `sources`, `testCall` and `phoneNumber` as `complete`, `skipped` or `needs setup` from the website crawl, uploaded documents, heard test calls, active numbers and `businesses.setupGuideSkippedSteps`. Changes nothing. Answers 200 `{ steps }`, each with `id`, an English `name` and `description`, `status`, and `documentId` for `fullScan`.
- `PATCH /api/setup`: Requires business_admin or higher, through `minimumRole` on `withOperatorTransaction`. Needs a known `stepId` and a boolean `skipped` (400). `updateSetupGuideSkippedStepsInTransaction` (activation.ts) locks the business row and adds or removes the step in `setupGuideSkippedSteps`. A missing business answers 404. Answers 200 `{ skippedSteps }`.

Related files: `packages/domain/src/server/activation.ts`, `apps/admin/src/components/live-setup-guide-surface.tsx`, `apps/admin/src/components/dashboard-setup-guide-card.tsx`.

**`apps/admin/app/api/analytics/route.ts`**

Supplies the Analytics screen (`live-analytics-surface.tsx`) with call, appointment and message totals, a time series, call outcomes, channels and agent response time, each compared with the previous period of the same length.

- `GET /api/analytics`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `getAnalytics` (`packages/domain/src/server/analytics.ts`). Reads `days` (default 30, clamped to 1 to 365), `from`, `to` and `granularity` (`hour`, `day`, `week`, `month` or `year`; default `day`). The range must be positive and at most 20, 366, 3493 or 3660 days depending on granularity; the comparison period is the same length just before `from`. Changes nothing. Answers 200 with `calls`, `appointments` and `messages` (current and previous), `averageCallDurationSeconds`, `agentResponseSeconds`, `series`, `outcomes` and `channels`.

Related files: `packages/domain/src/server/analytics.ts`, `apps/admin/src/components/live-analytics-surface.tsx`.

**`apps/admin/app/api/realtime/route.ts`**

The Server-Sent Events stream the dashboard opens per business through `subscribeRealtimeQuery` (`apps/admin/src/lib/realtime-query.ts`), so screens refetch when calls, messages, appointments, rules or knowledge change.

- `GET /api/realtime`: Any member: needs `?businessId=` (plain-text 400), then `withOperatorTransaction` checks membership. Without `REDIS_URL` it answers plain-text 503. Otherwise it returns a `text/event-stream` fed by its own ioredis subscriber on `<REDIS_PREFIX>:realtime:<businessId>`, where the worker's `realtime.publish` jobs and voice presence publish. It sends `ready` once subscribed, each event that `parseRealtimeMessage` (`apps/admin/src/lib/realtime.ts`) accepts for this business, with its `id`, type and JSON, and `ping` every 15 seconds while Redis answers. A Redis drop, failed ping or client abort closes it.

Related files: `apps/admin/src/lib/realtime.ts`, `apps/admin/src/lib/realtime-query.ts`, `apps/worker/src/handlers.ts`, `packages/contracts/src/index.ts`.

### Calls

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/calls` | List calls (`search`, `limit`, `offset`) | Member | `apps/admin/app/api/calls/route.ts` |
| GET | `https://demo.alloplace.com/api/calls/active` | How many calls are live right now | Member | `apps/admin/app/api/calls/active/route.ts` |
| GET | `https://demo.alloplace.com/api/calls/{callId}` | One call: transcript, recording state, follow-ups | Member | `apps/admin/app/api/calls/[callId]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/calls/{callId}` | Mark a call's follow-ups done (`action: complete_follow_up`; `inboxItemId` for just one) | Scheduler+ | `apps/admin/app/api/calls/[callId]/route.ts` |
| GET | `https://demo.alloplace.com/api/calls/{callId}/recording` | A short-lived link to download the recording (409 while it isn't ready, 410 once expired) | Member | `apps/admin/app/api/calls/[callId]/recording/route.ts` |

#### Entry files

**`apps/admin/app/api/calls/route.ts`**

Lists calls, newest first, with search and paging for the Calls screen (`live-calls-surface.tsx`).

- `GET /api/calls`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `listCalls` (`packages/domain/src/server/voice.ts`). Reads `limit` (default 50, clamped to 1 to 100), `offset` and `search`, which matches contact name or phone, conversation summary, disposition, provider call ID and the latest transcript line. Changes nothing. Answers 200 `{ calls, pagination }`: each call with status, transport, outcome, times, duration, contact, `recordingState` and `transcriptPreview`, and `pagination` with `limit`, `offset`, `total` and `hasNext`.

Related files: `packages/domain/src/server/voice.ts`, `apps/admin/src/components/live-calls-surface.tsx`.

**`apps/admin/app/api/calls/active/route.ts`**

Counts calls in progress for the live indicator on the Calls screen, from the voice presence entries the worker keeps in Redis.

- `GET /api/calls/active`: Any member: `withOperatorTransaction` with no `minimumRole`. Reads the business's presence set from Redis (`REDIS_URL`) with `getVoicePresenceCallIds` (`packages/jobs/src/voicePresence.ts`). For listed calls whose `calls.endedAt` is set, `removeCompletedVoicePresence` drops the entry and publishes a `call.updated` event on the business's realtime channel. Then `countActiveVoiceCalls` counts the remaining entries. Answers 200 `{ active }`.

Related files: `packages/jobs/src/voicePresence.ts`, `apps/admin/src/components/live-calls-surface.tsx`.

**`apps/admin/app/api/calls/[callId]/route.ts`**

Serves one call's detail page (`live-call-detail-surface.tsx`) and lets the team mark the call's follow-up messages and requests done.

- `GET /api/calls/{callId}`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `getCallDetail` (`packages/domain/src/server/voice.ts`). A non-UUID or unknown `callId` answers 404 `not_found`. Changes nothing. Answers 200 `{ call, contact, outcome, timeline, transcript, recording, appointments, followUpTasks }`; `recording` gives its state and, when present, the storage object ID, content type and retention date.
- `PATCH /api/calls/{callId}`: Requires scheduler or higher, checked inside `completeVoiceFollowUpTasks` (voice.ts). Needs `action` set to `complete_follow_up` (400); an `inboxItemId` must be a UUID (400 `invalid_request`); a non-UUID `callId` answers 404 `not_found`. Without `inboxItemId` it sets every open `voice_message` item of the call in `inbox_items` to `done`; with one, only that request, or all the call's open plain messages when it names a message. Answers 200 `{ completed }`, the number closed (0 for an unknown item).

Related files: `packages/domain/src/server/voice.ts`, `apps/admin/src/components/live-call-detail-surface.tsx`.

**`apps/admin/app/api/calls/[callId]/recording/route.ts`**

Gives the Calls list and the call detail page a short-lived link for playing a call recording.

- `GET /api/calls/{callId}/recording`: Any member: `requireOperatorBusiness`, then membership checks inside `getCallDetail` (`packages/domain/src/server/voice.ts`) and `createObjectDownload` (`packages/domain/src/server/storage.ts`). A non-UUID or unknown call answers 404 `not_found`. A recording that is not available answers 410 `recording_expired` when expired, else 409 `recording_<state>`. Otherwise the storage backend from `getStorageProvider()` (`apps/admin/src/lib/storage.ts`) signs a download URL valid for 300 seconds. Changes nothing. Answers 200 `{ url, fileName, contentType, length }`.

Related files: `packages/domain/src/server/voice.ts`, `packages/domain/src/server/storage.ts`, `apps/admin/src/lib/storage.ts`.

### Messages

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/messages` | Conversations, newest first, one row each (`search`, `channel` = `sms` or `web_chat`, `limit`, `offset`), or one whole conversation with `?conversationId=` | Member | `apps/admin/app/api/messages/route.ts` |
| POST | `https://demo.alloplace.com/api/messages` | Send a reply in a conversation (`channel` `sms`, `web_chat`, or `dashboard` by default). Needs `businessId`. | Scheduler+ | `apps/admin/app/api/messages/route.ts` |
| PATCH | `https://demo.alloplace.com/api/messages` | Take a conversation over from the AI, or give it back (`automationState` = `human_handoff` or `ai_active`). Needs `businessId`. | Scheduler+ | `apps/admin/app/api/messages/route.ts` |

#### Entry files

**`apps/admin/app/api/messages/route.ts`**

Backs the Messages screen (`live-messages-surface.tsx`): the conversation list and threads for texts and website chats, team replies, and handing a conversation between the AI and the team.

- `GET /api/messages`: Any member: `withOperatorTransaction` with no `minimumRole`; a non-UUID `conversationId` answers 400. With one, returns that thread's newest 500 messages oldest first, failed texts with a `failureReason`, plus `newerConversationId` (`findNewerWidgetChatInTransaction`) for a closed website chat and `smsReplyHold` (`loadSmsReachInTransaction`, `packages/domain/src/server/sms.ts`) for other channels. Without one, returns each conversation's latest message, newest first, filtered by `channel` (`web_chat` or `sms`) and `search`, paged by `limit` (1 to 100) and `offset`, as `{ messages, hasNext }`. Changes nothing.
- `POST /api/messages`: Requires scheduler or higher, checked inside `appendMessage` (`packages/domain/src/server/conversations.ts`). Needs `?businessId=` or `x-business-id`, `conversationId` and `body` (400) before `requireApiSession` runs. The domain refuses an unknown conversation (404 `not_found`), a closed website chat (409 `chat_closed`) or a text that cannot reach the contact (409 `sms_<reason>`), saves a queued outbound `messages` row and queues `realtime.publish`, plus `sms.send` when `channel` is `sms`. A `web_chat` reply takes the chat over from the AI. `channel` defaults to `dashboard`. Answers 201 `{ messageId }`.
- `PATCH /api/messages`: Requires scheduler or higher, checked inside `setAutomationState` (conversations.ts). Needs `?businessId=` or `x-business-id`, `conversationId` and an `automationState` of `ai_active` or `human_handoff` (400) before `requireApiSession` runs. Taking over a closed website chat answers 409 `chat_closed`. Otherwise it updates the conversation's automation fields, clears `teamRequestedAt` and queues `realtime.publish`. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/conversations.ts`, `packages/domain/src/server/sms.ts`, `apps/admin/src/components/live-messages-surface.tsx`.

### Contacts

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/contacts` | List contacts (`search`, `limit`, `offset`) | Member | `apps/admin/app/api/contacts/route.ts` |
| GET | `https://demo.alloplace.com/api/contacts/{contactId}` | One contact and their history | Member | `apps/admin/app/api/contacts/[contactId]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/contacts/{contactId}` | Block or unblock texts to the contact (`smsBlocked`) | Admin+ | `apps/admin/app/api/contacts/[contactId]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/contacts/{contactId}` | Delete the contact | Admin+ | `apps/admin/app/api/contacts/[contactId]/route.ts` |
| PUT | `https://demo.alloplace.com/api/contacts/{contactId}/passcode` | Set the contact's keypad PIN for appointment changes (4 to 8 digits; easy guesses refused) | Admin+ | `apps/admin/app/api/contacts/[contactId]/passcode/route.ts` |
| DELETE | `https://demo.alloplace.com/api/contacts/{contactId}/passcode` | Remove the keypad PIN | Admin+ | `apps/admin/app/api/contacts/[contactId]/passcode/route.ts` |

#### Entry files

**`apps/admin/app/api/contacts/route.ts`**

Lists contacts with activity counts and channels for the Contacts screen (`live-contacts-surface.tsx`), with search and paging.

- `GET /api/contacts`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `listContacts` (`packages/domain/src/server/contacts.ts`). Reads `search` (name, phone or email), `limit` (default 50, clamped to 1 to 100) and `offset`. Orders by latest interaction across calls, messages and past appointments. Changes nothing. Answers 200 `{ contacts, pagination }`: each contact with SMS consent and block fields, `callCount`, `messageCount`, `appointmentCount` and `channels`.

Related files: `packages/domain/src/server/contacts.ts`, `apps/admin/src/components/live-contacts-surface.tsx`.

**`apps/admin/app/api/contacts/[contactId]/route.ts`**

Backs the contact detail page and the Contacts list actions: reads one contact's history, blocks or unblocks texts to the contact, and deletes a contact that has no history.

- `GET /api/contacts/{contactId}`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `getContactDetail` (`packages/domain/src/server/contacts.ts`). Changes nothing. Answers 200 `{ contact, channels, passcode, calls, messages, appointments, activityCounts }` with the latest 25 calls, 50 messages and 25 appointments; `passcode` only says whether a PIN is set and locked.
- `PATCH /api/contacts/{contactId}`: Requires business_admin or higher, checked inside `setContactSmsManualBlock` (`packages/domain/src/server/sms.ts`). Needs a boolean `smsBlocked` (400). Sets or clears `contacts.operatorBlockedAt` and, for a contact with a phone, adds a `manual_blocked` or `manual_unblocked` row to `sms_consent_events`. An unknown contact answers 404. Answers 200 `{ contactId, smsBlocked }`.
- `DELETE /api/contacts/{contactId}`: Requires business_admin or higher, checked inside `deleteContact` (contacts.ts). Answers 409 when calls, conversations (including chats of linked widget visitors) or appointments reference the contact; otherwise deletes the `contacts` row and queues `realtime.publish`. An unknown contact answers 404. Answers 200 `{ ok: true, behavior }` with `deleted`.

Related files: `packages/domain/src/server/contacts.ts`, `packages/domain/src/server/sms.ts`, `apps/admin/src/components/live-contact-detail-surface.tsx`, `apps/admin/src/components/live-contacts-surface.tsx`.

**`apps/admin/app/api/contacts/[contactId]/passcode/route.ts`**

Sets or removes a contact's keypad PIN, which callers enter to verify appointment changes, from the contact detail page (`contact-passcode-section.tsx`).

- `PUT /api/contacts/{contactId}/passcode`: Requires business_admin or higher, checked inside `setContactPasscode` (`packages/domain/src/server/contactPasscodes.ts`). `passcode` must be 4 to 8 digits (400 `invalid_passcode`) and not guessable (400 `guessable_passcode`). Upserts a hash in `contact_passcodes`, which also clears a lock, and writes a `contact.passcode_set` row to `audit_logs`. An unknown contact answers 404. Answers 200 `{ contactId, passcode }` with `setAt` and `locked: false`, never the PIN.
- `DELETE /api/contacts/{contactId}/passcode`: Requires business_admin or higher, checked inside `removeContactPasscode` (contactPasscodes.ts). Deletes the `contact_passcodes` row and, when one existed, writes a `contact.passcode_removed` audit log. An unknown contact answers 404. Answers 200 `{ contactId, passcode: null }`.

Related files: `packages/domain/src/server/contactPasscodes.ts`, `apps/admin/src/components/contact-passcode-section.tsx`.

### Appointments

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/appointments` | Current appointments | Member | `apps/admin/app/api/appointments/route.ts` |
| POST | `https://demo.alloplace.com/api/appointments/{appointmentId}/cancel` | Cancel an appointment (409 when already cancelled) | Scheduler+ | `apps/admin/app/api/appointments/[appointmentId]/cancel/route.ts` |

#### Entry files

**`apps/admin/app/api/appointments/route.ts`**

Lists the appointments that have not ended and are not cancelled for the Appointments screen (`live-appointments-surface.tsx`).

- `GET /api/appointments`: Any member: `withOperatorTransaction` with no `minimumRole`. Calls `listCurrentAppointments` (`packages/domain/src/server/operatorActivity.ts`) with the current time: up to 100 appointments whose end is still ahead and whose status is not `canceled`, earliest start first, joined with contact, service and staff names. Changes nothing. Answers 200 `{ appointments }`, each with start, end, time zone, status, source channel and calendar sync state.

Related files: `packages/domain/src/server/operatorActivity.ts`, `apps/admin/src/components/live-appointments-surface.tsx`.

**`apps/admin/app/api/appointments/[appointmentId]/cancel/route.ts`**

Lets an operator cancel one appointment from the Appointments screen or the dashboard home (`cancel-appointment-button.tsx`).

- `POST /api/appointments/{appointmentId}/cancel`: Requires scheduler or higher, checked by `requireBusinessMembership` inside `cancelAppointment` (`packages/domain/src/server/booking.ts`); `requireOperatorBusiness` picks the business. A non-UUID `appointmentId` answers 400 `invalid_request`. The domain closes open caller cancellation requests in `inbox_items`, sets the appointment `canceled`, writes `audit_logs`, skips pending reminders, queues a cancellation text for a future appointment (`notification.dispatch`), `calendar.syncAppointment` and `realtime.publish`, and emits the `appointment.cancelled` webhook event. Unknown answers 404 `not_found`; already cancelled answers 409 `already_cancelled`. Answers 200 `{ appointmentId, status }` with `canceled`.

Related files: `packages/domain/src/server/booking.ts`, `apps/admin/src/components/cancel-appointment-button.tsx`.

### Receptionist: AI settings, hours, services, rules

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/agent` | The receptionist's settings, with the business's name, time zone and language | Member | `apps/admin/app/api/agent/route.ts` |
| PATCH | `https://demo.alloplace.com/api/agent` | Save AI settings, including the business's language and time zone | Admin+ | `apps/admin/app/api/agent/route.ts` |
| GET | `https://demo.alloplace.com/api/hours` | Weekly opening hours, who set them (nobody, AI or a person) and the booking mode | Member | `apps/admin/app/api/hours/route.ts` |
| PUT | `https://demo.alloplace.com/api/hours` | Replace the opening hours (up to 28 windows). Saved hours are never replaced by AI. | Admin+ | `apps/admin/app/api/hours/route.ts` |
| GET | `https://demo.alloplace.com/api/catalog` | Services (`search`, `limit`, `offset`) | Member | `apps/admin/app/api/catalog/route.ts` |
| POST | `https://demo.alloplace.com/api/catalog` | Add a service (`name`, `durationMinutes`; optional `slug`, `description`, `active`). Needs `businessId` (query, header or body; 500 without it). | Admin+ | `apps/admin/app/api/catalog/route.ts` |
| PATCH | `https://demo.alloplace.com/api/catalog/{serviceId}` | Change a service, or assign or unassign a staff member (`staffId`, `assigned`) | Admin+ | `apps/admin/app/api/catalog/[serviceId]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/catalog/{serviceId}` | Delete a service | Admin+ | `apps/admin/app/api/catalog/[serviceId]/route.ts` |
| GET | `https://demo.alloplace.com/api/rules` | Rules | Member | `apps/admin/app/api/rules/route.ts` |
| POST | `https://demo.alloplace.com/api/rules` | Add a rule (`title`, `content`, `active`) | Admin+ | `apps/admin/app/api/rules/route.ts` |
| PATCH | `https://demo.alloplace.com/api/rules` | Change a rule (`ruleId`), or put them in order (`ruleIds`) | Admin+ | `apps/admin/app/api/rules/route.ts` |
| DELETE | `https://demo.alloplace.com/api/rules` | Delete a rule (`ruleId`) | Admin+ | `apps/admin/app/api/rules/route.ts` |

#### Entry files

**`apps/admin/app/api/agent/route.ts`**

Reads and saves the receptionist's basic settings (greeting, tone, summary, instructions, transfer, booking mode, language and time zone) for the AI basic settings screen and the onboarding greeting step.

- `GET /api/agent`: Any member: `withOperatorTransaction` with no `minimumRole`. Reads the business's `id`, `name`, `timezone` and `defaultLocale` and its `receptionist_profiles` row. Changes nothing. Answers 200 `{ business, profile }`, each null when missing.
- `PATCH /api/agent`: Requires business_admin or higher, through `minimumRole` on `withOperatorTransaction`. `readReceptionistSettingsChange` (`packages/domain/src/server/receptionistProfile.ts`) checks the body and answers 400 naming the first bad field. A missing business answers 404. A `locale` or `timezone` goes to `updateBusinessInTransaction` (tenancy.ts), which updates `businesses` and staff time zones and queues `snapshot.refresh` (400 `invalid_timezone`). `saveReceptionistProfileInTransaction` upserts the profile and queues `snapshot.refresh`, plus `business.generateSummary` when `regenerateSummary` is true. Answers 200 `{ profile }`.

Related files: `packages/domain/src/server/receptionistProfile.ts`, `packages/domain/src/server/tenancy.ts`, `apps/admin/src/components/live-agent-basic-settings-surface.tsx`.

**`apps/admin/app/api/hours/route.ts`**

Reads and replaces the weekly opening hours edited in the AI basic settings and the setup guide (`business-hours-section.tsx`).

- `GET /api/hours`: Any member: `withOperatorTransaction` with no `minimumRole`. Reads the business's `timezone` and `hoursSource`, its `business_hours` rows and the receptionist's booking mode. A missing business answers 404. Changes nothing. Answers 200 `{ timezone, hoursSource, bookingMode, hours }`.
- `PUT /api/hours`: Requires business_admin or higher, through `minimumRole` on `withOperatorTransaction`. `hours` must be a list of at most 28 windows with numeric `dayOfWeek`, `openMinutes` and `closeMinutes` (400). `replaceBusinessHoursInTransaction` (`packages/domain/src/server/catalog.ts`) checks them with `normalizeHoursWindows`, sets `businesses.hoursSource` to `operator` so AI never replaces them, rewrites the `business_hours` rows and queues `snapshot.refresh`. Any error it throws answers 400 with its message. Answers 200 with the reloaded hours.

Related files: `packages/domain/src/server/catalog.ts`, `packages/domain/src/server/businessHours.ts`, `packages/domain/src/hours.ts`, `apps/admin/src/components/business-hours-section.tsx`.

**`apps/admin/app/api/catalog/route.ts`**

Loads the Services screen (`live-services-surface.tsx`) with services and their staff plus hours, closures, numbers, profile and rules, and adds a new service.

- `GET /api/catalog`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `listCatalog` (`packages/domain/src/server/catalog.ts`). Reads `search` (service name), `limit` (default and maximum 100) and `offset`. Changes nothing. Answers 200 `{ staff, services, servicesPagination, hours, closures, phoneNumbers, receptionistProfile, rules }`; deleted services are left out and each service lists `assignedStaffIds`.
- `POST /api/catalog`: Requires business_admin or higher, checked by `requireBusinessAdmin` inside `createService` (catalog.ts); the route itself runs only `requireApiSession`. Takes `businessId` from the body, `?businessId=` or `x-business-id`, never the active business. Checks `name` (up to 160 characters), `slug` (made from the name when absent), `durationMinutes` (1 to 1440), `active` and `description`. Inserts a `services` row and queues `snapshot.refresh`. Answers 201 `{ serviceId }`.

Related files: `packages/domain/src/server/catalog.ts`, `apps/admin/src/components/live-services-surface.tsx`.

**`apps/admin/app/api/catalog/[serviceId]/route.ts`**

Edits, deactivates, deletes and assigns staff to one service from the Services screen (`live-services-surface.tsx`).

- `PATCH /api/catalog/{serviceId}`: Requires business_admin or higher, checked by `requireBusinessAdmin` in each domain call (`packages/domain/src/server/catalog.ts`); `requireOperatorBusiness` picks the business. With `staffId` and `assigned`, calls `assignStaffToService` (404 for a missing service) or `unassignStaffFromService`, which add or delete a `staff_service_assignments` row. Otherwise `updateService` changes `name`, `slug`, `durationMinutes`, `description` or `active` (404 for a missing or deleted service). Each queues `snapshot.refresh`. Answers 200 `{ ok: true }`.
- `DELETE /api/catalog/{serviceId}`: Requires business_admin or higher, checked inside `deleteService` (catalog.ts). Marks the service inactive and deleted (appointments keep referencing it), deletes its staff assignments and queues `snapshot.refresh`. An unknown or already deleted service answers 404. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/catalog.ts`, `apps/admin/src/components/live-services-surface.tsx`.

**`apps/admin/app/api/rules/route.ts`**

Lists, adds, edits, reorders and deletes the receptionist's custom rules on the AI rules screen (`rules-surface.tsx`); calls read the rules from the business snapshot.

- `GET /api/rules`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `listAgentRules` (`packages/domain/src/server/rules.ts`). Changes nothing. Answers 200 with a bare array of `agent_rules` rows in their sort order.
- `POST /api/rules`: Requires business_admin or higher, checked inside `createAgentRule` (rules.ts). A zod schema checks `title`, `content` and optional `active` before `requireOperatorBusiness` runs. Inserts the rule after the others under an advisory lock and queues `snapshot.refresh` and `realtime.publish`. Answers 201 with the new rule's ID as a bare JSON string.
- `PATCH /api/rules`: Requires business_admin or higher, checked inside the domain call (rules.ts). A body with `ruleIds` calls `reorderAgentRules`, which renumbers `sortOrder` in that order; any other body calls `updateAgentRule` for `ruleId` with `title`, `content` or `active`. Both queue `snapshot.refresh` and `realtime.publish`. Answers 200 `{ ok: true }`.
- `DELETE /api/rules`: Requires business_admin or higher, checked inside `deleteAgentRule` (rules.ts). Reads `ruleId` from the JSON body, checked before the session, deletes the row and queues `snapshot.refresh` and `realtime.publish`. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/rules.ts`, `apps/admin/src/components/rules-surface.tsx`.

### Knowledge

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/knowledge` | Knowledge documents and website imports | Member | `apps/admin/app/api/knowledge/route.ts` |
| POST | `https://demo.alloplace.com/api/knowledge` | Add a knowledge source (`businessId`, `title`, `sourceType`; `sourceUrl` for a website). Needs `businessId` in the body. | Admin+ | `apps/admin/app/api/knowledge/route.ts` |
| GET | `https://demo.alloplace.com/api/knowledge/{documentId}` | A document's text | Member | `apps/admin/app/api/knowledge/[documentId]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/knowledge/{documentId}` | Turn a document on or off (`active`), or `action` = `retry`, `cancel` or `expand` (read the rest of a website) | Admin+ | `apps/admin/app/api/knowledge/[documentId]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/knowledge/{documentId}` | Delete a document | Admin+ | `apps/admin/app/api/knowledge/[documentId]/route.ts` |
| GET | `https://demo.alloplace.com/api/knowledge/embedding-status` | How many knowledge chunks are indexed, waiting or failed | Member | `apps/admin/app/api/knowledge/embedding-status/route.ts` |
| GET | `https://demo.alloplace.com/api/knowledge/snippets` | Snippets: short written answers | Member | `apps/admin/app/api/knowledge/snippets/route.ts` |
| POST | `https://demo.alloplace.com/api/knowledge/snippets` | Add a snippet (`title`, `content`; optional `tags`, `priority`, `active`). Needs `businessId`. | Admin+ | `apps/admin/app/api/knowledge/snippets/route.ts` |
| PATCH | `https://demo.alloplace.com/api/knowledge/snippets/{snippetId}` | Change a snippet | Admin+ | `apps/admin/app/api/knowledge/snippets/[snippetId]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/knowledge/snippets/{snippetId}` | Delete a snippet | Admin+ | `apps/admin/app/api/knowledge/snippets/[snippetId]/route.ts` |

#### Entry files

**`apps/admin/app/api/knowledge/route.ts`**

Lists knowledge sources for the Knowledge screen, onboarding and the setup guide, and adds a website as a source from the onboarding website step and the Knowledge screen.

- `GET /api/knowledge`: Any member: `withOperatorTransaction` with no `minimumRole`. Selects the business's `knowledge_documents` sorted by title, each with `websiteImport` (its `website_ingestion_jobs` row as JSON) and `textContent` (the first 500 characters of its first chunk). Changes nothing. Answers 200 `{ documents }`.
- `POST /api/knowledge`: Requires business_admin or higher, checked by `requireBusinessAdmin` inside `createKnowledgeDocument` (`packages/domain/src/server/knowledge.ts`); the route runs `requireApiSession`. Needs `businessId`, `title` and `sourceType` in the body (400). For a website it normalizes `sourceUrl` (422 `website_url_invalid`), saves it as the business website and advances the onboarding stage during onboarding, reuses an existing source with that URL (re-queuing a failed or cancelled one), or inserts `knowledge_documents` and `website_ingestion_jobs` rows and queues `knowledge.crawlWebsite`. Answers 201 `{ documentId }`.

Related files: `packages/domain/src/server/knowledge.ts`, `packages/domain/src/server/knowledgeUrl.ts`, `apps/admin/src/components/live-knowledge-surface.tsx`, `apps/admin/src/components/onboarding-website-surface.tsx`.

**`apps/admin/app/api/knowledge/[documentId]/route.ts`**

Acts on one knowledge source from the Knowledge screen and the setup guide: shows its extracted text, turns it on or off, retries, cancels or expands its crawl, or deletes it.

- `GET /api/knowledge/{documentId}`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `getKnowledgeDocumentContent` (`packages/domain/src/server/knowledge.ts`). An unknown document answers 404. Changes nothing. Answers 200 `{ document, content }`, the content being its chunks joined in order.
- `PATCH /api/knowledge/{documentId}`: Requires business_admin or higher, checked by `requireBusinessAdmin` in each domain call (knowledge.ts). A boolean `active` calls `setKnowledgeDocumentActive` (404), which queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours`. `action` `retry` calls `retryKnowledgeDocument`, which resets the document and queues `knowledge.crawlWebsite` or `knowledge.extractDocument`; `cancel` calls `cancelKnowledgeDocument` (409 unless processing); `expand` calls `expandWebsiteCrawl`, re-crawling a website at the full page limit (404, or 400 for a non-website). Anything else answers 400. Answers 200 `{ ok: true }`.
- `DELETE /api/knowledge/{documentId}`: Requires business_admin or higher, checked inside `deleteKnowledgeDocument` (knowledge.ts). Deletes the document's `knowledge_chunks` and its `knowledge_documents` row, then queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours`. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/knowledge.ts`, `packages/domain/src/server/businessHours.ts`, `apps/admin/src/components/live-knowledge-surface.tsx`.

**`apps/admin/app/api/knowledge/embedding-status/route.ts`**

Reports how many of the business's knowledge chunks carry embeddings from the embedding provider configured now. No client code in the repository calls it.

- `GET /api/knowledge/embedding-status`: Any member: `withOperatorTransaction` with no `minimumRole`. Takes the `fingerprint` of `createEmbeddingProvider()` (`packages/providers/src/ai/embeddingProvider.ts`), null when no provider is configured, and counts the business's `knowledge_chunks`: all, completed with that fingerprint, failed, and without a fingerprint. Changes nothing. Answers 200 `{ fingerprint, total, matching, completed, pending, failed, missing }`; `completed` repeats `matching`, and `pending` is what remains after matching and failed.

Related files: `packages/providers/src/ai/embeddingProvider.ts`.

**`apps/admin/app/api/knowledge/snippets/route.ts`**

Lists and adds text snippets, short knowledge entries the operator writes or pastes, for the Knowledge screen and the onboarding knowledge step.

- `GET /api/knowledge/snippets`: Any member: `requireOperatorBusiness`, then `requireBusinessMembership` inside `listKnowledgeSnippets` (`packages/domain/src/server/knowledge.ts`). Changes nothing. Answers 200 `{ snippets }`, highest priority first, then by title.
- `POST /api/knowledge/snippets`: Requires business_admin or higher, checked by `requireBusinessAdmin` inside `createKnowledgeSnippet` (knowledge.ts); the route runs `requireApiSession`. Takes `businessId` only from `?businessId=` or `x-business-id`, and needs a nonblank `title` and `content` (400); `tags`, `priority` and `active` are optional. Inserts a `knowledge_snippets` row and queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours`. Answers 201 `{ snippetId }`.

Related files: `packages/domain/src/server/knowledge.ts`, `apps/admin/src/components/live-knowledge-surface.tsx`, `apps/admin/src/components/onboarding-knowledge-surface.tsx`.

**`apps/admin/app/api/knowledge/snippets/[snippetId]/route.ts`**

Edits or deletes one knowledge snippet from the Knowledge screen (`live-knowledge-surface.tsx`).

- `PATCH /api/knowledge/snippets/{snippetId}`: Requires business_admin or higher, checked inside `updateKnowledgeSnippet` (`packages/domain/src/server/knowledge.ts`); `requireOperatorBusiness` picks the business. Passes the body's `title`, `content`, `tags`, `priority` and `active` without type checks. Updates the `knowledge_snippets` row and queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours`. Answers 200 `{ ok: true }`.
- `DELETE /api/knowledge/snippets/{snippetId}`: Requires business_admin or higher, checked inside `deleteKnowledgeSnippet` (knowledge.ts). Deletes the row and queues the same three outbox events. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/knowledge.ts`, `apps/admin/src/components/live-knowledge-surface.tsx`.

### Uploads and file storage

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| POST | `https://demo.alloplace.com/api/uploads` | Start a knowledge file upload (10 MB at most, with a SHA-256 checksum); answers with where to send the file | Admin+ | `apps/admin/app/api/uploads/route.ts` |
| PUT | `https://demo.alloplace.com/api/uploads` | Finish the upload, which starts reading the file | Admin+ | `apps/admin/app/api/uploads/route.ts` |
| GET | `https://demo.alloplace.com/api/uploads` | A download link for a stored file (`businessId`, `objectId`, optional `range`) | Member | `apps/admin/app/api/uploads/route.ts` |
| PUT | `https://demo.alloplace.com/api/storage/local` | Receive an uploaded file. Only with the local storage backend; the signed `?token=` from `POST /api/uploads` is the permission. | Signed token | `apps/admin/app/api/storage/local/route.ts` |
| GET | `https://demo.alloplace.com/api/storage/local` | Serve a stored file. Only with the local storage backend; signed `?token=`. | Signed token | `apps/admin/app/api/storage/local/route.ts` |

#### Entry files

**`apps/admin/app/api/uploads/route.ts`**

The dashboard's three-step knowledge document upload (`storage-upload.ts`): POST reserves an object and returns a signed upload URL, the browser sends the bytes there, and PUT finalizes it so indexing starts. GET returns a short-lived download URL.

- `GET /api/uploads`: `requireApiSession`; `businessId`, `objectId` and an optional `range` are parsed with `uploadDownloadRequestSchema`. `createObjectDownload` (`packages/domain/src/server/storage.ts`) requires membership in any role and a ready `storage_objects` row still within retention, then asks the storage provider for a five-minute download URL (S3 presigned, or `/api/storage/local`). Answers 200 `{ url, fileName, contentType, length }`, plus `headers` when a range was asked for. No dashboard component in this commit calls this GET.
- `POST /api/uploads`: `requireApiSession`; the body must pass `uploadCreateRequestSchema` (purpose `knowledge` only, an allowed content type, a SHA-256 `checksum`). `createUpload` (`packages/domain/src/server/storage.ts`) checks business_admin, enforces the 10 MB document cap (`planUpload`), inserts a pending `storage_objects` row that expires after 24 hours, and gets an upload URL and headers from the storage provider. Answers 201 `{ objectId, key, url, headers }`.
- `PUT /api/uploads`: `requireApiSession`; the body must pass `uploadFinalizeRequestSchema`. `finalizeUpload` (`packages/domain/src/server/storage.ts`) needs membership and a pending row, reads the stored object's metadata (`headObject`), and requires its length, type and checksum to match the request and the reservation. Then, as business_admin, `completeUploadInTransaction` refuses a plan whose knowledge storage is full, marks the row ready, inserts a pending `knowledge_documents` row and enqueues `knowledge.extractDocument`. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/storage.ts`, `apps/admin/src/lib/storage-upload.ts`, `packages/contracts/src/index.ts`, `apps/admin/src/lib/storage.ts`.

**`apps/admin/app/api/storage/local/route.ts`**

The byte endpoint of the local-disk storage backend (`LocalStorageProvider`, the default without S3 settings). Browsers and API clients upload to it, and file downloads (knowledge files, call recordings) read from it, through short-lived signed URLs.

- `PUT /api/storage/local`: No cookie: the `token` query parameter is the authorization, an HMAC-signed upload token from `LocalStorageProvider.createUpload` (15 minutes; `LOCAL_STORAGE_SIGNING_SECRET` or `INTERNAL_SERVICE_SECRET`), and the proxy exempts this path from its CSRF check. A missing, invalid or expired token answers 403. `Content-Type` must equal the signed type and `x-lobbystack-checksum-sha256` the signed checksum (400). `putObjectStream` streams the body to a temporary file, enforcing the signed length and SHA-256 (400), then moves the object and its metadata file into place. Answers 204.
- `GET /api/storage/local`: Authorized by a signed download token from `createDownloadUrl` (403 when missing, invalid or expired). It reads the object's metadata (404 when absent) and streams the file, applying the token's signed `range`, else the request's `Range` header (416 for a bad range). Answers 200, or 206 with `content-range`, with `accept-ranges: bytes`, `private, no-store`, and the stored content type and length. Both methods answer 500 when local storage isn't the configured backend.

Related files: `packages/providers/src/storage/local.ts`, `packages/providers/src/storage/provider.ts`, `apps/admin/src/lib/storage-upload.ts`, `apps/admin/proxy.ts`.

### Phone numbers

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/phone-numbers` | Active numbers, any claim in progress, and the business's one replacement | Member | `apps/admin/app/api/phone-numbers/route.ts` |
| DELETE | `https://demo.alloplace.com/api/phone-numbers` | Release a number (`phoneNumberId`); the release is scheduled. Needs `businessId`. | Admin+ | `apps/admin/app/api/phone-numbers/route.ts` |
| POST | `https://demo.alloplace.com/api/phone-numbers/replacement/search` | Find numbers for the replacement (`selection`, `limit`) | Admin+ | `apps/admin/app/api/phone-numbers/replacement/search/route.ts` |
| POST | `https://demo.alloplace.com/api/phone-numbers/replacement/claim` | Claim the replacement number (`claimToken`; answers 202). Needs `businessId`. | Admin+ | `apps/admin/app/api/phone-numbers/replacement/claim/route.ts` |
| GET | `https://demo.alloplace.com/api/phone-numbers/replacement/claim/{claimId}` | Where a replacement claim stands | Admin+ | `apps/admin/app/api/phone-numbers/replacement/claim/[claimId]/route.ts` |

#### Entry files

**`apps/admin/app/api/phone-numbers/route.ts`**

Lists the business's active phone numbers and open number claims for the phone number settings page and the onboarding number step. DELETE schedules a number's release.

- `GET /api/phone-numbers`: Any member: `withOperatorTransaction` without `minimumRole`. It reads the business's replacement reserved and used times, the caller's own reserved or provisioning claims in `onboarding_number_claim_events`, and every column of the business's active `phone_numbers` rows, oldest first. Answers 200 `{ phoneNumbers, activeClaim, replacement: { reservedAt, usedAt, activeClaim } }`; the screens poll it every second while a claim is open.
- `DELETE /api/phone-numbers`: `requireApiSession`; `businessId` from the query or `x-business-id` and a body `phoneNumberId` are required (400). `schedulePhoneNumberRelease` (`packages/domain/src/server/compliance.ts`) checks business_admin, takes the number-claim lock, expires abandoned claims, refuses a number whose replacement is still being bought (409), sets `reclaim_scheduled_at` to now and enqueues `phoneNumber.reclaim`; the worker then releases the number at Twilio. Answers 200 `{ status: "scheduled" }`.

Related files: `packages/domain/src/server/compliance.ts`, `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/components/live-phone-number-settings-surface.tsx`, `apps/worker/src/handlers.ts`.

**`apps/admin/app/api/phone-numbers/replacement/search/route.ts`**

Searches Twilio for a replacement number from the settings page's number chooser, which also calls it with only a limit for its first suggestions.

- `POST /api/phone-numbers/replacement/search`: `requireOperatorBusiness` and `readJson` with optional `selection` and `limit`. `assertPhoneNumberSearchAllowed` allows 20 searches per user per 10 minutes (429 or 503). `searchBusinessNumberInventory` (`packages/domain/src/server/phoneNumbers.ts`) runs with purpose `replacement`: business_admin, then 409 when the replacement was already used, no active number remains, or a cloud business has no paid plan, and 400 for an unsupported country. It lists numbers from Twilio and signs a five-minute replacement `claimToken` for each. Answers 200 `{ market, numbers }`.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/lib/phone-number-search-limit.ts`, `apps/admin/src/components/phone-number-chooser.tsx`.

**`apps/admin/app/api/phone-numbers/replacement/claim/route.ts`**

Claims a replacement for the business's number from the chooser on the phone number settings page. A business may replace its number once; the old number is released 30 days after the new one is live.

- `POST /api/phone-numbers/replacement/claim`: `requireApiSession`; `businessId` from the query or `x-business-id` and a body `claimToken` are required (400). `reserveReplacementNumberClaim` (`packages/domain/src/server/phoneNumbers.ts`) verifies the signed offer (400 `number_offer_invalid` or `number_offer_expired`) and that it is a replacement offer for this business and user (400 `number_offer_mismatch`), checks business_admin, reserves through `app.reserve_replacement_number_claim` (refusals map to 400, 409 or 429 codes) and enqueues `phoneNumber.provision` for the worker to buy the number. Answers 202 `{ claimId }`.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/components/phone-number-chooser.tsx`, `apps/worker/src/handlers.ts`.

**`apps/admin/app/api/phone-numbers/replacement/claim/[claimId]/route.ts`**

The settings page's number chooser polls this after claiming a replacement number, until the purchase finishes or fails.

- `GET /api/phone-numbers/replacement/claim/{claimId}`: `requireOperatorBusiness`, then `getOnboardingNumberClaim` (`packages/domain/src/server/phoneNumbers.ts`), which checks business_admin and reads the caller's own claim for the business. A claim whose purpose isn't `replacement` answers 404. Answers 200 `{ claim }`, or `{ claim: null }` when there is none.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/components/phone-number-chooser.tsx`.

### Onboarding

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| POST | `https://demo.alloplace.com/api/onboarding/stage` | Move to a later onboarding step (`to`) | Admin+ | `apps/admin/app/api/onboarding/stage/route.ts` |
| GET | `https://demo.alloplace.com/api/onboarding/phone-numbers/suggestion` | Ten suggested numbers | Admin+ | `apps/admin/app/api/onboarding/phone-numbers/suggestion/route.ts` |
| POST | `https://demo.alloplace.com/api/onboarding/phone-numbers/search` | Search for numbers (`selection`, `limit`) | Admin+ | `apps/admin/app/api/onboarding/phone-numbers/search/route.ts` |
| POST | `https://demo.alloplace.com/api/onboarding/phone-numbers/claim` | Claim a number (`claimToken`; answers 202). Needs `businessId`. | Admin+ | `apps/admin/app/api/onboarding/phone-numbers/claim/route.ts` |
| GET | `https://demo.alloplace.com/api/onboarding/phone-numbers/claim/{claimId}` | Where a claim stands | Admin+ | `apps/admin/app/api/onboarding/phone-numbers/claim/[claimId]/route.ts` |
| POST | `https://demo.alloplace.com/api/onboarding/phone-numbers/skip` | Skip the number step | Admin+ | `apps/admin/app/api/onboarding/phone-numbers/skip/route.ts` |
| POST | `https://demo.alloplace.com/api/onboarding/attribution` | Say how you heard about the app (`source`, `referralCode`); finishes onboarding | Admin+ | `apps/admin/app/api/onboarding/attribution/route.ts` |

#### Entry files

**`apps/admin/app/api/onboarding/stage/route.ts`**

Moves a business forward through onboarding as each onboarding screen (business, website, knowledge, greeting, plan) finishes.

- `POST /api/onboarding/stage`: `requireOperatorBusiness` and `readJson`; `to` must be an onboarding stage other than `create_business` or `complete` (400). `advanceOnboardingStage` (`packages/domain/src/server/onboarding.ts`) checks business_admin, locks the business row and repairs a legacy verification stage. A target at or before the current step changes nothing. Otherwise the move must be an allowed transition, and the conditional update answers 409 `onboarding_stage_conflict` if the stage changed meanwhile. Answers 200 `{ ok: true, stage }`.

Related files: `packages/domain/src/server/onboarding.ts`, `apps/admin/src/components/onboarding-plan-surface.tsx`.

**`apps/admin/app/api/onboarding/phone-numbers/suggestion/route.ts`**

Gives the onboarding number chooser its first suggestions: up to 10 numbers in the country inferred from the business's timezone.

- `GET /api/onboarding/phone-numbers/suggestion`: `requireOperatorBusiness`. `assertPhoneNumberSearchAllowed` applies the initial limit, 10 per user per 10 minutes (429 or 503). `searchBusinessNumberInventory` (`packages/domain/src/server/phoneNumbers.ts`) runs with no selection and a limit of 10: business_admin check, the same eligibility checks as search (409 or 400), the market from the business's timezone (`resolveBusinessNumberMarket`), and Twilio's available numbers, each with a signed five-minute `claimToken`. Answers 200 `{ market, numbers }`.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/lib/phone-number-search-limit.ts`, `apps/admin/src/components/phone-number-chooser.tsx`.

**`apps/admin/app/api/onboarding/phone-numbers/search/route.ts`**

Searches Twilio for numbers the business can pick during onboarding, by country, kind and area code, from the number chooser's search form.

- `POST /api/onboarding/phone-numbers/search`: `requireOperatorBusiness` and `readJson` with optional `selection` and `limit`. `assertPhoneNumberSearchAllowed` (`apps/admin/src/lib/phone-number-search-limit.ts`) allows 20 searches per user per 10 minutes (429 `number_search_rate_limited`, 503 `number_search_unavailable`). `searchBusinessNumberInventory` (`packages/domain/src/server/phoneNumbers.ts`) checks business_admin and eligibility (409 for the wrong onboarding stage or, on cloud, no paid plan; 400 for an unsupported country), lists numbers with voice and SMS from Twilio (`getTwilioProvider`), and signs a five-minute `claimToken` for each. Answers 200 `{ market, numbers }`.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/lib/phone-number-search-limit.ts`, `apps/admin/src/lib/twilio-provider.ts`, `apps/admin/src/components/phone-number-chooser.tsx`.

**`apps/admin/app/api/onboarding/phone-numbers/claim/route.ts`**

Claims the business's first phone number from the onboarding number chooser (`phone-number-chooser.tsx`): it reserves the searched number and queues its purchase from Twilio.

- `POST /api/onboarding/phone-numbers/claim`: `requireApiSession`; `businessId` must be in the query or `x-business-id` and the body must carry `claimToken` (400); `idempotencyKey` is optional. `reserveOnboardingNumberClaim` (`packages/domain/src/server/phoneNumbers.ts`) verifies the offer's HMAC (`NUMBER_CLAIM_TOKEN_SECRET`) and five-minute expiry (400 `number_offer_invalid` or `number_offer_expired`) and that it was issued for onboarding, this business and this user (400 `number_offer_mismatch`). It checks business_admin, reserves through `app.reserve_onboarding_number_claim` (refusals and quotas map to 409 or 429 codes) and enqueues `phoneNumber.provision`; the worker buys the number and adds it to the Twilio SIP trunk. Answers 202 `{ claimId }`.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/components/phone-number-chooser.tsx`, `apps/worker/src/handlers.ts`.

**`apps/admin/app/api/onboarding/phone-numbers/claim/[claimId]/route.ts`**

The onboarding number chooser polls this after a claim, until the number's purchase finishes or fails.

- `GET /api/onboarding/phone-numbers/claim/{claimId}`: `requireOperatorBusiness`, then `getOnboardingNumberClaim` (`packages/domain/src/server/phoneNumbers.ts`), which checks business_admin and reads the caller's own `onboarding_number_claim_events` row for the business. Answers 200 `{ claim }` with id, purpose, status, requestedE164, phoneNumberId and lastError, or `{ claim: null }` when there is no such claim. It does not filter by purpose, so it also returns replacement claims.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/components/phone-number-chooser.tsx`.

**`apps/admin/app/api/onboarding/phone-numbers/skip/route.ts`**

Lets the onboarding number step be skipped (`onboarding-number-surface.tsx`), moving the business on to the attribution step without a number.

- `POST /api/onboarding/phone-numbers/skip`: `requireOperatorBusiness`. `skipOnboardingNumber` (`packages/domain/src/server/phoneNumbers.ts`) checks business_admin and moves `businesses.onboarding_stage` from `plan` or `phone_number` to `attribution`; a business already at `attribution` or `complete` is left as it is. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/components/onboarding-number-surface.tsx`.

**`apps/admin/app/api/onboarding/attribution/route.ts`**

The last onboarding step (`onboarding-attribution-surface.tsx`): it records where the owner heard of the service, credits a stored affiliate referral code, and completes onboarding.

- `POST /api/onboarding/attribution`: `requireOperatorBusiness` and `readJson` with optional `source` and `referralCode`. `submitOnboardingAttribution` (`packages/domain/src/server/onboarding.ts`) checks business_admin. With a referral code and the business at the `attribution` stage, `attributeBusiness` runs as the system actor and inserts an `affiliate_attributions` row for an active affiliate other than the caller, incrementing its referral count. It then saves `onboarding_attribution` (120 characters), sets the stage to `complete` (409 `onboarding_stage_conflict` unless at `attribution` or `complete`) and enqueues `onboarding.sendFollowup` for 24 hours later. Answers 200 `{ ok: true, stage: "complete" }`.

Related files: `packages/domain/src/server/onboarding.ts`, `packages/domain/src/server/affiliates.ts`, `apps/admin/src/components/onboarding-attribution-surface.tsx`.

### Billing

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/billing` | Plan and its limits, usage, spending cap, payments, the plans on offer, a promo plan, and what you may change | Member | `apps/admin/app/api/billing/route.ts` |
| POST | `https://demo.alloplace.com/api/billing` | Set the overage spending cap (`capCents`, or `null` for none) | Admin+ | `apps/admin/app/api/billing/route.ts` |
| POST | `https://demo.alloplace.com/api/billing/checkout` | Start a Polar checkout, or a plan change for a business that already pays, for `starter` or `pro`, `monthly` or `annual`, or for the plan a `promoCode` unlocks; optional `billingEmail` (answers 202 with a `requestId`). Needs `businessId` (query, header or body; 500 without it). | Admin+ | `apps/admin/app/api/billing/checkout/route.ts` |
| GET | `https://demo.alloplace.com/api/billing/checkout` | Where a checkout or plan change stands, whether the plan has synced, and why a change was refused (`?requestId=`) | Admin+ | `apps/admin/app/api/billing/checkout/route.ts` |
| POST | `https://demo.alloplace.com/api/billing/portal` | Open the Polar customer portal (409 without a subscription history or on a managed plan; 429 past its hourly limit) | Admin+ | `apps/admin/app/api/billing/portal/route.ts` |
| POST | `https://demo.alloplace.com/api/billing/promo` | Look up a promo code: the plan it unlocks for this business, its discount and its prices (400 `promo_invalid` for a code that doesn't work) | Admin+ | `apps/admin/app/api/billing/promo/route.ts` |

#### Entry files

**`apps/admin/app/api/billing/route.ts`**

The billing summary many screens read (dashboard shell, plan, usage, onboarding plan, phone number and widget settings, upgrade dialog), and the overage spending cap that `billing-spending-cap.tsx` on the plan page saves.

- `GET /api/billing`: Any member: `withOperatorTransaction` without `minimumRole`, then `requireBusinessMembership` again for the role. It reads the `billing_accounts` row, this month's `billing_usage_events` (up to 100), the month's usage status, counted at read time from the usage and the limits in force so an upgrade or a new rate shows at once (`readUsageStatusInTransaction`), the last 20 `billing_transactions`, knowledge storage use (`getKnowledgeStorageUsageBytes`) and the enforced plan with its limits (`loadBusinessPlanLimits`). `billingAccess` (`packages/domain/src/server/billingAccess.ts`) grants management to business_admin and up, and checkout or portal only with Polar configured (`polarCheckoutConfigured`) and no managed plan. The plans come from the billing catalog once a `billing.json` has been applied, else from the running code (`loadBillingCatalog`, `billingPlanList`), and checkout offers a price only when a linked Polar product sells it. Answers 200 with the account, the effective plan and its limits, permissions, the plans, the checkout plans and intervals on offer, the promo plan the business took with a code (`loadBusinessPromoPlan`), the usage status, and transactions for admins only.
- `POST /api/billing`: `requireOperatorBusiness` and `readJson`. `capCents` must be present (400) and be null or a non-negative whole number (400). `setOverageSpendingCap` (`packages/domain/src/server/billing.ts`) checks business_admin, requires a Starter or Pro plan, and sets `billing_accounts.overage_spending_cap_cents` (null clears the cap). Answers 200 `{ overageSpendingCapCents, overageSpendCents, overageSpendingCapReached }`.

Related files: `packages/domain/src/server/billing.ts`, `packages/domain/src/server/billingAccess.ts`, `packages/domain/src/server/billingPlans.ts`, `packages/domain/src/server/billingCatalog.ts`, `apps/admin/src/components/live-plan-surface.tsx`, `apps/admin/src/components/billing-spending-cap.tsx`.

**`apps/admin/app/api/billing/checkout/route.ts`**

Starts and tracks a Polar checkout for the Starter or Pro plan, or for the plan a promo code unlocks. The onboarding plan page, the plan page and the upgrade dialog post a request, then poll it until the worker has a checkout URL, Polar has changed the subscription, or the plan has synced.

- `GET /api/billing/checkout`: Requires `requestId` in the query, then `withOperatorTransaction` with `minimumRole: "business_admin"`. It reads the business's `billing_checkout_requests` row (status, checkoutId, checkoutUrl, error, target, billingInterval, planCode) and its `billing_accounts` row. Answers 200 with the request plus `synced`, true once the request is `ready` or `changed` and the account shows the requested plan, interval and plan code in an active or trialing state, and `refusal`, the reason Polar refused a plan change (`planChangeRefusalOf`).
- `POST /api/billing/checkout`: `requireApiSession` and `readJson`. `businessId` comes from the body, else the query or `x-business-id`, with no active-business fallback. `target` must be starter or pro and `billingInterval` monthly or annual; `promoCode`, when given, must be a string, and `billingEmail` an email address (400). `createBillingCheckoutRequest` (`packages/domain/src/server/billing.ts`) checks business_admin. With a promo code it first counts a guess (`checkPromoCodeLimit`: 10 an hour per business, 20 per person and per address; 429 `promo_rate_limited`), then `billingCodeCheckout` finds the plan the code unlocks (400 `promo_invalid`, 409 `promo_current` or `promo_interval`) and sells it at that plan's tier. `createBillingCheckoutRequestInTransaction` takes the billing advisory lock, refuses a managed plan (409) and, without a code, anything but Free to a paid plan or Starter to Pro (409). The same person's open request for the same plan, interval and billing email comes back instead of a new one; a business that already pays through Polar changes plan one request at a time (409 `plan_change_pending`). Only a new request counts against the hourly checkout limit (`assertBillingCallAllowed`: 10 per business and 20 per person; 429 `billing_rate_limited`, 503 `billing_limit_unavailable` without Redis). It ensures a `billing_accounts` row, inserts a pending `billing_checkout_requests` row (with `plan_code`, `code_id` and `billing_email` when given) and enqueues the outbox topic `billing.createCheckout`, which the worker turns into a Polar checkout, or into a change of the subscription for a business that already pays. A request still waiting after 15 minutes fails (the worker's `billing.sweep`). Answers 202 `{ requestId }`.

Related files: `packages/domain/src/server/billing.ts`, `packages/domain/src/server/billingCodes.ts`, `apps/admin/src/lib/billing-limit.ts`, `apps/admin/src/lib/promo-code-limit.ts`, `apps/worker/src/handlers.ts`, `apps/admin/src/components/live-upgrade-plan-provider.tsx`, `apps/admin/src/components/onboarding-plan-surface.tsx`, `apps/admin/src/components/billing-email-form.tsx`.

**`apps/admin/app/api/billing/portal/route.ts`**

Opens the Polar customer portal from the plan page and the past-due banner, so an owner or admin can manage payment details and the subscription in Polar.

- `POST /api/billing/portal`: Without `POLAR_ACCESS_TOKEN` and `POLAR_ORGANIZATION_ID` it answers 500. `withOperatorTransaction` with `minimumRole: "business_admin"` reads the business's `billing_accounts` row. It answers 409 when `hasBillingCustomerPortal` finds no Polar customer with subscription history, or when `isManagedBillingAccount` shows a managed plan. Each session then counts against an hourly limit (`assertBillingCallAllowed("portal")`: 20 per business and 40 per person; 429 `billing_rate_limited`, 503 `billing_limit_unavailable` without Redis). `PolarBillingProvider.createCustomerPortalSession` (`packages/providers/src/polar/polarBilling.ts`) posts to Polar's `/v1/customer-sessions/` with the account's `billingKey` and the return URL `<APP_BASE_URL>/settings/plan`. Answers 200 `{ url }`. The admin's Polar token needs only `customer_sessions:write` for this, its one call to Polar.

Related files: `packages/providers/src/polar/polarBilling.ts`, `packages/domain/src/server/billingAccess.ts`, `apps/admin/src/lib/billing-limit.ts`, `apps/admin/src/components/billing-past-due-banner.tsx`.

**`apps/admin/app/api/billing/promo/route.ts`**

What the plan screens show once someone types a promo code under **Have a promo code?** or opens a code's link (`promo-code-entry.tsx`): the plan the code unlocks, before any checkout.

- `POST /api/billing/promo`: `readJson`; an empty `code` is 400 `promo_invalid`. `withOperatorTransaction` with `minimumRole: "business_admin"`. Each try counts as a guess (`checkPromoCodeLimit`: 10 an hour per business, 20 per person and per address; 429 `promo_rate_limited` with `Retry-After`, 503 `rate_limit_unavailable` without Redis). `billingCodeView` (`packages/domain/src/server/billingCodes.ts`) looks the code up, and a code that doesn't work, for any reason, is 400 `promo_invalid`. Answers 200 with the code, the plan it unlocks with its tier, names, discount and currency, whether the business already pays for that plan (`current`), each price with and without the discount and whether checkout can sell it here, what the plan includes, and whether that is more than its tier includes. Changes nothing.

Related files: `packages/domain/src/server/billingCodes.ts`, `apps/admin/src/lib/promo-code-limit.ts`, `apps/admin/src/components/promo-code-entry.tsx`.

### Integrations and Google Calendar

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/integrations` | Calendar connection, staff, calendars to choose from, Twilio and Polar status | Member | `apps/admin/app/api/integrations/route.ts` |
| POST | `https://demo.alloplace.com/api/integrations` | Refresh a calendar connection (`connectionId`). Needs `businessId`. | Admin+ | `apps/admin/app/api/integrations/route.ts` |
| PATCH | `https://demo.alloplace.com/api/integrations` | Choose the calendar to write to (`calendarId`) or the staff member it belongs to (`staffId`). Needs `businessId`. | Admin+ | `apps/admin/app/api/integrations/route.ts` |
| DELETE | `https://demo.alloplace.com/api/integrations` | Disconnect a calendar (`?connectionId=`). Needs `businessId`. | Admin+ | `apps/admin/app/api/integrations/route.ts` |
| GET | `https://demo.alloplace.com/api/calendar/google/start` | The Google address that starts connecting a calendar | Admin+ | `apps/admin/app/api/calendar/google/start/route.ts` |
| GET | `https://demo.alloplace.com/api/calendar/google/connect` | Opens a connect link made by the v1 API (`token`, `businessId`): asks a signed-out visitor to sign in, then goes to Google | Admin+ | `apps/admin/app/api/calendar/google/connect/route.ts` |
| GET | `https://demo.alloplace.com/api/calendar/google/callback` | Google sends the browser back here; it saves the connection and opens Integrations | The account that started the connection | `apps/admin/app/api/calendar/google/callback/route.ts` |

#### Entry files

**`apps/admin/app/api/integrations/route.ts`**

Backs the integrations page (`live-integrations-surface.tsx`): the Google Calendar connection with its calendar list and staff assignment, Twilio and Polar status lines, and the calendar actions select, refresh and disconnect.

- `GET /api/integrations`: Any member: `requireApiSession`, then `withOperatorTransaction` without `minimumRole` reads the billing account and the count of active `phone_numbers`. `listCalendarConnections` and `listCalendarStaff` (`packages/domain/src/server/calendar.ts`) need membership. For a Google connection, `discoverCalendars` gets a token through `resolveCalendarAccessToken` (worker context; refreshes and re-encrypts an expiring token) and lists calendars from Google; a failure becomes `discoveryError`. Answers 200 `{ calendarConnections, staff, calendarOptions, discoveryError, integrations }`, the last summarizing Google Calendar, Twilio and Polar billing.
- `PATCH /api/integrations`: `requireApiSession`; `businessId` must be in the query or `x-business-id`, and the body needs `connectionId` plus `calendarId` or `staffId` (400). For `calendarId`: `withOperatorTransaction` with business_admin, calendar discovery, and the calendar must grant owner or writer access (400); `selectCalendar` stores it, marks the connection syncing and enqueues `calendar.reconcileBusiness`. For `staffId`: `assignCalendarStaff` (business_admin) ties the connection to an active staff member, or with null to the business, and enqueues the same job. Answers 200 `{ ok: true }`.
- `POST /api/integrations`: `requireApiSession`; `businessId` from the query or `x-business-id` and a body `connectionId` are required (400). `refreshCalendar` (`packages/domain/src/server/calendar.ts`) checks business_admin and that the connection isn't disconnected, then enqueues `calendar.reconcileBusiness`. Answers 200 `{ ok: true }`.
- `DELETE /api/integrations`: `requireApiSession`; `businessId` and the `connectionId` query parameter are required (400). `disconnectCalendar` (`packages/domain/src/server/calendar.ts`) checks business_admin, marks the connection disconnected, clears its encrypted tokens, deletes its `calendar_busy_blocks` and writes a `calendar_connection.disconnected` audit row. Answers 200 `{ ok: true }`.

Related files: `packages/domain/src/server/calendar.ts`, `apps/admin/src/components/live-integrations-surface.tsx`, `packages/providers/src/google/calendar.ts`, `apps/admin/src/lib/google-calendar-provider.ts`.

**`apps/admin/app/api/calendar/google/start/route.ts`**

First leg of the Google Calendar OAuth round trip, behind the integrations page's Connect button: it mints a one-time state and returns Google's consent URL. Google then sends the browser to `/api/calendar/google/callback`.

- `GET /api/calendar/google/start`: `withOperatorTransaction` with `minimumRole: "business_admin"`. `enforceCalendarOAuthRateLimits` (`apps/admin/src/lib/google-calendar-oauth-limit.ts`) then counts the operator (20 per hour), the business (60) and the trusted client IP (30), answering 429 `calendar_oauth_rate_limited` or 503 `calendar_oauth_rate_limit_unavailable`. `createCalendarOAuthState` signs `{ userId, businessId, issuedAt, nonce }` with `BETTER_AUTH_SECRET` (or `INTERNAL_SERVICE_SECRET`), and `storeCalendarOAuthState` saves an HMAC digest of it in Better Auth's `verifications` table for 10 minutes. Answers 200 `{ url }` from `buildAuthorizationUrl` (offline access, consent prompt, calendar scopes); the page navigates there.

Related files: `apps/admin/src/lib/google-calendar-oauth.ts`, `apps/admin/src/lib/google-calendar-oauth-store.ts`, `apps/admin/src/lib/google-calendar-oauth-limit.ts`, `apps/admin/src/components/live-integrations-surface.tsx`.

**`apps/admin/app/api/calendar/google/connect/route.ts`**

Opens the connect link that `POST /v1/calendars/google/connect` hands out (signed by `createCalendarConnectLink`, valid seven days). It makes the visitor sign in, checks they administer the link's business, and sends them to Google.

- `GET /api/calendar/google/connect`: Signed link plus session cookie. `verifyCalendarConnectLinkToken` checks the `token` HMAC and age, and the query's `businessId` must be the link's; otherwise it redirects to `/integrations?calendar=google&status=error`. `withOperatorTransaction` with `minimumRole: "business_admin"` then checks that business: a signed-out visitor is redirected to `/login` with a return address, any other refusal gets the error redirect. After the `start` rate limits it creates a signed state (`createCalendarOAuthState`), stores its digest in `verifications` (`storeCalendarOAuthState`) and redirects (307) to Google's authorization URL. Nothing is stored about the calendar until the callback.

Related files: `apps/admin/src/lib/google-calendar-oauth.ts`, `apps/admin/src/lib/google-calendar-oauth-store.ts`, `apps/admin/src/lib/google-calendar-oauth-limit.ts`, `apps/admin/src/lib/auth-return-to.ts`.

**`apps/admin/app/api/calendar/google/callback/route.ts`**

Google's OAuth redirect target (`GOOGLE_REDIRECT_URI`), the last leg of connecting Google Calendar: it checks the one-time state, trades the code for tokens, stores the connection, and sends the browser back to the integrations page.

- `GET /api/calendar/google/callback`: Guarded by the signed state and session cookie. An IP limit runs first (429 or 503 JSON). `verifyCalendarOAuthState` checks the HMAC and 10-minute age (400), the session user must match the state (403), user and business limits follow, and `consumeCalendarOAuthState` deletes the stored `verifications` row, making the state single-use (400). A Google `error` or missing `code` redirects to `/integrations?calendar=google&status=error`. Otherwise it exchanges the code, encrypts the tokens with `SecretBox`, and calls `connectCalendar` (`packages/domain/src/server/calendar.ts`: business_admin, upserts `calendar_connections`, enqueues `calendar.reconcileBusiness`) and `switchWorkspace`. Success redirects with `status=success`, thrown errors with `status=error`.

Related files: `apps/admin/src/lib/google-calendar-oauth.ts`, `apps/admin/src/lib/google-calendar-oauth-store.ts`, `apps/admin/src/lib/google-calendar-oauth-limit.ts`, `packages/domain/src/server/calendar.ts`.

### Webhook endpoints (events sent out)

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/webhook-endpoints` | List the business's webhook endpoints | Admin+ | `apps/admin/app/api/webhook-endpoints/route.ts` |
| POST | `https://demo.alloplace.com/api/webhook-endpoints` | Create an endpoint (`url`, `events`, `description`); the signing secret is shown once | Admin+ | `apps/admin/app/api/webhook-endpoints/route.ts` |
| PATCH | `https://demo.alloplace.com/api/webhook-endpoints/{endpointId}` | Change the address, events or description, or turn it on or off (`status`) | Admin+ | `apps/admin/app/api/webhook-endpoints/[endpointId]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/webhook-endpoints/{endpointId}` | Delete an endpoint | Admin+ | `apps/admin/app/api/webhook-endpoints/[endpointId]/route.ts` |
| GET | `https://demo.alloplace.com/api/webhook-endpoints/{endpointId}/deliveries` | Recent deliveries to an endpoint | Admin+ | `apps/admin/app/api/webhook-endpoints/[endpointId]/deliveries/route.ts` |
| POST | `https://demo.alloplace.com/api/webhook-endpoints/{endpointId}/rotate-secret` | Make a new signing secret (shown once) | Admin+ | `apps/admin/app/api/webhook-endpoints/[endpointId]/rotate-secret/route.ts` |
| POST | `https://demo.alloplace.com/api/webhook-endpoints/{endpointId}/test` | Send a test event (answers 202) | Admin+ | `apps/admin/app/api/webhook-endpoints/[endpointId]/test/route.ts` |
| POST | `https://demo.alloplace.com/api/webhook-deliveries/{deliveryId}/resend` | Send a delivery again (answers 202) | Admin+ | `apps/admin/app/api/webhook-deliveries/[deliveryId]/resend/route.ts` |

#### Entry files

**`apps/admin/app/api/webhook-endpoints/route.ts`**

Lists and creates outgoing webhook endpoints on the webhooks page (`/integrations/webhooks`). Each endpoint receives signed deliveries for the events it subscribes to.

- `GET /api/webhook-endpoints`: `requireOperatorBusiness`, then `listWebhookEndpoints` (`packages/domain/src/server/publicApi/webhooks.ts`) as an operator manager, which checks business_admin (403). It reads the business's `webhook_endpoints`, newest first. Answers 200 `{ endpoints }`, each serialized with `consecutive_failures`, `last_success_at` and `last_failure_at`.
- `POST /api/webhook-endpoints`: `requireOperatorBusiness` and `readJson` with `url`, `events` and `description`. `createWebhookEndpoint` (`packages/domain/src/server/publicApi/webhooks.ts`) checks the URL (`assertWebhookUrlAllowed`: absolute, https except in development, no credentials, public host) and the events (known, at least one), each a 400 `invalid_request`. It then checks business_admin, takes a per-business advisory lock, enforces the 20-endpoint cap (409 `conflict`), inserts the endpoint with an encrypted signing secret and writes a `webhook_endpoint.created` audit row. Answers 201 `{ endpoint, secret }`; the secret is shown only once.

Related files: `packages/domain/src/server/publicApi/webhooks.ts`, `packages/domain/src/server/publicApi/webhookNetwork.ts`, `apps/admin/src/components/live-webhooks-surface.tsx`.

**`apps/admin/app/api/webhook-endpoints/[endpointId]/route.ts`**

Edits, pauses, resumes or deletes one outgoing webhook endpoint from the webhooks page.

- `PATCH /api/webhook-endpoints/{endpointId}`: `requireOperatorBusiness`; a non-UUID `endpointId` answers 400 `invalid_request`. `readJson` with optional `url`, `events`, `description` (null clears it) and `status` (`enabled` or `disabled`). `updateWebhookEndpoint` (`packages/domain/src/server/publicApi/webhooks.ts`) validates the URL and events (400), checks business_admin and updates the row: enabling clears the disabled reason and failure count, disabling records a manual reason. It writes a `webhook_endpoint.updated` audit row naming the changed fields. Answers 200 `{ endpoint }`, or 404 `not_found`.
- `DELETE /api/webhook-endpoints/{endpointId}`: `requireOperatorBusiness`; a non-UUID `endpointId` answers 400 `invalid_request`. `deleteWebhookEndpoint` (`packages/domain/src/server/publicApi/webhooks.ts`) checks business_admin, deletes the business's `webhook_endpoints` row and writes a `webhook_endpoint.deleted` audit row. Answers 200 `{ ok: true }`, or 404 `not_found`.

Related files: `packages/domain/src/server/publicApi/webhooks.ts`, `apps/admin/src/components/live-webhooks-surface.tsx`.

**`apps/admin/app/api/webhook-endpoints/[endpointId]/deliveries/route.ts`**

The delivery history the webhooks page shows for one endpoint, refreshed every 10 seconds.

- `GET /api/webhook-endpoints/{endpointId}/deliveries`: `requireOperatorBusiness`; a non-UUID `endpointId` answers 400 `invalid_request`. `listWebhookDeliveries` (`packages/domain/src/server/publicApi/webhooks.ts`) checks business_admin and reads the endpoint's latest 50 `webhook_deliveries` with their `webhook_events` type. Answers 200 `{ deliveries }`, each with status, attempt count, last response status and error, next attempt (only while pending or retrying), last attempt and creation time. An unknown endpoint gives an empty list.

Related files: `packages/domain/src/server/publicApi/webhooks.ts`, `apps/admin/src/components/live-webhooks-surface.tsx`.

**`apps/admin/app/api/webhook-endpoints/[endpointId]/rotate-secret/route.ts`**

Replaces an outgoing webhook endpoint's signing secret from the webhooks page; deliveries from then on are signed with the new secret.

- `POST /api/webhook-endpoints/{endpointId}/rotate-secret`: `requireOperatorBusiness`; a non-UUID `endpointId` answers 400 `invalid_request`. `rotateWebhookSecret` (`packages/domain/src/server/publicApi/webhooks.ts`) generates a secret, checks business_admin, stores it encrypted on the business's `webhook_endpoints` row and writes a `webhook_endpoint.secret_rotated` audit row. Answers 200 `{ secret }`, shown only this once, or 404 `not_found`.

Related files: `packages/domain/src/server/publicApi/webhooks.ts`, `apps/admin/src/components/live-webhooks-surface.tsx`.

**`apps/admin/app/api/webhook-endpoints/[endpointId]/test/route.ts`**

Sends a test event to one outgoing webhook endpoint from the webhooks page, so the receiver's handling and signature check can be tried.

- `POST /api/webhook-endpoints/{endpointId}/test`: `requireOperatorBusiness`; a non-UUID `endpointId` answers 400 `invalid_request`. `sendWebhookTestEvent` (`packages/domain/src/server/publicApi/webhooks.ts`) checks business_admin, finds the endpoint (404 `not_found`), inserts a `webhook_events` row of the test type with a short message, inserts a `webhook_deliveries` row and enqueues `webhook.deliver`. The event goes out even when the endpoint is disabled or not subscribed to it. Answers 202 `{ event_id, delivery_id }`.

Related files: `packages/domain/src/server/publicApi/webhooks.ts`, `apps/admin/src/components/live-webhooks-surface.tsx`.

**`apps/admin/app/api/webhook-deliveries/[deliveryId]/resend/route.ts`**

Resends one outgoing webhook delivery from an endpoint's delivery history on the webhooks page (`live-webhooks-surface.tsx`).

- `POST /api/webhook-deliveries/{deliveryId}/resend`: `requireOperatorBusiness`; a non-UUID `deliveryId` answers 400 `invalid_request`. `resendWebhookDelivery` (`packages/domain/src/server/publicApi/webhooks.ts`) checks business_admin, finds the business's delivery (404 `not_found`), inserts a new `webhook_deliveries` row for the same event and endpoint, so receivers see the same event id, and enqueues `webhook.deliver` attempt 1. The worker skips it while the endpoint is disabled, unless it carries a test event. Answers 202 `{ deliveryId }`.

Related files: `packages/domain/src/server/publicApi/webhooks.ts`, `apps/admin/src/components/live-webhooks-surface.tsx`.

### API keys and connected apps

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/api-keys` | List API keys | Admin+ | `apps/admin/app/api/api-keys/route.ts` |
| POST | `https://demo.alloplace.com/api/api-keys` | Create an API key (`name`, `scopes`); the key is shown once | Admin+ | `apps/admin/app/api/api-keys/route.ts` |
| DELETE | `https://demo.alloplace.com/api/api-keys/{apiKeyId}` | Revoke an API key | Admin+ | `apps/admin/app/api/api-keys/[apiKeyId]/route.ts` |
| GET | `https://demo.alloplace.com/api/oauth-grants` | Connected apps: AI assistants authorized over OAuth | Admin+ | `apps/admin/app/api/oauth-grants/route.ts` |
| DELETE | `https://demo.alloplace.com/api/oauth-grants/{grantId}` | Disconnect an app and revoke every token it holds | Admin+ | `apps/admin/app/api/oauth-grants/[grantId]/route.ts` |
| POST | `https://demo.alloplace.com/api/oauth/consent` | The consent page's answer (`oauth_query`, `accept`, `business_id`, `scopes`); returns where to send the browser | Signed in; approving needs Admin+ of the chosen business | `apps/admin/app/api/oauth/consent/route.ts` |

#### Entry files

**`apps/admin/app/api/api-keys/route.ts`**

Backs the API keys settings page (`live-api-keys-surface.tsx`), where owners and admins list and create the per-business bearer keys that the v1 REST API and the MCP endpoint accept.

- `GET /api/api-keys`: `requireOperatorBusiness`, then `listApiKeys` (`packages/domain/src/server/publicApi/apiKeys.ts`), which checks business_admin itself with `requireBusinessAdmin` (403 `forbidden`). It reads the business's `api_keys` rows, revoked ones included, newest first, with the creator's name and email. Answers 200 `{ keys }`, each with id, name, prefix, scopes, createdAt, createdBy, lastUsedAt and revokedAt. No hash or key is returned.
- `POST /api/api-keys`: `requireOperatorBusiness`, then `readJson` with `name` and `scopes`. `createApiKey` (`packages/domain/src/server/publicApi/apiKeys.ts`) checks the name (1 to 120 characters) and scopes (`normalizeScopes`: at least one, all known, none platform-only), each failure a 400 `invalid_request`, then checks business_admin. It generates an `lsk_` key, stores only its HMAC-SHA256 (peppered from `ENCRYPTION_KEY`) in `api_keys`, and writes an `api_key.created` audit row. Answers 201 `{ apiKey, key }`; the plaintext `key` appears only in this response.

Related files: `apps/admin/src/components/live-api-keys-surface.tsx`, `packages/domain/src/server/publicApi/apiKeys.ts`, `packages/domain/src/authz/index.ts`.

**`apps/admin/app/api/api-keys/[apiKeyId]/route.ts`**

Revokes one business API key from the API keys settings page. Revoking is permanent: the key stops resolving for the v1 API and MCP.

- `DELETE /api/api-keys/{apiKeyId}`: `requireOperatorBusiness`; a non-UUID `apiKeyId` answers 400 `invalid_request`. `revokeApiKey` (`packages/domain/src/server/publicApi/apiKeys.ts`) checks business_admin, locks the business's key row, sets `revoked_at` and `revoked_by_user_id`, and writes an `api_key.revoked` audit row; revoking an already revoked key succeeds without change. Answers 200 `{ ok: true }`, or 404 `not_found` when the business has no such key.

Related files: `packages/domain/src/server/publicApi/apiKeys.ts`, `apps/admin/src/components/live-api-keys-surface.tsx`.

**`apps/admin/app/api/oauth-grants/route.ts`**

Lists connected apps on the connected apps settings page: the MCP clients that owners or admins authorized for the business through OAuth.

- `GET /api/oauth-grants`: `requireOperatorBusiness`, then `listOAuthGrants` (`packages/domain/src/server/oauth/grants.ts`), which checks business_admin (403). It reads the business's `oauth_consents` rows (keyed by `reference_id`) joined with `oauth_clients`, newest first, and the grantors' names through `app.list_oauth_grantors`. Answers 200 `{ grants }`, each with client id, name, URI, discovery kind, scopes, grantor, and created, updated and last-used times.

Related files: `packages/domain/src/server/oauth/grants.ts`, `apps/admin/src/components/live-connected-apps-surface.tsx`.

**`apps/admin/app/api/oauth-grants/[grantId]/route.ts`**

Revokes a connected app from the connected apps settings page, cutting off that MCP client's access to the business at once.

- `DELETE /api/oauth-grants/{grantId}`: `requireOperatorBusiness`; a non-UUID `grantId` answers 400 `invalid_request`. `revokeOAuthGrant` (`packages/domain/src/server/oauth/grants.ts`) checks business_admin, finds the business's `oauth_consents` row, marks every unrevoked `oauth_access_tokens` and `oauth_refresh_tokens` row for that client, user and business revoked, deletes the consent and writes an `oauth_grant.revoked` audit row. Answers 200 `{ ok: true }`, or 404 `not_found`.

Related files: `packages/domain/src/server/oauth/grants.ts`, `apps/admin/src/components/live-connected-apps-surface.tsx`.

**`apps/admin/app/api/oauth/consent/route.ts`**

Receives the OAuth consent screen's answer (`oauth-consent-surface.tsx`) when an MCP client asks for access: allow for one business with chosen scopes, or deny. It answers with the URL to send the browser to.

- `POST /api/oauth/consent`: `requireApiSession` and `readJson`; `oauth_query` is required (400 `invalid_request`). `decideConsent` (`apps/admin/src/lib/oauth-consent.ts`) needs the query's `client_id`. A denial goes straight to Better Auth's `/oauth2/consent`. An approval needs a `business_id` (400 `business_required`) the user owns or administers (403), scopes the client requested (400 `invalid_scope`) and at least one besides `offline_access`. It runs the consent endpoint in process inside `withSelectedBusiness`, tying the grant to that business, and writes an `oauth_grant.approved` audit row. Answers 200 `{ url }` with `no-store`; a 4xx from Better Auth becomes 400 `invalid_request`.

Related files: `apps/admin/src/lib/oauth-consent.ts`, `apps/admin/src/lib/oauth-provider.ts`, `packages/domain/src/server/oauth/grants.ts`, `apps/admin/src/components/oauth-consent-surface.tsx`.

### Website widget keys

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/widget-keys` | Widget keys, with their install snippets | Member | `apps/admin/app/api/widget-keys/route.ts` |
| POST | `https://demo.alloplace.com/api/widget-keys` | Create a widget key (`label`, `allowedOrigins`, `config`). Needs `WIDGET_KEY_ISSUANCE_ENABLED=true` (403 otherwise). | Admin+ | `apps/admin/app/api/widget-keys/route.ts` |
| PATCH | `https://demo.alloplace.com/api/widget-keys` | Change a widget key (`?id=`): label, allowed websites, look, status. A revoked key stays off. | Admin+ | `apps/admin/app/api/widget-keys/route.ts` |

#### Entry files

**`apps/admin/app/api/widget-keys/route.ts`**

Backs the website widget settings page (`live-widget-settings-surface.tsx`): it lists the business's chat widget keys with their embed key, creates keys, and edits allowed origins, configuration, label and status.

- `GET /api/widget-keys`: Any member: `withOperatorTransaction` without `minimumRole`. It reads all of the business's `widget_keys`, newest first. Answers 200 `{ keys }`, each serialized by `serializeWidgetKeyConfig` (`apps/admin/src/lib/widget-keys.ts`) with configuration defaults filled in, plus the public `key` itself (null when revoked, or for older keys that kept only a hash).
- `POST /api/widget-keys`: `withOperatorTransaction` with `minimumRole: "business_admin"`. Without widget key issuance (`isWidgetKeyIssuanceEnabled`) it answers 403 `widget_issuance_disabled`. It normalizes `allowedOrigins`, validates `config` with `widgetConfigSchema` and trims `label` to 120 characters. `insertWidgetKeyInTransaction` (`packages/domain/src/server/widgetKeys.ts`) creates a `wk_live_` key and stores it with its SHA-256 hash in `widget_keys`. Answers 200 `{ ok: true, key: { id, key }, record }`.
- `PATCH /api/widget-keys`: `withOperatorTransaction` with `minimumRole: "business_admin"`; the key's `id` comes from the query. It loads the business's key, then applies any of `label`, `allowedOrigins`, `config` and `status` (`active`, `disabled` or `revoked`); turning a revoked key back on answers 409. `updateWidgetKeyInTransaction` (`packages/domain/src/server/widgetKeys.ts`) writes the patch to `widget_keys`. Answers 200 `{ ok: true, record }`.

Related files: `packages/domain/src/server/widgetKeys.ts`, `apps/admin/src/lib/widget-keys.ts`, `apps/admin/src/components/live-widget-settings-surface.tsx`.

### Public profile

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/business-profile` | The public profile's settings and address | Member | `apps/admin/app/api/business-profile/route.ts` |
| PUT | `https://demo.alloplace.com/api/business-profile` | Save or publish the public profile | Admin+ | `apps/admin/app/api/business-profile/route.ts` |

#### Entry files

**`apps/admin/app/api/business-profile/route.ts`**

Reads and saves the settings of the business's public page at `/profile/<slug>` for the public profile settings page; the QR code settings page reads them too.

- `GET /api/business-profile`: Any member: `withOperatorTransaction` without `minimumRole`, then `requireBusinessMembership` for the role. `getBusinessPublicProfileSettings` (`packages/domain/src/server/publicProfiles.ts`) returns the saved `business_public_profiles` row or defaults (unpublished, the receptionist summary as description, the most recently used active widget key), plus the active widget keys to choose from; a missing business answers 404. Answers 200 with that view, `url` (`publicProfileUrl`) and `canEdit` (business_admin and up).
- `PUT /api/business-profile`: `withOperatorTransaction` with `minimumRole: "business_admin"`. The body must pass `publicProfileSettingsSchema` (400 `public_profile_invalid` with the failing `field`). `updateBusinessPublicProfile` checks business_admin again; `savePublicProfileInTransaction` takes a per-business advisory lock, refuses a newly chosen widget key that isn't an active key of the business (400 `widget_key_unavailable`), upserts `business_public_profiles` (setting `published_at` on first publish) and writes a `public_profile.published` or `public_profile.unpublished` audit row when that changes. Answers 200 with the view, `url` and `canEdit: true`.

Related files: `packages/domain/src/server/publicProfiles.ts`, `apps/admin/src/components/live-public-profile-settings-surface.tsx`, `apps/admin/src/lib/public-profile-page.ts`.

### Branding

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/branding` | The deployment's app name and logo address | Public | `apps/admin/app/api/branding/route.ts` |
| POST | `https://demo.alloplace.com/api/branding/initial` | Save the name and logo chosen at `/onboarding/brand`. Refused (409) where a brand file sets them, as on demo.alloplace.com. | The deployment's first owner | `apps/admin/app/api/branding/initial/route.ts` |
| GET | `https://demo.alloplace.com/api/branding/logo` | The logo uploaded at onboarding (`?v=` makes it cacheable for good; 404 when there is none) | Public | `apps/admin/app/api/branding/logo/route.ts` |

#### Entry files

**`apps/admin/app/api/branding/route.ts`**

Tells prerendered pages the deployment's name and logo. `branding-provider.tsx` fetches it without cookies when a page was built before the database could say, and the onboarding brand screen reads the current choice.

- `GET /api/branding`: Public: no session or business. `loadBranding` (`apps/admin/src/lib/branding.ts`) uses the brand file that matches the deployment, else what onboarding saved in `deployment_branding` (`getSavedBranding`), else the defaults. It caches the result for 30 seconds and falls back to the brand file or defaults when the database read fails. Answers 200 `{ appName, logoUrl }`.

Related files: `apps/admin/src/lib/branding.ts`, `apps/admin/src/components/branding-provider.tsx`, `packages/domain/src/server/branding.ts`.

**`apps/admin/app/api/branding/initial/route.ts`**

Saves the deployment's own name and logo from the onboarding brand step (`onboarding-brand-surface.tsx`). Only the deployment's first owner may choose, and only once.

- `POST /api/branding/initial`: `requireApiSession`. When a brand file matches the deployment, it answers 409 `branding_set_by_brand_file`. The body is read up to a logo-sized limit (413 `logo_too_large`) and must be JSON (400 `invalid_json`) with `appName` as text and `logo` as base64, either null (400 `invalid_branding`). `saveInitialBranding` (`packages/domain/src/server/branding.ts`) checks name length, logo size and image type (400 or 413), then calls `app.save_initial_branding`, which inserts the single `deployment_branding` row only if none exists (409 `branding_already_saved`) and the caller owns every business (403 `branding_not_allowed`). It clears the branding cache and answers 200 `{ appName, logoUrl }`.

Related files: `packages/domain/src/server/branding.ts`, `packages/db/migrations/0098_deployment_branding.sql`, `apps/admin/src/components/onboarding-brand-surface.tsx`, `apps/admin/src/lib/branding.ts`.

**`apps/admin/app/api/branding/logo/route.ts`**

Serves the logo the deployment's first owner uploaded in onboarding. Pages link to it with the logo's digest in `?v=`, so browsers can cache that address for good.

- `GET /api/branding/logo`: Public: no session. `getSavedBrandLogo` (`packages/domain/src/server/branding.ts`) reads the bytes, content type and SHA-256 version from `deployment_branding`; no logo answers 404 with `no-store`. The ETag is the version, and a matching `If-None-Match` answers 304. `Cache-Control` is one year and immutable when `v` equals the version, else `max-age=0, must-revalidate`. Every answer carries `BRAND_LOGO_SECURITY_HEADERS` (a sandboxing CSP and `nosniff`) because the logo may be an SVG. A database error goes through `asApiResponse` with `no-store`.

Related files: `packages/domain/src/server/branding.ts`, `apps/admin/security-headers.ts`, `packages/shared/src/branding.ts`.

### Feedback and affiliate program

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| POST | `https://demo.alloplace.com/api/feedback` | Send feedback from the dashboard (`message`, `pagePath`) | Signed in (Member when it names a business) | `apps/admin/app/api/feedback/route.ts` |
| GET | `https://demo.alloplace.com/api/affiliate` | Your affiliate profile (made on first visit), referral link, stats, commissions and payouts | Signed in | `apps/admin/app/api/affiliate/route.ts` |
| PATCH | `https://demo.alloplace.com/api/affiliate` | Set your payout email | Signed in | `apps/admin/app/api/affiliate/route.ts` |
| POST | `https://demo.alloplace.com/api/affiliate/click` | Record a visit from a referral link (the sign-up page calls it) | Public | `apps/admin/app/api/affiliate/click/route.ts` |

#### Entry files

**`apps/admin/app/api/feedback/route.ts`**

Receives messages from the dashboard's feedback widget (`dashboard-feedback-widget.tsx`), stores them and emails them to the address in `FEEDBACK_TO_EMAIL`.

- `POST /api/feedback`: `requireApiSession` and `readJson`; `message` must be a string (400). A `businessId` from the query, `x-business-id` or the body is optional; when given, `requireFeedbackAccess` requires active membership in any role (403). `assertFeedbackSubmissionAllowed` (`apps/admin/src/lib/feedback-rate-limit.ts`) allows 10 per user and 50 per business per hour. `submitFeedback` (`packages/domain/src/server/feedback.ts`) trims the message (1 to 2,000 characters), inserts a `feedback_submissions` row and, when `FEEDBACK_TO_EMAIL` is set, enqueues an `email.send` outbox job with the `feedback_submission` template; otherwise the row is saved as `email_failed`. Answers 200 `{ feedbackSubmissionId }`.

Related files: `packages/domain/src/server/feedback.ts`, `apps/admin/src/lib/feedback-rate-limit.ts`, `apps/admin/src/components/dashboard-feedback-widget.tsx`.

**`apps/admin/app/api/affiliate/route.ts`**

Backs the dashboard's affiliate page (`live-affiliate-surface.tsx`): the signed-in user's referral link, counters and history, and the payout email. It belongs to the user, not to a business.

- `GET /api/affiliate`: Any signed-in user (`requireApiSession`); no business is involved. Inside `withBusinessTransaction` with only the user's id, it reads the user's `affiliate_profiles` row and, on the first visit, creates it with a referral code made from the name or email by `normalizeAffiliateReferralCode` (`packages/domain/src/server/affiliates.ts`), trying numbered variants when a code is taken, plus an `affiliate_profile_stats` row. It then reads the stats, the last 20 clicks, 20 attributions, 50 commissions and 20 payout items. Answers 200 `{ profile, stats, clicks, attributions, commissions, payouts }`, the profile carrying `referralLink` (`<SITE_URL>/signup?via=<code>`).
- `PATCH /api/affiliate`: Any signed-in user. It parses the body with `request.json()`, lowercases `payoutEmail` and checks its shape with a regular expression (400 when invalid). It updates `payout_email` on the user's own `affiliate_profiles` row and answers 200 `{ profile: { id, payoutEmail } }`, or `{ profile: null }` when the user has no profile yet.

Related files: `apps/admin/src/components/live-affiliate-surface.tsx`, `packages/domain/src/server/affiliates.ts`.

**`apps/admin/app/api/affiliate/click/route.ts`**

Counts a referral-link visit. The sign-up page (`auth-card.tsx`) posts here when it opens with a referral code, so the affiliate's click statistics grow. It needs no session.

- `POST /api/affiliate/click`: Public: no session, though the proxy's CSRF origin check applies. It requires a string `referralCode` (400). `enforceFixedWindow` allows 500 clicks per code per hour and 30 per trusted client IP (IPv6 /64); a limited click, or one Redis can't count in production, answers 200 `{ recorded: false }`. Otherwise `recordAffiliateClick` (`packages/domain/src/server/affiliates.ts`) runs as the system actor: the code must belong to an active profile, a `visitorId` seen in the last 24 hours is skipped, and it inserts an `affiliate_clicks` row and increments `affiliate_profile_stats.click_count`. Answers 200 `{ recorded }`.

Related files: `apps/admin/src/components/auth-card.tsx`, `packages/domain/src/server/affiliates.ts`, `apps/admin/src/lib/fixed-window-limit.ts`, `apps/admin/src/lib/trusted-client-ip.ts`.

### Prospect demos

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/demos` | List prospect demos | Demo operator | `apps/admin/app/api/demos/route.ts` |
| POST | `https://demo.alloplace.com/api/demos` | Create a prospect demo from a business name and website | Demo operator | `apps/admin/app/api/demos/route.ts` |
| GET | `https://demo.alloplace.com/api/demos/{demoId}` | Where a demo stands | Demo operator | `apps/admin/app/api/demos/[demoId]/route.ts` |
| POST | `https://demo.alloplace.com/api/demos/{demoId}` | `action` = `rotate` (new link), `revoke` or `publish` | Demo operator | `apps/admin/app/api/demos/[demoId]/route.ts` |
| POST | `https://demo.alloplace.com/api/demo/preview` | What a demo link shows (`token`) | Public (with a demo token) | `apps/admin/app/api/demo/preview/route.ts` |
| POST | `https://demo.alloplace.com/api/demo/claim` | Turn a demo into your own business (`token`) | Signed in | `apps/admin/app/api/demo/claim/route.ts` |

#### Entry files

**`apps/admin/app/api/demos/route.ts`**

Backs the internal Demos page (`live-demos-surface.tsx`), where the single configured prospect-demo operator lists demos and creates a new demo business from a prospect's website.

- `GET /api/demos`: `requireProspectDemoOperator`: the session's email must equal `PROSPECT_DEMO_OPERATOR_EMAIL` (503 `demo_operator_unconfigured` when unset, 403 `forbidden` otherwise). `listProspectDemos` (`packages/domain/src/server/demos.ts`) lists the operator's demos through `app.list_operator_prospect_demos()` and loads each with `getProspectDemoStatus`. Answers 200 `{ demos }`, each with status, expiry, website ingestion status and readiness flags.
- `POST /api/demos`: Same guard, then `readJson`; `name` and `websiteUrl` must be strings. `createProspectDemo` normalizes the URL (422 `website_url_invalid`), then, as the system actor, creates a business, the operator's business_owner membership, a receptionist profile with demo-only instructions, a default staff member and optional services, a queued `website_ingestion_jobs` row, and a `prospect_demos` row holding the token's hash and a 30-day expiry. It enqueues `knowledge.crawlWebsite` and `snapshot.refresh`. Answers 201 `{ demoId, businessId, slug, token, status: "preparing", websiteIngestionJobId }`.

Related files: `packages/domain/src/server/demos.ts`, `apps/admin/src/components/live-demos-surface.tsx`, `apps/admin/src/lib/api-helpers.ts`.

**`apps/admin/app/api/demos/[demoId]/route.ts`**

One prospect demo for the Demos page: its readiness status, and the operator's actions on it (rotate the link token, revoke, publish).

- `GET /api/demos/{demoId}`: `requireProspectDemoOperator` (the session's email must equal `PROSPECT_DEMO_OPERATOR_EMAIL`; 503 or 403). `getProspectDemoStatus` (`packages/domain/src/server/demos.ts`) resolves the demo through `app.resolve_operator_prospect_demo`, which finds only the caller's own demos, and reads it with its business slug, ingestion status, greeting and latest snapshot. Answers 200 with the status and the `greetingReady`, `snapshotReady` and `promptsReady` flags.
- `POST /api/demos/{demoId}`: Same guard, then `readJson` with an `action`. `rotate`: `rotateProspectDemoToken` replaces the token hash on an open demo and answers `{ token }`. `revoke`: `revokeProspectDemo` refuses a claimed demo, sets it revoked and detaches the operator (`app.detach_prospect_demo_operator`), answering `{ status: "revoked" }`. `publish`: needs the current `token`; `publishProspectDemo` requires an open, unexpired demo, a matching token hash, at least two prompts, a completed crawl with an indexed document, a greeting and a snapshot, then sets it active and answers `{ status: "active", expiresAt }`.

Related files: `packages/domain/src/server/demos.ts`, `apps/admin/src/components/live-demos-surface.tsx`.

**`apps/admin/app/api/demo/preview/route.ts`**

Lets the public demo page and the claim-demo page show a prospect demo from the token in their address. The demo page polls it every 1.5 seconds while the demo is still being prepared.

- `POST /api/demo/preview`: Public: no session; the unguessable token is the only key, and the proxy's CSRF origin check applies. It reads `token` from the body. `previewProspectDemo` (`packages/domain/src/server/demos.ts`) looks the demo up by the token's SHA-256 through the SECURITY DEFINER function `app.resolve_prospect_demo_by_token`. An empty or unknown token answers 200 `{ state: "invalid" }`. Otherwise it answers 200 with `state` (`expired` once an active demo passes `expires_at`), `businessName`, `businessSlug`, `websiteUrl`, `locale` and `suggestedPrompts`, and records a `prospect_demo.viewed` product event when the demo is active.

Related files: `packages/domain/src/server/demos.ts`, `apps/admin/src/components/demo-surface.tsx`, `apps/admin/src/components/claim-demo-surface.tsx`.

**`apps/admin/app/api/demo/claim/route.ts`**

Lets a signed-in prospect take over a prospect demo from the public claim-demo page (`claim-demo-surface.tsx`): the demo's business becomes theirs and the demo operator leaves it.

- `POST /api/demo/claim`: `requireApiSession`; the body must carry a `token` string. `claimProspectDemo` (`packages/domain/src/server/demos.ts`) finds the demo by the token's SHA-256 through `app.resolve_prospect_demo_by_token`, then, as the system actor, locks its row. A demo the caller already claimed just becomes their active business (`already_claimed`). Otherwise the demo must be active and unexpired and its business active: the caller becomes business_owner, the operator's membership is deleted, onboarding restarts at `create_business`, the demo is marked claimed and the caller's active business is set. It records a `prospect_demo.claim_succeeded` or `prospect_demo.claim_failed` event. Answers 200 `{ businessId, status }`.

Related files: `packages/domain/src/server/demos.ts`, `apps/admin/src/components/claim-demo-surface.tsx`.

## 9. Public API (v1)

The published API, for integrations and the `lobbystack` command line tool. Base address: `https://demo.alloplace.com/api/v1`.

- **Keys.** `Authorization: Bearer lsk_...` is a business's own API key, made at Settings > API keys. `Authorization: Bearer lsp_...` is a platform key from the deployment's `PLATFORM_API_KEYS` setting; it names the business in a `LobbyStack-Business` header.
- **Scopes.** Each key carries scopes, and each operation needs the one in the **Scope** column.
- **Limits.** 120 requests a minute per key by default (`PUBLIC_API_RATE_LIMIT_PER_MINUTE`).
- **Retries.** Operations marked `Idempotency-Key` accept that header, and some require it.
- **Errors.** An address under `/api/v1` that isn't listed answers JSON 404, and a listed address called with the wrong method answers 405.
- **OpenAPI.** `GET https://demo.alloplace.com/api/v1/openapi.json` is public and allows any origin. The **Operation** column is each operation's `operationId` there and its key in `packages/shared/src/publicApi/operations.ts`, the registry the routes, the OpenAPI document and the command line tool share.
- **Docs today:** `api/overview.mdx`, `api/authentication.mdx`, `api/requests.mdx`, `api/webhooks.mdx` and `api/cli.mdx`, plus the reference built from `mintlify/api-reference/openapi.json`.
- **Entry files:** each address has its own `apps/admin/app/api/v1/<path>/route.ts`, which only binds methods to `v1.<operationId>` in `apps/admin/src/lib/public-api/routes.ts` and answers 405 for the rest. The summaries after each table follow every method into that handler and the `packages/domain` function it calls. An unknown address reaches the catch-all `apps/admin/app/api/v1/[...path]/route.ts`.

### Business

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/me` | `getMe` | Check an API key | Any valid key | Platform key may leave out `LobbyStack-Business` | `apps/admin/app/api/v1/me/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/business` | `getBusiness` | Get the business | `business:read` | | `apps/admin/app/api/v1/business/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/business` | `updateBusiness` | Update the business | `business:write` | | `apps/admin/app/api/v1/business/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/services` | `listServices` | List services | `business:read` | Query: `include_inactive` | `apps/admin/app/api/v1/services/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/services` | `createService` | Add a service | `business:write` | `Idempotency-Key` optional; answers 201 | `apps/admin/app/api/v1/services/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/services/{service_id}` | `updateService` | Update a service | `business:write` | | `apps/admin/app/api/v1/services/[service_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/services/{service_id}` | `deleteService` | Delete a service | `business:write` | | `apps/admin/app/api/v1/services/[service_id]/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/staff` | `listStaff` | List staff | `business:read` | | `apps/admin/app/api/v1/staff/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/me/route.ts`**

Public API (v1) endpoint that checks an API key and names the business it acts on. The `lobbystack` CLI calls it in `login`, `whoami` and `lobbystack onboard`, and integrations use it to test a connection.

- `GET /api/v1/me`: Any valid key, whatever its scopes; a platform key may leave out the `LobbyStack-Business` header. `v1.getMe` sends a per-business key to `getMeForApi`, which reads its `api_keys` row joined to `businesses`, and a platform key to `getPlatformMeForApi`, which reports the `PLATFORM_API_KEYS` entry, its partner and access, and the named business or null. Both are in `packages/domain/src/server/publicApi/operations.ts`. Answers 200 `{ data: { api_key, business } }`, plus `platform` for platform keys. Other methods get 405 `method_not_allowed` (`Allow: GET, HEAD, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/platformKeys.ts`, `packages/cli/src/account.ts`.

**`apps/admin/app/api/v1/business/route.ts`**

Public API (v1) endpoint for the business record: name, time zone, caller language, website, type and weekly hours. Integrations and the `lobbystack` CLI (`business get`, `business update`, `business use`, `hours get`, `hours set`, `lobbystack onboard`) read and change it.

- `GET /api/v1/business`: Needs `business:read`. `v1.getBusiness` calls `getBusinessForApi` (`packages/domain/src/server/publicApi/operations.ts`), whose `loadBusinessResource` (`packages/domain/src/server/publicApi/resources.ts`) reads `businesses`, the receptionist's booking mode and `business_hours`, and resolves the onboarding stage the dashboard shows. Answers 200 `{ data }` with the business, or 404 if its row is gone.
- `PATCH /api/v1/business`: Needs `business:write`. `readApiBody` checks `apiBusinessUpdateSchema`. `updateBusinessForApi` answers 400 for an empty body or a time zone that isn't IANA. `updateBusinessInTransaction` (`packages/domain/src/server/tenancy.ts`) updates `businesses` and, for a new time zone, the `staff` rows. `hours` replace the week through `replaceBusinessHoursInTransaction` (`packages/domain/src/server/catalog.ts`), which sets `hours_source` to operator and rewrites `business_hours` (bad windows are 400). Each queues a `snapshot.refresh` outbox message. Audits `api.business.updated` and answers 200 `{ data }`. POST, PUT and DELETE get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/tenancy.ts`, `packages/domain/src/server/catalog.ts`.

**`apps/admin/app/api/v1/services/route.ts`**

Public API (v1) endpoint for the services customers can book: list them and add new ones. The `lobbystack` CLI uses it in `services list`, `services add` and `lobbystack onboard`.

- `GET /api/v1/services`: Needs `business:read`. `booleanParam` reads `include_inactive` (true or false, else 400). `listServicesForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listServiceResources` (`packages/domain/src/server/publicApi/resources.ts`): services not deleted, only active ones unless `include_inactive=true`, sorted by name, each with its `staff_ids` from `staff_service_assignments`. Answers 200 `{ data, next_cursor: null, has_more: false }`.
- `POST /api/v1/services`: Needs `business:write`; `Idempotency-Key` optional. `readApiBody` checks `apiServiceCreateSchema`. `createServiceForApi` makes a slug from the name when none is sent (400 if it can't), answers 409 when a live service has the slug, and inserts the `services` row with `insertServiceInTransaction` (`packages/domain/src/server/catalog.ts`), which queues `snapshot.refresh`. `staff_ids` go through `replaceServiceStaffInTransaction` (unknown staff is 400). Audits `api.service.created` and answers 201 `{ data }`. PUT, PATCH and DELETE get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/catalog.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/services/[service_id]/route.ts`**

Public API (v1) endpoint for changing or deleting one bookable service. The `lobbystack` CLI uses it in `services update`, `services remove` and `lobbystack onboard`.

- `PATCH /api/v1/services/{service_id}`: Needs `business:write`. `uuidParam` checks `service_id`; `readApiBody` checks `apiServiceUpdateSchema`. `updateServiceForApi` (`packages/domain/src/server/publicApi/operations.ts`) answers 400 for an empty body, locks the live service (404 when missing or deleted) and keeps only changed fields; a slug another service uses is 409. `updateServiceInTransaction` and, for `staff_ids`, `replaceServiceStaffInTransaction` (`packages/domain/src/server/catalog.ts`) write `services` and `staff_service_assignments` and queue `snapshot.refresh`. Audits `api.service.updated` when anything changed and answers 200 `{ data }`.
- `DELETE /api/v1/services/{service_id}`: Needs `business:write`. `uuidParam` checks `service_id`. `deleteServiceForApi` calls `deleteServiceInTransaction`, which marks the service inactive and deleted (404 when missing) while the row stays for its appointments, removes its `staff_service_assignments` and queues `snapshot.refresh`. Audits `api.service.deleted` and answers 200 `{ data: { id, deleted: true } }`. GET, POST and PUT get 405 `method_not_allowed` (`Allow: PATCH, DELETE, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/catalog.ts`.

**`apps/admin/app/api/v1/staff/route.ts`**

Public API (v1) endpoint that lists the people who take appointments, with the services each can be booked for. The `lobbystack` CLI uses it in `staff list`; integrations pass a staff id to availability and booking.

- `GET /api/v1/staff`: Needs `business:read`. `listStaffForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listStaffResources` (`packages/domain/src/server/publicApi/resources.ts`), which reads every `staff` row by name, active or not, and computes `service_ids`: active services with no assigned staff or with this person assigned, and none for inactive staff. Answers 200 `{ data, next_cursor: null, has_more: false }`. Other methods get 405 `method_not_allowed` (`Allow: GET, HEAD, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

### Platform

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| POST | `https://demo.alloplace.com/api/v1/businesses` | `createBusiness` | Create a business | `businesses:create` | Platform keys only; `Idempotency-Key` required; answers 201 | `apps/admin/app/api/v1/businesses/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/businesses` | `listBusinesses` | List onboarded businesses | `business:read` | Platform keys only; Query: `limit`, `cursor` | `apps/admin/app/api/v1/businesses/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/users` | `createUser` | Create a user | `users:create` | Platform keys only; `Idempotency-Key` required; answers 201 | `apps/admin/app/api/v1/users/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/businesses/route.ts`**

Public API (v1) endpoint for platform partners: list the businesses their partner onboarded and create new ones, owned by the key's owner account until handed over. The `lobbystack` CLI uses it in `business list`, `business create` and `lobbystack onboard`.

- `GET /api/v1/businesses`: Platform keys only (`business:read`); a per-business key gets 403 `forbidden`, and the `LobbyStack-Business` header is ignored. `pageQuery` reads `limit` (1 to 100, default 25) and `cursor`. `listBusinessesForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls the SQL function `app.list_platform_partner_businesses` for the key's partner (active businesses, newest first) and resolves each one's onboarding stage. Answers 200 `{ data, next_cursor, has_more }`; a bad `limit` or `cursor` is 400.
- `POST /api/v1/businesses`: Platform keys only (`businesses:create`); `Idempotency-Key` required (400 without). `readApiBody` checks `apiBusinessCreateSchema`. `createBusinessForApi` checks the time zone (400) and derives the business id from the key and Idempotency-Key, so a retry replays it with `Idempotent-Replayed: true` and another body is 422. Otherwise `insertBusinessInTransaction` (`packages/domain/src/server/tenancy.ts`) adds the business, an owner membership for the key's account, a staff row, a receptionist profile and a `snapshot.refresh` message; it links `platform_partner_businesses` and audits. A taken slug is 409. Answers 201 `{ data }`. Other methods get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/tenancy.ts`, `packages/db/migrations/0093_platform_business_listing.sql`.

**`apps/admin/app/api/v1/users/route.ts`**

Public API (v1) endpoint for platform partners to create a dashboard account for a business owner who has none, before sending a claim link. The `lobbystack` CLI calls it in `users create`.

- `POST /api/v1/users`: Platform keys only (`users:create`; others get 403 `forbidden`); `Idempotency-Key` required. Reads `{ email, name, locale }`. `createUserForApi` (`packages/domain/src/server/publicApi/users.ts`) runs on the auth database: one valid address (400), an id derived from key and Idempotency-Key (a retry replays with `Idempotent-Replayed: true`; another email is 422), 20 new accounts an hour per key (429), then a `users` row with no password and an unverified email; a taken email is 409. While unverified, `enqueueAccountSetupEmail` queues a set-password `email.send` message. Answers 201 `{ data }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/users.ts`, `apps/admin/src/lib/fixed-window-limit.ts`.

### Receptionist

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/receptionist` | `getReceptionist` | Get the receptionist settings | `business:read` | | `apps/admin/app/api/v1/receptionist/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/receptionist` | `updateReceptionist` | Update the receptionist settings | `business:write` | | `apps/admin/app/api/v1/receptionist/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/rules` | `listRules` | List rules | `business:read` | | `apps/admin/app/api/v1/rules/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/rules` | `createRule` | Add a rule | `business:write` | `Idempotency-Key` optional; answers 201 | `apps/admin/app/api/v1/rules/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/rules/{rule_id}` | `updateRule` | Update a rule | `business:write` | | `apps/admin/app/api/v1/rules/[rule_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/rules/{rule_id}` | `deleteRule` | Delete a rule | `business:write` | | `apps/admin/app/api/v1/rules/[rule_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/rules/reorder` | `reorderRules` | Put the rules in order | `business:write` | | `apps/admin/app/api/v1/rules/reorder/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/receptionist/route.ts`**

Public API (v1) endpoint for the receptionist settings: greeting, tone, summary, booking policy, channel instructions, call transfer, booking mode and appointment change policy. The `lobbystack` CLI uses it in `receptionist get`, `receptionist set` and `lobbystack onboard`.

- `GET /api/v1/receptionist`: Needs `business:read`. `getReceptionistForApi` (`packages/domain/src/server/publicApi/operations.ts`) reads the business and its `receptionist_profiles` row; a business without one shows `defaultReceptionistProfile` (`packages/domain/src/server/receptionistProfile.ts`). `serializeReceptionist` reports the transfer mode, booking mode and change policy as calls use them. Answers 200 `{ data }`, or 404 if the business is gone.
- `PATCH /api/v1/receptionist`: Needs `business:write`. `readApiBody` checks `apiReceptionistUpdateSchema` (`summary` and `regenerate_summary` can't both be sent). `updateReceptionistForApi` answers 400 for an empty body, locks the profile row and drops unchanged fields; with nothing left and no regeneration it returns the current settings. Otherwise `saveReceptionistProfileInTransaction` upserts `receptionist_profiles` (a sent summary becomes `operator`), queues `snapshot.refresh` and, with `regenerate_summary`, `business.generateSummary`. Audits `api.receptionist.updated` and answers 200 `{ data }`. POST, PUT and DELETE get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/receptionistProfile.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/rules/route.ts`**

Public API (v1) endpoint for the instructions the receptionist follows on calls and in chats: list them in order and add new ones. The `lobbystack` CLI uses it in `rules list`, `rules add` and `lobbystack onboard`.

- `GET /api/v1/rules`: Needs `business:read`. `listRulesForApi` (`packages/domain/src/server/publicApi/operations.ts`) reads every `agent_rules` row, active or not, through `listAgentRulesInTransaction` (`packages/domain/src/server/rules.ts`), ordered by `sort_order`. Answers 200 `{ data, next_cursor: null, has_more: false }` with all rules in one page.
- `POST /api/v1/rules`: Needs `business:write`; `Idempotency-Key` optional. `readApiBody` checks `{ title, content, active }` (`apiRuleCreateSchema`, content up to 4,000 characters). `createRuleForApi` takes the rules lock and answers 409 when the business already has 100 rules. `insertAgentRuleInTransaction` adds the rule last and queues `snapshot.refresh` and `realtime.publish` outbox messages. Audits `api.rule.created` and answers 201 `{ data }` with the rule. PUT, PATCH and DELETE get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/rules.ts`.

**`apps/admin/app/api/v1/rules/[rule_id]/route.ts`**

Public API (v1) endpoint for changing or deleting one receptionist rule. The `lobbystack` CLI uses it in `rules update`, `rules remove` and `lobbystack onboard`, which updates rules that already exist.

- `PATCH /api/v1/rules/{rule_id}`: Needs `business:write`. `uuidParam` checks `rule_id`; `readApiBody` checks `apiRuleUpdateSchema`. `updateRuleForApi` (`packages/domain/src/server/publicApi/operations.ts`) answers 400 for an empty body, locks the business's rule (404 when missing) and returns it unchanged when the values already match. Otherwise `updateAgentRuleInTransaction` (`packages/domain/src/server/rules.ts`) writes `agent_rules` and queues `snapshot.refresh` and `realtime.publish`; an `api.rule.updated` audit row follows. Answers 200 `{ data }` with the rule.
- `DELETE /api/v1/rules/{rule_id}`: Needs `business:write`. `uuidParam` checks `rule_id`. `deleteRuleForApi` calls `deleteAgentRuleInTransaction`, which deletes the `agent_rules` row (404 when missing) and queues `snapshot.refresh` and `realtime.publish`; an `api.rule.deleted` audit row follows. Answers 200 `{ data: { id, deleted: true } }`. GET, POST and PUT get 405 `method_not_allowed` (`Allow: PATCH, DELETE, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/rules.ts`.

**`apps/admin/app/api/v1/rules/reorder/route.ts`**

Public API (v1) endpoint that puts all of the receptionist's rules in a new order, the order calls read them in. The `lobbystack` CLI calls it in `rules reorder`.

- `POST /api/v1/rules/reorder`: Needs `business:write`. `readApiBody` checks `{ rule_ids }` (1 to 100 UUIDs, `apiRuleReorderSchema`). `reorderRulesForApi` (`packages/domain/src/server/publicApi/operations.ts`) takes the rules lock and answers 400 with details unless the list names every rule of the business exactly once. The current order, with no tied positions, changes nothing. Otherwise `reorderAgentRulesInTransaction` (`packages/domain/src/server/rules.ts`) rewrites `sort_order` and queues `snapshot.refresh` and `realtime.publish`; an `api.rules.reordered` audit row follows. Answers 200 `{ data, next_cursor: null, has_more: false }` in the new order. Other methods get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/rules.ts`.

### Billing

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/billing` | `getBilling` | Get the plan and spending | `billing:manage` | | `apps/admin/app/api/v1/billing/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/billing` | `updateBilling` | Set the spending cap | `billing:manage` | | `apps/admin/app/api/v1/billing/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/billing/plans` | `listBillingPlans` | List the plans | `billing:manage` | The standard plans as the plan cards show them; every business sees the same | `apps/admin/app/api/v1/billing/plans/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/billing/checkout` | `createCheckout` | Start a checkout, or a plan change for a business that already pays | `billing:manage` | `Idempotency-Key` optional; answers 202; the work finishes in the background. `plan` may be `promo`, with `promo_code`; optional `billing_email`; 429 past the hourly limits | `apps/admin/app/api/v1/billing/checkout/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/billing/checkout/{checkout_id}` | `getCheckout` | Check a checkout | `billing:manage` | `status` is `pending`, `processing`, `ready`, `changed` or `error` | `apps/admin/app/api/v1/billing/checkout/[checkout_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/billing/managed-plan` | `setManagedPlan` | Put the business on a managed plan | `billing:manage` | Operator platform keys only (access to every business). | `apps/admin/app/api/v1/billing/managed-plan/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/billing/managed-plan` | `endManagedPlan` | End the managed plan | `billing:manage` | Operator platform keys only (access to every business). | `apps/admin/app/api/v1/billing/managed-plan/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/billing/promo-plan` | `endPromoPlan` | End the promo plan at the next renewal | `billing:manage` | Operator platform keys only. 404 without a promo plan in force | `apps/admin/app/api/v1/billing/promo-plan/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/billing/catalog` | `getBillingCatalog` | Get the billing catalog | `billing:manage` | Operator platform keys only. Empty until the first apply | `apps/admin/app/api/v1/billing/catalog/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/billing/catalog/runs` | `listBillingCatalogRuns` | List billing runs | `billing:manage` | Operator platform keys only. Query: `limit`, `cursor`, `kind` | `apps/admin/app/api/v1/billing/catalog/runs/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/billing/catalog/runs` | `applyBillingCatalog` | Apply a `billing.json` | `billing:manage` | Operator platform keys only. `Idempotency-Key` required unless `dry_run` is true | `apps/admin/app/api/v1/billing/catalog/runs/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/billing/catalog/polar-links` | `linkBillingCatalog` | Link Polar's products to the catalog | `billing:manage` | Operator platform keys only. `Idempotency-Key` required unless `dry_run` is true; a mismatch is a 409 listing each reason | `apps/admin/app/api/v1/billing/catalog/polar-links/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/billing/codes` | `listBillingCodes` | List promo codes | `billing:manage` | Operator platform keys only. Query: `limit`, `cursor`, `plan`, `business_id` | `apps/admin/app/api/v1/billing/codes/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/billing/codes` | `createBillingCode` | Issue a promo code | `billing:manage` | Operator platform keys only. `Idempotency-Key` optional; answers 201; a code that is taken is a 409 | `apps/admin/app/api/v1/billing/codes/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/billing/codes/{code_id}` | `revokeBillingCode` | Revoke a promo code | `billing:manage` | Operator platform keys only. Businesses already on its plan keep it | `apps/admin/app/api/v1/billing/codes/[code_id]/route.ts` |

The operator-only operations check the key with `requireOperatorKey` (`apps/admin/src/lib/public-api/routes.ts`): anything but a platform key with access to every business gets a 403 `forbidden`. `pnpm billing plan`, `apply` and `verify` (`scripts/billing.ts`) call the catalog and link operations. The command line names the rest: `pnpm lobbystack billing plans`, `end-promo-plan`, `catalog`, `catalog-preview`, `catalog-apply`, `catalog-link`, `catalog-runs`, `codes`, `code-create` and `code-revoke`.

#### Entry files

**`apps/admin/app/api/v1/billing/route.ts`**

Public API (v1) endpoint for a business's plan and overage spending cap. Integrations and the `lobbystack` CLI (`billing status`, `billing cap`; `lobbystack onboard` reads it) use it to check the plan and set or remove the cap without the dashboard.

- `GET /api/v1/billing`: Needs a key with the `billing:manage` scope. `v1.getBilling` (`apps/admin/src/lib/public-api/routes.ts`) calls `getBillingForApi` (`packages/domain/src/server/publicApi/operations.ts`), which reads the effective plan through `loadBillingContext`, the `billing_accounts` row and this month's overage in `billing_usage_months`. Answers 200 `{ data }`: `plan`, `managed`, `subscription_state`, interval and period end (Starter or Pro only), `spending_cap_cents`, `overage_spend_cents` and `spending_cap_reached`.
- `PATCH /api/v1/billing`: Needs `billing:manage`. `readApiBody` checks `{ spending_cap_cents }` (whole cents, or null to remove the cap) against `apiBillingUpdateSchema`. `updateBillingForApi` answers 409 `conflict` unless the effective plan is starter or pro. When the cap differs, `setOverageSpendingCapInTransaction` (`packages/domain/src/server/billing.ts`) updates `billing_accounts.overage_spending_cap_cents` and an `api.billing.updated` row goes to `audit_logs`. Answers 200 `{ data }` with the billing view. POST, PUT and DELETE get `methodNotAllowed`: 405 `method_not_allowed` with `Allow: GET, PATCH, HEAD, OPTIONS`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/billing.ts`, `packages/domain/src/server/usage.ts`.

**`apps/admin/app/api/v1/billing/checkout/route.ts`**

Public API (v1) endpoint that starts a Polar checkout for the Starter or Pro plan, or for the plan a promo code unlocks. Integrations and the `lobbystack` CLI (`billing checkout`, `lobbystack onboard`) use it to get a payment page to send whoever pays. A business that already pays gets its subscription changed instead, with no page.

- `POST /api/v1/billing/checkout`: Needs `billing:manage`; `Idempotency-Key` optional. `v1.createCheckout` reads `{ plan, interval, promo_code, billing_email }` (`apiCheckoutCreateSchema`: `promo_code` is required with `plan` `promo` and refused otherwise). For a standard plan it checks that the catalog sells that price; for `promo`, that Polar checkout is configured, and each code tried counts as a guess (10 an hour per business, 20 per key and per person). `createCheckoutForApi` (`packages/domain/src/server/publicApi/operations.ts`) picks the payer: a per-business key's creator (403 `key_owner_inactive` unless still owner or admin), or for a platform key another active owner (409 if none). As in the dashboard, a free business can buy either plan and a Starter business can move to Pro; other changes, a managed plan and a plan the deployment doesn't sell are 409, and a code that doesn't work is a 400 on `promo_code`. The person's open checkout for the same plan, interval and billing email comes back and counts nothing; otherwise a business that already pays changes plan one checkout at a time (409), and a new checkout counts against the hourly limit (10 per business, 20 per person; 429). It inserts `billing_checkout_requests`, queues `billing.createCheckout` for the worker to ask Polar, audits, and answers 202 `{ data }`. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/billing.ts`, `apps/admin/src/lib/billing-limit.ts`, `apps/admin/src/lib/promo-code-limit.ts`.

**`apps/admin/app/api/v1/billing/checkout/[checkout_id]/route.ts`**

Public API (v1) endpoint for polling a checkout started with POST /api/v1/billing/checkout. The `lobbystack` CLI uses it in `billing checkout-status`, `billing checkout --wait` and `lobbystack onboard`, until the Polar page is ready or the plan is paid.

- `GET /api/v1/billing/checkout/{checkout_id}`: Needs `billing:manage`. `v1.getCheckout` checks `checkout_id` with `uuidParam` (400 if not a UUID) and calls `getCheckoutForApi` (`packages/domain/src/server/publicApi/operations.ts`). Its `loadCheckout` reads the business's `billing_checkout_requests` row (404 when missing) and `billing_accounts`. A canceled request reads as `error`, `checkout_url` is set only when `ready`, and `paid` turns true once Polar's webhook has put the business on that plan and interval. Answers 200 `{ data }`. Other methods get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`.

**`apps/admin/app/api/v1/billing/managed-plan/route.ts`**

Public API (v1) endpoint for the deployment operator to bill a business directly: it puts the business on the managed enterprise plan outside Polar, or ends it. Operator platform keys call it, as `lobbystack billing managed-plan`, `billing end-managed-plan` and `lobbystack onboard` do.

- `POST /api/v1/billing/managed-plan`: Needs `billing:manage`, and `requireOperatorKey` (routes.ts) refuses anything but a platform key whose `access` is `all` (403 `forbidden`). The body must be `{ "plan": "enterprise" }` (`apiManagedPlanCreateSchema`). `setManagedPlanForApi` calls `setManagedPlanInTransaction` (`packages/domain/src/server/billing.ts`): a live Polar subscription is 409; otherwise it upserts `billing_accounts` as an active managed enterprise plan with no cap, cancels open `billing_checkout_requests`, queues a `realtime.publish` `billing.updated` message and audits. A plan already in place changes nothing. Answers 200 `{ data }` with the billing view.
- `DELETE /api/v1/billing/managed-plan`: Same operator-key check. `endManagedPlanForApi` calls `endManagedPlanInTransaction`, which marks the live managed `billing_accounts` row canceled with `current_period_end` set to now, putting the business back on the free plan, and queues `realtime.publish`. A business without a managed plan is 404. Writes an `api.billing.managed_plan_ended` audit row and answers 200 `{ data }` with the billing view. GET, PUT and PATCH get 405 `method_not_allowed` (`Allow: POST, DELETE, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/billing.ts`.

**`apps/admin/app/api/v1/billing/plans/route.ts`**

Public API (v1) endpoint for the plans a deployment offers, as the dashboard's plan cards show them. `pnpm lobbystack billing plans` prints it.

- `GET /api/v1/billing/plans`: Needs `billing:manage`. `v1.listBillingPlans` calls `listBillingPlansForApi` (`packages/domain/src/server/billingPlans.ts`), which reads the billing catalog once a `billing.json` has been applied, in its currency, and the running code's plans before that, in US dollars. Each plan has what it includes, its overage rates and its prices, each marked with whether checkout can sell it here. Every business sees the same plans. Answers 200 `{ data }`. Other methods get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/billingPlans.ts`, `packages/domain/src/server/billingCatalog.ts`.

**`apps/admin/app/api/v1/billing/promo-plan/route.ts`**

Public API (v1) endpoint for the deployment operator to end a business's promo plan early, as `pnpm lobbystack billing end-promo-plan` does.

- `DELETE /api/v1/billing/promo-plan`: Needs `billing:manage` and an operator platform key (`requireOperatorKey`, else 403). `endPromoPlanForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `endPromoPlanInTransaction`, which ends the plan at the subscription's next renewal, as the plan's months running out would: its owners get an email, and the worker then moves the Polar subscription to the plan's tier without its discount, or cancels it for a plan that ends that way. A business without a promo plan in force is 404. Writes an `api.billing.promo_plan_ended` audit row and answers 200 `{ data }` with the billing view, whose `plan_ends` and `plan_ends_with` say what happens. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/billing.ts`, `apps/worker/src/handlers.ts`.

**`apps/admin/app/api/v1/billing/catalog/route.ts`**

Public API (v1) endpoint for the billing catalog, the brand's `billing.json` as the deployment holds it. `pnpm billing plan` and `verify`, and `pnpm lobbystack billing catalog`, read it.

- `GET /api/v1/billing/catalog`: Needs `billing:manage` and an operator platform key. `getBillingCatalogForApi` (`packages/domain/src/server/billingCatalog.ts`) reads every plan in `billing_plans`, standard or not, with its `billing_prices` and their Polar products, the file they came from, whether it matches the deployed code, and the Polar settings the deployment runs with, the webhook secret only as a hash. Empty until the first apply. Answers 200 `{ data }`. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/billingCatalog.ts`, `scripts/billing.ts`.

**`apps/admin/app/api/v1/billing/catalog/runs/route.ts`**

Public API (v1) endpoint for applying a `billing.json` and for the record of every run, used by `pnpm billing apply`.

- `GET /api/v1/billing/catalog/runs`: Needs `billing:manage` and an operator platform key. `listBillingCatalogRunsForApi` lists `billing_runs`, newest first, with the rows each changed and, for a verify, what it found. Query: `limit`, `cursor` and `kind`. Answers 200 `{ data, next_cursor, has_more }`.
- `POST /api/v1/billing/catalog/runs`: Same key check. `readApiBody` checks the body against `apiBillingCatalogApplySchema`. `applyBillingCatalogForApi` writes the file's plans and prices into `billing_plans` and `billing_prices` in one transaction and records the run in `billing_runs`; plans and prices the file leaves out are retired, never deleted, and nothing in Polar changes. With `dry_run` true it changes nothing and answers 200 with what the apply would change and anything that would stop it. Otherwise `Idempotency-Key` is required: a retry with the same value returns the same run (`Idempotent-Replayed: true`), and a different body with that value is a 422. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/billingCatalog.ts`, `packages/db/migrations/0108_billing_catalog.sql`, `scripts/billing.ts`.

**`apps/admin/app/api/v1/billing/catalog/polar-links/route.ts`**

Public API (v1) endpoint that records which Polar product sells each price, once `pnpm billing apply` has made Polar sell what the file says.

- `POST /api/v1/billing/catalog/polar-links`: Needs `billing:manage` and an operator platform key. `readApiBody` checks the body against `apiBillingCatalogLinkSchema`: every live price of every sold plan, the catalog hash and the Polar organization. `linkBillingCatalogForApi` (`packages/domain/src/server/billingCatalog.ts`) records each price's Polar product and each plan's Polar discount, then makes every sold plan active; anything that doesn't fit is a 409 listing each reason in `details`. Nothing in Polar changes. `dry_run` and `Idempotency-Key` work as for an apply. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/billingCatalog.ts`, `scripts/billing.ts`.

**`apps/admin/app/api/v1/billing/codes/route.ts`**

Public API (v1) endpoint for promo codes, issued by the deployment operator (`pnpm lobbystack billing code-create` and `billing codes`).

- `GET /api/v1/billing/codes`: Needs `billing:manage` and an operator platform key. `listBillingCodesForApi` (`packages/domain/src/server/billingCodes.ts`) lists `billing_codes`, newest first. Query: `limit`, `cursor`, `plan` and `business_id`. Answers 200 `{ data, next_cursor, has_more }`, each code with its link on the deployment's address.
- `POST /api/v1/billing/codes`: Same key check. `readApiBody` checks the body against `apiBillingCodeCreateSchema`. `createBillingCodeForApi` inserts a `billing_codes` row for a plan whose access is `code` in `billing.json`. A shared code needs `max_uses` and `expires_at`; a code bound to one business needs neither. A business that enters it buys that plan through Polar with the plan's discount, once (migration `0113`). With an `Idempotency-Key`, a retry returns the same code and a different body with that value is a 422; a code that is taken is a 409. Answers 201 `{ data }`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/billingCodes.ts`, `packages/db/migrations/0109_billing_codes.sql`, `packages/db/migrations/0113_billing_code_redemptions.sql`.

**`apps/admin/app/api/v1/billing/codes/[code_id]/route.ts`**

Public API (v1) endpoint that revokes a promo code (`pnpm lobbystack billing code-revoke`).

- `DELETE /api/v1/billing/codes/{code_id}`: Needs `billing:manage` and an operator platform key. `revokeBillingCodeForApi` sets the code's `status` to `revoked`, so no new checkout can use it; businesses already on its plan keep it. Revoking a revoked code returns it as it is; an unknown one is 404. Answers 200 `{ data }`. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/billingCodes.ts`.

### Phone numbers

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/phone-numbers` | `listPhoneNumbers` | List phone numbers | `phone_numbers:manage` | | `apps/admin/app/api/v1/phone-numbers/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/phone-numbers/search` | `searchPhoneNumbers` | Find numbers to claim | `phone_numbers:manage` | | `apps/admin/app/api/v1/phone-numbers/search/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/phone-numbers/claims` | `createPhoneNumberClaim` | Claim a number | `phone_numbers:manage` | `Idempotency-Key` required; answers 202; the work finishes in the background | `apps/admin/app/api/v1/phone-numbers/claims/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/phone-numbers/claims/{claim_id}` | `getPhoneNumberClaim` | Check a claim | `phone_numbers:manage` | | `apps/admin/app/api/v1/phone-numbers/claims/[claim_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/phone-numbers/{phone_number_id}` | `releasePhoneNumber` | Release a number | `phone_numbers:manage` | Answers 202; the work finishes in the background | `apps/admin/app/api/v1/phone-numbers/[phone_number_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/phone-numbers/{phone_number_id}/replace` | `replacePhoneNumber` | Replace a number | `phone_numbers:manage` | `Idempotency-Key` required; answers 202; the work finishes in the background | `apps/admin/app/api/v1/phone-numbers/[phone_number_id]/replace/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/phone-numbers/route.ts`**

Public API (v1) endpoint that lists every phone number the business has or had. The `lobbystack` CLI uses it in `numbers list` and in `lobbystack onboard`, which looks for an active number before claiming one.

- `GET /api/v1/phone-numbers`: Needs `phone_numbers:manage`. `v1.listPhoneNumbers` calls `listPhoneNumbersForApi` (`packages/domain/src/server/publicApi/operations.ts`), whose `listPhoneNumberResources` (`packages/domain/src/server/publicApi/resources.ts`) reads the business's `phone_numbers` rows, newest first, shows the worker's reclaim steps as `releasing` and `released`, and includes `release_scheduled_at`. Answers 200 `{ data, next_cursor: null, has_more: false }`, everything in one page. Other methods get 405 `method_not_allowed` (`Allow: GET, HEAD, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/phone-numbers/search/route.ts`**

Public API (v1) endpoint that searches the carrier for numbers the business can claim and returns offers signed for five minutes. The `lobbystack` CLI uses it in `numbers search` and `lobbystack onboard`, before a claim or a replacement.

- `POST /api/v1/phone-numbers/search`: Needs `phone_numbers:manage`. Reads `apiPhoneNumberSearchSchema` (location filters, `limit`, `replaces`), resolves the acting account (403 `key_owner_inactive` if a per-business key's creator lost owner or admin) and loads the Twilio provider and `NUMBER_CLAIM_TOKEN_SECRET`. `searchPhoneNumbersForApi` (`packages/domain/src/server/publicApi/operations.ts`) answers 409 without a paid plan on cloud, 404 or 409 for an unusable `replaces`, counts the account's searches (20 per 10 minutes, then 429), asks Twilio (a refused filter is 400), keeps voice and SMS numbers and signs offers. Answers 200 `{ data, next_cursor: null, has_more: false }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/phoneNumbers.ts`, `apps/admin/src/lib/phone-number-search-limit.ts`.

**`apps/admin/app/api/v1/phone-numbers/claims/route.ts`**

Public API (v1) endpoint that buys an offered phone number for the business and connects it to the receptionist. The `lobbystack` CLI calls it in `numbers claim` and `lobbystack onboard`, then polls the claim.

- `POST /api/v1/phone-numbers/claims`: Needs `phone_numbers:manage`; `Idempotency-Key` required. Resolves the acting account (403 `key_owner_inactive` if a per-business key's creator lost owner or admin). `claimPhoneNumberForApi` (`packages/domain/src/server/publicApi/operations.ts`) refuses a bad, expired, replacement or foreign `offer_token` (400). `app.reserve_api_number_claim` answers 409 for a claim in progress, an existing number or, on cloud, no paid plan; 429 past 3 an hour, 2 a day or 5 in 30 days (per business for platform keys). Inserts an `onboarding_number_claim_events` row, moves `onboarding_stage` up to `phone_number_claiming`. Queues `phoneNumber.provision`, audits, answers 202 `{ data }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/phoneNumbers.ts`, `packages/db/migrations/0094_api_number_claims.sql`.

**`apps/admin/app/api/v1/phone-numbers/claims/[claim_id]/route.ts`**

Public API (v1) endpoint for polling a phone number claim until it is claimed or failed. The `lobbystack` CLI uses it in `numbers claim-status`, the `--wait` option of `numbers claim` and `numbers replace`, and `lobbystack onboard`.

- `GET /api/v1/phone-numbers/claims/{claim_id}`: Needs `phone_numbers:manage`. `uuidParam` checks `claim_id`. `getPhoneNumberClaimForApi` (`packages/domain/src/server/publicApi/operations.ts`) first runs `expireAbandonedNumberClaimsInTransaction` (`packages/domain/src/server/phoneNumbers.ts`), so this GET writes: claims reserved over 15 minutes, or provisioning with no progress for 30, become failed, and the business goes back to its number step or frees its replacement reservation. It then reads the `onboarding_number_claim_events` row (404 when missing). Answers 200 `{ data }` with status pending, provisioning, claimed or failed. Other methods get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/phoneNumbers.ts`.

**`apps/admin/app/api/v1/phone-numbers/[phone_number_id]/route.ts`**

Public API (v1) endpoint that gives a business's phone number back to the carrier, which can't be undone. The `lobbystack` CLI calls it in `numbers release`; once the release finishes, the business can claim a new number.

- `DELETE /api/v1/phone-numbers/{phone_number_id}`: Needs `phone_numbers:manage`. `uuidParam` checks `phone_number_id`. `releasePhoneNumberForApi` (`packages/domain/src/server/publicApi/operations.ts`) takes the number-claim lock and loads the number (404 if not this business's); one already releasing, released or past its release time comes back as it is. Otherwise `schedulePhoneNumberReleaseInTransaction` (`packages/domain/src/server/compliance.ts`) answers 409 while a replacement is being bought, sets `reclaim_scheduled_at` to now and queues `phoneNumber.reclaim`, which the worker carries out with Twilio. Audits and answers 202 `{ data }`. Other methods get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/compliance.ts`.

**`apps/admin/app/api/v1/phone-numbers/[phone_number_id]/replace/route.ts`**

Public API (v1) endpoint that claims a replacement for the business's active number, using an offer from a search with `replaces`. The `lobbystack` CLI calls it in `numbers replace`; the old number is released 30 days after the new one goes live.

- `POST /api/v1/phone-numbers/{phone_number_id}/replace`: Needs `phone_numbers:manage`; `Idempotency-Key` required. Checks `phone_number_id`, reads `{ offer_token }` and resolves the acting account (403 `key_owner_inactive` if a per-business key's creator lost owner or admin). `claimPhoneNumberForApi` (`packages/domain/src/server/publicApi/operations.ts`) refuses a bad, expired, foreign or non-replacement offer (400), a number not this business's (404), and one inactive or scheduled for release (409). It reserves through `app.reserve_api_number_claim` (409 for a used or pending replacement or, on cloud, no paid plan; 429 past the claim limits), queues `phoneNumber.provision`, audits, and answers 202 `{ data }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/phoneNumbers.ts`, `packages/db/migrations/0094_api_number_claims.sql`.

### Onboarding

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/onboarding` | `getOnboarding` | Get onboarding progress | `business:read` | | `apps/admin/app/api/v1/onboarding/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/onboarding` | `updateOnboarding` | Skip setup steps | `business:write` | | `apps/admin/app/api/v1/onboarding/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/onboarding/complete` | `completeOnboarding` | Finish onboarding | `business:write` | | `apps/admin/app/api/v1/onboarding/complete/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/onboarding/route.ts`**

Public API (v1) endpoint for onboarding progress: what the receptionist has, what finishing still requires, and which setup-guide steps are skipped. The `lobbystack` CLI uses it in `onboarding status`, `onboarding skip` and `lobbystack onboard`.

- `GET /api/v1/onboarding`: Needs `business:read`. `getOnboardingForApi` (`packages/domain/src/server/publicApi/operations.ts`) runs `loadOnboarding`, which reads `businesses`, the receptionist greeting, the plan, indexed `knowledge_documents`, active `knowledge_snippets`, the setup guide (`loadSetupGuideInTransaction`) and whether a phone call was answered. Answers 200 `{ data }` with the dashboard's `stage`, `complete`, a seven-item `checklist` (each done, missing or skipped, and whether required) and `missing`.
- `PATCH /api/v1/onboarding`: Needs `business:write`. `readApiBody` checks `{ skip_steps }` (knowledge, phone_number, full_site_read, test_call) against `apiOnboardingUpdateSchema`. `updateOnboardingForApi` maps them to setup-guide steps, and `updateSetupGuideSkippedStepsInTransaction` (`packages/domain/src/server/activation.ts`) locks the business row and replaces the guide entries in `businesses.setup_guide_skipped_steps`. Audits `api.onboarding.updated` only when the list changed and answers 200 `{ data }` with the onboarding view. POST, PUT and DELETE get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/activation.ts`.

**`apps/admin/app/api/v1/onboarding/complete/route.ts`**

Public API (v1) endpoint that finishes a business's onboarding, so the dashboard opens on the business instead of its onboarding steps. The `lobbystack` CLI calls it in `onboarding complete` and `lobbystack onboard`.

- `POST /api/v1/onboarding/complete`: Needs `business:write`. Reads `{ source, referral_code, skip_number }`; `referral_code` is 400 from a platform key and 403 from a per-business key whose creator lost owner or admin. `completeOnboardingForApi` (`packages/domain/src/server/publicApi/operations.ts`) returns a finished business unchanged, refuses a referral for a partner-onboarded business (400), and answers 409 listing missing required items. It credits the referral with `attributeBusiness` as the system actor, sets `onboarding_stage` complete and `onboarding_attribution`, queues `onboarding.sendFollowup` a day later for per-business keys on non-partner businesses, audits, and answers 200 `{ data }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/affiliates.ts`, `packages/domain/src/server/onboarding.ts`.

### Team

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/team` | `getTeam` | Get the team | `team:manage` | | `apps/admin/app/api/v1/team/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/team/invitations` | `createTeamInvitation` | Invite someone | `team:manage` | `Idempotency-Key` required; answers 201 | `apps/admin/app/api/v1/team/invitations/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/team/invitations/{invitation_id}` | `revokeTeamInvitation` | Revoke an invitation | `team:manage` | | `apps/admin/app/api/v1/team/invitations/[invitation_id]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/team/members/{membership_id}` | `updateTeamMember` | Change someone's role | `team:manage` | | `apps/admin/app/api/v1/team/members/[membership_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/team/members/{membership_id}` | `removeTeamMember` | Remove someone from the team | `team:manage` | | `apps/admin/app/api/v1/team/members/[membership_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/team/claim-link` | `createClaimLink` | Hand the business over | `team:manage` | `Idempotency-Key` required; answers 201 | `apps/admin/app/api/v1/team/claim-link/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/team/route.ts`**

Public API (v1) endpoint that shows the business's team and its open invitations. The `lobbystack` CLI uses it in `team list` and `lobbystack onboard`, which checks whether the owner already owns the business or has a claim link.

- `GET /api/v1/team`: Needs `team:manage`. `getTeamForApi` (`packages/domain/src/server/publicApi/operations.ts`) reads active `business_memberships` joined to `users` (name, email, role), earliest first, and pending `business_invitations`, newest first; an invitation past `expires_at` reads as `expired`, and `transfers_ownership` marks a claim link. Answers 200 `{ data: { members, invitations } }`. Other methods get 405 `method_not_allowed` (`Allow: GET, HEAD, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`.

**`apps/admin/app/api/v1/team/invitations/route.ts`**

Public API (v1) endpoint that emails someone an invitation to join the business's team as admin, scheduler or viewer. The `lobbystack` CLI calls it in `team invite`.

- `POST /api/v1/team/invitations`: Needs `team:manage`; `Idempotency-Key` required. Reads `{ email, role }` (business_admin, scheduler or viewer) and resolves the acting account (403 `key_owner_inactive` if a per-business key's creator lost owner or admin). `createTeamInvitationForApi` (`packages/domain/src/server/publicApi/operations.ts`) requires one valid address (400) and counts the invitation against the account's 20 an hour, shared with the dashboard (429, or 503 when the limiter is down). `insertInvitationInTransaction` (`packages/domain/src/server/tenancy.ts`) inserts a `business_invitations` row valid 7 days and queues an `email.send` outbox message. Audits and answers 201 `{ data }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/tenancy.ts`, `apps/admin/src/lib/fixed-window-limit.ts`.

**`apps/admin/app/api/v1/team/invitations/[invitation_id]/route.ts`**

Public API (v1) endpoint that revokes an open team invitation or claim link. The `lobbystack` CLI calls it in `team revoke`.

- `DELETE /api/v1/team/invitations/{invitation_id}`: Needs `team:manage`. `uuidParam` checks `invitation_id`. `revokeTeamInvitationForApi` (`packages/domain/src/server/publicApi/operations.ts`) takes the team lock and, for a per-business key, checks its creator is still owner or admin (403 `key_owner_inactive`). `revokeInvitationInTransaction` (`packages/domain/src/server/tenancy.ts`) sets a pending `business_invitations` row to revoked; one already accepted, revoked or missing is 404. Audits `api.team.invitation_revoked` and answers 200 `{ data: { id, deleted: true } }`. Other methods get 405 `method_not_allowed` (`Allow: DELETE, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/tenancy.ts`.

**`apps/admin/app/api/v1/team/members/[membership_id]/route.ts`**

Public API (v1) endpoint for changing a team member's role or removing them from the business. The `lobbystack` CLI calls it in `team role` and `team remove`.

- `PATCH /api/v1/team/members/{membership_id}`: Needs `team:manage`. `uuidParam` checks `membership_id`; `readApiBody` reads `{ role }` (business_admin, scheduler or viewer). `updateTeamMemberForApi` (`packages/domain/src/server/publicApi/operations.ts`) takes the team lock, checks a per-business key's creator is still owner or admin (403 `key_owner_inactive`) and loads the active member (404); the same role changes nothing. `updateMemberRoleInTransaction` (`packages/domain/src/server/tenancy.ts`) refuses the last owner (409), updates `business_memberships.role`, and revokes the member's `api_keys` unless the new role is business_admin. Audits and answers 200 `{ data }` with the member.
- `DELETE /api/v1/team/members/{membership_id}`: Needs `team:manage`, with the same lock and creator check. `removeTeamMemberForApi` calls `removeMemberInTransaction`, which refuses a missing member (404) or the last owner (409), revokes pending invitations the member sent or received and their `api_keys`, and sets the membership to removed. Audits `api.team.member_removed` and answers 200 `{ data: { id, deleted: true } }`. GET, POST and PUT get 405 `method_not_allowed` (`Allow: PATCH, DELETE, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/tenancy.ts`.

**`apps/admin/app/api/v1/team/claim-link/route.ts`**

Public API (v1) endpoint that hands a business over to its owner: an owner invitation whose acceptance also takes the sending account off the team. Partners and operators use it after setting a business up, as `lobbystack team transfer-owner` and `lobbystack onboard` do.

- `POST /api/v1/team/claim-link`: Needs `team:manage`; `Idempotency-Key` required. Reads `{ email }` and resolves the acting account (403 `key_owner_inactive` if a per-business key's creator lost owner or admin). `createClaimLinkForApi` (`packages/domain/src/server/publicApi/operations.ts`) checks the address (400) and that the acting account owns the business (409), counts the account's invitations (20 an hour, then 429), then under the team lock revokes any pending claim link and inserts a `business_owner` invitation with `transfers_ownership` through `insertInvitationInTransaction` (`packages/domain/src/server/tenancy.ts`), which queues `email.send`. Audits and answers 201 `{ data: { invitation, url } }`. Other methods get 405, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/tenancy.ts`.

### Website chat

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/widget-keys` | `listWidgetKeys` | List widget keys | `business:read` | | `apps/admin/app/api/v1/widget-keys/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/widget-keys` | `createWidgetKey` | Add the chat widget to a website | `business:write` | `Idempotency-Key` optional; answers 201 | `apps/admin/app/api/v1/widget-keys/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/widget-keys/{widget_key_id}` | `updateWidgetKey` | Update a widget key | `business:write` | | `apps/admin/app/api/v1/widget-keys/[widget_key_id]/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/widget-keys/route.ts`**

Public API (v1) endpoint for website chat widget keys: list them with their script tags and create new ones. The `lobbystack` CLI uses it in `widget list` and `widget create`.

- `GET /api/v1/widget-keys`: Needs `business:read`. `listWidgetKeysForApi` (`packages/domain/src/server/publicApi/operations.ts`) reads the business's `widget_keys` rows, newest first, and `serializeWidgetKey` (`packages/domain/src/server/publicApi/resources.ts`) fills in default config values, the key (null once revoked) and an embed snippet served from the origin of `APP_BASE_URL`, or the request's. Answers 200 `{ data, next_cursor: null, has_more: false }`.
- `POST /api/v1/widget-keys`: Needs `business:write`; `Idempotency-Key` optional. `isWidgetKeyIssuanceEnabled` answers 403 `forbidden` unless `WIDGET_KEY_ISSUANCE_ENABLED=true`, since website chat is a restricted capability. `readApiBody` checks `apiWidgetKeyCreateSchema` (label, `allowed_origins`, config). `createWidgetKeyForApi` calls `insertWidgetKeyInTransaction` (`packages/domain/src/server/widgetKeys.ts`), which stores a new `wk_live_` key, its hash and the normalized origins in `widget_keys`, then audits `api.widget_key.created`. Answers 201 `{ data }` with `key` and `embed_snippet`. PUT, PATCH and DELETE get 405 `method_not_allowed`, without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/widgetKeys.ts`, `packages/shared/src/product-capabilities.ts`.

**`apps/admin/app/api/v1/widget-keys/[widget_key_id]/route.ts`**

Public API (v1) endpoint for changing one website chat widget key: its label, allowed origins, configuration, or status (active, disabled, revoked). The `lobbystack` CLI calls it in `widget update`.

- `PATCH /api/v1/widget-keys/{widget_key_id}`: Needs `business:write`. `uuidParam` checks `widget_key_id`; `readApiBody` checks `apiWidgetKeyUpdateSchema`. `updateWidgetKeyForApi` (`packages/domain/src/server/publicApi/operations.ts`) answers 400 for an empty body, locks the business's key (404 when missing) and answers 409 for turning a revoked key back on. It compares label, normalized origins, configuration and status with the stored key and returns it unchanged when nothing differs. Otherwise `updateWidgetKeyInTransaction` updates `widget_keys` and an `api.widget_key.updated` audit row follows. Answers 200 `{ data }`. Other methods get 405 `method_not_allowed` (`Allow: PATCH, OPTIONS`), without a key check.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/widgetKeys.ts`.

### Public profile

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/public-profile` | `getPublicProfile` | Get the public profile page | `business:read` | | `apps/admin/app/api/v1/public-profile/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/public-profile` | `updatePublicProfile` | Update or publish the public profile page | `business:write` | | `apps/admin/app/api/v1/public-profile/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/public-profile/route.ts`**

Reads and updates the business's public page at `/profile/<slug>`, including publishing it or taking it down, as Settings > Public profile does. API integrations, the CLI (`lobbystack public-profile get`, `set`, `publish`, `unpublish`, `address`) and `lobbystack onboard` use it.

- `GET /api/v1/public-profile`: Needs `business:read`. `v1.getPublicProfile` calls `getPublicProfileForApi` (`packages/domain/src/server/publicApi/operations.ts`) with the app origin (`APP_BASE_URL` or the request's). `getBusinessPublicProfileSettings` (`packages/domain/src/server/publicProfiles.ts`) reads `business_public_profiles`, or the dashboard's defaults when nothing is saved (the receptionist summary as description, the most recently used active widget key). `serializePublicProfile` adds the page `url`. Answers 200 `{ data }`.
- `PATCH /api/v1/public-profile`: Needs `business:write`. Body: `apiPublicProfileUpdateSchema`. `updatePublicProfileForApi` answers 400 for an empty body, takes the save lock and merges the sent fields over the saved settings or the defaults; a saved page that already has those values comes back unchanged. A widget other than the saved one must be active (400). `savePublicProfileInTransaction` upserts `business_public_profiles`, sets `published_at` whenever the page becomes published and audits publish changes; an `api.public_profile.updated` audit row lists the fields. Answers 200 `{ data }`. POST, PUT and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicProfiles.ts`, `packages/domain/src/server/publicApi/resources.ts`.

### Calendars

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| POST | `https://demo.alloplace.com/api/v1/calendars/google/connect` | `createCalendarConnectLink` | Get a link that connects Google Calendar | `business:write` | Answers 201 | `apps/admin/app/api/v1/calendars/google/connect/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/calendars` | `listCalendarConnections` | List calendar connections | `business:read` | | `apps/admin/app/api/v1/calendars/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/calendars/{connection_id}/calendars` | `listAccountCalendars` | List a connected account's calendars | `business:read` | | `apps/admin/app/api/v1/calendars/[connection_id]/calendars/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/calendars/{connection_id}` | `updateCalendarConnection` | Pick a calendar or a staff member | `business:write` | | `apps/admin/app/api/v1/calendars/[connection_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/calendars/{connection_id}` | `deleteCalendarConnection` | Disconnect a calendar | `business:write` | | `apps/admin/app/api/v1/calendars/[connection_id]/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/calendars/google/connect/route.ts`**

Creates a signed link that starts the Google Calendar consent flow in the dashboard. API integrations and the CLI (`lobbystack calendar connect`) send it to the calendar's owner, because Google needs that person to agree in a browser.

- `POST /api/v1/calendars/google/connect`: Needs `business:write`. `v1.createCalendarConnectLink` answers 403 `forbidden` unless `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and a signing secret (`BETTER_AUTH_SECRET` or `INTERNAL_SERVICE_SECRET`) are set. `createCalendarConnectLinkForApi` calls `createCalendarConnectLink` (`apps/admin/src/lib/google-calendar-oauth.ts`), which builds `/api/calendar/google/connect` on the app origin with the `businessId` and an HMAC-signed `token` valid for 7 days, and writes an `api.calendar.connect_link_created` audit row. Answers 201 `{ data: { url, expires_at } }`. GET, PUT, PATCH and DELETE answer 405 with `Allow: POST, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `apps/admin/src/lib/google-calendar-oauth.ts`, `packages/domain/src/server/publicApi/operations.ts`.

**`apps/admin/app/api/v1/calendars/route.ts`**

Lists the business's Google Calendar connections, the business's own and its staff's, for API integrations and the CLI (`lobbystack calendar list`), showing which calendar each uses and whether it syncs.

- `GET /api/v1/calendars`: Needs `business:read`. `v1.listCalendarConnections` calls `listCalendarConnectionsForApi` (`packages/domain/src/server/publicApi/operations.ts`), which runs `listCalendarConnectionsInTransaction` (`packages/domain/src/server/calendar.ts`): every `calendar_connections` row that isn't disconnected, oldest first. `serializeCalendarConnection` (`resources.ts`) reports any status other than `connected` or `syncing` as `error`. Answers 200 `{ data, next_cursor: null, has_more: false }`, all in one page. POST, PUT, PATCH and DELETE answer 405 with `Allow: GET, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/calendar.ts`.

**`apps/admin/app/api/v1/calendars/[connection_id]/calendars/route.ts`**

Lists the calendars inside one connected Google account, read live from Google, so API integrations and the CLI (`lobbystack calendar calendars`) can pick a writable `calendar_id` for the connection.

- `GET /api/v1/calendars/{connection_id}/calendars`: Needs `business:read`. `v1.listAccountCalendars` checks `connection_id` with `uuidParam`. `listAccountCalendarsForApi` (`packages/domain/src/server/publicApi/operations.ts`) answers 404 for an unknown connection, then `calendarAccess` answers 403 without `ENCRYPTION_KEY` and the Google OAuth settings. `resolveCalendarAccessToken` (`calendar.ts`) refreshes and re-encrypts a token near expiry in `calendar_connections`, and `googleCalendarProvider` lists the calendars, retrying once with a forced refresh after a 401. A connection Google refuses is 409. Answers 200 `{ data: [{ id, name, primary, writable, selected }], next_cursor: null, has_more: false }`. POST, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/calendar.ts`, `apps/admin/src/lib/google-calendar-provider.ts`.

**`apps/admin/app/api/v1/calendars/[connection_id]/route.ts`**

Changes or removes one Google Calendar connection for API integrations and the CLI (`lobbystack calendar set` and `disconnect`): picks the calendar it uses, assigns it to a staff member or the business, or disconnects it.

- `PATCH /api/v1/calendars/{connection_id}`: Needs `business:write`. `v1.updateCalendarConnection` checks `connection_id` with `uuidParam` and the body with `apiCalendarConnectionUpdateSchema` (`calendar_id`, `staff_id`). `updateCalendarConnectionForApi` answers 400 for an empty body and 404 for an unknown connection. A new `calendar_id` is checked with Google through `calendarAccess`: 403 without Google Calendar setup, 409 when Google refuses the connection, 400 if absent or not writable. `selectCalendarInTransaction` and `assignCalendarStaffInTransaction` (`calendar.ts`) update `calendar_connections` (400 for an inactive staff member) and queue `calendar.reconcileBusiness`; changes are audited. Answers 200 `{ data }`.
- `DELETE /api/v1/calendars/{connection_id}`: Needs `business:write`. `v1.deleteCalendarConnection` checks `connection_id` and calls `deleteCalendarConnectionForApi`, which runs `disconnectCalendarInTransaction` (`packages/domain/src/server/calendar.ts`): it marks the connection `disconnected`, clears its stored tokens and deletes its `calendar_busy_blocks`, then writes an `api.calendar_connection.disconnected` audit row. An unknown or already disconnected connection is 404. Answers 200 `{ data: { id, deleted: true } }`. GET, POST and PUT answer 405 with `Allow: PATCH, DELETE, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/calendar.ts`.

### Notifications

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/notification-preferences` | `getNotificationPreferences` | Get alert settings | `business:read` | | `apps/admin/app/api/v1/notification-preferences/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/notification-preferences` | `updateNotificationPreferences` | Change alert settings | `business:write` | | `apps/admin/app/api/v1/notification-preferences/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/notification-preferences/route.ts`**

Reads and changes the email and text alerts that the key's acting account gets about the business, for API integrations and the CLI (`lobbystack alerts get` and `set`). Each team member has their own settings.

- `GET /api/v1/notification-preferences`: Needs `business:read`. `resolveActingUserId` finds the acting account: a platform key's owner, or a per-business key's creator while business_owner or business_admin (else 403 `key_owner_inactive`). `hasVerifiedPhone` (`apps/admin/src/lib/verified-phone.ts`) reads its phone status from the auth database. `getNotificationPreferencesForApi` (`packages/domain/src/server/publicApi/operations.ts`) runs as that account on the app database role: 409 if it isn't on the team, else it reads `operator_notification_preferences`, showing texts off until they can be sent. Answers 200 `{ data }`.
- `PATCH /api/v1/notification-preferences`: Needs `business:write`. Body: `apiNotificationPreferencesUpdateSchema`; the acting account is resolved as for GET. `updateNotificationPreferencesForApi` answers 400 for an empty body or a daily summary without `send_time`, and 409 for turning a text on while `sms.available` is false. Unchanged settings come back as they are; otherwise `saveNotificationPreferencesInTransaction` (`packages/domain/src/server/notifications.ts`) upserts the row and an audit row lists the fields. Answers 200 `{ data }`. POST, PUT and DELETE answer 405 with `Allow: GET, PATCH, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/notifications.ts`, `apps/admin/src/lib/verified-phone.ts`.

### Calls and AI debug traces

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/calls` | `listCalls` | List calls | `calls:read` | Query: `limit`, `cursor`, `started_after`, `started_before` | `apps/admin/app/api/v1/calls/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/calls/{call_id}` | `getCall` | Get a call | `calls:read` | | `apps/admin/app/api/v1/calls/[call_id]/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/ai-traces` | `listAiTraces` | List AI debug traces | `calls:read` | Query: `limit`, `cursor`, `call_id`, `conversation_id`. Kept only while the business's `ai_traces_enabled` setting is on | `apps/admin/app/api/v1/ai-traces/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/ai-traces/{trace_id}` | `getAiTrace` | Get an AI debug trace | `calls:read` | | `apps/admin/app/api/v1/ai-traces/[trace_id]/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/calls/route.ts`**

Lists the receptionist's phone and web calls, newest first, for API integrations and the CLI (`lobbystack calls list`), with each call's outcome, summary, caller and duration.

- `GET /api/v1/calls`: Needs `calls:read`. `v1.listCalls` reads `limit` and `cursor` (`pageQuery`) and the `started_after` and `started_before` timestamps (400 if unparseable). `listCallsForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listCallResources` (`resources.ts`), which reads `calls` joined to their contact, conversation, conversation session and recording `storage_objects` row, newest start first. `serializeCall` derives `outcome`, `summary` and `recording_available`. Answers 200 `{ data, next_cursor, has_more }`. POST, PUT, PATCH and DELETE answer 405 with `Allow: GET, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/calls/[call_id]/route.ts`**

Returns one call with its transcript to API integrations and the CLI (`lobbystack calls get`).

- `GET /api/v1/calls/{call_id}`: Needs `calls:read`. `v1.getCall` checks `call_id` with `uuidParam` and calls `getCallForApi` (`packages/domain/src/server/publicApi/operations.ts`). `loadCallDetailResource` (`resources.ts`) loads the call as the list does, then adds its final `transcripts` lines in order, leaving out lines past their expiry, with speakers mapped to `caller`, `receptionist` or `other`. A missing call is 404. Answers 200 `{ data }`. POST, PUT, PATCH and DELETE answer 405 with `Allow: GET, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/ai-traces/route.ts`**

Lists the AI debug traces of the business's calls and website chats, newest first: what the receptionist's models were given and did on each turn, to find out why it said something (ADR 0009, fork PR #51).

- `GET /api/v1/ai-traces`: Needs `calls:read`. `v1.listAiTraces` reads `limit` and `cursor`, and `call_id` or `conversation_id` to narrow the list (400 unless a UUID). `listAiTracesForApi` (`packages/domain/src/server/publicApi/operations.ts`) reads the business's `ai_traces` rows. Traces are written only while the business's `ai_traces_enabled` setting is on and expire after the `ai_traces` retention period. Each list item leaves out its input, steps, instructions and snapshot. Answers 200 `{ data, next_cursor, has_more }`. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `docs/adr/0009-ai-conversation-traces.md`.

**`apps/admin/app/api/v1/ai-traces/[trace_id]/route.ts`**

Returns one AI debug trace with everything the turn was built from.

- `GET /api/v1/ai-traces/{trace_id}`: Needs `calls:read`. `v1.getAiTrace` checks `trace_id` with `uuidParam` and calls `getAiTraceForApi`, which loads the trace with its input, each model step with its tool calls and results, the instructions and the business snapshot. A missing trace is 404. Answers 200 `{ data }`. Other methods get 405 `method_not_allowed`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`.

### Contacts

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/contacts` | `listContacts` | List contacts | `contacts:read` | Query: `limit`, `cursor`, `phone`, `email`, `name` | `apps/admin/app/api/v1/contacts/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/contacts` | `createContact` | Create a contact | `contacts:write` | `Idempotency-Key` optional; answers 201 | `apps/admin/app/api/v1/contacts/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/contacts/{contact_id}` | `getContact` | Get a contact | `contacts:read` | | `apps/admin/app/api/v1/contacts/[contact_id]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/contacts/{contact_id}` | `updateContact` | Update a contact | `contacts:write` | | `apps/admin/app/api/v1/contacts/[contact_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/contacts/passcodes` | `setContactPasscodes` | Set or remove keypad PINs | `contacts:write` | | `apps/admin/app/api/v1/contacts/passcodes/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/contacts/passcodes/generate` | `generateContactPasscodes` | Generate keypad PINs | `contacts:write` | | `apps/admin/app/api/v1/contacts/passcodes/generate/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/contacts/route.ts`**

Lists and creates the business's contacts for API integrations and the CLI (`lobbystack contacts list` and `add`), with search by phone, email or name.

- `GET /api/v1/contacts`: Needs `contacts:read`. `v1.listContacts` reads `limit` and `cursor` (`pageQuery`), `phone`, `email` and `name` (up to 200 characters, else 400). `listContactsForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listContactResources` (`resources.ts`): `contacts` left-joined to `contact_passcodes` (never the hash), with an exact phone, a case-insensitive email and a substring name match, newest first. Answers 200 `{ data, next_cursor, has_more }`.
- `POST /api/v1/contacts`: Needs `contacts:write`; honors `Idempotency-Key`. `readApiBody` checks `apiContactCreateSchema` (a phone or an email is required). `createContactForApi` answers 400 for an unknown IANA `timezone` and 409 for a phone number already in use, inserts the `contacts` row, writes an `api.contact.created` audit row and emits `contact.created` through `emitWebhookEventInTransaction` (`webhooks.ts`), which stores a `webhook_events` row and queues a `webhook.deliver` outbox message per subscribed endpoint. Answers 201 `{ data }`. PUT, PATCH and DELETE answer 405 with `Allow: GET, POST, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`, `packages/domain/src/server/publicApi/webhooks.ts`.

**`apps/admin/app/api/v1/contacts/[contact_id]/route.ts`**

Reads and edits one contact for API integrations and the CLI (`lobbystack contacts get` and `update`).

- `GET /api/v1/contacts/{contact_id}`: Needs `contacts:read`. `v1.getContact` checks `contact_id` with `uuidParam` and calls `getContactForApi` (`packages/domain/src/server/publicApi/operations.ts`), which loads the contact with its PIN status (never the hash) through `loadContactResource` (`resources.ts`). A missing contact is 404. Answers 200 `{ data }`.
- `PATCH /api/v1/contacts/{contact_id}`: Needs `contacts:write`. `v1.updateContact` checks `contact_id` and the body with `apiContactUpdateSchema`. `updateContactForApi` answers 400 for an unknown IANA `timezone` or a body with no fields, updates the `contacts` row (404 if missing, 409 if another contact has the phone number) and writes an `api.contact.updated` audit row listing the fields. Answers 200 `{ data }` with the reloaded contact. POST, PUT and DELETE answer 405 with `Allow: GET, PATCH, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/contacts/passcodes/route.ts`**

Sets or removes contacts' keypad PINs in bulk. Callers type the PIN to change appointments by phone when verification needs a passcode. API integrations and the CLI (`lobbystack contacts set-pins`) use it.

- `POST /api/v1/contacts/passcodes`: Needs `contacts:write`; `resolveActingUserId` gives a per-business key whose creator is no longer business_owner or business_admin 403 `key_owner_inactive`. `readApiBody` checks `apiContactPasscodesUpdateSchema` (1 to 100 `{ contact_id, passcode }`, null removes). `setContactPasscodesForApi` answers 400 for repeated or foreign contacts and weak PINs, scrypt-hashes the PINs (`hashContactPasscodes` in `contactPasscodes.ts`), then upserts or deletes `contact_passcodes` rows and audits each contact. It ignores `Idempotency-Key`. Answers 200 `{ data, next_cursor: null, has_more: false }` with the contacts in the order sent. GET, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/contactPasscodes.ts`.

**`apps/admin/app/api/v1/contacts/passcodes/generate/route.ts`**

Gives contacts random keypad PINs and returns each PIN once, since only a hash is stored, for API integrations and the CLI (`lobbystack contacts generate-pins`).

- `POST /api/v1/contacts/passcodes/generate`: Needs `contacts:write`; a per-business key whose creator is no longer business_owner or business_admin gets 403 `key_owner_inactive`. Body: `apiContactPasscodesGenerateSchema` (optional `contact_ids`, `length` 4 to 8). `generateContactPasscodesForApi` takes the named contacts (400 if repeated or unknown) or up to 100 contacts with a phone and no PIN, oldest first, scrypt-hashes random PINs, saves them in `contact_passcodes` (replacing PINs only for named contacts) and audits each. It ignores `Idempotency-Key`. Answers 200 `{ data: { contacts, remaining } }`, each contact with `new_passcode`, marked no-store. GET, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/contactPasscodes.ts`.

### Appointments

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/appointments` | `listAppointments` | List appointments | `appointments:read` | Query: `limit`, `cursor`, `status`, `starts_after`, `starts_before`, `contact_id` | `apps/admin/app/api/v1/appointments/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/availability` | `getAvailability` | List open appointment times | `appointments:read` | Query: `service_id`, `start_date`, `end_date`, `staff_id` | `apps/admin/app/api/v1/availability/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/appointments` | `createAppointment` | Book an appointment | `appointments:write` | `Idempotency-Key` optional; answers 201 | `apps/admin/app/api/v1/appointments/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/appointments/{appointment_id}` | `getAppointment` | Get an appointment | `appointments:read` | | `apps/admin/app/api/v1/appointments/[appointment_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/appointments/{appointment_id}/cancel` | `cancelAppointment` | Cancel an appointment | `appointments:write` | | `apps/admin/app/api/v1/appointments/[appointment_id]/cancel/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/appointments/{appointment_id}/reschedule` | `rescheduleAppointment` | Reschedule an appointment | `appointments:write` | | `apps/admin/app/api/v1/appointments/[appointment_id]/reschedule/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/appointments/route.ts`**

Lists and books appointments for API integrations and the CLI (`lobbystack appointments list` and `book`). Booking follows the receptionist's rules: instant booking mode, an open slot, and the same confirmation texts, calendar sync and webhook events.

- `GET /api/v1/appointments`: Needs a key with `appointments:read`. `v1.listAppointments` (`apps/admin/src/lib/public-api/routes.ts`) reads `limit` and `cursor` (`pageQuery`), `status` (`confirmed` or `cancelled`), `starts_after`, `starts_before` and a UUID `contact_id`; bad values are 400. `listAppointmentsForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listAppointmentResources` (`resources.ts`), which reads `appointments` joined to their service, staff member and contact, newest booking first. Answers 200 `{ data, next_cursor, has_more }`.
- `POST /api/v1/appointments`: Needs `appointments:write`; honors `Idempotency-Key`. `readApiBody` checks `apiAppointmentCreateSchema`. `createAppointmentForApi` refuses a past `starts_at` or a bad contact or staff member (400) and any booking mode but instant (409 `booking_disabled` or `booking_requires_confirmation`). `bookAppointment` (`packages/domain/src/server/booking.ts`) then finds or creates the contact, inserts `appointments` plus a confirmation (and, over a day ahead, a reminder) in `notifications`, queues calendar sync, realtime and text outbox messages, and emits `appointment.booked`. A taken slot is 409 `slot_unavailable`. Answers 201 `{ data }`. PUT, PATCH and DELETE answer 405 with `Allow: GET, POST, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/booking.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/availability/route.ts`**

Lists open start times for one service over up to seven days, so API integrations and the CLI (`lobbystack appointments availability`) can offer slots before booking.

- `GET /api/v1/availability`: Needs `appointments:read`. `v1.getAvailability` requires a UUID `service_id` and a `start_date`, and takes `end_date` and a UUID `staff_id` (400 otherwise). `getAvailabilityForApi` (`packages/domain/src/server/publicApi/operations.ts`) answers 400 for an inactive service, staff who don't take it, bad dates or a range over 7 days. It builds future 30-minute starts within `business_hours` (`candidateStartTimes`) and checks each with `findAvailability` (`packages/domain/src/server/booking.ts`), six at a time. Answers 200 `{ data: [{ starts_at, ends_at }], next_cursor: null, has_more: false }`. POST, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/booking.ts`, `packages/domain/src/server/receptionistActions.ts`.

**`apps/admin/app/api/v1/appointments/[appointment_id]/route.ts`**

Returns one appointment to API integrations and the CLI (`lobbystack appointments get`), with its service, staff member, contact and calendar sync status.

- `GET /api/v1/appointments/{appointment_id}`: Needs a key with `appointments:read`. `v1.getAppointment` (`apps/admin/src/lib/public-api/routes.ts`) checks `appointment_id` with `uuidParam` (400 if not a UUID) and calls `getAppointmentForApi` (`packages/domain/src/server/publicApi/operations.ts`), which loads the row with `loadAppointmentResource` (`resources.ts`) from `appointments` joined to services, staff and contacts. A missing appointment is 404. Answers 200 `{ data }`. POST, PUT, PATCH and DELETE answer 405 `method_not_allowed` with `Allow: GET, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/appointments/[appointment_id]/cancel/route.ts`**

Cancels an appointment for API integrations and the CLI (`lobbystack appointments cancel`), with the same side effects as a dashboard cancellation: reminders skipped, the customer's cancellation text, calendar removal and a webhook event.

- `POST /api/v1/appointments/{appointment_id}/cancel`: Needs `appointments:write`. `v1.cancelAppointment` checks `appointment_id` with `uuidParam` and calls `cancelAppointmentForApi`, which runs `cancelAppointmentInTransaction` (`packages/domain/src/server/booking.ts`). That closes open cancellation requests in `inbox_items`, sets the appointment to `canceled`, audits, skips pending reminders, queues a cancellation text for a future appointment plus `calendar.syncAppointment` and `realtime.publish` outbox messages, and emits `appointment.cancelled`. An appointment already cancelled comes back unchanged; a missing one is 404. Answers 200 `{ data }`. GET, PUT, PATCH and DELETE answer 405 with `Allow: POST, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/booking.ts`.

**`apps/admin/app/api/v1/appointments/[appointment_id]/reschedule/route.ts`**

Moves an appointment to a new open time, optionally to another staff member, for API integrations and the CLI (`lobbystack appointments reschedule`).

- `POST /api/v1/appointments/{appointment_id}/reschedule`: Needs `appointments:write`. `v1.rescheduleAppointment` checks `appointment_id` with `uuidParam` and the body with `apiAppointmentRescheduleSchema` (`starts_at`, optional `staff_id`). `rescheduleAppointmentForApi` answers 400 for a past time or bad staff, 404 for a missing appointment, and 409 outside instant booking mode, for a cancelled appointment, or for a staff move when either has a connected calendar. `rescheduleAppointmentInTransaction` (`packages/domain/src/server/booking.ts`) rechecks the slot (409 `slot_unavailable`), updates `appointments`, moves the reminder, audits, queues calendar sync and realtime outbox messages and emits `appointment.rescheduled`. Answers 200 `{ data }`. GET, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/booking.ts`.

### Messages

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/messages` | `listMessages` | List messages | `messages:read` | Query: `limit`, `cursor`, `status` | `apps/admin/app/api/v1/messages/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/messages/route.ts`**

Lists the messages the receptionist took for the team, newest first, for API integrations and the CLI (`lobbystack messages list`).

- `GET /api/v1/messages`: Needs `messages:read`. `v1.listMessages` reads `limit` and `cursor` (`pageQuery`) and `status` (`open` or `done`, else 400). `listMessagesForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listMessageResources` (`resources.ts`), which reads `inbox_items` of kind `voice_message`, newest first. `serializeMessage` takes the caller, callback and urgency fields from the item's metadata and withholds content past its retention date, as the dashboard does. Answers 200 `{ data, next_cursor, has_more }`. POST, PUT, PATCH and DELETE answer 405 with `Allow: GET, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/publicApi/resources.ts`.

### Knowledge

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/knowledge` | `listKnowledgeEntries` | List knowledge entries | `knowledge:read` | Query: `limit`, `cursor`, `type` | `apps/admin/app/api/v1/knowledge/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge` | `createKnowledgeEntry` | Add a knowledge entry | `knowledge:write` | `Idempotency-Key` optional; answers 201 | `apps/admin/app/api/v1/knowledge/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/knowledge/{entry_id}` | `getKnowledgeEntry` | Get a knowledge entry | `knowledge:read` | | `apps/admin/app/api/v1/knowledge/[entry_id]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/knowledge/{entry_id}` | `updateKnowledgeEntry` | Update a knowledge entry | `knowledge:write` | | `apps/admin/app/api/v1/knowledge/[entry_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/knowledge/{entry_id}` | `deleteKnowledgeEntry` | Delete a knowledge entry | `knowledge:write` | | `apps/admin/app/api/v1/knowledge/[entry_id]/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/knowledge/sources` | `listKnowledgeSources` | List knowledge sources | `knowledge:read` | Query: `limit`, `cursor`, `type`, `status` | `apps/admin/app/api/v1/knowledge/sources/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge/sources` | `createKnowledgeSource` | Add a website | `knowledge:write` | Answers 202; the work finishes in the background | `apps/admin/app/api/v1/knowledge/sources/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/knowledge/sources/{source_id}` | `getKnowledgeSource` | Get a knowledge source | `knowledge:read` | | `apps/admin/app/api/v1/knowledge/sources/[source_id]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/knowledge/sources/{source_id}` | `updateKnowledgeSource` | Turn a knowledge source off or on | `knowledge:write` | | `apps/admin/app/api/v1/knowledge/sources/[source_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/knowledge/sources/{source_id}` | `deleteKnowledgeSource` | Delete a knowledge source | `knowledge:write` | | `apps/admin/app/api/v1/knowledge/sources/[source_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge/sources/{source_id}/expand` | `expandKnowledgeSource` | Read the rest of a website | `knowledge:write` | Answers 202; the work finishes in the background | `apps/admin/app/api/v1/knowledge/sources/[source_id]/expand/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge/sources/{source_id}/retry` | `retryKnowledgeSource` | Read a source again | `knowledge:write` | Answers 202; the work finishes in the background | `apps/admin/app/api/v1/knowledge/sources/[source_id]/retry/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge/uploads` | `createKnowledgeUpload` | Start a file upload | `knowledge:write` | Answers 201 | `apps/admin/app/api/v1/knowledge/uploads/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge/uploads/{upload_id}/complete` | `completeKnowledgeUpload` | Finish a file upload | `knowledge:write` | Answers 202; the work finishes in the background | `apps/admin/app/api/v1/knowledge/uploads/[upload_id]/complete/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/knowledge/sources/{source_id}/cancel` | `cancelKnowledgeSource` | Stop reading a source | `knowledge:write` | | `apps/admin/app/api/v1/knowledge/sources/[source_id]/cancel/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/knowledge/route.ts`**

Lists and adds knowledge entries, the text entries and FAQs the receptionist answers from, for API integrations, the CLI (`lobbystack knowledge list`, `add-text`, `add-faq`) and `lobbystack onboard`.

- `GET /api/v1/knowledge`: Needs `knowledge:read`. `v1.listKnowledgeEntries` reads `limit` and `cursor` (`pageQuery`) and `type` (`text` or `faq`, else 400). `listKnowledgeEntriesForApi` (`packages/domain/src/server/publicApi/operations.ts`) calls `listKnowledgeEntryResources` (`resources.ts`), which reads `knowledge_snippets` newest first; a snippet tagged `faq` is shown as an FAQ. Answers 200 `{ data, next_cursor, has_more }`.
- `POST /api/v1/knowledge`: Needs `knowledge:write`; honors `Idempotency-Key`. `readApiBody` checks `apiKnowledgeEntryCreateSchema`: `type` `text` with `title` and `content`, or `faq` with `question` and `answer`. `createKnowledgeEntryForApi` calls `createKnowledgeSnippetInTransaction` (`packages/domain/src/server/knowledge.ts`), which inserts the `knowledge_snippets` row (an FAQ gets the `faq` tag) and queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours` outbox messages, then writes an `api.knowledge.created` audit row. Answers 201 `{ data }`. PUT, PATCH and DELETE answer 405 with `Allow: GET, POST, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/knowledge/[entry_id]/route.ts`**

Reads, edits and deletes one knowledge entry for API integrations and the CLI (`lobbystack knowledge get`, `update`, `remove`); `lobbystack onboard` also updates entries through it.

- `GET /api/v1/knowledge/{entry_id}`: Needs `knowledge:read`. `v1.getKnowledgeEntry` checks `entry_id` with `uuidParam`; `getKnowledgeEntryForApi` (`packages/domain/src/server/publicApi/operations.ts`) loads the `knowledge_snippets` row (404 if missing). Answers 200 `{ data }`.
- `PATCH /api/v1/knowledge/{entry_id}`: Needs `knowledge:write`. Body: `apiKnowledgeEntryUpdateSchema` (`title`, `content`, `tags`, `priority`, `active`). `updateKnowledgeEntryForApi` answers 400 for an empty body, locks the row (404 if missing) and keeps an FAQ's `faq` tag. Unchanged values return the entry as it is; otherwise `updateKnowledgeSnippetInTransaction` (`knowledge.ts`) updates it and queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours`, and an `api.knowledge.updated` audit row lists the fields. Answers 200 `{ data }`.
- `DELETE /api/v1/knowledge/{entry_id}`: Needs `knowledge:write`. `v1.deleteKnowledgeEntry` checks `entry_id`; `deleteKnowledgeEntryForApi` calls `deleteKnowledgeSnippetInTransaction` (`packages/domain/src/server/knowledge.ts`), which deletes the `knowledge_snippets` row and queues the same snapshot, summary and hours refreshes, then writes an `api.knowledge.deleted` audit row. A missing entry is 404. Answers 200 `{ data: { id, deleted: true } }`. POST and PUT answer 405 with `Allow: GET, PATCH, DELETE, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`.

**`apps/admin/app/api/v1/knowledge/sources/route.ts`**

Lists knowledge sources (websites, the pages their crawls read, and uploaded files) and adds a website to crawl, for API integrations, the CLI (`lobbystack knowledge sources` and `add-website`) and `lobbystack onboard`.

- `GET /api/v1/knowledge/sources`: Needs `knowledge:read`. `v1.listKnowledgeSources` reads `limit` and `cursor` (`pageQuery`), `type` (`website`, `page`, `file`) and `status` (`pending`, `processing`, `indexed`, `error`, `cancelled`); other values are 400. `listKnowledgeSourcesForApi` calls `listKnowledgeSourceResources` (`packages/domain/src/server/publicApi/resources.ts`), which reads `knowledge_documents` left-joined to `website_ingestion_jobs` (a website has a crawl job, a page has none), newest first. Answers 200 `{ data, next_cursor, has_more }`.
- `POST /api/v1/knowledge/sources`: Needs `knowledge:write`. Body: `apiKnowledgeSourceCreateSchema` (`type` `website`, `url`). `createKnowledgeSourceForApi` normalizes the URL (400 if invalid). A page an earlier crawl read is 409. An existing website comes back as it is, re-queued at its page limit if its last crawl failed or was cancelled. Otherwise `createKnowledgeDocumentInTransaction` (`packages/domain/src/server/knowledge.ts`) inserts `knowledge_documents` and a 10-page `website_ingestion_jobs` row, sets the business website during onboarding's website step, and queues `knowledge.crawlWebsite`. Answers 202 `{ data }`. PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/knowledge/sources/[source_id]/route.ts`**

Reads, turns off or on, and deletes one knowledge source for API integrations and the CLI (`lobbystack knowledge source`, `source-update`, `source-remove`); the CLI's `--wait` polling and `lobbystack onboard` read it too.

- `GET /api/v1/knowledge/sources/{source_id}`: Needs `knowledge:read`. `v1.getKnowledgeSource` checks `source_id` with `uuidParam`; `getKnowledgeSourceForApi` (`packages/domain/src/server/publicApi/operations.ts`) loads it with `loadKnowledgeSourceResource` (`resources.ts`) from `knowledge_documents` and its crawl job (404 if missing). Answers 200 `{ data }`.
- `PATCH /api/v1/knowledge/sources/{source_id}`: Needs `knowledge:write`. Body: `apiKnowledgeSourceUpdateSchema` (`active`, required). `updateKnowledgeSourceForApi` locks the `knowledge_documents` row (404 if missing). When `active` changes, `setKnowledgeDocumentActiveInTransaction` (`knowledge.ts`) updates it and queues `snapshot.refresh`, `business.generateSummary` and `business.extractHours`, and an `api.knowledge_source.updated` audit row is written; the current value changes nothing. Answers 200 `{ data }`.
- `DELETE /api/v1/knowledge/sources/{source_id}`: Needs `knowledge:write`. `v1.deleteKnowledgeSource` checks `source_id`; `deleteKnowledgeSourceForApi` calls `deleteKnowledgeDocumentInTransaction` (`packages/domain/src/server/knowledge.ts`), which deletes the source's `knowledge_chunks` and its `knowledge_documents` row and queues the snapshot, summary and hours refreshes, then writes an `api.knowledge_source.deleted` audit row. A missing source is 404. Answers 200 `{ data: { id, deleted: true } }`. POST and PUT answer 405 with `Allow: GET, PATCH, DELETE, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`, `packages/domain/src/server/publicApi/resources.ts`.

**`apps/admin/app/api/v1/knowledge/sources/[source_id]/expand/route.ts`**

Crawls the rest of a website whose first crawl read only a sample, for API integrations, the CLI (`lobbystack knowledge expand`) and `lobbystack onboard`.

- `POST /api/v1/knowledge/sources/{source_id}/expand`: Needs `knowledge:write`. `v1.expandKnowledgeSource` checks `source_id` with `uuidParam`. `expandKnowledgeSourceForApi` goes through `changeKnowledgeSource` (`packages/domain/src/server/publicApi/operations.ts`): 404 for a missing source, 400 for a page. `expandWebsiteCrawlInTransaction` (`knowledge.ts`) refuses a file (400), sets the document back to `processing`, resets its `website_ingestion_jobs` row to the full 50-page limit and queues `knowledge.crawlWebsite`. An `api.knowledge_source.expanded` audit row is written. Answers 202 `{ data }`. GET, PUT, PATCH and DELETE answer 405 with `Allow: POST, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`.

**`apps/admin/app/api/v1/knowledge/sources/[source_id]/retry/route.ts`**

Reads a website or file source again at the page limit it last used, for example after a failure, for API integrations, the CLI (`lobbystack knowledge retry`) and `lobbystack onboard`.

- `POST /api/v1/knowledge/sources/{source_id}/retry`: Needs `knowledge:write`. `v1.retryKnowledgeSource` checks `source_id` with `uuidParam`. `retryKnowledgeSourceForApi` goes through `changeKnowledgeSource` (`packages/domain/src/server/publicApi/operations.ts`): 404 for a missing source, 400 for a page, 409 while it is `processing`. `retryKnowledgeDocumentInTransaction` (`knowledge.ts`) resets the document's status and error, re-queues a website's `website_ingestion_jobs` row at its last page limit, and queues `knowledge.crawlWebsite`, or `knowledge.extractDocument` for a file. An `api.knowledge_source.retried` audit row is written. Answers 202 `{ data }`. GET, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`.

**`apps/admin/app/api/v1/knowledge/uploads/route.ts`**

First step of a document upload: reserves a storage object and returns a signed URL to PUT the file to. API integrations, the CLI (`lobbystack knowledge upload`) and `lobbystack onboard` use it.

- `POST /api/v1/knowledge/uploads`: Needs `knowledge:write`. Body: `apiKnowledgeUploadCreateSchema` (`file_name`, an allowed `content_type`, `length` up to 10 MB, base64 `checksum_sha256`). `createKnowledgeUploadForApi` names the object with `planUpload`, inserts a `pending` `storage_objects` row that expires after a day (`insertPendingUploadInTransaction` in `packages/domain/src/server/storage.ts`) and audits it, then asks the storage backend from `getStorageProvider` (local or S3) for a signed upload URL. Answers 201 `{ data: { upload_id, upload_url, upload_headers, expires_at } }`. GET, PUT, PATCH and DELETE answer 405 with `Allow: POST, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/storage.ts`, `apps/admin/src/lib/storage.ts`.

**`apps/admin/app/api/v1/knowledge/uploads/[upload_id]/complete/route.ts`**

Second step of a document upload: checks the stored file and turns it into a file knowledge source queued for reading. API integrations, the CLI (`lobbystack knowledge upload`) and `lobbystack onboard` use it.

- `POST /api/v1/knowledge/uploads/{upload_id}/complete`: Needs `knowledge:write`. `v1.completeKnowledgeUpload` checks `upload_id` with `uuidParam` and the body with `apiKnowledgeUploadCompleteSchema` (`title`, `tags`; `{}` for neither). `completeKnowledgeUploadForApi` reads the `storage_objects` row (404 if missing or expired; a completed upload returns its source) and calls the storage backend's `headObject`: 409 if the file hasn't arrived, 400 if size, type or checksum differ. `completeUploadInTransaction` (`storage.ts`) answers 409 `plan_limit_reached` for a full plan, marks the object `ready`, inserts `knowledge_documents` and queues `knowledge.extractDocument`. Answers 202 `{ data }`. GET, PUT, PATCH and DELETE answer 405.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/storage.ts`, `apps/admin/src/lib/storage.ts`.

**`apps/admin/app/api/v1/knowledge/sources/[source_id]/cancel/route.ts`**

Stops a website crawl or file read that is still processing, for API integrations and the CLI (`lobbystack knowledge cancel`).

- `POST /api/v1/knowledge/sources/{source_id}/cancel`: Needs `knowledge:write`. `v1.cancelKnowledgeSource` checks `source_id` with `uuidParam`. `cancelKnowledgeSourceForApi` goes through `changeKnowledgeSource` (`packages/domain/src/server/publicApi/operations.ts`): 404 for a missing source, 400 for a page. `cancelKnowledgeDocumentInTransaction` (`knowledge.ts`) sets a `processing` document to `cancelled` and marks its `website_ingestion_jobs` row cancelled; any other status is 409. An `api.knowledge_source.cancelled` audit row is written. Answers 200 `{ data }` with the source. GET, PUT, PATCH and DELETE answer 405 with `Allow: POST, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/operations.ts`, `packages/domain/src/server/knowledge.ts`.

### Webhooks

| Method | Address | Operation | What it does | Scope | Notes | Entry file |
|---|---|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/webhooks` | `listWebhooks` | List webhook endpoints | `webhooks:manage` | | `apps/admin/app/api/v1/webhooks/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/webhooks` | `createWebhook` | Create a webhook endpoint | `webhooks:manage` | Answers 201 | `apps/admin/app/api/v1/webhooks/route.ts` |
| GET | `https://demo.alloplace.com/api/v1/webhooks/{webhook_id}` | `getWebhook` | Get a webhook endpoint | `webhooks:manage` | | `apps/admin/app/api/v1/webhooks/[webhook_id]/route.ts` |
| PATCH | `https://demo.alloplace.com/api/v1/webhooks/{webhook_id}` | `updateWebhook` | Update a webhook endpoint | `webhooks:manage` | | `apps/admin/app/api/v1/webhooks/[webhook_id]/route.ts` |
| DELETE | `https://demo.alloplace.com/api/v1/webhooks/{webhook_id}` | `deleteWebhook` | Delete a webhook endpoint | `webhooks:manage` | | `apps/admin/app/api/v1/webhooks/[webhook_id]/route.ts` |
| POST | `https://demo.alloplace.com/api/v1/webhooks/{webhook_id}/test` | `testWebhook` | Send a test event | `webhooks:manage` | Answers 202; the work finishes in the background | `apps/admin/app/api/v1/webhooks/[webhook_id]/test/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/webhooks/route.ts`**

Lists and creates webhook endpoints that receive call, appointment, message and contact events, for API integrations and the CLI (`lobbystack webhooks list` and `add`).

- `GET /api/v1/webhooks`: Needs `webhooks:manage`. `v1.listWebhooks` calls `listWebhookEndpoints` (`packages/domain/src/server/publicApi/webhooks.ts`), which reads every `webhook_endpoints` row of the business, newest first, whoever created it; `toApiEndpoint` in routes.ts drops the failure counters. Answers 200 `{ data, next_cursor: null, has_more: false }`.
- `POST /api/v1/webhooks`: Needs `webhooks:manage` plus the read scope each event carries, such as `calls:read` for `call.completed` (else 403 `insufficient_scope`). Body: `apiWebhookEndpointCreateSchema` (`url`, `events`, `description`). `createWebhookEndpoint` (`webhooks.ts`) requires an https URL on a public host (400), takes a per-business lock, refuses more than 20 endpoints (409), inserts the row with an AES-GCM encrypted `whsec_` secret and the creating key, and audits. It ignores `Idempotency-Key`. Answers 201 `{ data }` with `secret`, shown only here. PUT, PATCH and DELETE answer 405 with `Allow: GET, POST, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/webhooks.ts`, `packages/domain/src/server/publicApi/webhookNetwork.ts`.

**`apps/admin/app/api/v1/webhooks/[webhook_id]/route.ts`**

Reads, changes and deletes one webhook endpoint for API integrations and the CLI (`lobbystack webhooks get`, `update`, `remove`), including re-enabling an endpoint that was disabled after failed deliveries.

- `GET /api/v1/webhooks/{webhook_id}`: Needs `webhooks:manage`. `v1.getWebhook` checks `webhook_id` with `uuidParam` and calls `getWebhookEndpoint` (`packages/domain/src/server/publicApi/webhooks.ts`), which reads the business's `webhook_endpoints` row (404 if missing). Answers 200 `{ data }` without the secret.
- `PATCH /api/v1/webhooks/{webhook_id}`: Needs `webhooks:manage`. Body: `apiWebhookEndpointUpdateSchema` (`url`, `events`, `description`, `status`). A new `url` or `events` also needs the read scope of every event, new or saved (403 `insufficient_scope`). `updateWebhookEndpoint` (`webhooks.ts`) checks the URL (400) and updates the row: `enabled` clears the disabled reason and failure count, `disabled` marks it manual. It writes a `webhook_endpoint.updated` audit row; a missing endpoint is 404. Answers 200 `{ data }`. An empty body `{}` is accepted too: it only touches `updated_at` and writes an audit row naming no fields, where most other v1 PATCH operations answer 400.
- `DELETE /api/v1/webhooks/{webhook_id}`: Needs `webhooks:manage`. `v1.deleteWebhook` checks `webhook_id`; `deleteWebhookEndpoint` (`packages/domain/src/server/publicApi/webhooks.ts`) deletes the `webhook_endpoints` row (404 if missing) and writes a `webhook_endpoint.deleted` audit row. Answers 200 `{ data: { id, deleted: true } }`. POST and PUT answer 405 with `Allow: GET, PATCH, DELETE, HEAD, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/webhooks.ts`.

**`apps/admin/app/api/v1/webhooks/[webhook_id]/test/route.ts`**

Sends a `webhook.test` event to one endpoint, so API integrations and the CLI (`lobbystack webhooks test`) can check that the endpoint receives and verifies signed deliveries.

- `POST /api/v1/webhooks/{webhook_id}/test`: Needs `webhooks:manage`. `v1.testWebhook` checks `webhook_id` with `uuidParam` and calls `sendWebhookTestEvent` (`packages/domain/src/server/publicApi/webhooks.ts`). It reads the deployment's app name, checks the endpoint exists (404), and inserts a `webhook.test` row in `webhook_events` and a `webhook_deliveries` row with a `webhook.deliver` outbox message for the worker, whether or not the endpoint is subscribed or enabled. Answers 202 `{ data: { event_id, delivery_id } }`. GET, PUT, PATCH and DELETE answer 405 with `Allow: POST, OPTIONS`.

Related files: `apps/admin/src/lib/public-api/routes.ts`, `packages/domain/src/server/publicApi/webhooks.ts`.

### OpenAPI document

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/v1/openapi.json` | The OpenAPI document for every operation above, with this deployment's address and name | Public | `apps/admin/app/api/v1/openapi.json/route.ts` |
| GET, POST, PUT, PATCH, DELETE | `https://demo.alloplace.com/api/v1/{anything else}` | An address under `/api/v1` that isn't listed: 404 `not_found` in the API's error format | Public | `apps/admin/app/api/v1/[...path]/route.ts` |

#### Entry files

**`apps/admin/app/api/v1/openapi.json/route.ts`**

Serves the v1 OpenAPI 3.1 document without authentication, for API documentation, client generators and developers integrating with this deployment.

- `GET /api/v1/openapi.json`: Anyone may call it: no key, scope or rate limit. The server URL is `APP_BASE_URL` (trailing slash removed) or the request origin, plus `/api/v1`; the title uses the app name from `loadBranding` (`apps/admin/src/lib/branding.ts`). `buildOpenApiDocument` (`packages/shared/src/publicApi/operations.ts`) builds paths, scopes, parameters and error responses from `apiOperations`, component schemas from the zod schemas with `z.toJSONSchema`, and the webhook event payloads. Answers 200 JSON with `Access-Control-Allow-Origin: *`. The handler also sets `Cache-Control: public, max-age=300`, but the proxy has already set `private, no-store` on every `/api/` response and Next.js keeps a header that is already set, so clients most likely get `private, no-store` (not tested). POST, PUT, PATCH and DELETE answer 405 `method_not_allowed`.

Related files: `packages/shared/src/publicApi/operations.ts`, `apps/admin/src/lib/branding.ts`, `apps/admin/src/lib/public-api/http.ts`.

**`apps/admin/app/api/v1/[...path]/route.ts`**

Catch-all for addresses under `/api/v1/` that no other v1 route file matches, so API clients and the `lobbystack` CLI get a JSON error in the v1 format instead of the Next.js 404 page.

- `ALL /api/v1/[...path]`: Anyone can reach it: it checks no key, scope or rate limit. Next.js tries every more specific v1 route first, so only unknown paths land here. GET, POST, PUT, PATCH and DELETE are all bound to a local `notFound` function that calls `apiError` from `apps/admin/src/lib/public-api/http.ts`. Every method answers 404 `not_found` in the v1 error shape `{ error: { code, message } }`, with a message that points to `/api/v1/openapi.json`.

Related files: `apps/admin/src/lib/public-api/http.ts`.

## 10. MCP server and OAuth discovery

The MCP server lets AI assistants (Claude, ChatGPT, Cursor and others) work with a business. Address: `https://demo.alloplace.com/api/mcp`, Streamable HTTP without sessions; GET, POST and DELETE all reach the same handler. Only POST carries MCP messages: once a request passes the sign-in checks, GET and DELETE answer 405.

- **Sign-in.** An OAuth access token (`Bearer lsa_...`) from connecting the assistant, or a business API key (`Bearer lsk_...`). A browser request from any origin other than the app's own is refused.
- **Scopes and limits.** The connection needs at least one scope besides `webhooks:manage`, and each tool needs its scope. Tool calls count against the same per-key limit as the v1 API.
- **Docs today:** `ai/mcp.mdx`, `ai/connect-claude.mdx`, `ai/connect-chatgpt.mdx`, `ai/connect-other-clients.mdx`.
- **Entry file:** `apps/admin/app/api/mcp/route.ts`; the tools are defined in `apps/admin/src/lib/mcp/tools.ts`.

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET, POST, DELETE | `https://demo.alloplace.com/api/mcp` | The MCP endpoint | OAuth token or API key | `apps/admin/app/api/mcp/route.ts` |

### Entry file

**`apps/admin/app/api/mcp/route.ts`**

The MCP server (Streamable HTTP, stateless) that AI clients such as Claude Code or Cursor connect to. It exposes the v1 API's business, call, contact, appointment, message and knowledge operations as tools acting for one business.

- `GET, POST, DELETE /api/mcp`: The proxy's CSRF check skips `/api/mcp`. `createLobbyStackMcpHttpHandler` (`apps/admin/src/lib/mcp/handler.ts`) refuses an `Origin` outside the configured app URLs (403 `forbidden`) and needs `Authorization: Bearer`: an `lsa_` OAuth token resolves through `resolveOAuthAccessToken` (active grant of a business_owner or business_admin, audience `/api/mcp`), anything else through `resolveApiKey` (`lsk_` keys only). Missing or invalid gives 401 with a `WWW-Authenticate` challenge naming the resource metadata; no tool scope gives 403 `insufficient_scope`. The SDK's `createMcpHandler` builds a server per request holding only the tools those scopes allow; GET and DELETE (2025-era session requests) get 405. Each tool call counts against the credential's per-minute limit (`enforceApiRateLimit`: 120 unless `PUBLIC_API_RATE_LIMIT_PER_MINUTE` is set; over it, a `rate_limited` error result) and calls its v1 domain function (such as `createAppointmentForApi`) on the worker role, sharing idempotency records with REST.

Related files: `apps/admin/src/lib/mcp/handler.ts`, `apps/admin/src/lib/mcp/server.ts`, `apps/admin/src/lib/mcp/tools.ts`, `packages/domain/src/server/oauth/tokens.ts`.

### MCP tools

Each tool does what the v1 operation in **Same as** does.

| Tool | What it does | Same as | Scope |
|---|---|---|---|
| `get_business` | Get business profile | GET `/api/v1/business` | `business:read` |
| `list_services` | List services | GET `/api/v1/services` | `business:read` |
| `list_staff` | List staff | GET `/api/v1/staff` | `business:read` |
| `update_business_hours` | Replace opening hours | PATCH `/api/v1/business` | `business:write` |
| `list_calls` | List calls | GET `/api/v1/calls` | `calls:read` |
| `get_call` | Get a call with transcript | GET `/api/v1/calls/{call_id}` | `calls:read` |
| `search_contacts` | Search contacts | GET `/api/v1/contacts` | `contacts:read` |
| `get_contact` | Get a contact | GET `/api/v1/contacts/{contact_id}` | `contacts:read` |
| `create_contact` | Create a contact | POST `/api/v1/contacts` | `contacts:write` |
| `update_contact` | Update a contact | PATCH `/api/v1/contacts/{contact_id}` | `contacts:write` |
| `list_appointments` | List appointments | GET `/api/v1/appointments` | `appointments:read` |
| `get_appointment` | Get an appointment | GET `/api/v1/appointments/{appointment_id}` | `appointments:read` |
| `check_availability` | Check open times | GET `/api/v1/availability` | `appointments:read` |
| `book_appointment` | Book an appointment | POST `/api/v1/appointments` | `appointments:write` |
| `cancel_appointment` | Cancel an appointment | POST `/api/v1/appointments/{appointment_id}/cancel` | `appointments:write` |
| `reschedule_appointment` | Reschedule an appointment | POST `/api/v1/appointments/{appointment_id}/reschedule` | `appointments:write` |
| `list_messages` | List messages | GET `/api/v1/messages` | `messages:read` |
| `add_knowledge` | Add knowledge | POST `/api/v1/knowledge` | `knowledge:write` |

### OAuth discovery and redirects

Assistants find the sign-in service through these. The metadata routes are public and allow any origin.

| Method | Address | What it does | Entry file |
|---|---|---|---|
| GET, OPTIONS | `https://demo.alloplace.com/.well-known/oauth-authorization-server` | OAuth authorization server metadata (RFC 8414) | `apps/admin/app/.well-known/oauth-authorization-server/route.ts` |
| GET, OPTIONS | `https://demo.alloplace.com/.well-known/oauth-authorization-server/api/auth` | The same metadata at the issuer-path address some clients ask for | `apps/admin/app/.well-known/oauth-authorization-server/api/auth/route.ts` |
| GET, OPTIONS | `https://demo.alloplace.com/.well-known/oauth-protected-resource` | Protected resource metadata for the MCP server (RFC 9728) | `apps/admin/app/.well-known/oauth-protected-resource/route.ts` |
| GET, OPTIONS | `https://demo.alloplace.com/.well-known/oauth-protected-resource/api/mcp` | The same metadata at the resource-path address | `apps/admin/app/.well-known/oauth-protected-resource/api/mcp/route.ts` |
| GET | `https://demo.alloplace.com/oauth/sign-in` | Where the sign-in service sends a signed-out person during an app connection: redirects (302) to `/{locale}/login?returnTo=/api/auth/oauth2/authorize?...` | `apps/admin/app/oauth/sign-in/route.ts` |
| GET | `https://demo.alloplace.com/oauth/consent` | Redirects (302) to the consent page, `/{locale}/oauth/consent?...` | `apps/admin/app/oauth/consent/route.ts` |

#### Entry files

**`apps/admin/app/.well-known/oauth-authorization-server/route.ts`**

OAuth Authorization Server Metadata (RFC 8414) at the root well-known address, for MCP clients that look here instead of building the path from the issuer. It tells them where to register, authorize and exchange tokens.

- `GET /.well-known/oauth-authorization-server`: Public, no authentication. `authorizationServerMetadataResponse` in `apps/admin/src/lib/mcp/oauth-metadata.ts` calls `oauthProviderAuthServerMetadata(getAuth())` from `@better-auth/oauth-provider`, which builds the document from the Better Auth instance in `apps/admin/src/lib/auth.ts`: issuer `<APP_BASE_URL>/api/auth`, the authorize, token, register, introspect and revoke endpoints under `/api/auth/oauth2/`, the MCP tool scopes plus `offline_access`, and S256 PKCE. Answers 200 JSON with `Access-Control-Allow-Origin: *`, so browser-based clients can read it. Its own `Cache-Control: public, max-age=300` most likely loses to the proxy's `private, no-store` (section 17).
- `OPTIONS /.well-known/oauth-authorization-server`: Public CORS preflight. `metadataOptions` in `apps/admin/src/lib/mcp/oauth-metadata.ts` answers 204 with `Access-Control-Allow-Origin: *`, methods GET and OPTIONS, the `mcp-protocol-version` and `content-type` request headers, and `Access-Control-Max-Age: 86400`.

Related files: `apps/admin/src/lib/mcp/oauth-metadata.ts`, `apps/admin/src/lib/oauth-provider.ts`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/.well-known/oauth-authorization-server/api/auth/route.ts`**

The same RFC 8414 authorization server metadata at the path RFC 8414 derives from the issuer `<APP_BASE_URL>/api/auth`, so MCP clients that follow the standard find it.

- `GET /.well-known/oauth-authorization-server/api/auth`: Public, no authentication. Same handler as the root address: `authorizationServerMetadataResponse` (`apps/admin/src/lib/mcp/oauth-metadata.ts`) returns the oauth-provider plugin's document for the Better Auth instance in `apps/admin/src/lib/auth.ts`, with issuer `<APP_BASE_URL>/api/auth`, the authorize, token, register, introspect and revoke endpoints under `/api/auth/oauth2/`, the MCP tool scopes plus `offline_access`, and S256 PKCE. Answers 200 JSON with `Access-Control-Allow-Origin: *`. Its own `Cache-Control: public, max-age=300` most likely loses to the proxy's `private, no-store` (section 17).
- `OPTIONS /.well-known/oauth-authorization-server/api/auth`: Public CORS preflight. `metadataOptions` in `apps/admin/src/lib/mcp/oauth-metadata.ts` answers 204 with `Access-Control-Allow-Origin: *`, methods GET and OPTIONS, the `mcp-protocol-version` and `content-type` request headers, and `Access-Control-Max-Age: 86400`.

Related files: `apps/admin/src/lib/mcp/oauth-metadata.ts`, `apps/admin/src/lib/oauth-provider.ts`, `apps/admin/src/lib/auth.ts`.

**`apps/admin/app/.well-known/oauth-protected-resource/route.ts`**

OAuth Protected Resource Metadata (RFC 9728) for the MCP server at the root well-known address, for clients that look here before the path-specific one. It names `/api/mcp` as the resource and Better Auth as its authorization server.

- `GET /.well-known/oauth-protected-resource`: Public, no authentication. `protectedResourceMetadataResponse` in `apps/admin/src/lib/mcp/oauth-metadata.ts` returns `protectedResourceMetadata()` from `apps/admin/src/lib/mcp/oauth-config.ts`: `resource` (`<APP_BASE_URL>/api/mcp`), `authorization_servers` (`<APP_BASE_URL>/api/auth`), `scopes_supported` (the MCP tool scopes plus `offline_access`), `bearer_methods_supported` (`header`), `resource_name` (the deployment's app name from `loadBranding()`) and `resource_documentation` (the docs site's `/ai/mcp` page). Answers 200 JSON with `Access-Control-Allow-Origin: *`. Its own `Cache-Control: public, max-age=300` most likely loses to the proxy's `private, no-store` (section 17).
- `OPTIONS /.well-known/oauth-protected-resource`: Public CORS preflight. `metadataOptions` in `apps/admin/src/lib/mcp/oauth-metadata.ts` answers 204 with `Access-Control-Allow-Origin: *`, methods GET and OPTIONS, the `mcp-protocol-version` and `content-type` request headers, and `Access-Control-Max-Age: 86400`.

Related files: `apps/admin/src/lib/mcp/oauth-metadata.ts`, `apps/admin/src/lib/mcp/oauth-config.ts`, `apps/admin/src/lib/branding.ts`.

**`apps/admin/app/.well-known/oauth-protected-resource/api/mcp/route.ts`**

The same RFC 9728 metadata at the path RFC 9728 builds from the resource `<APP_BASE_URL>/api/mcp`. The MCP server's 401 challenge points clients here in its `resource_metadata` parameter.

- `GET /.well-known/oauth-protected-resource/api/mcp`: Public, no authentication. Same handler as the root address: `protectedResourceMetadataResponse` (`apps/admin/src/lib/mcp/oauth-metadata.ts`) returns `protectedResourceMetadata()` from `apps/admin/src/lib/mcp/oauth-config.ts`, with `resource` `<APP_BASE_URL>/api/mcp`, `authorization_servers` `<APP_BASE_URL>/api/auth`, the MCP tool scopes plus `offline_access`, header bearer tokens, the deployment's app name from `loadBranding()` and the docs link. Answers 200 JSON with `Access-Control-Allow-Origin: *`. Its own `Cache-Control: public, max-age=300` most likely loses to the proxy's `private, no-store` (section 17).
- `OPTIONS /.well-known/oauth-protected-resource/api/mcp`: Public CORS preflight. `metadataOptions` in `apps/admin/src/lib/mcp/oauth-metadata.ts` answers 204 with `Access-Control-Allow-Origin: *`, methods GET and OPTIONS, the `mcp-protocol-version` and `content-type` request headers, and `Access-Control-Max-Age: 86400`.

Related files: `apps/admin/src/lib/mcp/oauth-metadata.ts`, `apps/admin/src/lib/mcp/oauth-config.ts`, `apps/admin/src/lib/mcp/handler.ts`.

**`apps/admin/app/oauth/sign-in/route.ts`**

Better Auth's `loginPage` for MCP client authorization. A signed-out person who starts an OAuth authorization lands here and is sent to the localized login page, which returns them to the authorization request after sign-in.

- `GET /oauth/sign-in`: Public. `oauthSignInRedirect` in `apps/admin/src/lib/oauth-pages.ts` drops Better Auth's signature parameters (`sig`, `exp`, `ba_iat`, `ba_pl`, `ba_param`) with `authorizePathFromSignedQuery`, builds `returnTo` as `/api/auth/oauth2/authorize?` plus the client's own parameters, and answers 302 to `/<locale>/login?returnTo=...` (locale from the proxy's `x-lobbystack-locale`), never cached. After sign-in the login card follows `returnTo`, which replays the client's original authorization request.

Related files: `apps/admin/src/lib/oauth-pages.ts`, `apps/admin/src/lib/auth-return-to.ts`, `apps/admin/src/components/auth-card.tsx`, `apps/admin/src/lib/oauth-provider.ts`.

**`apps/admin/app/oauth/consent/route.ts`**

Better Auth's `consentPage` for MCP client authorization. The oauth-provider plugin sends the browser here with a signed authorization query, and this route forwards it to the localized consent page, where the person picks the business and scopes to grant.

- `GET /oauth/consent`: Public; the consent page does the session check. `oauthConsentRedirect` in `apps/admin/src/lib/oauth-pages.ts` reads the locale the proxy negotiated (`x-lobbystack-locale`, from `?lng=`, the locale cookie or `Accept-Language`) and answers 302 to `/<locale>/oauth/consent` with the query unchanged, Better Auth's signature included, never cached. The page (`apps/admin/app/(sensitive)/[locale]/oauth/consent/page.tsx`) sends a signed-out person to `/oauth/sign-in`, lists the businesses they can grant, and posts the decision to `/api/oauth/consent`.

Related files: `apps/admin/src/lib/oauth-pages.ts`, `apps/admin/app/(sensitive)/[locale]/oauth/consent/page.tsx`, `apps/admin/app/api/oauth/consent/route.ts`, `apps/admin/src/lib/oauth-provider.ts`.

The consent page itself is `/{locale}/oauth/consent` (section 5), its answer goes to `POST /api/oauth/consent` (section 8, API keys and connected apps), and the token endpoints are in section 11.

## 11. Sign-in service (Better Auth)

Better Auth 1.7.7 serves everything under `/api/auth/` through one catch-all route (`api/auth/[...all]/route.ts`, GET, POST and OPTIONS). It is set up in `apps/admin/src/lib/auth.ts` (email and password, email codes) and `apps/admin/src/lib/oauth-provider.ts` (the OAuth server for MCP). Endpoints not listed under a cap fall under Better Auth's general limit of 30 requests a minute. Docs today: `settings/account.mdx` and `getting-started/account-setup.mdx` for accounts, `ai/mcp.mdx` for OAuth.

### Used by the app's screens

| Method | Address | What it does | Entry file |
|---|---|---|---|
| POST | `https://demo.alloplace.com/api/auth/sign-up/email` | Create an account. Checks Turnstile and the password rules; 3 a minute per IP. An email that already has an account gets an email instead of an error. | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `signUpEmail`) |
| POST | `https://demo.alloplace.com/api/auth/sign-in/email` | Sign in with email and password; 5 a minute per IP. Sessions last 30 days. | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `signInEmail`) |
| POST | `https://demo.alloplace.com/api/auth/sign-out` | Sign out | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `signOut`) |
| GET | `https://demo.alloplace.com/api/auth/get-session` | The current session (POST works too) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `getSession`) |
| POST | `https://demo.alloplace.com/api/auth/email-otp/send-verification-otp` | Email a verification code. The app's own route replaces Better Auth's here (`api/auth/email-otp/send-verification-otp/route.ts`): Turnstile unless the request continues a verification already under way, 429 with `Retry-After: 60` when limited. | `apps/admin/app/api/auth/email-otp/send-verification-otp/route.ts` |
| POST | `https://demo.alloplace.com/api/auth/email-otp/verify-email` | Confirm the email with the code; 3 a minute | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth email OTP plugin, `verifyEmailOTP`) |
| GET | `https://demo.alloplace.com/api/auth/verify-email` | Confirm an email from an emailed link (`token`, `callbackURL`); `/{locale}/verify-email?token=` forwards here | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `verifyEmail`) |
| POST | `https://demo.alloplace.com/api/auth/email-otp/request-password-reset` | Email a password reset code; 3 a minute, also limited per recipient, and always answers as if it sent one | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth email OTP plugin, `requestPasswordResetEmailOTP`) |
| POST | `https://demo.alloplace.com/api/auth/email-otp/reset-password` | Set a new password with the code; 3 a minute | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth email OTP plugin, `resetPasswordEmailOTP`) |
| POST | `https://demo.alloplace.com/api/auth/reset-password` | Set a new password with a reset-link token (the `/{locale}/reset-password` pages) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `resetPassword`) |
| POST | `https://demo.alloplace.com/api/auth/change-email` | Start a sign-in email change; a confirmation link goes out (signed in) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `changeEmail`) |
| POST | `https://demo.alloplace.com/api/auth/change-password` | Change the password and sign out other sessions (signed in) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `changePassword`) |

### OAuth server (for MCP clients)

Clients register themselves (dynamic registration) or identify with a Client ID Metadata Document URL.

| Method | Address | What it does | Entry file |
|---|---|---|---|
| GET, POST | `https://demo.alloplace.com/api/auth/oauth2/authorize` | Start an authorization. PKCE is required. | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `oauth2Authorize`) |
| POST | `https://demo.alloplace.com/api/auth/oauth2/consent` | Record the person's consent (`POST /api/oauth/consent` calls it with the chosen business) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `oauth2Consent`) |
| POST | `https://demo.alloplace.com/api/auth/oauth2/continue` | Carry on an authorization after sign-in | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `oauth2Continue`) |
| POST | `https://demo.alloplace.com/api/auth/oauth2/token` | Exchange a code or refresh token. Access tokens (`lsa_...`) last 1 hour; refresh tokens last 30 days and rotate, and reusing an old one ends the connection. | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `oauth2Token`) |
| POST | `https://demo.alloplace.com/api/auth/oauth2/revoke` | Revoke a token | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `oauth2Revoke`) |
| POST | `https://demo.alloplace.com/api/auth/oauth2/introspect` | Check a token | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `oauth2Introspect`) |
| POST | `https://demo.alloplace.com/api/auth/oauth2/register` | Dynamic client registration, open to anyone. A client whose redirect addresses are all loopback registers as a native app. | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `registerOAuthClient`) |
| GET | `https://demo.alloplace.com/api/auth/oauth2/public-client` | A client's public details, for the consent page | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth OAuth provider plugin, `getOAuthClientPublic`) |

### Served, but not used by the app's screens

Better Auth answers these, though no screen calls them. Document them only if they become part of the product.

| Method | Address | What it does | Entry file |
|---|---|---|---|
| POST | `https://demo.alloplace.com/api/auth/request-password-reset` | Email a reset link (the app's screens use codes instead); 5 a minute | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `requestPasswordReset`) |
| GET | `https://demo.alloplace.com/api/auth/reset-password/{token}` | The reset link's landing address; forwards to the reset page | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `requestPasswordResetCallback`) |
| POST | `https://demo.alloplace.com/api/auth/update-user` | Change the account's name, picture or language | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `updateUser`) |
| GET | `https://demo.alloplace.com/api/auth/list-sessions` | List the account's sessions | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `listSessions`) |
| POST | `https://demo.alloplace.com/api/auth/revoke-session` | End one session | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `revokeSession`) |
| POST | `https://demo.alloplace.com/api/auth/revoke-sessions` | End every session | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `revokeSessions`) |
| POST | `https://demo.alloplace.com/api/auth/revoke-other-sessions` | End every other session | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `revokeOtherSessions`) |
| POST | `https://demo.alloplace.com/api/auth/update-session` | Update the session record | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `updateSession`) |
| POST | `https://demo.alloplace.com/api/auth/verify-password` | Check the current password | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `verifyPassword`) |
| GET | `https://demo.alloplace.com/api/auth/list-accounts` | List the sign-in methods linked to the account | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `listUserAccounts`) |
| GET | `https://demo.alloplace.com/api/auth/account-info` | Details from a linked sign-in provider | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `accountInfo`) |
| POST | `https://demo.alloplace.com/api/auth/unlink-account` | Unlink a sign-in method | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `unlinkAccount`) |
| GET | `https://demo.alloplace.com/api/auth/ok` | Better Auth's own health check | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `ok`) |
| GET | `https://demo.alloplace.com/api/auth/error` | Better Auth's error page | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `error`) |
| POST | `https://demo.alloplace.com/api/auth/sign-in/social` | Sign in with a social provider (none is configured, so it fails) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `signInSocial`) |
| POST | `https://demo.alloplace.com/api/auth/link-social` | Link a social provider (none is configured) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `linkSocialAccount`) |
| GET, POST | `https://demo.alloplace.com/api/auth/callback/{id}` | A social provider's return address (none is configured) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `callbackOAuth`) |
| POST | `https://demo.alloplace.com/api/auth/get-access-token` | A linked provider's access token (none is configured) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `getAccessToken`) |
| POST | `https://demo.alloplace.com/api/auth/refresh-token` | Refresh a linked provider's token (none is configured) | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `refreshToken`) |
| POST | `https://demo.alloplace.com/api/auth/delete-user` | Answers 404: account deletion isn't turned on | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `deleteUser`) |
| GET | `https://demo.alloplace.com/api/auth/delete-user/callback` | Answers 404: account deletion isn't turned on | `apps/admin/app/api/auth/[...all]/route.ts` (Better Auth core, `deleteUserCallback`) |

### Turned off (answer 404 "Endpoint not enabled")

The app refuses these Better Auth endpoints on purpose: no passwordless sign-in, no email change by code, and OAuth clients and consents are managed in the dashboard instead. Everything under `/api/auth/admin/oauth2/` is server-only and never served.

`/api/auth/send-verification-email`, `/api/auth/email-otp/change-email`, `/api/auth/email-otp/check-verification-otp`, `/api/auth/email-otp/request-email-change`, `/api/auth/sign-in/email-otp`, `/api/auth/forget-password/email-otp`, `/api/auth/oauth2/create-client`, `/api/auth/oauth2/update-client`, `/api/auth/oauth2/delete-client`, `/api/auth/oauth2/get-client`, `/api/auth/oauth2/get-clients`, `/api/auth/oauth2/client/rotate-secret`, `/api/auth/oauth2/get-consent`, `/api/auth/oauth2/get-consents`, `/api/auth/oauth2/update-consent`, `/api/auth/oauth2/delete-consent`, `/api/auth/oauth2/userinfo`, `/api/auth/oauth2/end-session`, `/api/auth/oauth2/end-session/confirm`, `/api/auth/oauth2/public-client-prelogin`

They reach `apps/admin/app/api/auth/[...all]/route.ts` like every other path here; its summary below says how they are refused.

### Entry files

**`apps/admin/app/api/auth/[...all]/route.ts`**

Better Auth's HTTP surface: sign-in, sign-up, sessions, password reset and email verification for the dashboard's auth screens, plus the OAuth 2.1 authorization server (authorize, consent, token, registration, revocation) that MCP clients use to get `lsa_` access tokens.

- `GET /api/auth/[...all]`: Public: the proxy's CSRF check skips `/api/auth`, and Better Auth applies its own `trustedOrigins` (`APP_BASE_URL`, `AUTH_TRUSTED_ORIGINS`) and session cookie. `toNextJsHandler(getAuth())` runs the instance from `apps/admin/src/lib/auth.ts` (email and password, the email-OTP plugin, and the OAuth provider and CIMD plugins from `apps/admin/src/lib/oauth-provider.ts`) on the `lobbystack_auth` role. Its `before` hook answers 404 `Endpoint not enabled.` for `/send-verification-email`, email-OTP routes outside `enabledEmailOtpPaths` (so no passwordless sign-in or email-change codes), `/admin/oauth2/*`, and `/oauth2/*` routes outside `allowedOAuthPaths`; before authorize, consent, continue and token it upserts the `/api/mcp` row in `oauth_resources`. A valid `/oauth2/authorize` request sends a signed-out person to `/oauth/sign-in` and a signed-in one to `/oauth/consent`, since no earlier consent ever matches. The limiter allows 30 requests a minute per IP and path (429 with `X-Retry-After`), counted in Redis when `REDIS_URL` is set.
- `POST /api/auth/[...all]`: Same handler, hooks and limiter as GET. The `before` hook also rejects a malformed email on reset routes (400), caps reset requests per recipient and IP through `assertEmailVerificationSendAllowed` (answering as if sent), enforces the password rule on sign-up, reset and change (400 `INVALID_PASSWORD`), registers a client whose redirect URIs are all loopback as `native` on `/oauth2/register`, and on `/sign-up/email` checks Turnstile (`turnstileToken` or `cf-turnstile-response`, via `verifyTurnstile` with `TURNSTILE_SECRET_KEY`, skipped only for a localhost `APP_BASE_URL` without one; 400 on failure). Limits tighten to 5 a minute for `/sign-in/email` and `/request-password-reset` and 3 for `/sign-up/email` and the OTP recovery routes. Auth emails are queued as `email.send` outbox events, and an `after` hook upgrades legacy password hashes on sign-in. A successful sign-up gets the signed `lobbystack.verification-flow` cookie (`attachVerificationFlow`); token, register and revoke responses get `Access-Control-Allow-Origin: *` without `Set-Cookie` (`withOAuthClientCors`).
- `OPTIONS /api/auth/[...all]`: Never reaches Better Auth. `oauthClientPreflight` in `apps/admin/src/lib/oauth-cors.ts` answers 204 for `/api/auth/oauth2/token`, `/api/auth/oauth2/register` and `/api/auth/oauth2/revoke`, with `Access-Control-Allow-Origin: *`, methods POST and OPTIONS, the `authorization`, `content-type`, `dpop` and `mcp-protocol-version` headers and a one-day max age, so browser-based MCP clients can call them. Every other path gets 404.

Related files: `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/oauth-provider.ts`, `apps/admin/src/lib/oauth-cors.ts`, `apps/admin/src/lib/email-verification-policy.ts`.

**`apps/admin/app/api/auth/email-otp/send-verification-otp/route.ts`**

Resends the email verification code from the sign-in and sign-up card (`AuthCard`). The email-OTP plugin's own endpoint at this path is disabled, so this route, which Next.js matches before the catch-all, issues codes with Turnstile, per-recipient limits and no account enumeration.

- `POST /api/auth/email-otp/send-verification-otp`: Public. Reads JSON `email`, `type` (`email-verification`) and optional `turnstileToken`; anything else gives 400 `INVALID_REQUEST`. Without a valid same-origin `lobbystack.verification-flow` cookie for that email, `verifyTurnstile` must pass (400 `CHALLENGE_FAILED`). `issueEmailVerificationCode` in `apps/admin/src/lib/auth.ts` takes a per-email advisory lock, applies Redis limits (60-second cooldown, 3 an hour per recipient, 10 an hour per IP when `TRUSTED_CLIENT_IP_HEADER` is set) and, only for an existing unverified user, creates the OTP and queues an `email.send` outbox event. Answers 200 `{ success: true }` whether or not the account exists; 429 `RATE_LIMITED` with `Retry-After: 60`; otherwise 503.

Related files: `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/email-verification-policy.ts`, `apps/admin/src/lib/verification-flow.ts`, `apps/admin/src/components/auth-card.tsx`.

## 12. Inbound webhooks

Providers call these; each checks the provider's signature first and answers 401 (400 for OpenAI) when it fails. Docs today: `self-hosting/overview.mdx` and `self-hosting/environment-variables.mdx` cover the OpenAI webhook and the Twilio webhook addresses; nothing covers the Polar and Resend webhooks yet.

| Method | Address | What it does | Signed with | Entry file |
|---|---|---|---|---|
| POST | `https://demo.alloplace.com/api/webhooks/openai/live` | OpenAI announces a phone call arriving at GPT-Live (`live.transport.incoming`); the admin accepts it and asks the worker to join. 404 unless `LIVE_PROTOTYPE_ENABLED=true`. | OpenAI webhook signature (`OPENAI_WEBHOOK_SECRET`) | `apps/admin/app/api/webhooks/openai/live/route.ts` |
| POST | `https://demo.alloplace.com/api/webhooks/twilio/sms` | A text arrives at a business number, or at the shared sender, which answers STOP, START and HELP itself; answers with TwiML | `X-Twilio-Signature` (`TWILIO_AUTH_TOKEN`) | `apps/admin/app/api/webhooks/twilio/sms/route.ts` |
| POST | `https://demo.alloplace.com/api/webhooks/twilio/status` | Delivery status of a sent text; 503 with `Retry-After: 60` when it can't be saved, so Twilio retries | `X-Twilio-Signature` | `apps/admin/app/api/webhooks/twilio/status/route.ts` |
| POST | `https://demo.alloplace.com/api/webhooks/polar` | Billing events from Polar (subscriptions and orders); stored, then reconciled in the background | Standard Webhooks signature (`POLAR_WEBHOOK_SECRET`) | `apps/admin/app/api/webhooks/polar/route.ts` |
| POST | `https://demo.alloplace.com/api/webhooks/resend` | Email delivery events from Resend; stored, then matched to the email that was sent. 503 when `RESEND_WEBHOOK_SECRET` is unset. | Svix signature (`RESEND_WEBHOOK_SECRET`) | `apps/admin/app/api/webhooks/resend/route.ts` |

### Entry files

**`apps/admin/app/api/webhooks/openai/live/route.ts`**

OpenAI calls this webhook when a phone call reaches the project's SIP endpoint through the Twilio Elastic SIP trunk. The admin picks the business from the dialled number, records the call, accepts the GPT-Live session and hands it to the worker.

- `POST /api/webhooks/openai/live`: Answers 404 unless `LIVE_PROTOTYPE_ENABLED=true`. `client.webhooks.unwrap` from `getLiveClient()` checks OpenAI's signature with `OPENAI_WEBHOOK_SECRET` (400); other events get 200. For `live.transport.incoming`, the dialled number from the `Diversion`, `To` or `P-Called-Party-ID` SIP header resolves through `app.resolve_business_by_phone` (lookup error: 503 for redelivery; no owner: 200, call left alone). `startLivePhoneCall` (`packages/domain/src/server/liveCalls.ts`) records the call and reserves minutes, then the session is accepted with `buildPhoneSessionConfig(snapshot)`, its starting instructions go to the call's AI debug trace without holding the call up (`recordAiTrace`), and `attachWorkerToLiveSession` (`apps/admin/src/lib/live-prototype.ts`) asks the worker to attach. Calls it can't take get SIP 486 (out of minutes), 603 (blocked caller) or 503 (setup failure); OpenAI still gets 200.

Related files: `apps/admin/src/lib/live-prototype.ts`, `packages/domain/src/server/liveCalls.ts`, `packages/agent-core/src/live/session.ts`, `apps/worker/src/liveCalls.ts`.

**`apps/admin/app/api/webhooks/twilio/sms/route.ts`**

Twilio's inbound SMS webhook. A text to a business's number lands in its SMS inbox; a text to the shared cloud sender (`TWILIO_ALERT_SMS_FROM`) only gets STOP, START and HELP handling.

- `POST /api/webhooks/twilio/sms`: Validates `X-Twilio-Signature` with `TWILIO_AUTH_TOKEN` over the URL (`TWILIO_SMS_WEBHOOK_URL` when set) and form fields (401). Resolves the business from `To` through `app.resolve_business_by_phone`. With none, only the shared sender is served: `receiveSharedSenderSms` (`packages/domain/src/server/sms.ts`) applies STOP or START to that phone's contacts at every business and returns the HELP or START reply. Otherwise `receiveInboundSms` stores the `provider_events` row, contact, conversation and inbound message, applies STOP and START, and queues realtime and keyword-reply outbox events or an operator alert. Answers 200 TwiML, with a `<Message>` only for the shared sender's reply; errors give 500.

Related files: `packages/domain/src/server/sms.ts`, `packages/domain/src/server/smsSender.ts`, `packages/providers/src/twilio/webhookSecurity.ts`.

**`apps/admin/app/api/webhooks/twilio/status/route.ts`**

Twilio's delivery status callback for outbound texts: conversation messages, customer appointment notifications and operator alerts. It moves each record's delivery status forward and records Twilio's price.

- `POST /api/webhooks/twilio/status`: Validates `X-Twilio-Signature` over the URL (`TWILIO_STATUS_CALLBACK_URL` when set) and form fields, with the token `twilioStatusAuthToken` picks: `TWILIO_AUTH_TOKEN`, or `TWILIO_ALERT_WEBHOOK_SECRET` for the alert account's notification and operator-alert texts (401). Finds the business by `MessageSid` or the `messageId`, `notificationId` or `operatorDeliveryId` query parameter (none: 200). `updateSmsDeliveryStatus`, `updateNotificationDeliveryStatus` or `updateOperatorNotificationDeliveryStatus` (`packages/domain`) then advances the status, stores price and segments, and queues realtime and `sms.syncPrice` outbox events. Answers 200 `{ ok: true }`; any failure gives 503 with `Retry-After: 60`.

Related files: `apps/admin/src/lib/twilio-status-auth.ts`, `packages/domain/src/server/sms.ts`, `packages/domain/src/server/notifications.ts`, `packages/providers/src/twilio/webhookSecurity.ts`.

**`apps/admin/app/api/webhooks/polar/route.ts`**

Receives Polar's signed subscription and order webhooks so the worker can reconcile each business's plan and billing state through a `billing.reconcile` job.

- `POST /api/webhooks/polar`: Verifies the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`) with `POLAR_WEBHOOK_SECRET` through `verifyPolarWebhookSignature`. A refused delivery answers 401 and logs `ops.billing.webhook_refused` with the reason (`unconfigured`, `missing_headers` or `bad_signature`) and Polar's delivery ID, never the body, since Polar turns an endpoint off after 10 failures in a row (fork PR #71). It then parses `polarWebhookSchema` with `id` from `webhook-id` (400). `normalizePolarEvent` (`apps/admin/src/lib/polar-event.ts`) names the plan of each product the billing catalog links (`readBillingCatalogSnapshot`, `polarProductLinks`) and finds the business UUID in the customer's external ID or metadata; a legacy Convex ID matches `businesses.legacy_convex_id` only with `POLAR_ACCEPT_LEGACY_BUSINESS_IDS=true`. Unattributable events are logged as `ops.billing.webhook_unresolved` and answered 200 `{ accepted: true, ignored: true }`. A customer that names another business than the checkout's logs `ops.billing.webhook_customer_mismatch` (fork PR #72), and the subscription still goes to the business that bought it. `storePolarWebhookEvent` (`packages/domain`) inserts a `provider_events` row and queues a `billing.reconcile` outbox event in one transaction, and a redelivery of an event that never applied queues it again: 200 `{ accepted, duplicate, eventId }`. Errors answer 500 with an `errorId`, also in `x-error-id`, reported to PostHog as `billing.webhook`.

Related files: `apps/admin/src/lib/polar-event.ts`, `packages/providers/src/polar/webhook.ts`, `packages/domain/src/server/billing.ts`.

**`apps/admin/app/api/webhooks/resend/route.ts`**

Receives Resend's signed email events (sent, delivered, bounced, failed, complained) so the worker can update the delivery status of notification and operator-alert emails.

- `POST /api/webhooks/resend`: Answers 503 `{ error }` when `RESEND_WEBHOOK_SECRET` is unset. Verifies the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) through `verifyResendWebhookSignature` (401), then `resendWebhookSchema` (400). The `email_id` resolves the business through `app.resolve_business_by_email_provider_id`. It inserts a `provider_events` row keyed by `svix-id`; with a business it also queues an `email.reconcileDelivery` outbox event, which the worker turns into `notifications` and `operator_notification_deliveries` status updates. Without one the row is stored through the dispatcher role and nothing is queued. Answers 200 `{ accepted, duplicate, eventId }`; errors give 500.

Related files: `packages/providers/src/email/webhook.ts`, `packages/domain/src/server/email.ts`, `apps/worker/src/handlers.ts`.

## 13. Health, operations and static files

| Method | Address | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `https://demo.alloplace.com/api/health/live` | Liveness: `ok`, the service name and its version | Public | `apps/admin/app/api/health/live/route.ts` |
| GET | `https://demo.alloplace.com/api/health/ready` | Readiness: database, storage and Redis checks, plus which brand is showing. 503 when a check fails. | Public | `apps/admin/app/api/health/ready/route.ts` |
| GET | `https://demo.alloplace.com/api/internal/finance/export` | Finance export, paged (`resource` = `usage`, `businesses`, `service-periods`, `transactions` or `metrics`; `from` and `to` as YYYY-MM-DD; `cursor`, `limit`). 404 unless `FINANCE_EXPORT_ENABLED=true`. | `Authorization: Bearer <FINANCE_EXPORT_TOKEN>` | `apps/admin/app/api/internal/finance/export/route.ts` |

### Entry files

**`apps/admin/app/api/health/live/route.ts`**

Liveness probe for the admin app. The admin image's Docker `HEALTHCHECK` and docker-compose call it to confirm the Node server answers.

- `GET /api/health/live`: Public; it checks no database or service. The proxy lets GET and HEAD health probes through even in maintenance mode. Answers 200 `{ ok: true, service, version }` with `service` set to `lobbystack-admin`, where `releaseVersion()` from `apps/admin/src/lib/release-version.ts` returns `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_DEPLOYMENT_ID`, `SERVICE_VERSION` or `development`, in that order.

Related files: `apps/admin/src/lib/release-version.ts`.

**`apps/admin/app/api/health/ready/route.ts`**

Readiness probe for the admin app; Railway's deployment health check (`.railway/railway.ts`) waits on it. It reports whether PostgreSQL, file storage and Redis answer, plus which brand the build serves.

- `GET /api/health/ready`: Public; maintenance mode lets it through. Runs in parallel `databaseHealthCheck` from `packages/db/src/client.ts` (`select 1` on the `lobbystack_app` role), `getStorageProvider().ensureReady()` (an S3 bucket check or a local disk write and read) and a Redis `ping` (required in production, skipped elsewhere without `REDIS_URL`). Answers `{ ok, service, brand: { id, source }, checks: { database, storage, redis } }`, each check `ok` or `failed`: 200 when all pass, otherwise 503. An unexpected error gives 503 with every check `failed` and no `brand`.

Related files: `packages/db/src/client.ts`, `apps/admin/src/lib/storage.ts`, `apps/admin/src/lib/redis.ts`.

**`apps/admin/app/api/internal/finance/export/route.ts`**

A disabled-by-default, read-only JSON export for a finance consumer holding the dedicated bearer token: usage cost events, businesses, billing periods, Polar transactions and daily call and booking metrics, paged by an `(updatedAt, id)` cursor.

- `GET /api/internal/finance/export`: Answers 404 unless `FINANCE_EXPORT_ENABLED=true`, then 401 unless `Authorization: Bearer` matches `FINANCE_EXPORT_TOKEN` (timing-safe). Reads `resource` (`usage`, `businesses`, `service-periods`, `transactions` or `metrics`), an optional base64url `cursor`, `from` and `to` (`YYYY-MM-DD`) and `limit` (1 to 500, default 100); a bad `resource`, `cursor` or date gives 400 `{ error }`. Raw SQL runs through `getFinanceExportDatabase()` in `apps/admin/src/lib/api-helpers.ts`, which throws unless `LOBBYSTACK_FINANCE_EXPORT_DATABASE_URL` configures the read-only `lobbystack_finance_export` role. Answers 200 `{ version, resource, data, nextCursor }` (`version` is `v1`), rows ordered by `updatedAt` (microsecond UTC text) then `id`.

Related files: `apps/admin/src/lib/api-helpers.ts`, `packages/db/migrations/0049_finance_usage_metadata.sql`, `packages/db/migrations/0065_finance_billed_voice_seconds.sql`.

### Static files

| Address | What it is | File |
|---|---|---|
| `https://demo.alloplace.com/locales/{locale}/{namespace}.json` | Interface text. Namespaces: admin, affiliate, agent, auth, calls, common, contacts, dashboard, demos, inbox, knowledge, messages, nav, onboarding, profile, settings, widget. | `apps/admin/public/locales/` |
| `https://demo.alloplace.com/brand/logo-icon.svg`, `https://demo.alloplace.com/brand/logo-wordmark.svg` | The default LobbyStack logo | `apps/admin/public/brand/` |
| `https://demo.alloplace.com/brand/alloplace/logo.svg`, `https://demo.alloplace.com/brand/alloplace/logo-email.png`, `https://demo.alloplace.com/brand/alloplace/og.png` | The AlloPlace logo, email logo and sharing image | `apps/admin/public/brand/alloplace/` |
| `https://demo.alloplace.com/lobbystack-logo.svg` | The LobbyStack logo | `apps/admin/public/lobbystack-logo.svg` |
| `https://demo.alloplace.com/_next/static/...`, `https://demo.alloplace.com/_next/image` | Next.js build files and image resizing | Next.js |

The admin has no favicon, `robots.txt` or sitemap route.

## 14. Worker (internal)

`apps/worker` runs one small HTTP server on `PORT`, else `WORKER_PORT`, else 3002. It isn't part of demo.alloplace.com: the admin calls it at `WORKER_INTERNAL_URL`. The two `/internal/live/` routes exist only when `LIVE_PROTOTYPE_ENABLED=true`, answer 405 to any method but POST, and 401 without the token. Docs today: `docs/voice/runtime.md` in the repository (not in `mintlify/`).

| Method | Path | What it does | Who | Entry file |
|---|---|---|---|---|
| GET | `/health/live` | Liveness: `{ "ok": true }` | Anyone who can reach the worker's port | `apps/worker/src/health.ts` |
| GET | `/health/ready` | Readiness: ready, database, Redis, storage, draining, active jobs; 503 when not ready | Anyone who can reach the worker's port | `apps/worker/src/health.ts` |
| POST | `/internal/live/attach` | The admin asks the worker to join a GPT-Live call (`sessionId`, `businessId`, `callId`, `channel`); 202, or 503 while the worker shuts down | `X-Internal-Service-Token` = `INTERNAL_SERVICE_TOKEN` | `apps/worker/src/liveCalls.ts` |
| POST | `/internal/live/end` | End a browser call by `sessionId` (202) | `X-Internal-Service-Token` = `INTERNAL_SERVICE_TOKEN` | `apps/worker/src/liveCalls.ts` |

### Entry files

**`apps/worker/src/health.ts`**

The worker's only HTTP server, on its own port rather than the admin's address. Railway and Docker health checks call `/health/live` and `/health/ready`, and the same server hands `/internal/live/*` to the GPT-Live handler in `liveCalls.ts`.

- `GET /health/live`: No authentication and no method check. `startHealthServer`, which `main()` in `apps/worker/src/index.ts` starts on `PORT`, else `WORKER_PORT`, else 3002 (listening on `::`), first offers every request to `liveCalls.handle` from `apps/worker/src/liveCalls.ts`, which claims `/internal/live/*`. This path then answers 200 `{ ok: true }`. In maintenance mode the worker starts only this server, without the live routes, so liveness still passes.
- `GET /health/ready`: No authentication. Answers `{ ok, ready, redis, database, storage, activeJobs, draining }`: 200 when `ready`, `redis`, `database` and `storage` are true and `draining` is false, else 503. `checkHealth` in `apps/worker/src/index.ts` sets the flags at startup and every 10 seconds from `databaseHealthCheck` on the `lobbystack_worker` role, `storage.ensureReady()`, `getJobCounts()` on every BullMQ queue and a Redis `ping`; SIGTERM or SIGINT sets `draining`. Maintenance mode always answers 503. Any other path gets 404.

Related files: `apps/worker/src/index.ts`, `apps/worker/src/liveCalls.ts`, `packages/db/src/client.ts`.

**`apps/worker/src/liveCalls.ts`**

The worker's internal GPT-Live endpoints. Right after the admin creates or accepts a session (phone webhook or browser call) it calls attach, so the worker holds the sideband for the whole call; end closes a browser session.

- `POST /internal/live/attach`: Served only when `LIVE_PROTOTYPE_ENABLED=true` (else `health.ts` answers 404); other methods get 405. `X-Internal-Service-Token` must equal `INTERNAL_SERVICE_TOKEN` (401). `parseAttachRequest` needs `sessionId`, `businessId`, `callId` and `channel` (`voice` or `web_voice`), else 400; a draining worker answers 503 with `Connection: close`. `attach` takes the Redis lock `live-attach:<sessionId>` (held by another instance: nothing to do), loads the business snapshot and starts a `LiveCallController` (`packages/agent-core`) that answers delegations with the receptionist agent, saves turns and calls `finishLiveCall` on close. Answers 202 `{ ok: true }` once the business loads; failures give 500.
- `POST /internal/live/end`: Same guards as attach. Reads `sessionId` from the JSON body (400 without it). `endSession` has this worker's `LiveCallController` end the call when it holds the session, otherwise sends `session.close` over a new sideband through `closeLiveSession` (`packages/agent-core/src/live/callController.ts`). Answers 202 `{ ok: true }`; errors give 500. The admin's `endLiveBrowserSession` calls it for browser calls, since OpenAI's hangup endpoint covers only SIP calls.

Related files: `apps/worker/src/health.ts`, `apps/worker/src/index.ts`, `packages/agent-core/src/live/callController.ts`, `apps/admin/src/lib/live-prototype.ts`.

## 15. Marketing site (separate)

`apps/landing` is the marketing site: an Astro build of static files for Cloudflare Pages. It is not served at demo.alloplace.com, and its code fixes the original project's own website as its address, so its pages are listed by path only. English pages have no prefix; French, Spanish and Serbian copies sit under `/fr`, `/es` and `/sr`. Many pages also have a Markdown copy for AI agents at the same path ending in `.md`; only the home pages also serve that copy to a request that asks for `text/markdown`. Source: `apps/landing/src/pages/`. The entry file named in the tables is the English page; the summaries below list every file, translated copies included.

| Path | Page | Languages | Markdown copy | Entry file |
|---|---|---|---|---|
| `/` | Home, with a live browser call to the product's own receptionist | en, fr, es, sr | `/index.md` | `apps/landing/src/pages/index.astro` |
| `/features/` | Features | en, fr, es, sr | `/features.md` | `apps/landing/src/pages/features.astro` |
| `/pricing/` | Pricing | en, fr, es, sr | `/pricing.md` | `apps/landing/src/pages/pricing.astro` |
| `/solutions/` | Solutions | en, fr, es, sr | None | `apps/landing/src/pages/solutions/index.astro` |
| `/solutions/{slug}/` | 18 solution pages: after-hours-answering-service, ai-appointment-scheduler, ai-phone-answering, ai-receptionist-for-dental-offices, ai-receptionist-for-home-services, ai-receptionist-for-salons-and-spas, self-hosted-ai-receptionist, ai-receptionist-for-plumbers, ai-receptionist-for-hvac, ai-receptionist-for-electricians, ai-receptionist-for-garage-door-repair, ai-receptionist-for-appliance-repair, ai-receptionist-for-restoration-companies, ai-receptionist-for-locksmiths, after-hours-answering-service-for-contractors, property-management-answering-service, roofing-answering-service, open-source-ai-receptionist | en, fr, es, sr | None | `apps/landing/src/pages/solutions/[slug].astro` and 7 more |
| `/about/` | About | en, fr, es, sr | `/about.md` (English) | `apps/landing/src/pages/about.astro` |
| `/affiliate-program/` | Affiliate program | en, fr, es, sr | `/affiliate-program.md` | `apps/landing/src/pages/affiliate-program.astro` |
| `/blog/` | Blog | en, fr, es, sr | `/blog.md` | `apps/landing/src/pages/blog/index.astro` |
| `/blog/{slug}/` | Blog posts, 42 in each language | en, fr, es, sr | `/blog/{slug}.md` | `apps/landing/src/pages/blog/[slug].astro` |
| `/changelog/` | Changelog | en, fr, es, sr | `/changelog.md` | `apps/landing/src/pages/changelog.astro` |
| `/docs/api/` | Guide to the site's own discovery files for agents (not the product's API) | en, fr, es, sr | `/docs/api.md` | `apps/landing/src/pages/docs/api.astro` |
| `/missed-call-revenue-calculator/` | Missed-call revenue calculator, worked out in the browser | en, fr, es, sr | `/missed-call-revenue-calculator/index.md` | `apps/landing/src/pages/missed-call-revenue-calculator/index.astro` |
| `/privacy/`, `/terms/`, `/cookie-policy/` | Legal pages | en, fr, es, sr | None | `apps/landing/src/pages/privacy.astro`, `apps/landing/src/pages/terms.astro`, `apps/landing/src/pages/cookie-policy.astro` |
| `/search/` | Search, run in the browser on a Pagefind index | en, fr, es, sr | None | `apps/landing/src/pages/search.astro` |
| `/404` | Not found page | en, fr, es, sr | None | `apps/landing/src/pages/404.astro` |

Machine-readable files:

| Path | What it is | Entry file |
|---|---|---|
| `/feed.xml` | RSS feed of the English blog posts | `apps/landing/src/pages/feed.xml.ts` |
| `/openapi.json` | OpenAPI description of the site's own discovery files (not the product's API) | `apps/landing/src/pages/openapi.json.ts` |
| `/schema/page.json`, `/schema/post.json` | schema.org graphs of the English pages and of the English posts | `apps/landing/src/pages/schema/page.json.ts`, `apps/landing/src/pages/schema/post.json.ts` |
| `/schemamap.xml` | The list of those two graphs | `apps/landing/src/pages/schemamap.xml.ts` |
| `/og/{slug}.jpg` | Sharing images, made at build time | `apps/landing/src/pages/og/[...slug].jpg.ts` |
| `/sitemap-index.xml` | Sitemap index, pointing to a blog sitemap and a site sitemap | `apps/landing/astro.config.mjs`, `apps/landing/src/lib/sitemap.ts` |
| `/api/status` | A fixed `ok` status written at build time, not a health check of the product | `apps/landing/src/pages/api/status.ts` |
| `/{indexNowKey}.txt` | IndexNow key file, built only when `INDEXNOW_KEY` is set | `apps/landing/src/pages/[indexNowKey].txt.ts` |
| `/.well-known/agent-skills/index.json` | Agent Skills index | `apps/landing/src/pages/.well-known/agent-skills/index.json.ts` |
| `/.well-known/agent-skills/lobbystack-discovery/SKILL.md` | The skill file that index lists | `apps/landing/src/pages/.well-known/agent-skills/lobbystack-discovery/SKILL.md.ts` |
| `/.well-known/api-catalog` | API catalog (an RFC 9727 linkset) | `apps/landing/src/pages/.well-known/api-catalog.ts` |
| `/.well-known/mcp/server-card.json` | Card for the WebMCP tools the pages register in the browser; no MCP server stands behind it | `apps/landing/src/pages/.well-known/mcp/server-card.json.ts` |
| `/llms.txt`, `/robots.txt`, `/webmcp.js`, `/favicon.svg` | Static files copied as they are | `apps/landing/public/llms.txt`, `apps/landing/public/robots.txt`, `apps/landing/public/webmcp.js`, `apps/landing/public/favicon.svg` |

Redirects and headers:

| File | What it does |
|---|---|
| `apps/landing/public/_redirects` | 28 permanent (301) redirects: 17 add the trailing slash to English addresses, and 11 move retired addresses (`/comparison`, `/compare/...` and three removed posts) to the blog |
| `apps/landing/public/_headers` | Response headers: discovery `Link` headers on every page, content types for files without an extension and for `.md` files, noindex for search, legal and schema files, cache lifetimes |
| `apps/landing/functions/_middleware.js` | Sends the `www` host and the site's `pages.dev` host to the original project's website (301), sends a visitor whose chosen or browser language is French, Spanish or Serbian from an English page to its copy (302), and answers a `text/markdown` request for a home page with its `.md` file |

### Entry files

The first version of this catalog summarized each of the marketing site's entry files. They were left out when the catalog moved into the repository: the site is the original LobbyStack project's own, with its name, prices and addresses written into its code, and a deployment of this fork doesn't publish it (deployment guide, [Appendix F](../deployment/guide/appendix-f-sites.md)). The files named in the tables above are the place to start.

## 16. Keeping this catalog current

Where each list in this catalog comes from, to re-check it after a change:

| List | Where it lives |
|---|---|
| Pages | `find apps/admin/app -name page.tsx` (route groups in parentheses don't appear in the address) |
| Route handlers | `find apps/admin/app -name route.ts`; each exports its methods (GET, POST, ...) |
| Sidebar and Settings tabs | `apps/admin/src/components/dashboard-shell.tsx` and `settings-shell.tsx` |
| Onboarding steps | `packages/domain/src/server/onboarding.ts` and `apps/admin/src/lib/onboarding-route.ts` |
| Language redirects, cross-site protection, maintenance mode | `apps/admin/proxy.ts` and `apps/admin/src/lib/locale-path.ts` |
| Public API operations | `apiOperations` in `packages/shared/src/publicApi/operations.ts` |
| MCP tools | `apps/admin/src/lib/mcp/tools.ts` |
| Sign-in endpoints allowed or turned off | `enabledEmailOtpPaths` in `apps/admin/src/lib/auth.ts` and `allowedOAuthPaths` in `apps/admin/src/lib/oauth-provider.ts` |
| Who can use each dashboard API route | `minimumRole` in the route, or the role check in the `packages/domain` function it calls |
| Worker routes | `apps/worker/src/health.ts` and `apps/worker/src/liveCalls.ts` |
| Marketing site pages | `apps/landing/src/pages/`, `public/_redirects` and `functions/_middleware.js` |
| Entry file summaries | The entry file and the files listed under Related files. The summaries describe the code at `d18f916`, and those of the routes fork PRs #50 to #76 added or changed the code at `da1f548`; re-read those files when a route changes. |

### Changes since the first version

Checked on 2026-10-24 against `git diff d18f916 da1f548`:

- **Added:** `POST /api/billing/promo` (fork PR #63); `GET /api/v1/ai-traces` and `GET /api/v1/ai-traces/{trace_id}` (#51); `GET /api/v1/billing/catalog` and `GET` and `POST /api/v1/billing/catalog/runs` (#58), `POST /api/v1/billing/catalog/polar-links` (#59); `GET /api/v1/billing/plans` (#61); `GET` and `POST /api/v1/billing/codes` and `DELETE /api/v1/billing/codes/{code_id}` (#63); `DELETE /api/v1/billing/promo-plan` (#65).
- **Changed:** `GET /api/billing` (plans from the catalog, limits, promo plan; #61, #62, #64), `GET` and `POST /api/billing/checkout` (plan changes #60, promo codes #63, billing email #72, limits #74, one change at a time #75), `POST /api/billing/portal` (limits, #74), `GET /api/activation` (`numberIncluded`, #62), `POST /api/webhooks/polar` (catalog products #61, refusals logged #71, customer mismatch #72), `POST /api/voice/live/session` (AI trace #51, greeting captions #52), `POST /api/webhooks/openai/live` and `POST /api/widget/chat` (AI traces, #51), `POST /api/v1/billing/checkout` (as the dashboard's), and the onboarding number step (#62).
- **Unchanged:** the pages, the MCP tools (still 18), the sign-in service's endpoints, the worker's routes and the marketing site's pages. The dashboard's sidebar gained the version line (#57), which isn't a route.

## 17. Things that look unintended

These turned up while the entry files were read for this catalog. Each was checked against the code, but none was tried on a running server and nothing was changed. Worth a decision before the documentation describes any of them as intended.

### Access

| Route | What the code does | Where |
|---|---|---|
| `PATCH`, `DELETE /api/team`; `PATCH`, `DELETE /api/v1/team/members/{membership_id}` | A business_admin, or an API key an admin created, can demote or remove a business_owner while another owner remains: the checks refuse only the last owner and never compare roles. The team screen shows no remove action for owners, but the API accepts it. | `updateMemberRoleInTransaction` and `removeMemberInTransaction` in `packages/domain/src/server/tenancy.ts` |
| `POST /api/voice/live/session` | On the public business path (`WEB_CALL_PUBLIC_BUSINESS_SLUG`), the call keeps the `widgetId` the browser sends, so it can be recorded as a website widget call or a prospect demo call without a widget session or demo token. | `apps/admin/src/lib/live-web-call.ts:131` |
| `GET /api/integrations` | Any member, viewers included, makes the server refresh the Google token and list the connected account's calendars. Only the screen limits this to owners and admins. | `apps/admin/app/api/integrations/route.ts:29-47` |
| `GET`, `PUT /api/storage/local` | A failure answers with the raw error message, which for a file-system error can include server paths. The status is chosen by searching that message for "token" or "range". | `apps/admin/app/api/storage/local/route.ts:55-56, 79-81` |
| `POST /api/demo/preview` | This public route has no rate limit, and every call with an active demo's token records another `prospect_demo.viewed` event. | `packages/domain/src/server/demos.ts:333-335` |
| `POST /api/auth/oauth2/introspect` | Served and advertised in the OAuth discovery document, although the comment above `allowedOAuthPaths` says introspection is turned off. | `apps/admin/src/lib/oauth-provider.ts:53-64` |

### Mistakes by the caller that answer 500

`asApiResponse` keeps a status only when the error carries one. These requests throw a plain `Error` (or a `ZodError`), so they answer 500 "Request failed." and are reported as server errors, where a 400, 404, 409 or 429 was meant.

| Route | Which requests | Where |
|---|---|---|
| `GET /api/analytics` | An invalid `from` or `to`, an unknown `granularity`, a range too long for it | `apps/admin/app/api/analytics/route.ts:12, 27, 30` |
| `POST`, `PATCH /api/businesses` | POST with a `slug` another business has; PATCH with no field it knows | `packages/domain/src/server/tenancy.ts:88-116, 185` |
| `POST /api/catalog` | A missing `businessId`, or any field that fails its check | `apps/admin/app/api/catalog/route.ts:30-36` |
| `POST`, `PATCH`, `DELETE /api/rules` | A body that fails its check, an unknown rule, an empty change, a reorder that doesn't list every rule | `apps/admin/app/api/rules/route.ts`, `packages/domain/src/server/rules.ts` |
| `POST`, `PATCH`, `DELETE /api/team` | A missing body, `businessId`, `email` or valid `role`; an unknown member or invitation; the last owner | `apps/admin/app/api/team/route.ts:58-63`, `packages/domain/src/server/tenancy.ts:483-507` |
| `POST /api/team/accept` | A missing token; an unknown, expired or used invitation | `packages/domain/src/server/tenancy.ts:341-362` |
| `POST /api/knowledge` | Any `sourceType` but `website` | `packages/domain/src/server/knowledge.ts:94-95` |
| `PATCH`, `DELETE /api/knowledge/{documentId}`; `PATCH`, `DELETE /api/knowledge/snippets/{snippetId}` | An unknown document or snippet | `packages/domain/src/server/knowledge.ts:160, 235, 277, 296` |
| `PUT /api/notification-preferences` | Turning texts on without consent given now or before | `packages/domain/src/server/notifications.ts:385` |
| `PATCH /api/affiliate` | A body that isn't JSON (it uses `request.json()`, not `readJson`) | `apps/admin/app/api/affiliate/route.ts:47` |
| `POST /api/billing` | A plan other than Starter or Pro, or no billing account | `packages/domain/src/server/billing.ts:567, 573` |
| `GET`, `POST /api/billing/checkout` | A missing `requestId` or unknown request; a missing body or `businessId`; an invalid `target`, `billingInterval` or `promoCode`. An invalid `billingEmail` answers 400 since fork PR #72. | `apps/admin/app/api/billing/checkout/route.ts:23-47` |
| `POST /api/demo/claim` | A missing token; an invalid or expired demo; a demo someone else claimed | `packages/domain/src/server/demos.ts:354-369` |
| `POST /api/demos`, `POST /api/demos/{demoId}` | A missing `name` or `websiteUrl`; an unknown or closed demo, a wrong token, unmet publish needs, an unknown `action` | `apps/admin/app/api/demos/route.ts:24-26`, `packages/domain/src/server/demos.ts` |
| `POST /api/feedback` | Over the rate limit, or the limiter unavailable (429 and 503 were meant); an empty or too long message | `apps/admin/src/lib/feedback-rate-limit.ts:12`, `packages/domain/src/server/feedback.ts:34-35` |
| `PATCH`, `POST`, `DELETE /api/integrations` | An unknown or disconnected `connectionId`, an unknown staff member | `packages/domain/src/server/calendar.ts:280, 305, 316` |
| `POST /api/onboarding/phone-numbers/skip` | A business before the plan step | `packages/domain/src/server/phoneNumbers.ts:283` |
| `POST /api/onboarding/stage` | A move that skips a step or isn't allowed | `packages/domain/src/server/onboarding.ts:164-166` |
| `DELETE /api/phone-numbers` | A number that isn't active | `packages/domain/src/server/compliance.ts:36` |
| `GET`, `POST`, `PUT /api/uploads` | Any field that fails its check, a missing `businessId` included; a file over 10 MB, full storage, an upload that doesn't match, an unknown object. The upload form's own messages for these never show. | `apps/admin/app/api/uploads/route.ts:15, 30, 38`, `packages/domain/src/server/storage.ts`, `apps/admin/src/lib/storage-upload.ts:19-23` |
| `POST`, `PATCH /api/widget-keys` | Invalid `allowedOrigins` or `config`, a missing `id`, an unknown key, an empty change | `apps/admin/app/api/widget-keys/route.ts:14-70` |
| `POST /api/widget/chat` | A body that fails `widgetChatRequestSchema` | `apps/admin/app/api/widget/chat/route.ts:64` |
| `GET /api/calls/active` | Any request while no worker heartbeat is fresh, for example when the worker isn't running, even with no calls. An open Calls page asks every 5 seconds, and each answer is reported as a server error. | `packages/jobs/src/voicePresence.ts:105-119` |

### Other status codes

| Route | What the code does | Where |
|---|---|---|
| `PUT /api/hours` | Every error from saving the hours, database failures included, answers 400 with the raw message. | `apps/admin/app/api/hours/route.ts:45-49` |
| `GET /api/contacts/{contactId}`; `PATCH /api/messages` | An unknown contact answers 200 with `contact: null`; an unknown conversation answers `{ ok: true }`. | `packages/domain/src/server/contacts.ts:100`, `packages/domain/src/server/conversations.ts:300` |
| `POST /api/webhooks/twilio/status` | A payload that fails its schema answers 503 with `Retry-After: 60`, the answer meant for a failed save, where 400 fits. | `apps/admin/app/api/webhooks/twilio/status/route.ts:20, 47-50` |
| `POST /api/webhooks/openai/live` | Without `OPENAI_API_KEY`, the 503 response it builds is thrown outside any `try`, so the request ends in an unhandled error. | `apps/admin/app/api/webhooks/openai/live/route.ts:37` |
| `POST /api/widget/session` and the other widget routes | A disabled or revoked key answers 404 `widget_key_invalid`, never 403 `widget_disabled`, because the key lookup returns active keys only. | `packages/db/migrations/0038_website_chat_widget.sql:87`, `apps/admin/src/lib/widget-access.ts:70` |
| `GET /api/calendar/google/callback` | Early failures (rate limit, missing or invalid state) answer raw JSON to a browser coming back from Google. A signed-out browser gets the error redirect instead of a sign-in page. | `apps/admin/app/api/calendar/google/callback/route.ts:28-40, 60-62` |

### Other behavior

| Route | What the code does | Where |
|---|---|---|
| `POST /api/widget/chat` | The visitor's message is saved and the team alert queued before the 503 and 402 checks, so a message the widget shows as failed still reaches the inbox. `messageId` is required but never read, so a resent message is saved twice. | `apps/admin/app/api/widget/chat/route.ts:79-95`, `packages/shared/src/index.ts:341` |
| `PATCH /api/catalog/{serviceId}` | Skips the checks `POST /api/catalog` makes, so it saves a duration of 0, below 0 or over 1,440 minutes, and an empty name. The database has no check on the duration. | `apps/admin/app/api/catalog/[serviceId]/route.ts:12-19`, `packages/domain/src/server/catalog.ts:82-93` |
| `PATCH /api/widget-keys` | An unknown `status` is dropped without an error; the check meant to refuse it can never fire. | `apps/admin/app/api/widget-keys/route.ts:61-62` |
| `PATCH /api/v1/webhooks/{webhook_id}` | An empty body is accepted: it touches `updated_at` and writes an audit row naming no fields. | `packages/shared/src/publicApi/schemas.ts:836`, `packages/domain/src/server/publicApi/webhooks.ts:115` |
| `POST /api/v1/businesses` | The dashboard's limit of 10 owned businesses per account doesn't apply, so a platform key's owner account can own any number. | `packages/domain/src/server/publicApi/operations.ts:1320`, `packages/domain/src/server/tenancy.ts:33, 75` |
| `OPTIONS` on any `/api/v1/...` address | Next.js answers 204 with an `Allow` header listing all seven methods, because every route file exports the methods it refuses; a 405 from the same address lists only the real ones. | `apps/admin/app/api/v1/*/route.ts`, `apps/admin/src/lib/public-api/http.ts:88` |
| `GET /api/v1/openapi.json`, the four `/.well-known/oauth-...` metadata routes, `GET /embed/embed.js` | The proxy puts `Cache-Control: private, no-store` on these before the route runs, and Next.js keeps a header that is already set, so their own cache lifetimes (5 minutes, and a year for the loader file) most likely never reach clients. The proxy skips only `/locales/`, `/brand/` and the logo file, which do keep theirs. | `apps/admin/proxy.ts:85-91, 198`, `apps/admin/src/lib/mcp/oauth-metadata.ts:15`, `apps/admin/app/api/v1/openapi.json/route.ts:15`, `apps/admin/next.config.ts:90` |
| `GET /api/internal/finance/export?resource=businesses` | `from` and `to` are checked but not applied; only `cursor` and `limit` narrow the list. | `apps/admin/app/api/internal/finance/export/route.ts:79` |
| Realtime events | A rule change publishes `conversation.updated`, and a processed Resend email event publishes `billing.updated`, so open dashboards refetch data that didn't change. | `packages/domain/src/server/rules.ts:132`, `packages/domain/src/server/email.ts:25` |
| `DELETE /api/phone-numbers`, `GET /api/uploads` | No dashboard screen calls these. | `apps/admin/src/components/` |

### Pages

| Page | What the code does | Where |
|---|---|---|
| Every dashboard page | A signed-out visitor goes to the login page without `returnTo`, so a link to a call or a contact lands on Home after sign-in. | `apps/admin/app/(dashboard)/layout.tsx:21` |
| `/{locale}/verify-email` | The default callback adds `?verified=true`, which nothing reads, so the login page shows no confirmation. | `apps/admin/app/(sensitive)/[locale]/verify-email/page.tsx:10` |
| `/{locale}/demo` | Saves the light theme as the visitor's own choice and restores the old one only when they leave inside the app, so a reload or a closed tab keeps light. | `apps/admin/src/components/demo-surface.tsx:36-42` |
| `/settings/team` | The invite dialog offers admin and viewer only, though the API also takes scheduler, and a scheduler's badge shows the raw word `scheduler`. | `apps/admin/src/components/live-team-surface.tsx:26-32` |
| `/agent/services` | Loads at most 100 services, so a longer list is cut off without notice. | `apps/admin/src/components/live-services-surface.tsx:54` |
| `/settings/account`, `/messages`, `/analytics`, `/{locale}/demo/{token}` | Some text is hard-coded in English: the account page's loading and error lines, the web chat tooltip, the analytics error, and "Opening secure demo link...". | `live-account-surface.tsx:20`, `live-messages-surface.tsx:209`, `live-analytics-surface.tsx:126`, `demo-token-compatibility-route.tsx:19` in `apps/admin/src/components/` |

### Marketing site

| Route | What the code does | Where |
|---|---|---|
| The home, features, pricing, about, affiliate and calculator `.md` copies | Each starts with two front matter blocks: the Markdown text already has one, and `renderMarkdownAlternate` adds another. | `apps/landing/src/lib/markdown-response.ts:15`, `apps/landing/src/lib/agent-discovery.ts:541` |
| `.md` copies, `/openapi.json`, `/api/status`, `SKILL.md` | Headers the endpoint code sets (content type, `Cache-Control`, `X-Markdown-Tokens`) are never served: a static build keeps only the body, so `public/_headers` is the only source of headers. | `apps/landing/src/lib/markdown-response.ts:24` |
| `/feed.xml` | Its Markdown converter handles only `#` and `##` headings, `- ` lists and paragraphs, so links, tables, `###` headings and numbered lists show as raw Markdown. | `apps/landing/src/pages/feed.xml.ts:13` |
| `/fr/solutions/self-hosted-ai-receptionist/` | Its main button, "Lire la documentation", opens `/docs/api/`, the guide to the site's discovery files. The English, Spanish and Serbian copies of this page open the original project's self-hosting guide. | `apps/landing/src/lib/fr-seo-landing-pages.ts:664`, `apps/landing/src/lib/seo-landing-pages.ts:436` |
| The original project's PostHog relay host | `apps/landing/README.md` and the original version of `docs/deployment/landing-cloudflare-pages.md` say the middleware forwards this host to PostHog, and the cookie banner sends PostHog traffic there by default, but the middleware has no such code. | `apps/landing/functions/_middleware.js`, `apps/landing/src/lib/posthog.ts:8`, `apps/landing/README.md:29` |
