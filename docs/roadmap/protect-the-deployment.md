# Protect the widget and the deployment

The widget's key is public, sign-up is open to anyone who passes Turnstile, and every business shares one admin process, one OpenAI key and one Twilio account. So a script can lock a business out of its own widget, run up GPT-Live minutes or slow every business down, and a stranger can sign up and spend a self-hosted deployment's credit. The widget scalability review of 2026-10-15 measured this and listed fixes in order ([widget scalability](../reviews/widget-scalability-2026-10-15.md#do-these-in-order)); the [widget review](../reviews/widget-2026-10-15.md#follow-the-code-improvements), the [scalability review](../reviews/scalability-2026-10-18.md#know-the-sign-up-account-and-billing-limits) and [Railway automation](../research/railway-automation.md) added the rest.

- **Status:** parts are done. Fork PR #174 on `releases/r2` (AUDIT-004) added Turnstile's check before the receptionist answers a website chat, a daily chat limit for each business, the live update stream's count before its first wait, and a refused start on Railway without `TRUSTED_CLIENT_IP_HEADER` ([website widget](../features/website-widget.md#stop-scripts-from-spending-a-businesss-chats)). The rest isn't built. Nothing waits on a decision: change the settings before the widget goes on busy sites, and the code before sign-up is advertised or abuse shows up.
- **Effort:** the first four are settings; the code changes weren't estimated.

## Change these settings first

1. **Put Cloudflare in front of the dashboard's domain,** on its free plan: a rate-limit rule on `/api/widget/`, caching for `/embed.js` and `/_next/static/`, SSL set to Full, and Bot Fight Mode off, since it can't exempt the widget's calls.
2. **Make Cloudflare the only way in,** with Railway Edge Rules that allow only Cloudflare and block the `railway.app` address.
3. **Set `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`** on the admin, which turns on the per-IP limits. Since fork PR #174, a production admin on Railway doesn't start without the header, and `x-real-ip` serves until Cloudflare is in front.
4. **Cap the bills, not the service:** budget alerts on the OpenAI project and Railway's usage alerts, since a Railway hard spend limit takes every service offline; and `AI_CHAT_REASONING_EFFORT=low` on the admin, which cuts the tokens each chat reply spends.

## Then change the code

5. Check rate limits before any database work, and cache widget key lookups for a minute.
6. Add Turnstile before a widget session and before a call: the only fix for scripts that use the public key. Done for the chat in fork PR #174, where the check runs before the receptionist answers; calls and the lead form still go without it.
7. Answer 503 early when the database pool or the event loop is overloaded.
8. ~~Count a live update connection before its first wait, so the cap of 1,000 for each process holds.~~ Done in fork PR #174.
9. Make the per-business limits configurable.
10. Cap operator alert emails per business per hour, since each new website chat sends one.
11. Cap each business's website calls below the GPT-Live session limit, so phone calls keep their slots.
12. Add a daily AI spending cap and per-key limits for self-hosted deployments. Fork PR #174 caps the website chats each business's receptionist starts in a day, at a share of its plan's chats; plans without a chat limit, such as self-hosted ones, have none yet.
13. Add a sign-up mode, open, by allowlist, by invitation or closed, so a self-hosted deployment on the internet isn't open to anyone ([multitenancy](../features/multitenancy.md#know-who-can-sign-up)).

## Know what it protects against

- **Locking a business out:** the per-business limits that protect the server can be used up by a script, so real visitors are refused until the window resets.
- **Running up costs:** website calls spend GPT-Live minutes, and calls from several businesses can fill the deployment's GPT-Live sessions, so phone calls fail too.
- **Slowing everyone down:** rate limits are checked only after database work and nothing sheds load, so in the 2026-10-15 test a few hundred requests a second from one machine slowed every widget.
- **Strangers spending the credit:** the self-hosted plan has no minute or number limits, so anyone who signs up can spend the deployment's OpenAI and Twilio budget.
