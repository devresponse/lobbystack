# Part 3. Set up the outside services

**Status:** written on 2026-10-18 from the code on `main` at `d18f916` and from each provider's documentation that day. No provider account was opened for this part, so a few button names couldn't be checked on the real screens; they're marked *(name not confirmed)*. Each service gets its first real test in [Part 4](part-4-test-environment.md). The Polar steps ([3.7](#37-optional-services), "[Selling plans](#selling-plans-polar)") were rewritten on 2026-10-22 for fork PR #59 (`a44f995`) and updated for fork PRs #60 to #62 the same day, #63 to #66 (`d800141`) on 2026-10-23 and #67 to #70 (`40435d2` to `fa0aa11`) the same day, and #72 to #75 (`cc0c65d` to `24e211d`) on 2026-10-24, from the code only, and checked again at `24e211d` later that day. The brand ([3.6](#36-your-brand)) was updated on 2026-10-27 for fork PR #87, from the code only: an address no brand claims now gets the only brand besides LobbyStack. The notes on the plan screens in "[Selling plans](#selling-plans-polar)", step 7, were updated the same day for fork PRs #88 and #89, from the code only.

LobbyStack relies on outside services to answer calls, send email and keep robots from signing up. This part sets up each one. As you go, write each value on your worksheet ([Appendix D](appendix-d-worksheet.md)), or, for a key or a secret, the name of the password manager entry that holds it; [Part 4](part-4-test-environment.md) puts them into Railway.

