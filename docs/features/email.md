# Send email

LobbyStack sends email for sign-up, sign-in and team invitations, alerts to the team, the email after each call, and billing notices. The worker sends every email over SMTP from the outbox, so a failed send is retried. Since fork PR #46 every email has a proper layout and says why it was sent. Checked against `main` at `da1f548`; the email after each call, against `62517d2` with fork PR #84's changes.

## Know how an email is sent

1. The admin or the worker writes an `email.send` message to the outbox in the same transaction as the change that causes it.
2. The worker renders it with `renderEmail` (`packages/providers/src/email/templates.ts`) and sends it through `packages/providers/src/email/smtp.ts`.
3. A failed send is retried with the outbox's backoff. A message that fails ten times is dead-lettered and alerts ([alerts](../operations/alerts.md)).

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` and `EMAIL_FROM` on the worker. Without them, password resets, verification codes and invitations fail. [Resend](../providers/resend.md) can be the SMTP server.

## Know the templates

`TemplateName` lists them: `existing_account`, `account_setup`, `verify_email`, `password_reset`, `invitation`, `operator_alert`, `call_transcript`, `feedback_submission`, `onboarding_followup` and `promo_ending`. Each is laid out once, as headings, paragraphs, a button, a code or a quote, and rendered as HTML and as plain text:

- In plain text, parts are separated by a blank line and each link sits on its own line after its label.
- Every email ends with why it was sent ("You're receiving this email because…").
- The app's name and the email logo come from the deployment's brand ([branding](../branding.md)).

## Know which language an email uses

| Email | Language |
| --- | --- |
| Account emails: sign-up, verification, password reset, email change | The account's preferred language |
| Invitations | The inviter's language |
| Promo plan endings | The language of each owner who gets it |
| The email after each call | The dashboard language of each person who gets it, English if they have none |
| Alerts and feedback | English. An alert's subject and body are written when it's queued and shared with its text message. |
| The founder check-in (`onboarding_followup`) | English, text only |

The interface languages are English, French, Spanish and Serbian (Latin script).

## Know the alert buttons

Alert emails name the business and have a button to the page the alert is about: the dashboard, Messages, Calls, Integrations or Webhooks, with **Settings > Notifications** in the footer. The links use the worker's `APP_BASE_URL`, which falls back to `http://localhost:3000`, so set `APP_BASE_URL` on the worker too.

## Email the team after each call

Since fork PR #84, each person on a business's team can get an email after each call the caller spoke on: a phone call, a website call or a dashboard test call, but not a prospect demo. A caller who said fewer than 15 characters, the summary job's own test, sends nothing.

- **Each person turns it on** under **Settings > Notifications**, in **Communication**, on the row **Call summary** or **Call transcript** (it's named for what the email holds). It starts off for everyone, goes by email only, and needs the person's email alerts on.
- **Owners and admins choose for the business,** under **Emails after each call** on the same page: **Who can get them** (**Owners and admins**, the default, **Everyone on the team** or **Nobody**) and **What they hold** (**Summary and a link**, the default, or **Summary and the whole conversation**). Migration `0117` adds the two choices to `businesses` (`call_transcript_recipients`, `call_transcript_content`), and each change is audited as `call_transcript_settings.updated`. Someone the business leaves out keeps their own switch as it was and gets nothing until they're let in again.
- **What it holds:** a subject with the caller's name, or "unknown caller", and the call's length, such as "Call summary: unknown caller, 4 min" ("Call transcript" with the whole conversation, "Test call summary" for a test call); when the call started in the business's time zone, how long it lasted, the caller's name and number, whether it was a phone, website or test call, the summary, and a button to the call. With the whole conversation, every turn follows with its time from the start of the call. A long call stops at 80 KB of HTML, before Gmail clips the email, and attaches the whole conversation as a text file. Replies go to the business owner's address, or to the reader when the business has no owner.
- **Card and ID numbers are taken out** of the summary, the turns and the attached file, as "[card number removed]" and "[ID number removed]" in the reader's language: 13 to 19 digits that pass the card checksum, and nine digits shaped like a US social security number or a Canadian social insurance number. A number counts whether the transcription wrote it in figures, in groups, or one word at a time, in English, French, Spanish or Serbian. Phone numbers, times and prices stay. The saved transcript and the dashboard keep every word, and a number split across two turns isn't caught (`withoutCardAndIdNumbers` in `packages/shared/src/callTranscripts.ts`).
- **How it's sent:** once the summary is saved, the summary job queues one delivery per person who gets it, holding the call's ID alone (`queueCallTranscriptEmailsInTransaction` in `packages/domain/src/server/callTranscriptEmails.ts`), at most one per person per call. The worker builds the email as it sends it, from the call and the business's choices as they are then (`loadCallTranscriptEmail`), so the conversation never sits in the outbox, in Redis or in the delivery row. A delivery that no longer applies is marked skipped with its reason, such as "The person turned call emails off." Turns past their retention date stay out.
- **When a send fails,** PostHog gets `notification.delivery_failed` with the delivery's kind, `callTranscript`. A mail server's 5xx refusal marks the delivery failed at once instead of retrying it for hours, for alert emails too; other errors retry for about 3 hours.
- **The v1 API** has the business's two choices on `GET` and `PATCH /business` (`call_transcript_recipients`, `call_transcript_content`), and the `call_transcript` event, with `call_transcript.available`, on `GET` and `PATCH /notification-preferences`.

Copies of the whole conversation stay in people's mailboxes after the dashboard deletes the transcript, and after they leave the team; the setting's description says so.

## Know the gaps

- Appointment notifications only go by text: the worker's email branch for them is never reached.
- `RESEND_WEBHOOK_SECRET` turns on a Resend webhook that looks up each email by Resend's own ID, which sending over SMTP never records, so its events match no email.
