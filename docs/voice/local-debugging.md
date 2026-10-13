# Debug calls and texts on your desktop

A local stack can take real phone calls and texts through a public tunnel to the admin app, while your deployment keeps answering its own numbers. This page sets that up and covers what to watch for in a debugger. For scripted calls against the real model, see [Test a voice change before you ship it](./testing.md).

## What needs a public URL

Only the admin app receives requests from outside, and only on three routes:

| Sender | Route on the admin | When |
| --- | --- | --- |
| OpenAI | `POST /api/webhooks/openai/live` | A phone call arrives (`live.transport.incoming`) |
| Twilio | `POST /api/webhooks/twilio/sms` | Someone texts the number |
| Twilio | `POST /api/webhooks/twilio/status` | Delivery updates for texts the worker sends |

The worker only makes outbound connections: its sideband WebSocket to OpenAI and Twilio's API. The tunnel only needs the admin's port, `ADMIN_PORT` (13000 in `.env.example`). Keep the worker's port private, because its attach endpoint is there.

Browser test calls from the local dashboard need no tunnel. The browser talks to OpenAI over WebRTC and the worker attaches over its sideband, so instructions, tools, delegation and transcripts can all be debugged on localhost. `pnpm voice:eval` needs no tunnel either. Use a phone call when you need the SIP path, caller ID, keypad PINs or transfers, and a text for the SMS routes.

## Start a tunnel to the admin

