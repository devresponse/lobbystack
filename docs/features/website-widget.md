# Run the website widget

The website widget puts the receptionist on a business's own website: a chat, a "Say Allo!" button that starts a browser call, and, when the business turns it on, live chat with its team. One script tag adds it. This page covers how it works, how to switch it on, its limits, and what the fork changed. Checked against `main` at `f30fce3`.

## Know how it works

1. The site adds one script tag, which the dashboard's Widget page shows: `<script src="https://<dashboard domain>/embed.js?key=<key>" data-widget-key="<key>" defer></script>` (`packages/shared/src/widget.ts`). The loader is built from `packages/embed` and served at `/embed.js`.
2. The loader opens an iframe panel at `/embed/<key>`, the widget app in `apps/admin/app/(app)/embed`.
3. The panel talks to `/api/widget/*`: `session`, `session/verify`, `config`, `history`, `chat`, `lead` and `stream`. Each request checks the key, the website's origin against the key's allowed websites, and the rate limits below. On a deployment with Turnstile's keys, the panel passes Cloudflare Turnstile's check before the receptionist answers it ([below](#stop-scripts-from-spending-a-businesss-chats)).
4. A chat message runs the receptionist agent from `packages/agent-core` on the `web_chat` channel. The conversation keys on the widget visitor's ID, so no phone number is needed.
5. "Say Allo!" starts a browser WebRTC call to GPT-Live through `/api/voice/live/session`, the same route as the dashboard's test call, on the `web_voice` channel. No Twilio or SIP is involved. The worker attaches to the call as it does for phone calls ([voice runtime](../voice/runtime.md)). Since fork PR #84, a line under the button says calls are answered by an AI assistant and are recorded and transcribed, as the call says after its greeting, unless the business turned that off ([calls](calls.md#tell-callers-theyre-speaking-with-an-ai-and-the-call-is-recorded)).
6. Team replies, take-overs and new messages reach the panel through `/api/widget/stream` (server-sent events) and the dashboard's Messages page through `/api/realtime`. Both read one Redis channel per business that the worker publishes to.

## Switch it on

| Setting | Where | What it does |
| --- | --- | --- |
| `WIDGET_KEY_ISSUANCE_ENABLED=true` | Admin, then redeploy | Lets the dashboard create widget keys. Without it, the Widget page says new widgets aren't available yet. |
| `WIDGET_SESSION_SECRET` | Admin | Signs widget sessions. Set a long random value. |
| `TRUSTED_CLIENT_IP_HEADER` | Admin | The header that holds the visitor's real IP: `x-real-ip` on Railway, also with Cloudflare's proxy in front, or `cf-connecting-ip` where nothing but Cloudflare can reach the admin. Without it, no per-IP limit runs. Since fork PR #174, a production admin on Railway doesn't start without it ([below](#stop-scripts-from-spending-a-businesss-chats)). |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Admin | The Turnstile keys sign-up uses. With both, the chat runs Turnstile's check before the receptionist answers (fork PR #174). |
| `WIDGET_TURNSTILE=false` | Admin | Turns the chat's check off while keeping it on sign-up. The admin then logs `widget.turnstile_off` as it starts. |
| `WIDGET_CHAT_DAILY_PERCENT` | Admin | The share of a business's chats for the month that the receptionist may start in one UTC day, from 1 to 99. Unset, 25; `100` or `off` turns the daily limit off. |
| `LIVE_PROTOTYPE_ENABLED=true`, `OPENAI_API_KEY` | Admin and worker | Needed for "Say Allo!". |
| `WEB_CALL_MAX_DURATION_MS` | Admin | Shortens website calls below the 30-minute default. |
| `LIVE_RECORDED_GREETING` | Admin | Unset or anything but `false` (since fork PR #139; before, `true`): opens browser calls, and phone calls, with a recording of the greeting ([calls](calls.md#open-calls-with-a-recorded-greeting)). |

Then, in the dashboard, open **Widget** in the menu, create a key, list the websites allowed to use it, set the look (colour, position, greeting) and copy the snippet. A key's **Live chat** setting is off until the business turns it on.

Since fork PR #161 on `releases/r2`, that list is the field **Allowed origins (list of websites allowed to host a chat widget)**, and on a new key it starts with the deployment's own address, `APP_BASE_URL`'s origin (`https://<APP_HOST>` on a deployment the setup script made). The owner adds the business's website after a comma, or replaces the address. The page reads `APP_BASE_URL` on the server each time it opens (`defaultWidgetKeyOrigin` in `apps/admin/src/lib/widget-keys.ts`), and without it the field starts empty, as before. Listed, the deployment's address lets the key run on the deployment's own pages and nowhere else; the business's published profile page runs the widget it shows either way.

On a test deployment closed to strangers with `PROTECTION_TOKEN` (fork PR #176 on `releases/r2`), the widget keeps working on the business's website for visitors who never opened the access link: the loader, the chat window, `/api/widget/` and the call's session are among the routes the gate leaves open, behind the widget's own checks. The dashboard's Widget page and the business's published profile page are closed like every other page ([close a test deployment to strangers](access-gate.md#know-what-stays-open)).

The call button shows only when the business has an active voice number, the business's saved context snapshot names that number, `LIVE_PROTOTYPE_ENABLED=true` and `OPENAI_API_KEY` are set, and the plan has minutes left. Since fork PR #30, claiming or releasing a number refreshes the snapshot. Before it, the button stayed hidden until something else refreshed it.

## Choose the widget's receptionist

Since fork PR #129 a business can have several receptionists. Each widget key names the one that answers its chats and calls: **Receptionist** on the key in **Settings > Website widget**, which a new key sets to the default receptionist unless the form picks another. While that receptionist is paused or archived, the default one answers.

- **On the business's own pages,** the page decides instead. `/profile/<slug>` and `/profile/<slug>/<handle>` sign a token naming their receptionist (`createReceptionistPageToken` in `apps/admin/src/lib/widget-keys.ts`, with a key derived from `WIDGET_SESSION_SECRET`), the page's script tag carries it as `data-receptionist-token`, the loader sends it with the session request as `receptionistToken`, and `/api/widget/session` checks it was signed for this business and this key before it puts the receptionist in the session token. A token that doesn't check out is logged as `widget.receptionist_token_rejected` and the key's receptionist answers.
- **The chat and the call** answer with that receptionist's view of the business's snapshot, and `/api/widget/config` returns its name (`receptionist`), never what it helps with.
- **A visitor's chat belongs to its receptionist.** On another receptionist's page, `/api/widget/history` shows no earlier chat and the next message starts one with this receptionist, unless the team has taken the earlier chat over, which stays the visitor's.

The v1 API's widget key fields don't include the receptionist yet ([receptionists](receptionists.md#know-what-visitors-see)).

## Know what the receptionist says on the website

- On `web_chat` and `web_voice`, the receptionist never says it is transferring or connecting anyone (fork PR #18). If a phone call to the business could reach a person, it gives the business's own number, never the transfer number. Otherwise it says it can't connect them. It always offers to take a message.
- The keypad PIN and text-message codes are phone-only, so website callers who want to change an appointment get a message taken for the team.
- Chat replies stay short and on topic, and are capped in length (fork PR #8).
- Web addresses in chat become links (fork PR #21). Every bubble goes through `renderSafeMarkdown` (`apps/admin/src/lib/widget-markdown.ts`), which escapes all HTML first, then formats code, bold and `http(s)` links. HTML links, `mailto:`, `tel:` and addresses without a scheme stay text on purpose.

## Know which language the chat uses

- **The widget's words** are in English, French, Spanish or Serbian. **Settings** > **Website widget** > **Language** sets one of them. Left at "Visitor's language", the widget shows the first of the visitor's browser languages it has, and otherwise the business's **Default customer language** when it's one of those four, or else English (`widgetLocale` in `apps/admin/src/components/widget/widget-chat-client.tsx`). Until fork PR #81 it always showed the business's language, English or French.
- **The replies** start in the widget's language. When the visitor writes in another language, or asks for one, the receptionist answers in it and keeps it for the rest of the chat, even when the documents it answers from are in another language, until the visitor switches again (the chat's `extraInstructions` in `apps/admin/app/api/widget/chat/route.ts`). Until fork PR #81 it switched only when the visitor asked.
- **"Say Allo!"** opens in the business's **Default customer language**, any of the 13 that calls open in since fork PR #82, as a phone call does, and follows the caller from there ([calls](calls.md#know-which-language-a-call-uses)).

## Hand a chat to the team

With **Live chat** on, the agent's `requestTeamMember` tool lets a visitor ask for a person during opening hours (fork PR #19, migration `0099`):

1. The chat is marked as waiting for the team, and the business gets a live chat alert, by email or by opt-in text.
2. The visitor sees a waiting banner. If nobody joins within 3 minutes, the receptionist takes the chat back and offers a callback.
3. When someone joins from Messages, the visitor sees their first name, never their email. The first person to join keeps the chat.
4. If the team goes quiet for 10 minutes after taking over, the receptionist answers the visitor's next message (`TEAM_CHAT_QUIET_MS`).

A chat whose last message is a day old closes, and the visitor's next message starts a new one (`WIDGET_CHAT_IDLE_CLOSE_MS`). Live updates and the 3-minute hand-back need the worker running, with the same `REDIS_URL` and `REDIS_PREFIX` on the admin and the worker.

## Stop scripts from spending a business's chats

The widget's key is public: it's in the snippet on the business's website. Since fork PR #174 on `releases/r2` (AUDIT-004 in the technical audit of 2026-11-14), three things stop a script that uses it from spending the business's chats.

1. **Turnstile's check before the receptionist answers.** On a deployment with both Turnstile keys, the chat window runs Cloudflare Turnstile as soon as the loader's session arrives, invisibly unless Cloudflare wants the visitor to tick a box. It sends Turnstile's token with the session to `POST /api/widget/session/verify`, which asks Cloudflare and signs the same session again, marked as checked. The chat route answers only a checked session; any other gets 403 `widget_challenge_required` before anything is saved. Each new session from the loader gets its own check, which has usually passed by the time the visitor sends a message. Until it has, the Send button spins and the message stays in the box; when it can't pass, the widget says so and keeps the message.
2. **A daily limit for each business.** The receptionist starts at most a quarter of the business's chats for the month in one UTC day, rounded up and never fewer than 10: 13 a day on Starter's 50, 50 a day on Pro's 200. On a pack, it's a quarter of the pack's chats. A plan without a chat limit has no daily limit. Past it, the visitor's message still reaches **Messages**, where the team can answer, but the receptionist doesn't reply, and the widget says "Today's chat limit has been reached. Our team will reply shortly." The team gets one "Your website chat reached today's limit" email a day, the **Website chat reached its daily limit** notification. A chat that started before the limit keeps its receptionist.
3. **The limits per IP address always run on Railway.** A production admin on Railway doesn't start without `TRUSTED_CLIENT_IP_HEADER` set to `x-real-ip` or `cf-connecting-ip`, and Railway keeps the running version until a deploy has it. The Railway template, `.railway/railway.ts` and the setup script set `x-real-ip`. Off Railway, the admin can't tell which proxy is in front of it, so the setting stays optional there.

The check runs in the chat's own frame, on the dashboard's address, so the Turnstile widget's hostname list needs only the dashboard's domain, never the businesses' websites, and a loader a website cached keeps working. The other widget requests, the settings, history, live updates and lead form, keep the loader's session. A chat window open when the deploy that brought the check lands can't send until the visitor reloads the page.

What to look for when it goes wrong:

| What happens | Why | What to do |
| --- | --- | --- |
| The admin's log has `widget.turnstile_off` at startup | The deployment has no Turnstile keys (`keys_missing`), or `WIDGET_TURNSTILE=false` (`turned_off`), so the chat answers without the check | Add both keys ([guide, 3.5](../deployment/guide/part-3-outside-services.md#35-cloudflare-turnstile)), or remove `WIDGET_TURNSTILE` |
| Visitors see "Your browser couldn't be checked" | `widget.verify_refused` lines say why: `widget_challenge_failed` (Cloudflare turned the token down), `widget_challenge_unavailable` (Cloudflare couldn't be asked) or a rate limit | Check that the Turnstile widget lists the dashboard's domain. To let chats through while you look, set `WIDGET_TURNSTILE=false` |
| A deploy on Railway fails with `[trusted-client-ip] TRUSTED_CLIENT_IP_HEADER is not set` | The admin has no trusted IP header | Set `TRUSTED_CLIENT_IP_HEADER=x-real-ip` on the admin and deploy again. It serves with Cloudflare's proxy in front too; `cf-connecting-ip` is only for an admin that nothing but Cloudflare can reach |
| A business's chats stop answering with `chat_daily_limit_reached` in `widget.chat_refused` | It started as many chats today as its daily limit allows | The line's `dailyLimit` and `plan` say which limit. A busy but genuine day needs a bigger plan or a higher `WIDGET_CHAT_DAILY_PERCENT` |

## Know the limits

Limits are fixed windows in Redis, checked before the request does its work. A refused request uses no quota. When Redis is down, every widget route answers 503.

Each count's Redis key names what it counts by its id, such as the business, the key or the visitor, and an IP address only by its SHA-256 digest, so Redis never holds an address. Before fork PR #152 every key was a digest, so the counts named by ids started again from zero once after that deploy.

**Chat and the other widget requests** (`apps/admin/src/lib/widget-policy.ts`):

| Count | Chat messages | Other requests (session, the chat's check, history, config, lead, live updates) |
| --- | --- | --- |
| Per key, each minute | 60 | 180 |
| Per key, each hour | 600 | 1,000 |
| Per business, new sessions each minute | | 60 |
| Per visitor, hour and day | 60 and 300 | 120 and 600 |
| Per IP, hour and day (only with `TRUSTED_CLIENT_IP_HEADER`) | 60 and 300 | 120 and 600 |

Each kind of request has counts of its own, so opening the widget doesn't spend the chat's. On top of these, the receptionist starts at most the business's daily share of its chats each UTC day ([above](#stop-scripts-from-spending-a-businesss-chats)), and one admin process keeps at most 1,000 live update streams open; past that, a chat falls back to its slower history check. Since fork PR #174 the stream is counted before its first wait, so a burst can't open more, and each one ends after 9 to 10 minutes, at random, so the streams a deploy cut off don't all come back at the same moment.

**Browser calls** (`apps/admin/src/lib/web-voice-policy.ts`):

| Count | Website calls | Dashboard test calls |
| --- | --- | --- |
| Per visitor | 10 an hour, 50 a day | 30 an hour, 100 a day |
| Per IP (only with `TRUSTED_CLIENT_IP_HEADER`) | 20 an hour, 100 a day | 30 an hour, 100 a day |
| Per website origin | 30 every 10 minutes | 120 every 10 minutes |
| Per business | 60 an hour, 300 a day | 120 an hour, 600 a day |
| The whole deployment | 120 a minute | 120 a minute |

Every allowed call start counts, even one that then fails at OpenAI. A refused start logs `live.browser_refused` with the status and reason, and the widget says why (fork PR #49). OpenAI's own refusals are reported as errors ("OpenAI refused to create the live session").

A website call lasts at most 30 minutes. A minute before the end, the receptionist warns the caller, and at the end it says goodbye before hanging up ([calls](calls.md#end-calls-politely-at-the-time-limit)). On a plan with included minutes, a website call reserves its whole length when it starts.

## Find out why a reply failed

When the receptionist can't answer, the widget says "Your message couldn't be sent. Please try again." and shows an Error ID under it (fork PR #79). By then the visitor's message is saved and the "New website chat message" alert has gone out, so the message waits in **Messages**.

1. Copy the Error ID from the widget. The browser has it too: in the developer tools' **Network** tab, the `chat` request's answer ends with an `error` part whose `errorText` holds `"code":"chat_reply_failed"` and the `errorId`.
2. Filter the admin's log with `@errorId:<id>` ([guide, 7.11](../deployment/guide/part-7-operations.md#711-logs-error-ids-and-following-one-call)). The line starts with `[admin] exception:` and the error's own message, such as OpenAI's explanation. With PostHog set up, Error Tracking has the same report, with the operation `widget.chat_reply`.
3. Read the line's fields. None of them holds what the visitor or the receptionist wrote.

| Field | What it says |
| --- | --- |
| `category` | Why the reply failed, from the table below |
| `providerErrorStatus`, `providerErrorCode`, `providerErrorKind`, `providerErrorParam` | What OpenAI answered: the HTTP status, its error code and type, and the request field it objected to |
| `retryable`, `attempts` | Whether trying again could help, and, when the AI SDK retried, how many tries it made (3 at most) |
| `stage` | How far the reply got: `load_context` (the business's details and the chat so far), `generate` (the AI) or `save_reply` |
| `modelSteps`, `tools`, `durationMs` | The model steps that finished, the tools they called, and how long the reply ran |
| `businessId`, `conversationId` | The business, and the chat |

| `category` | What it usually means | What to check |
| --- | --- | --- |
| `provider_auth` | OpenAI answered 401 or 403: the key is wrong or revoked, or its project may not use the model | `AI_CHAT_API_KEY` on the admin, or `OPENAI_API_KEY` when that isn't set, and the key's project at OpenAI |
| `provider_rejected` | Another 4xx, such as 400 or 404: a model the account can't use, a setting the model doesn't take, or a request that's too big. `providerErrorParam` names the setting | `AI_CHAT_MODEL`, `AI_CHAT_REASONING_EFFORT` and `AI_CHAT_SERVICE_TIER` on the admin |
| `provider_rate_limited` | 429. `insufficient_quota` means the OpenAI account is out of credit; any other code is a rate limit | Billing and limits at OpenAI ([guide, 7.13](../deployment/guide/part-7-operations.md#713-costs-and-usage-limits)) |
| `provider_unavailable` | 408, 409 or 5xx, still failing after the AI SDK's retries | OpenAI's status page. It usually passes |
| `provider_unreachable` | No answer from OpenAI: the name lookup, the network or TLS failed | The admin's outbound network, and `AI_CHAT_BASE_URL` when it's set |
| `invalid_response` | An answer the AI SDK couldn't read | The `ai` and `@ai-sdk/openai` versions, against the model |
| `output_limit` | The model used the reply's 4,000 output tokens, usually on reasoning, before writing anything | `AI_CHAT_REASONING_EFFORT` |
| `content_filter` | The provider's filter stopped the reply | The chat in **Messages** |
| `step_limit` | The model called tools in all 4 of its steps and never wrote a reply | The reply's AI trace ([calls](calls.md#trace-what-the-ai-was-given)) |
| `no_reply` | The model stopped without writing anything | The reply's AI trace |
| `generation_failed` | Anything else, such as a tool that threw, or the database while the chat loaded | `stage`, and the error's stack in PostHog |

A message turned away before the reply starts shows the same words without an Error ID, or, since fork PR #174, words of its own for the day's limit, a visitor sending too fast, and a session that didn't pass Turnstile's check. The admin's `widget.chat_refused` line has its `status` and `code`, and for a rate limit the `reason`, which names the count that ran out, such as `rate_limit_visitor_hour`. The codes are `widget_challenge_required` (403, a session without Turnstile's check), `widget_rate_limited` (429), `chat_daily_limit_reached` (429, with the business's `dailyLimit`) and `chat_ai_limit_reached` (402, the month's chats). The check itself logs `widget.verify_refused` with its `status` and `code`. When the admin fails before the reply starts, such as while saving the message, the widget shows an Error ID, and the report's operation is `widget.chat`.

Each answer logs `widget.chat_reply`, with `durationMs`, `timeToFirstTokenMs`, `modelSteps`, `tools`, `finishReason` and the token counts. A visitor's request for a person logs `widget.team_request` with its `outcome`: `requested`, `closed` (outside opening hours), `team_has_chat` or `not_found`. These lines carry `businessId` and `conversationId`, and never the chat's words.

## Know what was changed in the fork

| Pull request | Change |
| --- | --- |
| #6, #7 | Widgets in the dashboard menu, settings checked, the bubble's look set from the dashboard, and the snippet shown again. |
| #8, #9, #10, #11 | Replies stay on topic; live captions during calls, and a question before leaving mid-call; one panel size that follows streaming replies, and the "Say Allo!" button; the loader paints in the widget's colour. |
| #18, #19 | What the receptionist says about transfers on the website; live chat with the team. |
| #20, #21 | The send arrow points right; clickable links. |
| #22 | Six bugs from the [widget review](../reviews/widget-2026-10-15.md): a site's fixed elements covered the panel, a taken-over chat never returned to the AI, a reply was lost when the visitor changed page, a snippet in `<head>` without `defer` failed, an unlisted website got a generic error, and the panel painted in the browser's language first. PostHog left the widget, so a first open loads about 100 KB less and stores nothing for analytics. |
| #23 to #26 | The history loads with the settings, the visitor is saved once per session, allowance checks stop writing, and the conversation starts with the first message. A returning visitor's chat opens in about 250 ms instead of 360 ms, and a first open writes 2 rows instead of 8. |
| #30 | The call button appears as soon as the business gets its number (migration `0101` refreshes existing snapshots). |
| #43 | Messages and the widget keep updating after a dropped connection, such as during a deploy. Streams reopen with backoff, and the loader renews its session before it expires. |
| #45, #49, #52, #54 | The recorded greeting, clearer call refusals and higher limits, the greeting on the caller's first audio, and 30-minute calls with a polite ending. |
| #79 | A failed reply shows an Error ID, and the admin logs and reports why ([above](#find-out-why-a-reply-failed)). A reply cut off by an error is no longer saved as if it were whole, and a request that fails its checks answers 400 instead of 500. |
| #80 | A call's captions leave out the sounds GPT-Live's transcription marks in square brackets, such as "[tongue click]" or "[laughs]", and a caption that was only a sound goes. The saved transcript and the receptionist's agent leave them out too ([calls](calls.md#follow-a-call)). |
| #81 | The chat answers in the language the visitor writes in and keeps it, and "Visitor's language" follows the visitor's browser ([above](#know-which-language-the-chat-uses)). |
| #82 | "Say Allo!" opens in any of the 13 languages a business can pick, and the widget's words fall back to English for a business language they aren't translated into. |
| #84 | A line under "Say Allo!" says calls are answered by an AI assistant and are recorded and transcribed, and the call says so after its greeting. A website call can send the team an email after it ([email](email.md#email-the-team-after-each-call)). |
| #174, on `releases/r2` | AUDIT-004: Turnstile's check before the receptionist answers, a daily chat limit for each business with an email to its team, and no production start on Railway without `TRUSTED_CLIENT_IP_HEADER` ([above](#stop-scripts-from-spending-a-businesss-chats)). Reliability: the loader tries a failed first session again three times, renews its session when the page wakes, comes back online or returns from the back button, times its renewal by the seconds the server gives rather than the visitor's clock, and asks for a new session when the chat finds its own turned down; streams reopen at random moments and are counted before their first wait. |
| #176, on `releases/r2` | The widget stays open on a test deployment closed with `PROTECTION_TOKEN`: the loader, the chat window, `/api/widget/` and the call's session answer without the access cookie ([close a test deployment to strangers](access-gate.md)). Nothing in the widget changed. |
| #161, on `releases/r2` | A new key's allowed origins start with the deployment's own address, and the field is labelled "Allowed origins (list of websites allowed to host a chat widget)" in all four languages ([above](#switch-it-on)). A key whose list names that address no longer passes the origin check for every website when the check isn't strict; every widget route checks strictly, so nothing changed for them. |

## Know the gaps

- Bots: since fork PR #174 the receptionist answers a website chat only after Turnstile's check, and starts at most the business's daily share of its chats. Nothing but rate limits stops a script from opening sessions, sending the lead form or starting calls: one script can use a business's hourly session allowance, and a business with a phone number can be called for about $75 a day. Turnstile before a call, Cloudflare in front, and a per-business call concurrency cap are recommended and not built ([widget scalability](../reviews/widget-scalability-2026-10-15.md), [roadmap](../roadmap/protect-the-deployment.md)).
- Turnstile's check inside the widget's frame, on a customer's website, hasn't been tried in a real browser with real keys. Its tests use a stand-in for Turnstile. Safari and Firefox may ask visitors to tick the box more often in a frame from another site.
- Capacity: one admin process handled about 400 people chatting at once in a local test. Past that, add admin replicas, which first needs connection pooling ([scalability](../reviews/scalability-2026-10-18.md)).
- Left from the review's improvement list: stop the 45-second fallback poll, measure time to the first word, cache the loader with an ETag, a panel-only layout, and a spending cap per website rather than per business.
- Left from the realtime work: hand back an overdue team request when the visitor writes, keep polling whenever live updates are down, link a website call to its widget visitor, and show who replied on Messages.
- When only the reply fails, the widget still says "Your message couldn't be sent. Please try again.", though the message was saved and the team alerted, and sending it again saves it twice.
- A real GPT-Live call through the widget on a website hasn't been run since fork PRs #18, #52, #54 and #84. `pnpm voice:eval --browser --recorded-greeting` ran on 2026-11-07 and passed 23 of 24 ([calls](calls.md#know-what-hasnt-been-tried)).
