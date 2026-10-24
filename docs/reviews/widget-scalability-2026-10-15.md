# Know how far the widget scales, 2026-10-15

On 2026-10-15 a local production build of `9f9c30e` (with fork PR #22) was load tested: one admin process pinned to 2 cores, 400 test businesses, and a stand-in AI that answers in 4 seconds, first words at 1.5. It measured how many people one process serves, which limits bind first, and what request floods do. None of it ran on Railway, so read the numbers as an order of magnitude. Nothing it recommends has been done yet ([open items](../project/open-items.md)).

## Know the answer

- **Per business,** the code's own limits bind long before the server: at the time, 60 widget opens and 60 messages a minute, and 600 messages an hour, about 150 four-message chats. [Website widget](../features/website-widget.md#know-the-limits) lists today's limits, which fork PR #49 raised for calls.
- **Per deployment,** one admin process served about 400 people chatting at once, slowed at 600 and failed at 800. Its single JavaScript thread runs out first; a bigger machine doesn't help, a second admin copy does.
- **OpenAI may bind first:** on the Build tier, about 285 chat replies a minute (an estimate of 7,000 tokens a reply) and 50 GPT-Live sessions at once, shared by widget and phone calls. The monthly spend limit is shared by every business.
- **Network floods** stop at Railway's edge. **Request floods** reach the app and slow every business's widget and the dashboard, since one process serves them all.

## Know the measurements

| People chatting at once | Replies a second | Widget open, typical and slowest 5% | First words, typical and slowest 5% | Failed |
| --- | --- | --- | --- | --- |
| 200 | 4.8 | 0.14 s, 0.28 s | 1.6 s, 1.6 s | none |
| 400 | 9.4 | 0.55 s, 1.3 s | 1.6 s, 2.1 s | none |
| 600 | 13.5 | 3.5 s, 9.5 s | 1.8 s, 6.4 s | none |
| 800 | 13.0 | 24 s, 32 s | 3.8 s, 9.5 s | 190 of about 990 opens |
| 800, with a pool of 24 | 13.9 | 26 s, 38 s | 3.4 s, 6.9 s | 14 of about 830 opens |

- At 800, requests waited more than 5 seconds for a database connection and failed; a bigger pool turned errors into waiting.
- Memory stayed under 1 GB.
- A chat reply costs about 37 ms of the thread; the peak was about 24 replies a second.
- The live update connections' cap of 1,000 per process could be passed in a burst, because the check races.

## Know the outside limits

| Limit | Build | Launch | Grow |
| --- | --- | --- | --- |
| Chat model tokens a minute | 2M (about 285 replies) | 10M (about 1,400) | 180M (about 25,000) |
| GPT-Live sessions at once | 50 | 300 | 500 |
| Monthly spend limit | $500 | $5,000 | $200,000 |

When OpenAI refuses for rate, nothing queues: in a test with refusals switched on, about two thirds of messages ended in an error. On Railway, more capacity means more admin replicas, set by hand; three or more need PgBouncer, since Postgres allows 100 connections.

## Know the abuse risks

The widget key has to be public, so anything the widget can do, a script can do too:

- **Lock a business out.** The per-business limits that protect the server can be used up by a script, so real visitors are refused until the window resets.
- **Run up costs.** Website calls cost GPT-Live minutes, and calls from several businesses can fill the deployment's GPT-Live sessions, so phone calls fail too.
- **Slow everyone down.** Rate limits are checked only after database work and nothing sheds load, so a few hundred requests a second from one machine slowed every widget.
- **Leave side effects:** database rows per scripted visitor, and an operator alert email per new web chat.

A Railway hard spend limit takes every service offline when reached, so prefer usage alerts.

## Do these, in order

Settings, no code:

1. Put Cloudflare's free plan in front of the dashboard's domain, with a rate-limit rule on `/api/widget/`, caching `/embed.js` and `/_next/static/`, SSL set to Full, and Bot Fight Mode off, since it can't exempt the widget's calls.
2. Make Cloudflare the only way in, with Railway Edge Rules that allow only Cloudflare and block the `railway.app` address.
3. Set `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip` on the admin, which turns the per-IP limits on. Without Cloudflare, `x-real-ip` may work; test it first.
4. Cap the bills, not the service: budget alerts on the OpenAI project and Railway usage alerts. `AI_CHAT_REASONING_EFFORT=low` also cuts tokens per reply.

Code:

5. Check rate limits before any database work, and cache widget key lookups for a minute.
6. Add Cloudflare Turnstile before a widget session and before a call: the only fix for scripts that use the public key.
7. Answer 503 early when the database pool or event loop is overloaded.
8. Count a live update connection before its first wait, so the cap holds.
9. Make the per-business limits configurable.
10. Cap operator alert emails per business per hour.
11. Cap website calls below the GPT-Live session limit, so phone calls keep their slots.

When real traffic needs it: a second admin replica, which should roughly double the ceiling (not measured), and a chat page rendered once and cached.