The examples use ngrok. Its [free plan](https://ngrok.com/docs/pricing-limits/free-plan-limits) gives each account one fixed dev domain, such as `your-name.ngrok-free.app`, so you enter the URLs in OpenAI and Twilio once. The free monthly quota of 20,000 requests and 1 GB of transfer is plenty for webhooks, but not for browsing the dashboard through the tunnel.

Install ngrok (`winget install ngrok -s msstore` on Windows, or see [ngrok's download page](https://ngrok.com/download) for other systems), then add your authtoken:

```sh
ngrok config add-authtoken your_ngrok_authtoken
```

Save this [traffic policy](https://ngrok.com/docs/traffic-policy/concepts/expressions) as `webhooks-only.yml` outside the repo. It lets the three webhook routes through and answers 404 to everything else, so the rest of your dev admin stays off the internet:

```yaml
on_http_request:
  - expressions:
      - "!(req.url.path in ['/api/webhooks/openai/live', '/api/webhooks/twilio/sms', '/api/webhooks/twilio/status'])"
    actions:
      - type: deny
        config:
          status_code: 404
```

Start the tunnel with your dev domain, which the ngrok dashboard shows:

```sh
ngrok http 13000 --url https://your-dev-domain.ngrok-free.app --traffic-policy-file /path/to/webhooks-only.yml
```

ngrok's inspector at `http://127.0.0.1:4040` lists every webhook with the admin's response, and can replay one while you step through the route. A replayed text runs the route again but isn't saved twice, because the admin keys texts on Twilio's message ID.

If you own a domain on Cloudflare, a named `cloudflared` tunnel works the same way. Avoid quick tunnels on `trycloudflare.com`: their URL changes on every start, so you'd re-enter it in OpenAI and Twilio each time.

## Point OpenAI at the tunnel

Keep your deployment's OpenAI project and SIP trunk. In the OpenAI dashboard, open that project's webhooks and add a second endpoint:

- URL: `https://your-dev-domain.ngrok-free.app/api/webhooks/openai/live`, with no trailing slash. Next.js would redirect it, and OpenAI's [webhooks guide](https://developers.openai.com/api/docs/guides/webhooks) counts a redirect as a failed delivery.
- Event: `live.transport.incoming`.
- Copy the new endpoint's signing secret for the local `OPENAI_WEBHOOK_SECRET`. Each endpoint has its own secret, so your deployment's secret doesn't verify local deliveries.

OpenAI then sends every incoming call to both your deployment and your desktop. The webhook route in `apps/admin/app/api/webhooks/openai/live/route.ts` is built for that, the same way staging and production share one project: it answers a call only when the dialled number belongs to a business in its own database, and otherwise returns 200 and leaves the call alone. While the tunnel is up, the local admin logs `incoming call for a number this deployment doesn't serve` for your deployment's calls, and your deployment logs the same line for local ones.

While the tunnel is down, OpenAI keeps retrying deliveries to the local endpoint for up to 72 hours. Your deployment gets its own delivery, so its calls aren't affected.

Use an API key from that same project for the local `OPENAI_API_KEY`, because accepting a call has to come from the project that received it. A separate key lets you revoke it on its own and see local usage apart.

## Give the local stack its own number

Use a second Twilio number on the same account and the same SIP trunk:

1. Buy a number in Twilio, or pick a spare one, that no business on your deployment uses.
2. Add it to the SIP trunk under Elastic SIP Trunking. Its calls then reach OpenAI the same way your deployment's do.
3. In the number's messaging configuration, set "A message comes in" to Webhook, `https://your-dev-domain.ngrok-free.app/api/webhooks/twilio/sms`, HTTP POST.

Keep each number in one database only. If the same number belongs to a business on your deployment and on your desktop, both try to answer its calls and the first to accept wins. To debug calls to a deployed number, take that number off its deployed business first.

If you'd rather your deployment never see your test calls, and your desktop never see the deployment's, use a second OpenAI project with SIP enabled, its own webhook and API key, and a second Elastic SIP trunk whose origination URI is `sip:your_new_project_id@sip.api.openai.com;transport=tls`. Then put the test number on that trunk instead.

## Set the local environment

Put these in `.env.local` at the repo root. `pnpm dev` loads it before `.env`, so its values win (see `scripts/dev.mjs`), and Git ignores it.

```dotenv
LIVE_PROTOTYPE_ENABLED=true
OPENAI_API_KEY=a_key_from_the_project_your_sip_trunk_uses
OPENAI_WEBHOOK_SECRET=the_local_endpoint_signing_secret
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_SMS_WEBHOOK_URL=https://your-dev-domain.ngrok-free.app/api/webhooks/twilio/sms
TWILIO_STATUS_CALLBACK_URL=https://your-dev-domain.ngrok-free.app/api/webhooks/twilio/status
```

- Twilio signs each request with the URL it called, and the admin checks the signature against these two URLs rather than the URL the request arrived on. They must match what's set in Twilio exactly, scheme and host included. The worker also adds the status URL to every text it sends, so delivery updates come back to the local stack.
- Keep `APP_BASE_URL` on localhost, so sign-in, links and recordings keep working there.
- Leave `TWILIO_SIP_TRUNK_SID` empty. The worker then refuses to provision numbers, so claiming a number in the local dashboard can't buy one on the shared account. A number bought locally would also get a localhost SMS URL, because the worker builds it from `APP_BASE_URL`. The only other effect is that local calls skip the Twilio price lookup.
- Run `pnpm dev` from the repo root. `pnpm dev:worker` on its own doesn't load the env files.
- `ALLOWED_DEV_ORIGINS` only matters if you open the dashboard through the tunnel, which also means dropping the traffic policy. It takes the hostname alone, without `https://`. Webhooks don't need it, because Next.js only guards its own `/_next` dev resources.

## Attach the number to a local business

The local dashboard only adds numbers by buying new ones, so add the test number's row directly. With Docker running, from the repo root:

```sh
docker compose exec postgres psql -U postgres -d lobbystack
```

```sql
select id, name from businesses;

insert into phone_numbers (business_id, e164, provider_phone_id, voice_webhook_status, voice_webhook_target_url, sms_webhook_status, sms_webhook_target_url)
values ('your_business_id', '+15815550123', 'your_number_sid', 'synced', 'sip-trunk:your_trunk_sid', 'synced', 'https://your-dev-domain.ngrok-free.app/api/webhooks/twilio/sms');
```

Then change and save one AI setting for that business in the local dashboard, such as the greeting. Saving rebuilds the business snapshot, which picks up the number. A self-hosted business also texts from it.

The business needs a published snapshot and minutes left on its plan. Don't release this number from the local dashboard: that releases it from your Twilio account.

## Check the path

```sh
docker compose up -d postgres redis
pnpm dev
```

Start the tunnel in a second terminal, then send one request through it. In Windows PowerShell, type `curl.exe` rather than `curl`.

```sh
curl -X POST https://your-dev-domain.ngrok-free.app/api/webhooks/openai/live
```

`Invalid signature.` means the request reached the admin. It also makes `pnpm dev` compile the route now, which it would otherwise do on your first real call while the caller hears ringing.

Then call the test number. The admin logs `live.incoming` with each step's timing, and the worker logs `live.delegation` and `live.closed`. Text the number to see the message under Messages. For repeatable calls, `pnpm voice:call` can dial the test number with the scripted callers from [Place real test calls](./testing.md#place-real-test-calls). It reads `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` from the shell, not from `.env.local`, and `pnpm voice:eval` reads `OPENAI_API_KEY` the same way.

## Debug in VS Code

Add `.vscode/launch.json`, which Git ignores in this repo:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "LobbyStack dev",
      "type": "node-terminal",
      "request": "launch",
      "command": "pnpm dev",
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

It runs `pnpm dev` in a debug terminal, which attaches to every Node process it starts, so breakpoints bind in both the admin and the worker.

A phone call keeps running while you're paused:

- Prefer logpoints in the worker during a call. While the worker is paused, GPT-Live's requests wait unanswered, timers that came due fire as soon as you resume (the silence timeout among them), and a long pause can drop the sideband, which ends the call.
- A breakpoint in the webhook route before the accept keeps the caller hearing ringing. OpenAI expects an answer within a few seconds and then delivers the event again. The route handles the repeat.
- Saving a file the worker imports, including package code, makes `tsx watch` restart the worker, which ends a call in progress. tsx gives the old process 5 seconds to exit, so the restart goodbye from [Deploy the worker during calls](./runtime.md#deploy-the-worker-during-calls) may not finish. On Windows the old process is killed at once, without the drain: the call stays up, but nothing answers GPT-Live's requests until the recovery job takes the call over a minute or two later. Edit between calls.

## If something fails

| What you see | Likely cause |
| --- | --- |
| The webhook answers 400 `Invalid signature.` to real calls in the ngrok inspector | `OPENAI_WEBHOOK_SECRET` is your deployment's secret, not the local endpoint's |
| The local admin logs `incoming call for a number this deployment doesn't serve` for your test call | The number isn't in the local `phone_numbers` table, or isn't `active` |
| A busy signal | The local business's plan has no minutes left (SIP 486) |
| The call never connects, and the local admin logs `no published snapshot for incoming call` | The local business has no published snapshot yet |
| The SMS webhook answers 401 | `TWILIO_SMS_WEBHOOK_URL` doesn't exactly match the number's URL in Twilio, or the auth token belongs to another account |
| Texts never reach the tunnel although the number's URL is right | The number belongs to a Messaging Service, whose own incoming-message setting applies |
| ngrok shows `ERR_NGROK_8012` | The admin isn't running on the tunnel's port |
