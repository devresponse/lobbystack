# Run the website widget

The website widget puts the receptionist on a business's own website: a chat, a "Say Allo!" button that starts a browser call, and, when the business turns it on, live chat with its team. One script tag adds it. This page covers how it works, how to switch it on, its limits, and what the fork changed. Checked against `main` at `da1f548`.

## Know how it works

1. The site adds one script tag, which the dashboard's Widget page shows: `<script src="https://<dashboard domain>/embed.js?key=<key>" data-widget-key="<key>" defer></script>` (`packages/shared/src/widget.ts`). The loader is built from `packages/embed` and served at `/embed.js`.
2. The loader opens an iframe panel at `/embed/<key>`, the widget app in `apps/admin/app/(app)/embed`.
3. The panel talks to `/api/widget/*`: `session`, `config`, `history`, `chat`, `lead` and `stream`. Each request checks the key, the website's origin against the key's allowed websites, and the rate limits below.
4. A chat message runs the receptionist agent from `packages/agent-core` on the `web_chat` channel. The conversation keys on the widget visitor's ID, so no phone number is needed.
5. "Say Allo!" starts a browser WebRTC call to GPT-Live through `/api/voice/live/session`, the same route as the dashboard's test call, on the `web_voice` channel. No Twilio or SIP is involved. The worker attaches to the call as it does for phone calls ([voice runtime](../voice/runtime.md)).
6. Team replies, take-overs and new messages reach the panel through `/api/widget/stream` (server-sent events) and the dashboard's Messages page through `/api/realtime`. Both read one Redis channel per business that the worker publishes to.

## Switch it on

| Setting | Where | What it does |
| --- | --- | --- |
| `WIDGET_KEY_ISSUANCE_ENABLED=true` | Admin, then redeploy | Lets the dashboard create widget keys. Without it, the Widget page says new widgets aren't available yet. |
| `WIDGET_SESSION_SECRET` | Admin | Signs widget sessions. Set a long random value. |
| `TRUSTED_CLIENT_IP_HEADER` | Admin | The header that holds the visitor's real IP, such as `x-real-ip` on Railway or `cf-connecting-ip` behind Cloudflare. Without it, no per-IP limit runs. |
| `LIVE_PROTOTYPE_ENABLED=true`, `OPENAI_API_KEY` | Admin and worker | Needed for "Say Allo!". |
| `WEB_CALL_MAX_DURATION_MS` | Admin | Shortens website calls below the 30-minute default. |
| `LIVE_RECORDED_GREETING=true` | Admin | Opens browser calls with a recording of the greeting ([calls](calls.md#open-browser-calls-with-a-recorded-greeting)). |

Then, in the dashboard, open **Widget** in the menu, create a key, list the websites allowed to use it, set the look (colour, position, greeting) and copy the snippet. A key's **Live chat** setting is off until the business turns it on.

The call button shows only when the business has an active voice number, the business's saved context snapshot names that number, `LIVE_PROTOTYPE_ENABLED=true` and `OPENAI_API_KEY` are set, and the plan has minutes left. Since fork PR #30, claiming or releasing a number refreshes the snapshot. Before it, the button stayed hidden until something else refreshed it.

## Know what the receptionist says on the website

- On `web_chat` and `web_voice`, the receptionist never says it is transferring or connecting anyone (fork PR #18). If a phone call to the business could reach a person, it gives the business's own number, never the transfer number. Otherwise it says it can't connect them. It always offers to take a message.
- The keypad PIN and text-message codes are phone-only, so website callers who want to change an appointment get a message taken for the team.
- Chat replies stay short and on topic, and are capped in length (fork PR #8).
- Web addresses in chat become links (fork PR #21). Every bubble goes through `renderSafeMarkdown` (`apps/admin/src/lib/widget-markdown.ts`), which escapes all HTML first, then formats code, bold and `http(s)` links. HTML links, `mailto:`, `tel:` and addresses without a scheme stay text on purpose.

## Hand a chat to the team

With **Live chat** on, the agent's `requestTeamMember` tool lets a visitor ask for a person during opening hours (fork PR #19, migration `0099`):

1. The chat is marked as waiting for the team, and the business gets a live chat alert, by email or by opt-in text.
2. The visitor sees a waiting banner. If nobody joins within 3 minutes, the receptionist takes the chat back and offers a callback.
3. When someone joins from Messages, the visitor sees their first name, never their email. The first person to join keeps the chat.
4. If the team goes quiet for 10 minutes after taking over, the receptionist answers the visitor's next message (`TEAM_CHAT_QUIET_MS`).

A chat whose last message is a day old closes, and the visitor's next message starts a new one (`WIDGET_CHAT_IDLE_CLOSE_MS`). Live updates and the 3-minute hand-back need the worker running, with the same `REDIS_URL` and `REDIS_PREFIX` on the admin and the worker.

## Know the limits

Limits are fixed windows in Redis, checked before the request does its work. A refused request uses no quota. When Redis is down, every widget route answers 503.

**Chat and the other widget requests** (`apps/admin/src/lib/widget-policy.ts`):

| Count | Chat messages | Other requests (session, history, config, lead) |
| --- | --- | --- |
| Per key, each minute | 60 | 180 |
| Per key, each hour | 600 | 1,000 |
| Per business, new sessions each minute | | 60 |
| Per visitor, hour and day | 60 and 300 | 120 and 600 |
| Per IP, hour and day (only with `TRUSTED_CLIENT_IP_HEADER`) | 60 and 300 | 120 and 600 |

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

## Know the gaps

- Bots: nothing but rate limits stops a script from opening sessions or starting calls. One script can use a business's hourly session allowance, and a business with a phone number can be called for about $75 a day. Turnstile before opening and before a call, Cloudflare in front, and a per-business call concurrency cap are recommended and not built ([widget scalability](../reviews/widget-scalability-2026-10-15.md)).
- Capacity: one admin process handled about 400 people chatting at once in a local test. Past that, add admin replicas, which first needs connection pooling ([scalability](../reviews/scalability-2026-10-18.md)).
- Left from the review's improvement list: stop the 45-second fallback poll and add jitter, measure time to the first word, cache the loader with an ETag, a panel-only layout, Turnstile, and a spending cap per website.
- Left from the realtime work: hand back an overdue team request when the visitor writes, keep polling whenever live updates are down, link a website call to its widget visitor, and show who replied on Messages.
- A real GPT-Live call through the widget, and `pnpm voice:eval --browser`, haven't been run since fork PRs #18, #52 and #54.