| Service | What LobbyStack uses it for | Needed? | To start | Section |
| --- | --- | --- | --- | --- |
| A domain name | Your instance's address | For production; optional for test | A yearly fee | [3.1](#31-choose-your-addresses) |
| OpenAI | Website chat, calls, knowledge search | Yes | $5 of prepaid credit | [3.2](#32-openai) |
| Twilio | Phone numbers, phone calls, texts | For phone calls and texts | A paid account; numbers from $1.15 a month | [3.3](#33-twilio) |
| An email service (this guide uses Resend) | Sign-up codes, password resets, invitations, alerts | Yes | Free up to 3,000 emails a month | [3.4](#34-email) |
| Cloudflare Turnstile | Keeps robots from signing up | Yes | Free | [3.5](#35-cloudflare-turnstile) |
| Google Cloud | Google Calendar, and the map on public profile pages | Optional | Free | [3.7](#37-optional-services) |
| Firecrawl | Importing a business's website | Optional | Free up to 1,000 pages a month | [3.7](#37-optional-services) |
| PostHog | Errors, analytics and logs | Optional; recommended for production | Free tier | [3.7](#37-optional-services) |

Three rules for this part:

- **Set up the test environment first.** [Part 5](part-5-production.md) repeats this part for production, with its own OpenAI project, Twilio subaccount and keys, so nothing you do while testing can reach real customers or their bills.
- **Some steps wait for the address.** Steps marked **After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional)** need your instance's final web address to be working, which it is once you finish Part [4.7](part-4-test-environment.md#47-use-your-own-domain-optional). Skip them for now: [3.8](#38-before-you-go-on) lists them, and Part [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment) brings you back.
- **Copy secrets straight into your password manager.** Several services show a key only once.

In the "What goes where" tables, **admin** and **worker** are the two LobbyStack services that take these values ([0.3](part-0-start-here.md#03-how-lobbystack-fits-together)). **Built in** means the value is written into the dashboard when the admin is built, so changing it later needs a rebuild of the admin, not just a restart.

## 3.1 Choose your addresses

Every outside service needs your instance's web address, and LobbyStack picks its brand from it ([3.6](#36-your-brand)), so choose the addresses first.

1. **Pick an address for each environment.** This guide's default:

   | Environment | Address | Example |
   | --- | --- | --- |
   | Test | Railway's free address, or a test subdomain of your domain | `your-admin.up.railway.app` or `test.example.com` |
   | Production | A subdomain of your own domain | `app.example.com` |

   - Railway's free address appears in Part [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker). It's fine for testing. No brand claims it, so it shows AlloPlace, the only brand in the code besides LobbyStack, unless `BRAND_PRESET` names another ([3.6](#36-your-brand)).
   - A subdomain such as `app.` works with every DNS provider. The bare domain (`example.com`) needs a DNS provider that can point the root of a domain at another name: Cloudflare, DNSimple, Namecheap and bunny.net can; GoDaddy, Amazon Route 53, Azure DNS, Hostinger, NameSilo, Hurricane Electric and Squarespace can't.
   - Changing an address later is real work: every service in this part, and every phone number's settings at Twilio, must follow ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)).

2. **Get a domain, if you don't have one.** Choose a registrar with fair renewal prices, not just a cheap first year, and free privacy for your contact details. Two good choices:
   - **Cloudflare Registrar** charges what the registry charges, with no markup, and keeps your DNS at Cloudflare, where you'll have an account anyway ([3.5](#35-cloudflare-turnstile)). A domain bought there must keep using Cloudflare's DNS.
   - **Railway Domains** sells domains at cost from inside Railway (**Buy a Domain** in a service's networking settings) and sets up the DNS for you. Railway is then listed as the domain's registrant contact.

3. **In [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): add the two records Railway shows.** When you add your domain to the admin service ([4.7](part-4-test-environment.md#47-use-your-own-domain-optional)), Railway shows a CNAME record and a TXT record. Create both at your DNS provider exactly as shown:

   | Type | Name | Value |
   | --- | --- | --- |
   | CNAME | Your subdomain, such as `app` | The target Railway shows, ending in `.up.railway.app` |
   | TXT | The name Railway shows, starting with `_railway-verify` | The value Railway shows, starting with `railway-verify=` |

   - In Cloudflare: **DNS** > **Records** > **Add record**. Choose the **Type**, fill in the **Name** and the value, set **Proxy status** to **DNS only** (a grey cloud), and click **Save**.
   - Without the TXT record, the address answers every visit with a 404 error.
   - DNS changes usually show up within minutes but can take up to 72 hours. Railway then gets an HTTPS certificate for the address, usually within an hour, and shows a green check mark next to the domain.

4. **Leave Cloudflare's proxy off** for this record. With the proxy on (an orange cloud), Railway may not get its certificate, Cloudflare's SSL/TLS mode must be **Full** rather than **Full (strict)**, and on a server the admin no longer sees each visitor's own IP address, which its limits on sign-ups and website calls count by. [7.20](part-7-operations.md#720-decide-who-can-sign-up) turns the proxy on for Railway, to close sign-up, with the settings that keep LobbyStack working.

The dashboard works only at exactly this address, over HTTPS. From any other address, sign-in says "Incorrect email or password" even when the password is right, just as on your computer ([2.6](part-2-local-development.md#26-sign-in-for-the-first-time-and-create-a-test-business)).

**What goes where**

| Value | Example | Variable | Service | Built in? |
| --- | --- | --- | --- | --- |
| The address, with `https://` and no slash at the end | `https://app.example.com` | `APP_BASE_URL` | admin and worker | Yes, on the admin |
| The header in which Railway passes each visitor's IP address | `x-real-ip` | `TRUSTED_CLIENT_IP_HEADER` | admin | No |

`TRUSTED_CLIENT_IP_HEADER` matters more than it looks. Without it, the admin can't tell visitors apart: some of its limits fall back to one allowance shared by everyone, and website calls lose their per-address limit. Railway overwrites `x-real-ip` with each visitor's address, so that header is safe to trust there.

**Not yet confirmed:** the exact name of Railway's TXT record (Railway's docs say only "TXT"; the format above comes from Railway's community forum), and how well Cloudflare's proxy works with Railway when you do turn it on.

## 3.2 OpenAI

OpenAI runs the receptionist: it writes the chat answers, holds the phone and browser calls (its GPT-Live service), and makes your knowledge searchable. You need an OpenAI account with prepaid credit, and one project for each environment.

**Create the account and add credit**

1. Sign up at `platform.openai.com`.
2. Verify a mobile phone number when OpenAI asks. It doesn't accept landlines or internet phone numbers, Twilio's included.
3. Optional: rename the organization after your business, under **Organization settings** > **General** > **Organization name**.
4. Add credit. The free tier can't use GPT-Live at all.
   1. Open the billing page, `platform.openai.com/account/billing`.
   2. Click **Add payment details** and enter a card.
   3. Choose an amount: $5 is the minimum, and enough to start.
   4. Decide about **Use auto-reload**, which is on by default. Turn it off, or set the balance that triggers a top-up, the balance to top up to, and a monthly top-up limit.
   - Credit expires a year after you buy it and generally isn't refunded.
   - The first purchase puts the account on the Build tier: 50 calls at the same time and $500 of use a month, about 10,000 call minutes. Once your purchases total $100, it moves to Launch: 300 calls at once and $5,000 a month. **Settings** > **Organization** > **Limits** shows your tier.

**Create this environment's project**

5. Hover over the project name in the top-left corner, choose **Create project**, and name it after the environment, such as "LobbyStack test". Only organization owners can create projects.
6. Copy the project ID, which starts with `proj_`, from **Settings** > **Project** > **General**. The Twilio trunk needs it ([3.3](#33-twilio)).

Do the remaining steps with this project chosen in the project menu. Each project has its own key, spending limit and webhook, and OpenAI sends every incoming call to every webhook of the project that received it, so separate projects keep test calls out of production.

**Create the API key**

7. Open the project's **API Keys** page (`platform.openai.com/api-keys`) and click **+ Create new secret key**.
8. If the dialog asks who owns the key *(wording not confirmed)*, choose a service account rather than yourself: a service account's key keeps working after the person who made it leaves.
9. Name the key after the environment, such as "lobbystack-test".
10. Leave **Permissions** at **All**. LobbyStack uses several OpenAI services, and a **Restricted** key that misses one breaks calls in ways that are hard to trace.
11. Create the key and copy it right away: OpenAI shows it only once. It starts with `sk-`.

**Set a spending limit**

12. In the project's settings, open **Limits**. Under **Spend**, click **Edit spend limit**, enter a **Monthly spend limit**, turn on **Enforce a hard limit**, and click **Save**.
13. On the same page, under **Notification threshold**, set alerts below the limit; **Add Alert** adds more. Alerts only warn you; the hard limit is what stops spending.

When the limit is reached, OpenAI refuses the project's requests: website chat stops answering and new calls can't start until you raise the limit or the next month begins. Spending can run slightly past the limit before it stops. An empty credit balance stops everything the same way.

**After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): create the incoming-call webhook**

Phone calls need this webhook; website chat and browser calls work without it.

14. In the project's settings, open **Webhooks** (`platform.openai.com/settings/project/webhooks`) and click **Create**.
15. Fill in the **Create webhook endpoint** dialog:
    - **Name**: anything, such as "LobbyStack test calls".
    - **URL**: `https://<your address>/api/webhooks/openai/live`, exactly, with no slash at the end.
    - **Event types**: click **Select event types...** and tick only `live.transport.incoming`. Don't add `realtime.call.incoming`, which belongs to an older OpenAI service: a second handler would race LobbyStack to answer each call.
16. Click **Create**. The **Save your signing secret** dialog shows a value starting with `whsec_`, once. Copy all of it, `whsec_` included, and click **Done**.

The admin accepts OpenAI's signed messages only within 5 minutes of when they were sent, so the server's clock must be right. On your own server, keep automatic time on ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)).

**Phone calls (SIP)**

OpenAI documents no switch for phone calls. Its guide says only to "Confirm that GPT-Live SIP support is enabled for your project", without saying how. Make a test call once your first number is bought ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)). If it fails and the webhook page shows no delivery, ask OpenAI support (`help.openai.com`) to enable GPT-Live SIP for your project ID.

**What OpenAI keeps**

OpenAI doesn't train on API data unless you opt in, and keeps abuse-monitoring logs for up to 30 days. LobbyStack asks OpenAI to keep each call's recording for 30 days, so it can copy it. Zero Data Retention needs OpenAI's approval through sales, and it turns those recordings off. Clinics will find a HIPAA flow under **Organization settings** > **General**.

**What goes where**

| Value | Looks like | Variable | Service |
| --- | --- | --- | --- |
| API key | Starts with `sk-` | `OPENAI_API_KEY` | admin and worker |
| Webhook signing secret | Starts with `whsec_` | `OPENAI_WEBHOOK_SECRET` | admin |
| Turns calls on | `true` | `LIVE_PROTOTYPE_ENABLED` | admin and worker |
| Project ID | Starts with `proj_` | None: it goes in the Twilio trunk's address ([3.3](#33-twilio)) | Twilio |

- Leave the model settings as they are. LobbyStack uses `gpt-6-luna` for chat and for answers during calls, `gpt-live-1` for the calls themselves, and `text-embedding-3-small` for knowledge. If you limit the project's models on its **Limits** page, allow those three, plus `gpt-4o-mini-tts` when `LIVE_RECORDED_GREETING=true`.
- Don't set `OPENAI_BASE_URL`, `OPENAI_PROJECT_ID` or `OPENAI_ORG_ID` on any service. LobbyStack doesn't read them, but OpenAI's own code does, and a wrong value sends requests to another address or project.

**What it costs**, at OpenAI's list prices on 2026-10-18: calls cost $0.05 a minute, billed by the second. Chat with `gpt-6-luna` costs $0.10 per million input tokens and $0.50 per million output tokens; answers during calls use the faster priority tier, at twice that. Knowledge search costs $0.02 per million tokens. A 3-minute phone call costs about $0.15 at OpenAI, plus its chat tokens.

**Not yet confirmed:**

- How SIP gets enabled for a new project.
- Whether call recordings need the project's "session storage" switched on. OpenAI's docs say "Session storage is disabled by default" and don't say how to enable it; the first test call ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)) shows whether a recording is saved.
- Whether the webhook page can send a test event, which would check the address and the secret before the first call.

## 3.3 Twilio

Twilio provides the phone numbers. A call to a number travels over a Twilio SIP trunk, a phone line between Twilio and OpenAI, to GPT-Live; a text goes to the admin. Once Twilio is set up, LobbyStack buys numbers itself, from the dashboard.

**Open and upgrade the account**

1. Sign up at `twilio.com`, verify your email and your own phone number, and answer the short questionnaire. No card is needed yet.
2. Upgrade right away: click **Upgrade your account**, or the **Trial** banner, then fill in your profile and address, add a payment method, and load a starting balance. A trial account has no SIP trunking, so LobbyStack's calls can't be tested on one.
3. Start your business profile now, because Twilio's review takes one to three days and several later steps need it: **Communications** > **Trust Hub** > **Profiles** > **Primary profile** tab > **Business Profile**. Fill in **Individual details**, **Business details**, **Business address** and **Notification settings**, clicking **Continue** after each, then **Next** and **Finish**. Until the profile is approved, Twilio limits how many calls a new account's trunk carries at once.

**Create this environment's subaccount**

4. Go to **Settings** > **Account settings** > **Subaccount management**, click **Create new subaccount**, name it after the environment, such as "LobbyStack test", and click **Create subaccount**.
5. Click the subaccount's name to switch into it. Its home page shows the **Account SID**, which starts with `AC`, and the **Auth Token**, under **Account Info**; click **show** to see the token.
6. Stay in this subaccount for every step below. The trunk, the numbers and the two values from step 5 must all belong to the same account.

All subaccounts bill to the main account's balance. LobbyStack needs the Auth Token itself, because Twilio signs every request it sends with it and LobbyStack checks that signature; Twilio's API keys can't replace it.

**Create the SIP trunk to OpenAI**

7. Open **Communications** > **Elastic SIP Trunking** > **Trunks**; in Twilio's older menu it's **Develop** > **Elastic SIP Trunking** > **Manage** > **Trunks**. Create a trunk *(button name not confirmed)*, name it, such as "LobbyStack test", and click **Create**.
8. Under **General settings** > **Features**, set:
   - **Call Transfer (SIP REFER)**: **Enabled**. The receptionist hands callers to staff this way.
   - **Caller ID for Transfer Target**: **Transferee**, so staff see the caller's own number.
   - **Enable PSTN Transfer**: ticked, so transfers can reach ordinary phone numbers. Twilio bills a transferred call for both its parts.
   - **Secure Trunking**: on. GPT-Live accepts only encrypted calls.
   - **Symmetric RTP**: off, as it starts.
   - **Call Recording**: **Do Not Record**, as it starts. LobbyStack gets its recordings from OpenAI.

   Then save the settings *(button name not confirmed)*.
9. Copy the **Trunk SID** from **General settings**. It starts with `TK`.
10. Skip the **Termination** tab: LobbyStack doesn't need it.
11. Open **Origination** and click **Add new Origination URI**. In **Origination SIP URI**, enter `sip:<your OpenAI project ID>@sip.api.openai.com;transport=tls`, such as `sip:proj_abc123@sip.api.openai.com;transport=tls`, with this environment's project ID ([3.2](#32-openai), step 6). Leave **Priority** and **Weight** as they are, and click **Add**.
12. Leave **CNAM Lookup** off: LobbyStack doesn't use callers' names.
13. Don't add numbers to the trunk: LobbyStack adds each number it buys.

**Which numbers LobbyStack can buy**

- The dashboard buys local numbers that take both calls and texts, in the US, Canada, the UK and Australia. A local number costs $1.15 a month in the US or Canada from the day it's bought, so keep the balance topped up.
- US and Canadian numbers need no paperwork.
- On an instance that sells plans, a business can buy a number only once it pays for a plan ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)).
- UK and Australian numbers need an approved regulatory bundle, with a local address and documents (**Phone Numbers** > **Regulatory Compliance** > **Bundles**). LobbyStack doesn't send a bundle when it buys a number, so buying one from the dashboard will probably fail. Plan on US or Canadian numbers for now ([Appendix E](appendix-e-doc-problems.md)).
- The receptionist can't transfer callers to emergency numbers: Twilio doesn't allow it.

**Get ready to text**

Calls work as soon as a number is bought. Texting needs a registration that takes days or weeks, so start early.

14. **US texting (A2P 10DLC).** Twilio blocks texts to US phones from US or Canadian local numbers that aren't registered. Register on Twilio's **Onboarding** page for A2P 10DLC *(menu path not confirmed)*, in this order:
    1. **Create Customer Profile**: skip it once your business profile (step 3) is approved.
    2. **Register Brand**, choosing the type that fits:

       | Type | For | Fees |
       | --- | --- | --- |
       | Sole Proprietor | No business tax number; one number, about 3,000 texts a day | $4.50 once, then $2 a month for the campaign |
       | Low-Volume Standard | A business tax number and under 6,000 texts a day | $4.50 once, then $1.50 a month |
       | Standard | A business tax number and more texts | $46 once, then $10 a month |

    3. **Campaign Registration**, once the first number is bought ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)). It needs a Messaging Service with the number in its **Sender Pool**, and each number bought after that must be added there too, by hand ([7.21](part-7-operations.md#721-buy-change-and-release-numbers)). In that service's **Integration** settings, keep incoming messages on **Defer to sender's webhook**, as it starts: any other choice stops texts reaching LobbyStack. Twilio charges $15 to review a campaign and says review takes 10 to 15 days.
       - The form asks for sample messages and for the replies people get to HELP and START. LobbyStack sends these replies itself, so register its wording, with your brand's name, contact email and website ([3.6](#36-your-brand)) filled in:
         - HELP: `<app name>: For help, contact <contact email> or visit <website>. Reply STOP to opt out.`
         - START: `<app name>: You are subscribed again. Reply HELP for help or STOP to opt out.`
       - The website must be live, and its privacy policy must say that mobile numbers aren't shared and that "Message and data rates may apply".
15. **More than one business.** When your instance texts for other businesses, Twilio treats you as a software vendor (an ISV), and each business needs its own profile, brand and campaign. Read Twilio's "ISV A2P 10DLC Onboarding Overview" before a second business texts US phones.
16. **Toll-free numbers** need Twilio's toll-free verification before they can text US or Canadian phones. The dashboard buys only local numbers; LobbyStack's API can also buy toll-free ones.
17. **Canadian numbers texting Canadian phones:** Twilio states no registration, but some Twilio resellers report that numbers bought since 2025-03-26 need one. Texting US phones from a Canadian number needs A2P 10DLC either way.

**Only if the instance sells plans: the shared number**

On an instance that sells plans, cloud businesses send their appointment texts, change codes and team alerts from one number that belongs to the instance ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)); replies typed in **Messages** still go from the business's own number, so steps 14 to 17 apply too (`packages/domain/src/server/sms.ts:235-237`). The original LobbyStack used a toll-free number that Twilio verified for account notifications (`mintlify/integrations/sms.mdx:22`), and these steps do the same.

18. In this subaccount, buy one toll-free number that can send texts: **Phone Numbers** > **Manage** > **Buy a number** *(menu path not confirmed)*. A toll-free number texts only US and Canadian phones, so LobbyStack offers these texts only to those phones (`packages/shared/src/smsReach.ts:2-8`).
19. Send the number for Twilio's toll-free verification, under your own business, with account notifications as the use case *(menu path and field names not confirmed)*. Describe how people agree to texts from the "Consent model" section of `mintlify/integrations/sms.mdx`, and give these replies as sample messages, with your brand's name and contact email ([3.6](#36-your-brand)) filled in (`packages/domain/src/server/sms.ts:64-69`):
    - HELP: `<app name>: For help with an appointment, call the business you booked with. For anything else, email <contact email>. Reply STOP to opt out.`
    - START: `<app name>: You can get texts from this number again. Reply HELP for help or STOP to opt out.`

    Until Twilio verifies it, the number can't send texts.
20. **After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional):** open the number's settings, set **A message comes in** to **Webhook**, `https://<your address>/api/webhooks/twilio/sms`, **HTTP POST**, and save *(field names not confirmed)*. LobbyStack didn't buy this number, so it doesn't set this address itself, and it needs these texts to record STOP and START and to answer HELP.

The shared number answers only STOP, START and HELP; any other text to it gets no reply and isn't kept. A STOP to it stops texts from every business that has that phone as a contact (`packages/domain/src/server/sms.ts:72-85`).

**After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): nothing to do at Twilio for the business numbers**

LobbyStack writes the texting addresses onto each number it buys, from the worker's `APP_BASE_URL`. You only give the admin and the worker the same addresses, below, so the admin accepts what Twilio sends.

**What goes where**

| Value | Looks like | Variable | Service |
| --- | --- | --- | --- |
| The subaccount's Account SID | Starts with `AC` | `TWILIO_ACCOUNT_SID` | admin and worker |
| The subaccount's Auth Token | 32 letters and digits | `TWILIO_AUTH_TOKEN` | admin and worker |
| The Trunk SID | Starts with `TK` | `TWILIO_SIP_TRUNK_SID` | worker |
| Your address, then `/api/webhooks/twilio/sms` | `https://app.example.com/api/webhooks/twilio/sms` | `TWILIO_SMS_WEBHOOK_URL` | admin |
| Your address, then `/api/webhooks/twilio/status` | `https://app.example.com/api/webhooks/twilio/status` | `TWILIO_STATUS_CALLBACK_URL` | admin and worker |
| A random value of 32 characters or more | Generated in [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets) | `NUMBER_CLAIM_TOKEN_SECRET` | admin |
| Only if the instance sells plans: the shared number (step 18) | `+18445550123`, with no spaces | `TWILIO_ALERT_SMS_FROM` | admin and worker |

- Twilio signs each request with the exact address it called, and the admin checks that signature against these two addresses. If they're missing or wrong, the admin refuses every text to your numbers, STOP and HELP included. `.env.example` sets them to `http://127.0.0.1:13000/...`, which works only on your own computer.
- Without the trunk SID, buying a number fails with "This server isn't set up to buy phone numbers." Without `NUMBER_CLAIM_TOKEN_SECRET`, choosing a number fails with "Request failed."
- On an instance that doesn't sell plans, leave `TWILIO_ALERT_SMS_FROM` empty: each business texts from its own number. On one that sells plans, cloud businesses can't send appointment texts or alerts until it's set (`packages/domain/src/server/smsSender.ts:9-11`).
- Leave the other `TWILIO_ALERT_*` variables empty either way. They put the shared number in a separate Twilio account; empty, LobbyStack sends from this subaccount (`apps/worker/src/handlers.ts:253`).

**What it costs**, at Twilio's US list prices on 2026-10-18: a local number costs $1.15 a month. Incoming calls cost $0.0034 a minute on the trunk ($0.0045 in Canada), and a transfer adds $0.0100 a minute. A text costs $0.0083 per part, plus a carrier fee on texts you send.

**Not yet confirmed:**

- How many calls a new account's trunk carries at once before the business profile is approved.
- Whether a subaccount can use a texting brand registered on the main account (an old Twilio article says support can share one), and which of Twilio's ISV setups fits LobbyStack, which keeps every business's numbers in one account.
- Canada's current texting rule.
- Several Console button names, which differ between Twilio's new and old menus.

## 3.4 Email

LobbyStack emails sign-up codes, password resets, invitations and alerts. Only the worker sends email, and only over SMTP, the standard way a program hands mail to an email service.

**Check first that your host lets the worker send email**

- **Railway** allows outgoing email (SMTP) only on its **Pro** plan. On the Free, Trial and Hobby plans, the worker can't send email at all. After upgrading, redeploy the worker.
- **Your own server** ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)): DigitalOcean blocks the usual email ports 25, 465 and 587 on every server, so use your email service's other port, such as Resend's 2587 (not tested). Hetzner blocks 25 and 465, so 587 works there.

Without email, LobbyStack still runs, but:

- New accounts wait for a sign-up code that never comes. People can still sign in from the sign-in page, as on your computer ([2.6](part-2-local-development.md#26-sign-in-for-the-first-time-and-create-a-test-business)).
- Password resets don't work.
- Invitations never arrive, and couldn't be accepted anyway, because accepting one needs a verified email address.
- Alerts don't go out.

**Set up Resend**

This guide uses Resend, which Railway recommends. Its free plan sends 3,000 emails a month, at most 100 a day, from up to 3 domains. Other services are in the table at the end of this section.

1. Sign up at `resend.com/signup`. The password needs at least 12 characters.
2. Open **Domains** and click **Add Domain**. Enter a subdomain kept for email, such as `notifications.example.com`, which Resend recommends over your main domain. Choose the region closest to most of the people you'll email; it can't be changed later.
3. Open the domain's **Records** tab and add every record it lists at your DNS provider, exactly as shown. Expect a TXT record named `resend._domainkey`, plus either an MX and a TXT record named `send` or two CNAME records named `send` and `rsend`, depending on when the domain was added.
   - With Cloudflare, **Sign in to Cloudflare** on Resend's domain page adds them for you. If you add them by hand, set each to **DNS only**.
   - Enter only the part before your domain, such as `send`, not `send.example.com`: most DNS providers add the rest.
4. Click **Verify DNS Records**. Domains often verify within 15 minutes, though DNS can take up to 72 hours.
5. Once the domain shows **Verified**, add a TXT record named `_dmarc` with the value `v=DMARC1; p=none; rua=mailto:<an address you read>`. It lets receiving mail services report problems to you.
6. Open **API Keys**, click **Create API Key**, name it after the environment, choose **Sending access** and your sending domain, and create it. Copy the key, which starts with `re_`: Resend shows it only once.

One sending domain can serve both environments, with a key for each.

**What goes where**

| Value | Example | Variable | Service |
| --- | --- | --- | --- |
| Resend's server | `smtp.resend.com` | `SMTP_HOST` | worker |
| Port | `587`, or `2587` on DigitalOcean | `SMTP_PORT` | worker |
| Encrypted from the start | `false` with 587 or 2587; `true` only with 465 or 2465 | `SMTP_SECURE` | worker |
| User name | `resend` | `SMTP_USERNAME` | worker |
| Password | The `re_` key | `SMTP_PASSWORD` | worker |
| Sender | `no-reply@notifications.example.com` | `EMAIL_FROM` | worker |
| Where replies go (optional) | `support@example.com` | `EMAIL_REPLY_TO` | worker |
| Where dashboard feedback goes (optional) | `you@example.com` | `FEEDBACK_TO_EMAIL` | admin |

- `EMAIL_FROM` must be an address on your verified domain. When a brand file applies ([3.6](#36-your-brand)), LobbyStack puts the brand's name in front of it, so people see "AlloPlace" as the sender. In a copy of the code with no brand of its own, write the name yourself: `Your Business <no-reply@notifications.example.com>`.
- If `EMAIL_FROM` is empty, the worker sends from `no-reply@localhost`, which Resend refuses because it isn't on your verified domain.

**Other email services**

| Service | Server and port | Catch |
| --- | --- | --- |
| Postmark | `smtp.postmarkapp.com`, 587 or 2525 | Sends only to your own domain until Postmark approves the account |
| Amazon SES | `email-smtp.<region>.amazonaws.com`, 587 or 2587 | Sends only to addresses you've verified until you get production access |
| Mailgun | `smtp.mailgun.org`, or `smtp.eu.mailgun.org` for EU domains; 587 or 2525 | The free plan sends 100 emails a day |
| Google Workspace SMTP relay | `smtp-relay.gmail.com`, 587 | A Workspace admin has to set it up |
| Gmail with an app password | `smtp.gmail.com`, 587 | About 500 emails a day, and Google advises against app passwords |

**Not yet confirmed:** whether Resend's other ports, such as 2587, get through on Railway's Hobby plan. Railway describes its block by plan, not by port, so plan on Pro.

## 3.5 Cloudflare Turnstile

Turnstile checks that a person, not a program, is filling in the sign-up form. Anywhere but on your own computer, sign-up doesn't work without it.

1. Create a free Cloudflare account at `dash.cloudflare.com/sign-up`. You don't need to move a domain to Cloudflare.
2. Open Turnstile (`dash.cloudflare.com/?to=/:account/turnstile`) and click **Add widget**.
3. **Widget name**: the environment, such as "LobbyStack test sign-up".
4. **Hostname management**: add the dashboard's host name only, with no `https://`, port or path, such as `test.example.com`. Adding `example.com` covers all its subdomains. For Railway's address, add its full host name, such as `your-admin.up.railway.app`, **after [4.7](part-4-test-environment.md#47-use-your-own-domain-optional)**.
5. **Widget mode**: **Managed**, which Cloudflare recommends. Most people see nothing, at most a checkbox.
6. **Pre-clearance**: **No**.
7. Click **Create**, and copy the **Site Key** and the **Secret Key**.

You can add host names later, under the widget's **Settings**, without changing the keys.

**What goes where**

| Value | Variable | Service | Built in? |
| --- | --- | --- | --- |
| Site Key | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | admin | Yes |
| Secret Key | `TURNSTILE_SECRET_KEY` | admin | No |

- Set both before the admin is first built. Without the secret key, or with it but without a site key in the build, every sign-up says "We couldn't create your account. Please try again."
- Only sign-up and **Send a new code** use Turnstile (right after sign-up, the code screen skips the check for 10 minutes). Sign-in and password resets don't.

**Not yet confirmed:** the exact screen where the keys appear after **Create**.

## 3.6 Your brand

The brand is the name, logo, color and links people see in the dashboard, on public profile pages, in emails and in text replies. LobbyStack picks it from the domain of `APP_BASE_URL`, else from `BRAND_PRESET`, else it takes the only brand in the code besides LobbyStack, and builds it into the dashboard, so decide it before the first deploy. There are four ways:

| Way | What you do | What people see |
| --- | --- | --- |
| AlloPlace, the brand in the code | Nothing. It's the only brand besides LobbyStack, so every address gets it, not just `alloplace.com` and `alloplace.ai` | AlloPlace everywhere |
| LobbyStack | Set `BRAND_PRESET` to `lobbystack`, on an address no brand claims | LobbyStack everywhere. Replies to HELP texts give the original project's email address and website, and so do the dashboard's links to a website, terms and privacy policy (`packages/shared/src/brandLinks.ts`) |
| Your own brand | A developer adds it to the fork, as below | Your brand everywhere |
| A name and logo chosen in onboarding | Only in a copy of the code with no brand besides LobbyStack, or with several and none picked: the first owner names the app and adds a logo ([6.2](part-6-first-run.md#62-the-brand-step)) | Your name in the dashboard, emails and texts, and your logo in the dashboard. Everything else stays the original project's, as for LobbyStack |

Adding your own brand is a small code change, best done once by someone used to Git, following `docs/branding.md`:

1. Create a folder `brands/<id>/` with a file `brand.json`. Only `appName` is required. It can also name a logo, an email logo, a link-preview image, an accent color, links to your website, docs, terms and privacy policy, and a contact email. Each image must be 256 KB or smaller. An instance that sells plans needs a `billing.json` in the folder too ([3.7](#37-optional-services), "[Selling plans](#selling-plans-polar)", step 2).
2. Claim your domain in `brands/index.json`, such as `"example.com": "<id>"`. For an address you don't own, such as Railway's, set `BRAND_PRESET` to the folder name instead. Beside AlloPlace, your brand is a second one, so an address no brand claims no longer gets a brand on its own: give every such deployment a `BRAND_PRESET`, or it shows LobbyStack. If your folder replaces AlloPlace's, it's the only one again and every address gets it.
3. Run `pnpm brands:build`, commit everything it writes, and push. The next build of the admin and the worker includes the brand.

Settle the brand before you register for texting ([3.3](#33-twilio), step 14): Twilio's reviewers read the HELP and START replies, which carry the brand's name, contact email and website.

**What goes where**

| Value | Variable | Service | Built in? |
| --- | --- | --- | --- |
| A brand's folder name, for an address that no brand claims, when the only brand besides LobbyStack isn't the one you want there | `BRAND_PRESET` | admin and worker | Yes, on the admin |

- These old variables no longer do anything: `BRAND_APP_NAME`, `BRAND_LOGO_URL`, `BRAND_ACCENT_COLOR`, and the `NEXT_PUBLIC_` link variables such as `NEXT_PUBLIC_TERMS_URL`.
- A few things stay "LobbyStack" whatever the brand: the name Twilio shows for each number (`LobbyStack <business id>`), the services' names, and some technical identifiers.

## 3.7 Optional services

### Google Calendar

Lets a business connect its Google Calendar, so the receptionist books into real free time. One Google Cloud project can serve both environments, with a sign-in client for each.

1. Sign in to `console.cloud.google.com` and create a project: **IAM & Admin** > **Create a Project**, enter a **Project Name** such as "LobbyStack", and click **Create**. Calendar needs no billing account.
2. Turn on the Calendar API: **APIs & Services** > **Library**, find **Calendar API**, and click **Enable**.
3. Set up the screen where owners give LobbyStack access: **Google Auth platform** > **Branding** > **Get Started**.
   1. **App name**, which can't contain "Google", and **User support email**, then **Next**.
   2. **Audience**: **External**, then **Next**.
   3. **Contact Information**: your email, then **Next**.
   4. Agree to Google's user data policy, then **Continue** and **Create**.
4. On **Branding**, add your domain under **Authorized domains**, such as `example.com`. For Railway's address, add its full host name, such as `your-admin.up.railway.app`. Skip the logo: an uploaded logo needs Google's review.
5. Open **Data Access** > **ADD OR REMOVE SCOPES**, add these four, click **UPDATE**, and save:
   - `openid`
   - `email`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
6. Open **Clients** > **Create Client** and choose **Web application**. Name it after the environment, click **Add URI** under **Authorized redirect URIs**, enter `https://<your address>/api/calendar/google/callback`, and click **Create**. With Railway's address, do this step **after [4.7](part-4-test-environment.md#47-use-your-own-domain-optional)**.
7. Copy the client ID, which ends with `.apps.googleusercontent.com`, and the client secret. Google shows the full secret only once.
8. Open **Audience** and click **Publish app**. Don't skip this: while the app is in "Testing", every calendar connection stops working after 7 days.

When an owner connects a calendar, Google warns that the app isn't verified, and they continue with **Advanced** > **Go to** *your project's name* **(unsafe)**. An unverified app can be connected by 100 people in total. To go beyond that or remove the warning, apply for Google's verification: it needs a public home page and privacy policy on your domain, proof that you own the domain, and a short video, and it typically takes 3 to 5 business days.

| Value | Variable | Service |
| --- | --- | --- |
| Client ID | `GOOGLE_CLIENT_ID` | admin and worker |
| Client secret | `GOOGLE_CLIENT_SECRET` | admin and worker |
| `https://<your address>/api/calendar/google/callback` | `GOOGLE_REDIRECT_URI` | admin and worker |

The worker needs all three as well. Without them, a chosen calendar stays "Synchronizing" and never syncs, so the receptionist books nothing and takes messages instead ([8.9](part-8-troubleshooting.md#89-google-calendar)).

### The map on public profile pages

Without a key, a business's public profile page shows a simple drawn map that opens Google Maps. With a Google Maps Embed key, it shows Google's own map, free and with no usage limit.

1. Link a billing account to your Google Cloud project: Google requires one even for this free map.
2. Turn on the **Maps Embed API** from the Google Maps Platform list of APIs *(button name not confirmed)*.
3. Open **Google Maps Platform** > **Credentials** > **Create credentials** > **API key**, then click **Close**.
4. Restrict the key, because anyone can see it in the page. Select it, then:
   - Under **Set an application restriction**, choose **Websites** and add `https://<your address>/*`. Don't narrow it to `/profile/*`: Google sees only the site, not the page, so that rule would never match.
   - Under **API restrictions**, choose **Restrict key**, select only **Maps Embed API**, and click **Save**.

| Value | Looks like | Variable | Service |
| --- | --- | --- | --- |
| Maps key | Starts with `AIza` | `GOOGLE_MAPS_EMBED_API_KEY` | admin; not built into the dashboard ([7.6](part-7-operations.md#76-change-a-setting-safely)) |

### Website import (Firecrawl)

Lets onboarding and the Knowledge page import a business's website.

1. Sign up at `firecrawl.dev/app/api-keys`.
2. Copy the key from the **API keys** page. It starts with `fc-`.

| Value | Variable | Service |
| --- | --- | --- |
| Firecrawl key | `FIRECRAWL_API_KEY` | worker |

The free plan reads 1,000 pages a month, and an import reads up to 50 pages, so it covers about 20 imports. Without a key, imports fail with "Website crawling is not configured." The same key can serve both environments.

### Errors, analytics and logs (PostHog)

Collects the errors and logs of every LobbyStack service in one place. It's optional, and recommended for production. The free tier covers 1 million events, 100,000 errors and 10 GB of logs a month.

1. Sign up at `us.posthog.com`, or at `eu.posthog.com` to keep the data in Europe. The region can't be changed later.
2. Create a project for each environment, and copy its project token from the project's settings. It starts with `phc_`. Don't use a personal API key, which starts with `phx_`.

| What it's for | Variable | Value | Service | Built in? |
| --- | --- | --- | --- | --- |
| Dashboard analytics and the admin's error reports | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | `phc_…` | admin | Yes |
| Where the dashboard sends them | `NEXT_PUBLIC_POSTHOG_HOST` | `https://us.i.posthog.com`, or `https://eu.i.posthog.com` | admin | Yes |
| The worker's events and error reports | `POSTHOG_API_KEY` | `phc_…` | worker | No |
| Where the worker sends them | `POSTHOG_HOST` | Needed only for EU: `https://eu.i.posthog.com` | worker | No |
| Logs from every service | `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://us.i.posthog.com/i` | admin, worker and migrate | No |
| The logs' credentials | `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer phc_…` | admin, worker and migrate | No |

- On Docker Compose, always set `NEXT_PUBLIC_POSTHOG_HOST`: without it, Compose sends the dashboard's data to the original project's own PostHog relay, the default written in `docker-compose.yml`.
- Once the token is built in, dashboard analytics are on for every business from the start, recordings of operators' screens included. Each business can turn them off with **Share telemetry data** under **Settings** > **Preferences** ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).

**Not yet confirmed:** the EU address for logs, presumably `https://eu.i.posthog.com/i`, and whether PostHog charges for the traces and metrics that LobbyStack sends along with its logs, since its free tier lists neither.

### Selling plans (Polar)

Only for an instance that sells Starter and Pro ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)). Polar runs the checkout page, tells LobbyStack about each payment, and bills the minutes, texts and transfers a paid plan uses beyond its allowance.

One command sets Polar up. `pnpm billing apply` reads the brand's plans from `brands/<brand>/billing.json`, makes Polar sell them, records which Polar product sells each price, and checks the file, the instance's billing tables and Polar against each other (`brands/README.md:67-84`). From the first `apply` on, the plan screens and the plans' limits follow the file too (step 7). It runs from the copy of the code on your computer ([Part 2](part-2-local-development.md)) and works through the running instance, so steps 5 to 8 wait until **after [4.7](part-4-test-environment.md#47-use-your-own-domain-optional)**. It came with fork PR #59 (`a44f995`). Its tests use a stand-in for Polar, and it hasn't been run against a real Polar organization yet.

An earlier, separate setup guide did by hand what the command now does, with a script of its own, `polar-setup.mjs`, which is now in `devops/` for reference ([billing design history](../../billing/design-history.md)). Use it only on a copy older than `a44f995`. Since fork PR #73 the command's annual products invoice their overage each month, while those that `polar-setup.mjs` makes invoice it once a year, so set up a new organization with the command, even when the brand needs a `billing.json` first (step 2).

1. **An organization for each environment.** Set up the test environment in Polar's sandbox, at `sandbox.polar.sh`, where test cards move no money, and production in a live organization at `polar.sh`. Nothing carries over between the two, and Polar's review of a live organization can take up to 14 days, so start it early. An instance stays with the first organization it's linked to, so never link the test environment to the live one (`scripts/billing.ts:193`).
2. **The brand's plans.** The command needs a brand with a `billing.json` ([3.6](#36-your-brand)). AlloPlace has one, `brands/alloplace/billing.json`, priced in Canadian dollars. For your own brand, copy that file into the brand's folder, keep its four plans, and change their prices, allowances and rates as you need: once `pnpm billing apply` has run, the plan screens and the limits a business runs into both follow the file (step 7). A plan includes one phone number at most: `limits.businessNumbers` is 0 or 1, and a file with more is refused before anything changes (`packages/shared/src/billingProfile.ts:45`; fork PR #70). Then run `pnpm brands:build`, commit and push, as in [3.6](#36-your-brand). The lobbystack brand, which an instance shows with `BRAND_PRESET=lobbystack`, has no `billing.json`: give it one the same way, in `brands/lobbystack/`, rather than use the separate guide, whose annual products would invoice their overage once a year (`packages/shared/src/brands/schema.ts:54`, `docs/providers/polar.md:47`; fork PR #73).
   - `--brand` must name the brand that `https://<your address>/api/health/ready` shows. On an address no brand claims, such as Railway's, that's the one in `BRAND_PRESET`, or AlloPlace when it's empty ([3.6](#36-your-brand)).
3. **LobbyStack's tokens.** Since fork PR #74 the admin and the worker each have a token of their own, with only the scopes each one uses (`docs/providers/polar.md:68-77`). In the organization, open **Settings**, scroll to **Developers**, and click **New Token**. Name it after the environment and the service, such as "LobbyStack test admin", note its end date ([7.25](part-7-operations.md#725-routine-maintenance-calendar)), and give it one scope:
   - `customer_sessions:write`, with which the dashboard opens Polar's billing portal, from **Manage subscription** under **Settings** > **Plan**. It's the admin's only call to Polar (`apps/admin/app/api/billing/portal/route.ts:14`).

   Then click **New Token** again for the worker's, such as "LobbyStack test worker", note its end date too, and give it eight scopes:
   - `checkouts:write` and `events:write`, for checkouts and usage reports.
   - `organizations:read`, `meters:read`, `products:read` and `discounts:read`, with which the worker checks Polar once a day (`apps/worker/src/index.ts:67-74`). Since fork PR #69 the worker no longer reads Polar's benefits, so a token made earlier with `benefits:read` as well works as it is.
   - `subscriptions:write`, with which **Upgrade to Pro** moves a business that already pays for Starter onto Pro (`apps/worker/src/handlers.ts:1489-1554`, `changeBillingPlan`).
   - `customers:write`, with which each checkout finds or makes the business's own Polar customer. Polar keeps one customer per email, so without it, someone who pays for two businesses gets the second one's subscription on the first one's customer (`apps/worker/src/handlers.ts:1449-1470`, `checkoutCustomer`; fork PR #72). A token made before fork PR #72 lacks it. Checkouts still work with such a token, as they did before, but each one logs the warning "The worker's Polar token can't read or make customers", which PostHog shows too when it's set up. Put in a new worker token with all eight scopes, as [7.18](part-7-operations.md#718-rotate-secrets-and-keys) says.

   Give neither token `webhooks:read`. Polar lists each webhook with its signing secret, and whoever has the secret can send LobbyStack messages that put any business on any plan. So since fork PR #74 the worker's daily check leaves the webhook out, and `pnpm billing verify` checks it with a token of your own (step 8); when Polar turns the webhook off after failed deliveries, it emails the organization's members. On a server, Docker Compose gives the admin and the worker the same `POLAR_ACCESS_TOKEN` line from `.env` (`docker-compose.yml:168, 284`), so there make one token with all nine scopes, still without `webhooks:read`.

   - **A token made before fork PR #74** has ten scopes, `webhooks:read` among them, and on Railway the worker refers to the admin's. It keeps working after the deploy, but put in the two tokens above, or the one on a server, as soon as you can, as [7.18](part-7-operations.md#718-rotate-secrets-and-keys) says, then delete the old one in Polar.

   Copy each token straight into your password manager: Polar revokes tokens it finds leaked on the web.
4. **The organization's ID.** Copy it from **Settings** as well. It must be the real ID: `pnpm billing` checks it against the organization the token reaches (`scripts/billing.ts:185-196`).

Set `DEPLOYMENT_MODE=cloud` on the admin and the worker, and these. The first four go in before the first build ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)); the webhook's secret comes from step 7:

| Value | Variable | Service |
| --- | --- | --- |
| The admin's token (step 3) | `POLAR_ACCESS_TOKEN` | admin |
| The worker's token (step 3), typed in, not a reference to the admin's | `POLAR_ACCESS_TOKEN` | worker |
| The organization's ID (step 4) | `POLAR_ORGANIZATION_ID` | admin and worker |
| `https://sandbox-api.polar.sh` for the test environment; empty for production | `POLAR_API_BASE_URL` | admin and worker |
| The webhook's secret (step 7) | `POLAR_WEBHOOK_SECRET` | admin |

5. **After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): an operator's key.** `pnpm billing` reaches the instance with a platform key made with `--access all`. Make it as in [6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line), "A key for every business", steps 2 to 4, and add the `PLATFORM_API_KEYS` value it prints to the admin with [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment)'s other values, so one deploy covers them. After that deploy, sign up with the key's email and enter the code from the email ([4.9](part-4-test-environment.md#49-smoke-test), step 1): the key works only for a verified account. Then sign the command line in with the key, at your final address ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line), "A key for every business", step 5). Setting `LOBBYSTACK_URL` and `LOBBYSTACK_API_KEY` in the terminal works too.
6. **After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): a setup token.** Under **Developers** again, make another token, such as "LobbyStack setup", with the shortest end date offered, and five scopes: `organizations:write`, `meters:write`, `products:write`, `discounts:write` and `webhooks:write`. Each run lists the organization's discounts, even when no plan in the file has one, so without `discounts:write` every run stops with `exit 2` and a message naming `GET /v1/discounts/` (`packages/providers/src/polar/polarCatalog.ts:172`, `brands/README.md:77`). Since fork PR #69 the token needs no `benefits:write`: taking Credits off a product (step 7) comes under `products:write`. Only `pnpm billing` uses it, and it never goes on Railway.
7. **After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): set Polar up.** In the code folder, updated to the version the instance runs so that both have the same `billing.json`, run:

   ```sh
   pnpm billing plan --brand <brand> --polar sandbox
   pnpm billing apply --brand <brand> --polar sandbox --railway-file .env.railway
   ```

   - `plan` asks for a read token and `apply` for the setup token, with typing hidden, and neither saves it: give both the setup token.
   - `plan` changes nothing. It lists what `apply` would do: first the changes to the instance's billing tables, then each change in Polar, from the organization's settings (the file's currency, one subscription per customer, plan changes on in the customer portal) to the meters, products, discounts and the webhook.
   - `apply` lists the same, asks you to type `yes`, makes the changes, links each price to its product, and ends with a check of all three. When this run made the webhook, that first check ends `Result: drift (exit 1)`, naming `POLAR_WEBHOOK_SECRET`. That's expected: step 8 sets it.
   - The webhook goes to the address the command line is signed in at, `https://<your address>/api/webhooks/polar`, in Raw format, with the 15 events LobbyStack handles (`packages/domain/src/server/billingPolar.ts:13-33`).
   - `--railway-file` saves `POLAR_API_BASE_URL`, `POLAR_ORGANIZATION_ID` and, when this run made the webhook, `POLAR_WEBHOOK_SECRET` to a new file, here `.env.railway`, a name Git ignores, so it can't be committed by mistake. Since fork PR #67 the file is written as soon as Polar is set up, so a run that stops after that still leaves it, with the secret: delete it once Railway has the values (step 8), whether the run finished or not. Without the flag, the secret is on the webhook's page in Polar (`scripts/billing.ts:216-224, 308-322`).
   - **An organization set up earlier,** with `polar-setup.mjs` or the separate guide: add `--adopt --allow-replace` to both commands. `--adopt` takes over its meters and monthly products, keeps their IDs, and lists each one as `tag`; `--allow-replace` makes its annual products again, as the bullet after next says. Any other `create` for something you already have means it wasn't recognized: products are matched by name, such as `Starter monthly`, so stop and compare. Without `--adopt`, such a lookalike stops the run, so a forgotten flag can't make duplicates.
   - **An organization set up before fork PR #69** has Credits on its monthly products, which are no longer needed: the worker now reports only the usage past each month's allowance, on monthly and annual plans alike. So every `apply`, with or without `--adopt`, takes any Credits off the brand's products, one `detach` line per product, and leaves their other benefits. The Credits stay in Polar's **Benefits** list, on no product. Run `apply` soon after deploying fork PR #69: until then the allowance is taken off twice, by the worker and by the Credits, and `verify` and the daily check report the Credits as drift. Polar then takes the Credits back from current subscribers, who may be billed in this billing cycle for allowance they used before the change. An organization set up from fork PR #69 on never has Credits (`packages/domain/src/server/billingPolar.ts:452-462`).
   - **An organization set up before fork PR #73,** by `apply` or by `polar-setup.mjs`, has annual products that invoice their overage once a year, and Polar never adds a meter cycle to a product. So after deploying fork PR #73, run `apply` once with `--allow-replace`, and with `--adopt` too if no run has adopted the organization yet, such as `pnpm billing apply --brand alloplace --polar sandbox --adopt --allow-replace`. It lists a `create` line for each annual product, saying `overage invoiced each month`, and an `archive` line for the old one, whose subscribers keep it and still pay their overage once a year. The same run moves the webhook to Polar's API version `2026-10` ([7.22](part-7-operations.md#722-upgrade-pinned-versions)). Without `--allow-replace`, `plan` and `apply` end `Refused, so nothing changed:`, with a line for each annual product that ends `Run with --allow-replace to make a new product and archive this one; its subscribers keep it.`, and the daily check reports drift until the run (`packages/domain/src/server/billingPolar.ts:283-290, 438`). Afterwards, delete `POLAR_STARTER_ANNUAL_PRODUCT_ID` and `POLAR_PRO_ANNUAL_PRODUCT_ID` from the admin and the worker if they're still set (step 8). This hasn't been run against Polar's sandbox yet.
   - A run that stops part-way is finished by running it again: it finds what it made by its tags, and the webhook by its address. If the stopped run left `.env.railway`, keep it for step 8 and leave `--railway-file` out this time, since a run stops at once when its file is already there (`scripts/billing.ts:347`). Until then, checkout doesn't sell a plan the stopped run added or changed, even if only its price changed: a plan sells again once a run links it (`docs/providers/polar.md:17`). Nothing is ever deleted, in Polar or in the tables.
   - Onboarding's plan step, the upgrade dialog and **Settings** > **Plan** show the file's prices, allowances and overage rates in its currency, such as CA$37 for AlloPlace in English. A yearly price shows as what it comes to a month, rounded to the nearest whole dollar, such as CA$31 for Starter's CA$370, and the **Annual** tab says **Get 2 months for free!** while every plan's year costs ten months (fork PR #89). Before the first `apply` they show the file as the deployed code carries it, which `pnpm brands:build` wrote into the code, with **Starter** and **Pro** greyed out while no Polar product sells them; from the first `apply` on, they show the instance's tables, so a later change to the file shows once it is applied. Only a brand without a `billing.json` shows the plans built into the code, in US dollars (`packages/domain/src/server/billingPlans.ts:229-233`; fork PRs #61 and #88).
   - The limits follow the file the same way: the call minutes, alert texts, outbound calls and website chats each plan includes, the overage rates counted toward a business's spending cap, the knowledge storage limit, and whether a plan may pick a phone number. **Settings** > **Usage** and **Settings** > **Phone Number** show the same numbers. Before the first `apply`, the check on claiming a phone number still counts one number on Starter and Pro and none on Free, as AlloPlace's file does. A change counts for the whole current month: usage already recorded this month is measured against the new allowance, so lowering one can block a business at once (`brands/README.md:36`, `packages/domain/src/server/billingPlans.ts:272-286`; fork PRs #62 and #88).
8. **After [4.7](part-4-test-environment.md#47-use-your-own-domain-optional): put the values on Railway.** Open `.env.railway`. If it has a `POLAR_WEBHOOK_SECRET` line, add that line to the admin's variables and click **Deploy**; the file's other two lines, `POLAR_API_BASE_URL` and `POLAR_ORGANIZATION_ID`, are there already. No product ID variables are needed: checkout and **Upgrade to Pro** sell the products `apply` linked (fork PR #66). Then delete the file and run:

   ```sh
   pnpm billing verify --brand <brand> --polar sandbox
   ```

   When it asks for a read token, give it the setup token again: since fork PR #74, `verify` is the only check of the webhook and its secret (step 3). It should end `Result: in sync (exit 0).` With `exit 1`, the lines marked `DRIFT` say what differs; with `exit 2`, Polar couldn't be read, usually because a token lacks a scope. Then delete the setup token in Polar.
   - On an instance set up before fork PR #66, `verify` lists the old `POLAR_…_PRODUCT_ID` variables in an `info` line, or in a `warn` line when one names another product than the linked one. Neither fails the check: delete the four from the admin and the worker when convenient (`packages/domain/src/server/billingVerify.ts:159-173`). After the `--allow-replace` run of fork PR #73 (step 7), the two annual ones name the archived products, so each gets a `warn` line ending `Checkout sells the linked product and ignores the variable, so remove it from the instance.`: delete them then.
   - `devops/railway-vars.mjs` can set the file's values for you. Change `lobbystack-admin` in its `[...]` lines to `admin` first.
   - To see the plans as customers now see them, run `pnpm lobbystack billing plans --business <ID>`, with your business's **Business ID** from **Settings** > **API keys**. It lists each plan's allowances and prices, marks a price checkout can't sell `(not sold here)`, and for AlloPlace should end `Prices in CAD, from the billing catalog.`
   - To run `verify` again later, once the setup token is gone, make a read token for it with `organizations:read`, `meters:read`, `products:read`, `discounts:read` and `webhooks:read` and the shortest end date offered, and delete it afterwards. Like the setup token, it never goes on Railway, since it can read the webhook's secret.

- From then on, the worker runs the same check every day and reports any difference ([7.12](part-7-operations.md#712-alerts-and-how-to-respond)). `pnpm lobbystack billing catalog-runs --kind verify` lists its checks.
- To change the plans or prices later, change `billing.json` in a pull request, deploy it, then do steps 6 to 8 again in each environment (`brands/README.md:11-36`). Subscribers keep the price they signed up at, and edits made in Polar's dashboard are put back to the file's. So once businesses pay for Starter or Pro, leave that plan's price, overage rates and allowances as they are: LobbyStack applies new terms to every business on the plan at once, while Polar keeps billing each subscriber what they bought, so their **Settings** > **Usage** page and spending cap stop matching their invoices. Until LobbyStack keeps each subscription's own terms, put new terms under a new plan code, which for now sells through a promo code (`brands/README.md:21-25`). An extra plan's terms are fixed by its first subscriber anyway: `apply` refuses to change them (`packages/domain/src/server/billingCatalog.ts:158-159`). Lowered allowances count for the whole current month, so a business that has already used more is blocked at once. Archiving a product or discount the file no longer has needs `--allow-archive`. A change Polar can't make in place, such as a product's billing or meter cycle, needs `--allow-replace` and gives the product a new ID. Subscribers stay on the old product, and since fork PR #61 the admin still recognizes it through its retired price (`packages/domain/src/server/billingPlans.ts:175-185`). Since fork PR #62 such a pull request needs no change to the code: the test on AlloPlace's file checks only that each plan keeps its kind (`packages/shared/src/billingProfile.test.ts:72`).
- **Promo plans and codes.** A plan in `billing.json` with `"access": "code"` is sold only to a business that enters one of its codes. Once `apply` has made its Polar product and discount, issue codes with the operator's key: `pnpm lobbystack billing code-create <plan> --max-uses 50 --expires-at 2026-12-31T00:00:00Z` makes one anyone may use, and `--business-id <ID>` in place of the last two makes one for a single business. It prints the code and a link, `https://<your address>/signup?promo=<code>`; the business can also type the code under **Have a promo code?** on onboarding's plan step or **Settings** > **Plan**. Each business uses a code once: after its subscription has gone live on the code's plan, the code won't sell it that plan again, even once the plan has ended or the subscription has lapsed, though while the business is on the plan the code still says so. Other businesses can use it up to `--max-uses`. Since fork PR #75 their open checkouts count toward that too, for up to 25 hours, a little longer than Polar keeps a checkout page, so a code's last use goes to one business at a time; an abandoned checkout holds its use that long, and a failed one frees it at once. A business can try 10 codes an hour, and a person, an address or a key 20 across all businesses, so an operator testing codes with the platform key has 20 an hour in all. Since fork PR #74 the codes a key tries count toward the 20 of the person it acts for as well, together with theirs on the dashboard. A plan with `months` ends at the first renewal after them: a week before, the worker emails the owners ([3.4](#34-email)) and tells Polar. Since fork PR #75 a subscription that has already left the plan, such as after **Upgrade to Pro**, is left as it is. `pnpm lobbystack billing end-promo-plan --business <ID>` ends one at the next renewal instead (`brands/README.md:38-65`, `packages/db/migrations/0113_billing_code_redemptions.sql`, `apps/admin/src/lib/promo-code-limit.ts`; fork PRs #63 to #65, #70 and #74).
- A business that already pays for Starter moves to Pro with **Upgrade to Pro**, under **Settings** > **Plan**: its Polar subscription changes in place, and Polar charges the prorated difference to the saved card straight away (`"upgradeProration": "invoice"` in `billing.json`, `docs/providers/polar.md:119`). Without `subscriptions:write` on the worker's token, the dashboard says "Plan changes aren't set up here yet. Contact support.", and the worker logs a warning with `Polar refused a plan change:`, which PostHog shows too when it's set up ([3.7](#37-optional-services), "[Errors, analytics and logs](#errors-analytics-and-logs-posthog)"). Moving down to Starter still goes through **Manage subscription**. This came with fork PR #60 (`a6ff674`) and hasn't been tried against Polar's sandbox yet. Since fork PR #75 a business that already pays changes plan one request at a time: while another of its changes still waits for Polar, the upgrade dialog and **Have a promo code?** say "An earlier change to your subscription is still being applied. Try again in a minute." ([8.4](part-8-troubleshooting.md#84-the-dashboard)), and the API answers 409 `conflict` (`docs/providers/polar.md:127`).
- **A billing email for a second business.** Since fork PR #72, a business's first checkout makes it a Polar customer of its own, with the business's name and the payer's email. Polar keeps one customer per email, so when the payer's email already belongs to another business's customer, as when someone pays for a second business, the checkout stops and the screen asks for a **Billing email** for this business, where Polar then sends its receipts. It says "Your email is already used for another business's billing in Polar. Enter a separate billing email for this business.", and **Continue** starts the checkout again with the new address. It asks the same when Polar doesn't accept the email at all, and asks again if the new address is taken too. Onboarding's plan step, the upgrade dialog and **Have a promo code?** all ask this way, and a promo code tried again with a billing email counts as another try. API callers send `billing_email` with `POST /api/v1/billing/checkout` (`docs/providers/polar.md:102-112`, `apps/admin/src/components/billing-email-form.tsx`, `packages/db/migrations/0115_billing_email.sql`). It hasn't been tried against Polar's sandbox yet.
  - On an instance that sold plans before fork PR #72, events about subscriptions bought earlier still go to a business by their Polar customer, as before. An earlier version could also change a business's billing key to another business's key or to Polar's own customer ID, so that its usage was never billed, and nothing changes such a key now. Someone technical can list them as `postgres`: `select business_id, billing_key, customer_id from billing_accounts where billing_key <> 'business:' || business_id::text;`. Keys that hold an old ID from the original platform are fine. Fixing any other means moving its Polar customer by hand, which hasn't been worked out here.
- **Annual plans' overage.** Since fork PR #73, an annual subscriber pays the plan's price once a year and each month's overage separately: Polar invoices it as an order of its own, emails it to them as a usage invoice, and tells LobbyStack, which records it like any other order. When its payment fails, Polar tries again after 2, 7, 14 and 21 days, then gives up on it, and the business keeps its plan; a spending cap, when set, still limits each month's overage. Subscribers of an annual product that the `--allow-replace` run archived (step 7) keep paying their overage once a year. Moving one to the new product is a plan change, which invoices their overage so far at once (`docs/providers/polar.md:47`, `brands/README.md:69`, and the pull request's notes). It hasn't been tried against Polar's sandbox yet.
- **Limits on checkouts and the billing portal.** Polar's limit on requests counts for the whole organization, and past it Polar refuses every call, payments and usage reports included. So since fork PR #74, a business can start 10 checkouts an hour and open the billing portal 20 times, and a person 20 checkouts and 40 portal sessions across all their businesses (`apps/admin/src/lib/billing-limit.ts`, `docs/providers/polar.md:94`). A plan change such as **Upgrade to Pro** counts as a checkout, and so does one started through the API, for the business and for the person it's made out to, who for the platform key is the business's owner. Only a request that passes the other checks counts, so someone who doesn't manage the business can't use its count up. The same person asking again for the same plan, interval, promo code and billing email while their earlier request is still being prepared, within its 15 minutes, gets that request back, which counts nothing. Two admins asking at once make two requests only while the business doesn't pay yet: since fork PR #75, one that already pays takes one change at a time, as the note on **Upgrade to Pro** above says. The counts start again at the top of each hour, not an hour after the first try. Over a limit, the dashboard says "Too many tries. Try again later." ([8.4](part-8-troubleshooting.md#84-the-dashboard)), and the API answers 429 `rate_limited`. The counts are kept in Redis, so while it's down no one can start a checkout or open the billing portal ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)). This hasn't been tried against Polar's sandbox yet.
- **Usage corrections.** Some usage is corrected after it's recorded, such as a text that Twilio settles on more segments than LobbyStack estimated. Since fork PR #75 each correction reaches Polar as an event for the difference, negative when the count went down, and goes on the next invoice when Polar has already invoiced that month. Corrections made before the deploy to usage that was still waiting for Polar are lost (`docs/providers/polar.md:43`, and the pull request's notes). This hasn't been tried against Polar's sandbox yet.
- A business you bill yourself needs no Polar: `lobbystack billing managed-plan` puts it on the Enterprise plan (`packages/cli/src/commands.ts:346`).

**Not yet confirmed:** the names of Polar's token screens and the end dates they offer, and whether the hidden token question works in Git Bash on Windows.

## 3.8 Before you go on

Check your worksheet ([Appendix D](appendix-d-worksheet.md)). For the test environment you should now have:

- [ ] The address, or a note that it comes from Railway in [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)
- [ ] OpenAI: the API key and the project ID, with a hard spending limit set
- [ ] Twilio: the subaccount's Account SID and Auth Token, and the Trunk SID, with the business profile sent for review
- [ ] Email: the SMTP settings and the sender address, with Railway on the Pro plan
- [ ] Turnstile: the site key and the secret key
- [ ] The brand decided, and added to the fork if it's your own
- [ ] Optional: the Google client ID and secret, the Maps key, the Firecrawl key and the PostHog token
- [ ] Only if you sell plans: the shared number, sent for verification ([3.3](#33-twilio), steps 18 and 19); a brand with a `billing.json`; and the sandbox organization's ID and LobbyStack's two tokens for it ([3.7](#37-optional-services), "[Selling plans](#selling-plans-polar)", steps 1 to 4)

Left for after [4.7](part-4-test-environment.md#47-use-your-own-domain-optional), which Part [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment) walks through:

- The DNS records for your domain ([3.1](#31-choose-your-addresses), step 3).
- The OpenAI webhook and its secret ([3.2](#32-openai), steps 14 to 16).
- With Railway's address: its host name on the Turnstile widget ([3.5](#35-cloudflare-turnstile), step 4), on Google's authorized domains and redirect address ([3.7](#37-optional-services), steps 4 and 6), and on the Maps key's websites ([3.7](#37-optional-services)).
- Only if you sell plans: the shared number's incoming-text address ([3.3](#33-twilio), step 20), and Polar's products and webhook, made by `pnpm billing apply` ([3.7](#37-optional-services), "[Selling plans](#selling-plans-polar)", steps 5 to 8).

**Checked against:** `.env.example`, `docker-compose.yml`, `.railway/template.ts`, `Dockerfile.admin`, `apps/admin/src/lib/turnstile.ts`, `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/trusted-client-ip.ts`, `apps/admin/app/api/webhooks/openai/live/route.ts`, `apps/admin/app/api/webhooks/twilio/`, `packages/providers/src/twilio/`, `apps/worker/src/index.ts`, `apps/worker/src/handlers.ts`, `packages/domain/src/server/sms.ts`, `packages/shared/src/branding.ts`, `packages/shared/src/brands/resolve.ts`, `packages/providers/src/google/calendar.ts`, `packages/telemetry/src/node.ts`, `docs/branding.md` and `docs/voice/runtime.md`. The steps for an instance that sells plans were added the same day, checked against `packages/domain/src/server/smsSender.ts`, `tenancy.ts`, `usage.ts` and `phoneNumbers.ts`, `packages/shared/src/billing.ts` and `smsReach.ts`, and `mintlify/integrations/sms.mdx`. The Polar steps were rewritten on 2026-10-22 for fork PR #59, checked at `a44f995` against `scripts/billing.ts`, `brands/README.md`, `brands/alloplace/billing.json`, `.env.example`, `.gitignore`, `packages/domain/src/server/billingPolar.ts`, `billingVerify.ts` and `billingCatalog.ts`, `apps/worker/src/index.ts`, `handlers.ts` and `scheduler.ts`, `apps/admin/src/lib/public-api/routes.ts` and `http.ts`, `scripts/platform-key.ts` and `packages/cli/src/config.ts`. Fork PR #60's plan changes were added at `a6ff674`, checked against `apps/worker/src/handlers.ts`, `packages/shared/src/billing.ts`, `packages/domain/src/server/billingCatalog.ts`, `apps/admin/src/components/live-plan-surface.tsx` and `upgrade-plan-dialog.tsx`, `apps/admin/public/locales/en/settings.json`, `packages/telemetry/src/node.ts`, `.env.example` and `docs/providers/polar.md`. Fork PR #61's plan screens and linked products were added at `b6ba2aa`, checked against `packages/domain/src/server/billingPlans.ts`, `billingVerify.ts`, `billingCatalog.ts` and `usage.ts`, `packages/shared/src/billing.ts` and `billingProfile.test.ts`, `apps/admin/src/lib/polar-event.ts` and `public-api/http.ts`, `apps/admin/src/components/live-plan-surface.tsx` and `live-usage-surface.tsx`, `packages/cli/src/commands.ts`, `packages/shared/src/publicApi/operations.ts` and `constants.ts`, `.env.example` and `docs/providers/polar.md`. Fork PR #62's limits were added at `a067534`, checked against `packages/domain/src/server/billingPlans.ts`, `usage.ts`, `phoneNumbers.ts`, `storage.ts`, `knowledge.ts` and `onboarding.ts`, `packages/shared/src/billing.ts`, `billingProfile.test.ts` and `product-capabilities.ts`, `apps/admin/src/components/live-usage-surface.tsx`, `apps/worker/src/handlers.ts` and `brands/README.md`. Fork PRs #63 to #66 were added at `d800141`, checked against `brands/README.md`, `scripts/billing.ts`, `packages/domain/src/server/billingVerify.ts` and `billingPlans.ts`, `packages/cli/src/commands.ts`, `packages/shared/src/publicApi/operations.ts` and `schemas.ts`, `.env.example`, `docker-compose.yml`, `.railway/railway.ts` and `docs/providers/polar.md`. Fork PR #67's corrections were added at `40435d2`, checked against `scripts/billing.ts`, `packages/providers/src/polar/polarCatalog.ts`, `packages/domain/src/server/billingCatalog.ts`, `billingPlans.ts` and `billingPolar.ts`, `packages/shared/src/billingProfile.ts`, `brands/README.md` and `docs/providers/polar.md`. Fork PRs #68 and #69 were added at `91d5c3a`, checked against `packages/domain/src/server/usage.ts`, `billing.ts`, `billingPolar.ts` and `billingVerify.ts`, `packages/providers/src/polar/polarCatalog.ts`, `scripts/billing.ts`, `.env.example`, `brands/README.md`, `docs/providers/polar.md` and `mintlify/billing/usage.mdx`. Fork PR #70 was added at `fa0aa11`, checked against `packages/db/migrations/0113_billing_code_redemptions.sql`, `packages/db/src/cli.ts`, `packages/domain/src/server/billing.ts`, `billingCodes.ts` and `publicApi/operations.ts`, `apps/admin/src/lib/promo-code-limit.ts` and `public-api/routes.ts`, `packages/shared/src/billingProfile.ts`, `brands/README.md` and `mintlify/billing/plans.mdx`. Fork PR #72 was added at `cc0c65d`, checked against `apps/worker/src/handlers.ts`, `packages/providers/src/polar/polarBilling.ts`, `apps/admin/src/components/billing-email-form.tsx`, `live-upgrade-plan-provider.tsx`, `onboarding-plan-surface.tsx` and `promo-code-entry.tsx`, `apps/admin/app/api/billing/checkout/route.ts`, `apps/admin/public/locales/en/settings.json`, `packages/shared/src/publicApi/schemas.ts` and `operations.ts`, `packages/domain/src/server/billing.ts`, `packages/db/migrations/0115_billing_email.sql`, `.env.example`, `brands/README.md`, `docs/providers/polar.md` and the pull request's notes. Fork PR #73 was added at `35af54b`, checked against `packages/domain/src/server/billingPolar.ts` and `billingVerify.ts`, `packages/providers/src/polar/polarCatalog.ts` and `polarBilling.ts`, `packages/shared/src/billing.ts` and `brands/schema.ts`, `scripts/billing.ts`, `brands/README.md`, `docs/providers/polar.md` and the pull request's notes. Fork PR #74 was added at `7d20322`, checked against `apps/admin/src/lib/billing-limit.ts`, `fixed-window-limit.ts`, `promo-code-limit.ts` and `public-api/routes.ts`, `apps/admin/app/api/billing/checkout/route.ts` and `portal/route.ts`, `packages/domain/src/server/billing.ts` and `billingVerify.ts`, `packages/providers/src/polar/polarCatalog.ts`, `apps/worker/src/index.ts` and `handlers.ts`, `docker-compose.yml`, `.env.example`, `brands/README.md`, `docs/providers/polar.md` and the pull request's notes. Fork PR #75 was added at `24e211d`, checked against `packages/domain/src/server/billing.ts`, `billingCodes.ts`, `billingSweep.ts` and `usage.ts`, `packages/db/migrations/0116_billing_edges.sql`, `apps/worker/src/handlers.ts`, `apps/admin/src/components/live-upgrade-plan-provider.tsx` and `promo-code-entry.tsx`, `apps/admin/public/locales/en/settings.json`, `brands/README.md`, `docs/providers/polar.md` and the pull request's notes, and [3.7](#37-optional-services)'s line numbers are from that commit. The note on changing a paid plan's terms was added on 2026-10-24 from the billing pass of 2026-10-23, checked at `24e211d` against `brands/README.md` and `packages/domain/src/server/billingCatalog.ts`. The brand ([3.6](#36-your-brand)) was updated on 2026-10-27 for fork PR #87, checked against `packages/shared/src/brands/resolve.ts`, `brands/README.md` and `docs/branding.md`. The plans shown before the first `apply` ("[Selling plans](#selling-plans-polar)", step 7) were updated the same day for fork PR #88, checked against `packages/domain/src/server/billingPlans.ts`, `packages/shared/src/brands/schema.ts`, `apps/admin/src/components/onboarding-plan-surface.tsx`, `packages/db/migrations/0112_number_claims_by_allowance.sql` and `brands/README.md`, and their line numbers are from that pull request.
