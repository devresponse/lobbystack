# Handle text messages

Texts sent to a business's number land in the dashboard's **Messages**, and the team answers them by hand. The receptionist never answers a text. LobbyStack also sends texts of its own: alerts to the team, appointment confirmations and reminders, and verification codes. This page covers both directions, who a text comes from, and what the fork changed. Checked against `main` at `da1f548`.

## Receive texts

1. Twilio posts each incoming text to the admin's `/api/webhooks/twilio/sms`. The route checks Twilio's signature against `TWILIO_SMS_WEBHOOK_URL` and finds the business by the number the text was sent to.
2. `receiveInboundSms` (`packages/domain/src/server/sms.ts`) saves it in the contact's `sms` conversation and queues an alert for the team. Since fork PR #108, a text in a conversation the team archived puts it back in the **Messages** list ([archiving](messages.md#know-what-brings-one-back-by-itself)).
3. `STOP` opts the contact out of texts, and `HELP` and `START` get fixed replies. The `HELP` reply carries the brand's name, contact address and website, so a deployment without a brand file sends the original project's ([branding](../branding.md)).

AI replies to texts are left out on purpose: `ai_sms` is a restricted capability in `packages/shared/src/product-capabilities.ts`, and the parity check refuses code that adds one. Adding them would need an `sms` channel in the agent core, a worker job, the **Take over** switch for text threads, a usage cap and, for US local numbers, A2P 10DLC registration.

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
- `pnpm replacement:sms-consent` checks consent, `STOP` handling, replies to people who texted first, and cross-business isolation against a local stack.
