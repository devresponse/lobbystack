# Send email

LobbyStack sends email for sign-up, sign-in and team invitations, alerts to the team, and billing notices. The worker sends every email over SMTP from the outbox, so a failed send is retried. Since fork PR #46 every email has a proper layout and says why it was sent. Checked against `main` at `da1f548`.

## Know how an email is sent

1. The admin or the worker writes an `email.send` message to the outbox in the same transaction as the change that causes it.
2. The worker renders it with `renderEmail` (`packages/providers/src/email/templates.ts`) and sends it through `packages/providers/src/email/smtp.ts`.
3. A failed send is retried with the outbox's backoff. A message that fails ten times is dead-lettered and alerts ([alerts](../operations/alerts.md)).

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` and `EMAIL_FROM` on the worker. Without them, password resets, verification codes and invitations fail. [Resend](../providers/resend.md) can be the SMTP server.

## Know the templates

`TemplateName` lists them: `existing_account`, `account_setup`, `verify_email`, `password_reset`, `invitation`, `operator_alert`, `feedback_submission`, `onboarding_followup` and `promo_ending`. Each is laid out once, as headings, paragraphs, a button, a code or a quote, and rendered as HTML and as plain text:

- In plain text, parts are separated by a blank line and each link sits on its own line after its label.
- Every email ends with why it was sent ("You're receiving this email because…").
- The app's name and the email logo come from the deployment's brand ([branding](../branding.md)).

## Know which language an email uses

| Email | Language |
| --- | --- |
| Account emails: sign-up, verification, password reset, email change | The account's preferred language |
| Invitations | The inviter's language |
| Promo plan endings | The language of each owner who gets it |
| Alerts and feedback | English. An alert's subject and body are written when it's queued and shared with its text message. |
| The founder check-in (`onboarding_followup`) | English, text only |

The interface languages are English, French, Spanish and Serbian (Latin script).

## Know the alert buttons

Alert emails name the business and have a button to the page the alert is about: the dashboard, Messages, Calls, Integrations or Webhooks, with **Settings > Notifications** in the footer. The links use the worker's `APP_BASE_URL`, which falls back to `http://localhost:3000`, so set `APP_BASE_URL` on the worker too.

## Know the gaps

- Appointment notifications only go by text: the worker's email branch for them is never reached.
- `RESEND_WEBHOOK_SECRET` turns on a Resend webhook that looks up each email by Resend's own ID, which sending over SMTP never records, so its events match no email.
