# Handle text messages

Texts sent to a business's number land in the dashboard's **Messages**, and the team answers them by hand. The receptionist never answers a text. LobbyStack also sends texts of its own: alerts to the team, appointment confirmations and reminders, and verification codes. This page covers both directions, who a text comes from, and what the fork changed. Checked against `main` at `da1f548`.

## Receive texts

1. Twilio posts each incoming text to the admin's `/api/webhooks/twilio/sms`. The route checks Twilio's signature against `TWILIO_SMS_WEBHOOK_URL` and finds the business by the number the text was sent to.
2. `receiveInboundSms` (`packages/domain/src/server/sms.ts`) saves it in the contact's `sms` conversation and queues an alert for the team. Since fork PR #108, a text in a conversation the team archived puts it back in the **Messages** list ([archiving](messages.md#know-what-brings-one-back-by-itself)).
3. `STOP` opts the contact out of texts, and `HELP` and `START` get fixed replies. The `HELP` reply carries the brand's name, contact address and website, so a deployment without a brand file sends the original project's ([branding](../branding.md)).

AI replies to texts are left out on purpose: `ai_sms` is a restricted capability in `packages/shared/src/product-capabilities.ts`, and the parity check refuses code that adds one. Adding them would need an `sms` channel in the agent core, a worker job, the **Take over** switch for text threads, a usage cap and, for US local numbers, A2P 10DLC registration.

## Know what happens when a text can't be handled

Since fork PR #181, on `develop/r2`, the two Twilio routes, `/api/webhooks/twilio/sms` and `/api/webhooks/twilio/status`, answer a delivery they can't handle in one of two ways (`apps/admin/src/lib/twilio-webhook-failure.ts`). Before, the texts route answered 500 and the status route 503, and neither left a trace.

| Answer | When | What it leaves |
| --- | --- | --- |
| 400 `{ ok: false, error: "Invalid Twilio webhook.", errorId }` | Twilio signed the delivery, but its fields don't pass the schema, for example a text with no `To` or no message SID. Sending it again changes nothing. | A warning in the admin's log, `ops.twilio.webhook_invalid`, with the route, the error ID, the names of the fields refused and the message SID |
| 503 `{ ok: false, error: "Temporary webhook failure.", errorId }`, with `Retry-After: 60` | Handling it failed, for example because the database didn't answer | An error report in PostHog and the admin's log, with the operation (`twilio.sms` or `twilio.status`), the route, the error ID and the message SID |

Both answers carry the error ID in the `x-error-id` header too. No line or report holds a text's words or a phone number. The message SID, which finds the message in Twilio's console, is the only thing from the delivery they repeat, and only when it looks like one: two letters and 32 hex digits. An error report also leaves out the values Drizzle puts in its messages, email addresses and phone numbers (`redactOtelExceptionText` in `packages/telemetry/src/node.ts`). A request without Twilio's signature still answers 401, and logs nothing.

### Get a second try at a text

Twilio tries an incoming text's webhook again only when it can't connect: by default, one more try after a failed connection or TLS handshake ([Twilio's connection overrides](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides)). A text whose request fails or times out goes to the number's fallback address instead, when it has one. Since fork PR #181, every number LobbyStack buys has its texting address as its fallback too (`purchasePhoneNumber` in `packages/providers/src/twilio/twilioProvider.ts`), and bootstrap's `twilio.tollfree` step sets the same on the shared toll-free number. The second try stores the text once, since a text's message SID is saved only once.

A number bought before, or a shared sender set up before or by hand, needs it set by hand: in Twilio's console, open the number's settings and set **Primary handler fails** to **Webhook**, the same address as **A message comes in**, and **HTTP POST** *(field names not confirmed)*. For a shared number bootstrap set up, `node devops/bootstrap.mjs redo .env.bootstrap-<name> twilio.tollfree`, then `up`, sets it instead, without buying another number. When the fallback fails too, the text is only in Twilio's console: **Monitor** > **Logs** > **Messaging** has it, and the **Debugger** shows error 11200.

A status callback has no fallback, and Twilio tries it again only when it can't connect. Twilio's connection overrides at the end of `TWILIO_STATUS_CALLBACK_URL` could ask for more, for example `#rc=3&rp=5xx` for up to three more tries after a 5xx answer; the admin leaves the part after `#` out when it checks the signature, as Twilio does. LobbyStack sets none, and none has been tried on a deployment.

## Reply from Messages

A reply from Messages goes out when the contact agreed to texts, or when they texted that conversation themselves (fork PR #12). Before #12, a reply to someone who had just texted, without having agreed to texts, stayed queued forever and looked sent. Texts held back before #12 were never sent.

A text can still be held back, or fail, and Messages shows why (`packages/shared/src/smsReach.ts`):

| Shown as | Why |
| --- | --- |
| Held: no phone, blocked, opted out, no consent | The contact can't get texts from the business. |
| Held: no sender | The business has no number that can send texts, and no shared sender applies. |
| Rejected, or blocked for the region | Twilio refused the number, or the account can't text that country (error 21408). |
| Not sent | Every try failed, for example a text that's too long (fork PR #42). |

A Twilio toll-free number can only text numbers in the US and Canada.

## Know who a text comes from

Since fork PR #55, `resolveSmsSender` (`packages/domain/src/server/smsSender.ts`) picks the sender for every text LobbyStack sends, alerts and appointment texts included:

1. The business's own newest active number that can send texts and isn't being released.
2. Otherwise, for a cloud business, the deployment's shared sender, `TWILIO_ALERT_SMS_FROM`. Set it on the admin and the worker: the admin checks it for the Notifications screen, and the worker sends.
3. Otherwise, no sender: the text is held.

Before #55, a cloud business always texted from the shared sender and a self-hosted one from its own number, with no fallback. Migration `0107` refreshes each business's saved context snapshot so the receptionist knows its texting number.

Without the `TWILIO_ALERT_*` account variables, the worker sends through the main `TWILIO_ACCOUNT_SID` account. US numbers that text US phones need A2P 10DLC registration; a Canadian number texting Canadian phones needs none.

## Record what each text cost

After Twilio accepts a text, the worker asks Twilio for its price and segment count, for usage, finance exports and alert billing. Twilio often has no price yet. Since fork PR #44 the worker checks again later through the outbox: after 1 minute, then doubling, 10 times in all, about 17 hours (`packages/domain/src/server/providerPricing.ts`). If there is still no price, it reports a warning, not an error, to PostHog and the logs. A request that fails at Twilio still reports an error.

One known gap: texts sent through the `TWILIO_ALERT_*` account are priced against the main account, where Twilio doesn't find them.

## Check texts on a deployment

- No alerts or appointment texts: for a cloud business without its own texting number, check `TWILIO_ALERT_SMS_FROM` on both services. For a business with a number, check that the number is active and can send texts.
- A reply that stays queued: open it in Messages and read why it was held.
- A text that never reached Messages: find it in Twilio's console, under **Monitor** > **Logs** > **Messaging**, and search the admin's log for its message SID. An `ops.twilio.webhook_invalid` warning names the fields the admin refused. An exception with the operation `twilio.sms` is a failure, under the error ID that Twilio's **Debugger** shows with the admin's answer *(not confirmed)*. A 401 there means the signature didn't match: check `TWILIO_AUTH_TOKEN` and `TWILIO_SMS_WEBHOOK_URL` on the admin.
- `pnpm replacement:sms-consent` checks consent, `STOP` handling, replies to people who texted first, and cross-business isolation against a local stack.
