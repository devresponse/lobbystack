# Part 6. First run on a new instance

**Status:** written on 2026-10-19 from the code on `main` at `d18f916`; [6.4](#64-get-a-phone-number-and-make-the-first-calls)'s test call length was updated on 2026-10-20 for fork PR #54 (`9b66d01`). The onboarding steps were tried on a computer on 2026-10-18 ([2.6](part-2-local-development.md#26-sign-in-for-the-first-time-and-create-a-test-business)); nothing else in this part has been run on a deployed instance yet.

This part takes a new instance from an empty dashboard to a business whose receptionist answers calls and chats, books appointments and takes messages. Do it on the test environment first ([Part 4](part-4-test-environment.md)), then on production ([Part 5](part-5-production.md)).

**Before you start**

- Sign up before you give the address to anyone. The first person to sign up chooses the instance's name and logo ([6.2](#62-the-brand-step)), and there's no administrator account: everyone who signs up is equal.
- Have ready the email inbox you'll sign up with, a computer with a microphone and a wide browser window (the **Test Call** button is hidden in narrow windows), and a phone for test calls and texts.
- Get email working first ([3.4](part-3-outside-services.md#34-email)). Without it you can still get in ([6.1](#61-create-your-account)), but no invitation, reset code or alert reaches anyone.

## 6.1 Create your account

1. Open `https://<your address>/en/signup`. For French, Spanish or Serbian, put `fr`, `es` or `sr` in place of `en`. Emails to you then use that language, and so does the dashboard in this browser.
2. Type your email and a password. The rules under the password tick as you meet them: at least 8 characters, a number and a special character. **Create account** stays greyed out until all three are met. Sign-in has no second step, such as a code from an app, so use a long password from a password manager.
3. Below the form, the security check (Turnstile, [3.5](part-3-outside-services.md#35-cloudflare-turnstile)) usually passes on its own. If you click too soon, the page says "Complete the security check and try again." and goes on by itself once the check passes.
4. "Verify your email" asks for the 6-digit code sent from your `EMAIL_FROM` address ([3.4](part-3-outside-services.md#34-email)). Type it and click **Verify email**. Onboarding starts ([6.2](#62-the-brand-step) and [6.3](#63-set-up-the-first-business)).
   - A code works for 10 minutes, and 3 wrong tries use it up. Each address gets at most 1 code a minute and 3 in a clock hour, the first one included, so **Send a new code** works twice more in that hour ([8.3](part-8-troubleshooting.md#83-sign-up-sign-in-and-email-codes)).

**If it doesn't work**

| What you see | What to check |
| --- | --- |
| "We couldn't create your account. Please try again." | The Turnstile keys and the widget's host names ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)). The page shows this message whatever went wrong. Sign-up also allows only 3 tries a minute |
| No email arrives | Your spam folder, then the worker's log, which says why ([3.4](part-3-outside-services.md#34-email)). On Railway, the project must be on Pro. Meanwhile, open `https://<your address>/en/login` and sign in with the same email and password: this works while `REQUIRE_EMAIL_VERIFICATION` isn't `true` |

**About accounts**

- Your name in the dashboard is the part of your email before the `@`, and invitations you send show it. There's no field to change it.
- A sign-in lasts 30 days. **Forgot password?** on the sign-in page emails a 6-digit reset code, and a reset signs you out everywhere.
- Your account settings are in the menu at the bottom of the sidebar: click your name, then **Account**. There you change your email (the confirmation link goes to your current address first, then to the new one) and your password (which signs out your other sessions). The dashboard's language is in **Settings** > **Preferences** > **Dashboard language**.
- Nothing deletes an account or a business: not the dashboard, the API or the command line ([Appendix E](appendix-e-doc-problems.md)).

**Require the email code on production**

By default, someone who skips the code can still sign in and use their business; only accepting an invitation needs the code ([6.6](#66-invite-the-team)). Once email works, set `REQUIRE_EMAIL_VERIFICATION=true` on the admin and deploy. An account that never entered its code must then enter one before it can sign in; accounts that did sign in as before. Don't turn it on while email isn't working: those accounts, and every new one, would be locked out.

**Who else can sign up**

Anyone who can open your address can create an account. Nothing turns sign-up off or limits it to some emails ([Appendix E](appendix-e-doc-problems.md)), and the address can't stay secret, because the public pages and the website chat use it. Each account can own up to 10 businesses. What a stranger's business gets depends on whether your instance sells plans ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)):

- **It doesn't sell plans:** the business has no limits. It runs on your OpenAI key, and it can buy a phone number on your Twilio account: one per business, and at most 2 a day and 5 in 30 days per person.
- **It sells plans:** the business starts on the Free plan, with 30 minutes of browser calls and no phone number until it pays.

Row-level security keeps each business's data apart, so a stranger never sees yours. On an instance that doesn't sell plans, look at your Twilio console's active numbers now and then: each number LobbyStack buys is named `LobbyStack <business ID>`, and your own business's ID is in **Settings** > **API keys** > **Business ID**. [7.20](part-7-operations.md#720-decide-who-can-sign-up) covers what to do about a business you don't know.

## 6.2 The brand step

"Make this app your own" is the first onboarding page only when all of these are true:

- No brand matches your address, and `BRAND_PRESET` isn't set ([3.6](part-3-outside-services.md#36-your-brand)).
- You have no business yet.
- Nobody has chosen yet, and you own every business on the instance. On a new instance, that's the first person to get here.
- migrate set up the database as its main user, as in Parts 4 and 5. Otherwise the step never appears, and no message says why.

**Decide before you click.** The name and logo are chosen once, for the whole instance: the sign-in pages, the dashboard, the browser tab and the name emails come from. No setting changes them later, and **Skip and keep LobbyStack** also ends the choice for good. The only way back is a database command, in `docs/branding.md` ("Change the branding later").

1. **App name:** up to 40 characters.
2. **Logo:** click **Choose a logo** and pick a square PNG, JPEG, WebP or SVG of 256 KB or less. It also becomes the icon on the browser tab. Check the **Preview**.
3. Click **Continue**, or **Skip and keep LobbyStack**.

Some things stay LobbyStack's whatever you choose here, such as the replies to HELP texts and the links to a website, terms and privacy policy ([3.6](part-3-outside-services.md#36-your-brand)).

## 6.3 Set up the first business

**Onboarding**

A bar at the top shows 8 steps. If you stop partway, signing in again brings you back to the same step, and you can click an earlier step to change it.

1. "First, what is the name of your business?" Type the name callers know, and click **Continue**.
   - The business takes your browser's time zone at this moment, or UTC if the browser gives none. Setting up a business in another time zone? Fix it afterwards in **AI settings** (step 3 of the next list).
2. "Now let's train <app name> on your website". Type the business's website and click **Continue**, or click **I don't have a website**.
   - Reading a website needs `FIRECRAWL_API_KEY` on the worker ([3.7](part-3-outside-services.md#37-optional-services)). It reads 10 pages now, and the rest later from **Getting started**. Without the key, the step still takes the address and later says "We couldn't read <site>". Nothing is broken: add the details by hand instead.
3. "Add training documents". Under **Upload files**, add PDF, DOCX, TXT or Markdown files of up to 10 MB each. Or, under **Paste text**, paste what callers ask about: services, prices, policies and frequent questions. Or click **Skip for now** and add them later in **Knowledge**.
4. "How should we greet your callers?" The greeting is the first thing every caller hears, and it starts as "Thanks for calling <business name>." Change it if you like, and click **Continue**.
   - Nothing else tells callers that they're talking to an AI, or that every call is recorded ([6.4](#64-get-a-phone-number-and-make-the-first-calls)). The law where the business operates may require saying both, and LobbyStack's own terms leave that to the business. A greeting such as "Thanks for calling Bar George. I'm the AI receptionist, and this call is recorded. How can I help?" says both.
   - This step also sets the language calls open in: French if your dashboard is in French, English otherwise. Change it later in **AI settings** > **Default customer language**. The receptionist switches when a caller asks, or clearly speaks another language, and keeps answering in it for the rest of the call.
5. "Choose your plan".
   - **On an instance that doesn't sell plans,** click **Start free**. The page shows the hosted service's plans and prices whatever your instance does: ignore them. Your business has no limits and can get a phone number, and **Settings** > **Plan** shows it as "Self-host". **Starter** and **Pro** stay greyed out.
   - **On an instance that sells plans,** **Start free** gives the Free plan: 30 minutes of browser calls and no phone number. **Starter** or **Pro** opens Polar's checkout ([3.7](part-3-outside-services.md#37-optional-services); use Polar's sandbox for tests). After you pay, "Pick your AI's phone number" follows: pick one as in [6.4](#64-get-a-phone-number-and-make-the-first-calls), or click **I'll add a number later**.
6. "How did you hear about <app name>?" Click **Skip** or **Finish**, and the dashboard opens.

**Make the receptionist useful**

The receptionist can already answer from what it read, and take messages. To book, it needs steps 1 and 2 below. Each field saves on its own: there's no **Save** button for the whole page. A change reaches the next call and the next chat message a few seconds later, once the worker has refreshed what the receptionist knows. A call in progress keeps what it started with.

1. **Opening hours.** Open **AI settings** (under **Agent** in the sidebar), go to **Opening hours** and click **Edit**. Turn on each open day, set its hours, and click **Save hours**. A day can have up to 4 time ranges, to leave out a lunch break for example.
   - Without opening hours, the receptionist books nothing: it takes each request as a message instead.
   - If it read a website or documents, AI may fill in the hours a few minutes later, marked "We filled these in from your website and documents. Check them." AI never replaces hours you saved.
   - Holidays and other closed days can't be entered anywhere ([Appendix E](appendix-e-doc-problems.md)). Add a rule that names them (step 5), and check the appointments booked for those days.
2. **Services.** Open **Services** (under **Agent**) and click **Add Service**. Fill in the **Title**, the **Duration** in minutes, and under **Content** what callers should know, such as the price and what's included. Leave **Bookable** on.
   - The receptionist offers only bookable services, and doesn't even know about the others. There's no price field: put prices in **Content**.
   - It offers start times every 30 minutes inside the opening hours, and two appointments can't overlap.
3. **AI settings.** Check each of these:
   - **Business timezone**, used for the opening hours and the times offered.
   - **Default customer language**, and the **Greeting** (the pencil button).
   - **Business summary**, the receptionist's description of the business. AI writes it from the website and documents a few minutes after they're read, and **Rewrite with AI** writes it again.
   - **Default transfer number**: a phone caller who asks for a person is transferred to it. Without it, the receptionist takes a message. Browser calls and chats can't be transferred.
   - **Appointments**: with **Books appointments** (the default), the receptionist checks your open times and books. With **Takes requests**, it notes the service and preferred time, and you confirm from the inbox. With **Doesn't book**, it takes a message.
   - **Appointment changes**: **Allow AI cancellations** and **Allow AI rescheduling** let callers change a booking. **Caller verification** sets how they prove it's theirs: the number and booking details, a code texted to them, or a keypad PIN saved on their contact. With **Your team makes changes**, the receptionist passes every change to you.
4. **Knowledge.** In **Knowledge** (under **Agent**), **Add Knowledge** adds a document (**Upload**), a website of up to 50 pages (**Website**) or a note (**Text**). Each one shows "Queued", then "Indexing", then "Ready".
5. **Rules.** In **Rules** (under **Agent**), **Add Rule** gives the receptionist an instruction in plain words, such as what to say after hours, or which questions to pass to you. There's no other box for instructions.
6. **Business details.** The name is in **Settings** > **Team** > **Business name** > **Change**. A new name doesn't change the greeting, so edit that too. The address and email in **Settings** > **Public profile** appear only on the public page ([6.5](#65-put-the-chat-on-your-website)); add them to **Knowledge** as well if callers ask for them.
7. **Alerts.** In **Settings** > **Notifications**, every member gets an email by default when the receptionist takes a message, when a text arrives, and when something fails, such as a transfer or the calendar sync. No alert goes out for each call or booking: those show on **Home** and in **Calls**. Alerts by text need each person to verify their mobile on this page, and a number to send from: the business's own number on an instance that doesn't sell plans, once its texting registration is approved ([3.3](part-3-outside-services.md#33-twilio)), or `TWILIO_ALERT_SMS_FROM` on one that does. Alerts for website chats are set in **Settings** > **Website widget** ([6.5](#65-put-the-chat-on-your-website)).
8. **Google Calendar** (optional). Click **Integrations** > **Connect Google** ([3.7](part-3-outside-services.md#37-optional-services)). Booking works without it. Once it's connected, choose the calendar, and booked appointments appear in it. Whenever the chosen calendar isn't in sync (until its first sync, after a failure, or 20 minutes after its last one), the receptionist books nothing and takes a message instead ([8.9](part-8-troubleshooting.md#89-google-calendar)).

**Getting started**

The **Getting started** card at the bottom of the sidebar opens a checklist of four steps: **Read the rest of your site** (up to 50 pages), **Add more sources** (only an uploaded document counts), **Hear your agent** (a test call, [6.4](#64-get-a-phone-number-and-make-the-first-calls)) and **Connect a phone number**. Each step has **Skip**.

- On an instance that doesn't sell plans, the last step's **Choose a number** opens the plan picker by mistake ([Appendix E](appendix-e-doc-problems.md)). Use **Settings** > **Phone Number** instead ([6.4](#64-get-a-phone-number-and-make-the-first-calls)).

**What the receptionist needs**

| To | It needs |
| --- | --- |
| Answer questions | What it read during onboarding, and the knowledge you add |
| Take a message | Nothing more. Messages land in **Messages**, and members get the "Voice message captured" alert |
| Book an appointment | **Books appointments**, a bookable service and opening hours. It also asks for the caller's name, and on chat a phone number; on a phone call, the caller's own number counts |

## 6.4 Get a phone number and make the first calls

**First, a call from the browser**

1. Click **Test Call** at the top right of the dashboard, or **Getting started** > **Hear your agent** > **Start a call**. Only owners and admins can.
2. Allow the microphone when the browser asks. The screen says "Connecting to your AI receptionist", then "Live with your AI receptionist", and you hear the greeting.
3. Ask about your hours and a service, then book a test appointment. Click **Hang up** when you're done. A test call stops after 30 minutes, or after 5 on a copy older than `9b66d01`.
4. The call is listed in **Calls**, with its transcript.

If there's no **Test Call** button, widen the window. If the call doesn't start, check `LIVE_PROTOTYPE_ENABLED=true` and `OPENAI_API_KEY` on the admin and the worker, and open the dashboard at exactly the address in `APP_BASE_URL`: the call is refused from any other address. [8.6](part-8-troubleshooting.md#86-calls-from-the-browser) lists what each message means.

**Get a number**

This needs Twilio set up, with credit and the SIP trunk ([3.3](part-3-outside-services.md#33-twilio)). On an instance that sells plans, the business must be on Starter or Pro first.

1. Open **Settings** > **Phone Number** and click **Get number**. Only owners and admins have the button.
2. The list already shows numbers for the country of the business's time zone. To choose another, pick the **Country**, type an **Area code** (US and Canada only) and click **Search**. **Load more** shows more numbers.
   - Choose a US or Canadian number. UK and Australian numbers need paperwork LobbyStack doesn't send, so buying one will probably fail ([3.3](part-3-outside-services.md#33-twilio)).
   - The dashboard offers local numbers only, and shows no prices. Twilio charges its monthly fee from the day of purchase: $1.15 a month for a US or Canadian local number ([3.3](part-3-outside-services.md#33-twilio)).
3. Click **Select** next to a number. It spins for up to 2 minutes while the worker buys the number, adds it to the SIP trunk and points its texts at your address.
4. "Phone number added." appears, and the page shows your number.

- Each business has one number. **Request change** swaps it once: the old number keeps working for 30 days, then it's released.
- Each person can get 2 numbers a day and 5 in 30 days, over all their businesses.
- There's no button to give a number back. Release it with the command line ([6.7](#67-optional-the-api-and-the-command-line)).

**If it fails**

| What you see | What it means |
| --- | --- |
| A reason, such as "Phone numbers are available in the US, Canada, the UK and Australia." | LobbyStack refused the request, for the reason given |
| A message that ends with "Error ID:" and an ID | Something failed on the admin. Its log has the same ID, on a line that starts with `[admin] exception:` ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)) |
| "We couldn't get that number. Please try again." | The purchase failed on the worker, which doesn't pass the reason on. Its log has a `job.failed` line for `phoneNumber.provision` that says why, such as a missing `TWILIO_SIP_TRUNK_SID`. The page also shows this when it stops waiting after 2 minutes, so reload it before you try again: the number may have arrived late |
| "That number was just taken. Pick another one from the refreshed list." | Someone else bought it first. Pick another |

**Then a phone call**

1. Call the number from your own phone. It rings until the receptionist picks up, then you hear the greeting.
2. Ask your questions, book a test appointment, and ask for a person if you saved a transfer number.
3. Hang up. In **Calls**, the call shows its transcript, a one-line summary and, once it's processed, the recording. Your phone number is now a contact.
   - No recording? OpenAI's project may need its session storage switched on ([3.2](part-3-outside-services.md#32-openai)).
   - It rang with no answer? Check `OPENAI_WEBHOOK_SECRET`, and whether OpenAI's webhook page shows a delivery ([3.2](part-3-outside-services.md#32-openai), "Phone calls (SIP)").

About calls:

- Every call is recorded, by phone and in the browser, and no setting stops it. LobbyStack keeps recordings and transcripts for 90 days, or 30 days on the Free plan. OpenAI keeps its own copy for 30 days.
- A call ends after 30 minutes, or after 75 seconds of silence.
- There's no voicemail: the receptionist takes a message instead.

**Then a text**

1. Text the number from your phone. The text appears in **Messages**, your number becomes a contact, and members get the "New text message" alert.
2. The receptionist doesn't answer texts: you do. Open the conversation, type in the box that says "Reply via SMS...", and click **Send**. The reply shows "Sent", then "Delivered".
   - Texts to US phones are delivered only once the number's texting registration is approved ([3.3](part-3-outside-services.md#33-twilio), step 14). Until then, a reply probably shows "Not delivered".
   - HELP and START get an automatic reply. STOP stops the business's texts to that phone, and LobbyStack doesn't reply to it.

**Texts to callers**

After a booking on a phone call, the receptionist asks whether it may text a confirmation and a reminder. If the caller agrees, they get a confirmation right after the call, a reminder 24 hours before when the booking is more than a day ahead, and a text if it's canceled. Bookings by chat or browser call get no texts, and no customer gets an email. The texts come from the business's own number on an instance that doesn't sell plans, so they too wait for the texting registration, or from `TWILIO_ALERT_SMS_FROM` on one that does.

**Keep the business's current number**

Callers can keep dialing the number they know: ask the business's phone company to forward calls to the new number, and forwarded calls reach the receptionist. Forwarding doesn't carry texts, so those still go to the old number. LobbyStack can't take over (port) an existing number.

## 6.5 Put the chat on your website

The website widget adds the receptionist's chat to any website, with a button to talk to it. The business's public page shows the same chat at your own address.

1. Open **Settings** > **Website widget**. If it says "New website widgets are not available yet", set `WIDGET_KEY_ISSUANCE_ENABLED=true` on the admin and deploy.
2. Give the key a **Label**. Under **Allowed origins**, enter each website address the chat will be on, such as `https://www.example.com`. You can also change the **Title**, the **Greeting**, the **Accent color** and the **Position**.
   - **Ask visitors for their contact details** asks for an email or a phone number, before the chat or during it.
   - **Let visitors chat with your team**: during opening hours, a visitor who asks for a person gets someone from your team, who replies from **Messages**. If nobody replies within 3 minutes, the receptionist offers to take a message.
3. Click **Create widget key**, then **Copy embed snippet**. Paste the snippet into the HTML of every page that should show the chat, or into your site builder's custom code setting. It starts with `<script src="https://<your address>/embed.js?key=wk_live_`.
4. Open your website and ask the chat a question. The button to talk, **Say Allo!**, appears once the business has a phone number ([6.4](#64-get-a-phone-number-and-make-the-first-calls)), on an instance where calls from the browser work ([8.6](part-8-troubleshooting.md#86-calls-from-the-browser)).

The alerts for website chats, "New website chat message" and "Visitor asking for a person", are on this page too, not in **Notifications**.

**The public page**

1. Open **Settings** > **Public profile**. Fill in the **Details** (**Category**, **Description**, **Public email** and **Address**), choose what the page shows (phone number, opening hours, services and map), and under **Chat**, pick the widget.
2. Turn on **Published** and click **Save**. Until it's published, nobody outside your team can open the page.
3. **Open page** shows it, at `https://<your address>/profile/<a short form of the business name>`. **Copy link** copies the address.
4. **Settings** > **QR code** prints signs that open the page.

## 6.6 Invite the team

1. Open **Settings** > **Team** and click **Invite**. Only owners and admins have the button.
2. Type one email address, and choose **Admin** or **Viewer**. An admin manages the team, the settings, the plan and the integrations. A viewer sees calls, contacts and activity, and changes nothing. Click **Send invitation**.
3. The person gets an email with a link that works for 7 days. They click **Create account to accept**, or **Sign in to accept** if they already have an account, enter the email code, and click **Accept invitation**.
   - They must use the address you invited, and enter its code, even when sign-in doesn't ask for the code ([6.1](#61-create-your-account)).

- Without working email, nothing is sent, but the page still says "Invitation sent to" the address ([Appendix E](appendix-e-doc-problems.md)).
- There's no **Resend**. To send an invitation again, choose **Cancel invite** in the row's menu (the three dots), then invite again. **Remove**, in the same menu, takes someone off the team and revokes the API keys they made. Both act at once, without asking you to confirm, and [7.19](part-7-operations.md#719-manage-operators-api-keys-and-platform-keys) says what **Remove** leaves running.
- Owners show as "Admin". The dashboard can't change a role or hand the business to someone else, but the command line can ([6.7](#67-optional-the-api-and-the-command-line)). It also offers a third role, scheduler, for someone who books appointments and handles conversations but changes no settings.
- To work on another business, click the business's name at the top of the sidebar. The list shows your businesses, and **Create Business** runs onboarding for a new one. An account can own up to 10.

## 6.7 Optional: the API and the command line

This is for anyone comfortable with a terminal. The `lobbystack` command works through the API, from any computer with the copy of the code from [Part 2](part-2-local-development.md): run it from that folder as `pnpm lobbystack`. It isn't published as a package. The full reference is `mintlify/api/cli.mdx`.

**A key for one business**

1. In **Settings** > **API keys**, click **Create API key**. Name the key, and under **Access** tick only what it needs. Five read-only boxes start ticked. To release a number, also tick "Find, buy, replace and release phone numbers". To manage the team, tick "Invite and remove team members, change roles and hand the business over".
2. Click **Create key**, and copy the key into your password manager: "You won't see this key again."
3. Sign the command in with it:

   ```sh
   pnpm lobbystack login --url https://<your address> --key-stdin
   ```

   Paste the key, press Enter, then press Ctrl+D. (`--key <the key>` works too, but leaves the key in the terminal's history.) The address must start with `https://`.
4. Commands then act on that business:

| To | Run |
| --- | --- |
| See the number and its ID | `pnpm lobbystack numbers list` |
| Release a number, for good | `pnpm lobbystack numbers release <number ID>` |
| See the team, with each member's ID | `pnpm lobbystack team list` |
| Change someone's role | `pnpm lobbystack team role <member ID> viewer`, or `business_admin` or `scheduler` in place of `viewer` |
| Hand the business to someone | `pnpm lobbystack team transfer-owner <their email>` |

- A released number stops reaching the receptionist within moments, and goes back to Twilio straight away. If Twilio's side fails, it shows as `active` again, and the worker tries again every hour ([7.21](part-7-operations.md#721-buy-change-and-release-numbers)).
- A business key stops working when you click **Revoke**, when the person who made it leaves the team or drops below Admin, when the business is handed over, and if `ENCRYPTION_KEY` ever changes.

**A key for every business (platform key)**

A platform key isn't tied to one business. It can create businesses and accounts, and with `--access all`, it reaches every business on the instance. You make it on your computer, and it lives only in `PLATFORM_API_KEYS` on the admin.

1. Sign up with the email the key will act as, and enter its code ([6.1](#61-create-your-account)).
2. In the code folder, run:

   ```sh
   pnpm platform-key:create --name "Operator key" --partner operator --owner-email <your email> --access all
   ```

   Without `--access all`, the key reaches only the businesses created with keys of the same partner.
3. It saves the key in `.platform-keys/<prefix>.json` and prints a new value for `PLATFORM_API_KEYS`. Set that value on the admin and deploy.
   - If the admin already has platform keys, the new value must include them. The command adds the new key only to what's in `PLATFORM_API_KEYS` in your terminal, so run it as `PLATFORM_API_KEYS='<the value now on the admin>' pnpm platform-key:create ...`. Otherwise the old keys stop working.
   - A mistake in the value stops every platform key.
4. Move the key into your password manager, and delete the file.
5. Sign the command in with this key, as above. Pick a business with `pnpm lobbystack business use <ID>`, or add `--business <ID>` to a command. `pnpm lobbystack business list` lists only the businesses this key's partner set up, even with `--access all`. For any other business you need its ID: the **Business ID** in **Settings** > **API keys** for one you belong to, or the name of its number in Twilio ([6.1](#61-create-your-account)) for one you don't.

To revoke a platform key, delete its entry from `PLATFORM_API_KEYS` and deploy.

**Set up a business from a file**

`lobbystack onboard` sets up a business from one file, called a manifest: its details and hours, the greeting and other receptionist settings, services, rules, knowledge, the public page and, if you ask, a phone number. Only the name and the time zone are required:

```yaml
business:
  name: Acme Plumbing
  timezone: America/Toronto
```

Run `pnpm lobbystack onboard acme.yaml --plan` to see what it would do, then run it again without `--plan`. It asks before buying a number, because a number costs money. `mintlify/api/cli.mdx` shows a full manifest.

- With a platform key, it creates the business. With an `owner` email in the file, that person gets a link to claim it.
- With a business key, it fills in that key's own business.
- On an instance that doesn't sell plans, it skips any plan in the file.
- A key made without `--access all` can't include a plan or a phone number.

**Not yet confirmed:**

- Whether the brand step appears on Railway. It should, because migrate signs in as the database's main user ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database)).
- How long a number takes to buy, and how a reply to a US phone shows before the texting registration is approved.
- Whether Twilio itself replies to STOP.
- What the plan picker shows on an instance that doesn't sell plans when **Choose a number** opens it.
- Whether Ctrl+D ends the key in Git Bash on Windows.
- Which message a refused test call shows for each cause.
- How long documents and websites take to read.

**Checked against:** `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/turnstile.ts`, `apps/admin/src/lib/email-verification-policy.ts`, `apps/admin/src/lib/onboarding-branding.ts`, `apps/admin/src/lib/live-web-call.ts`, the onboarding, setup guide, hours, services, team, invitation, phone number, widget and API key components in `apps/admin/src/components/`, `apps/admin/app/api/billing/route.ts`, `packages/db/migrations/0084_number_claim_in_progress.sql` and `0098_deployment_branding.sql`, `packages/domain/src/server/` (`tenancy.ts`, `onboarding.ts`, `usage.ts`, `knowledge.ts`, `booking.ts`, `receptionistActions.ts`, `notifications.ts`, `smsSender.ts`, `sms.ts`, `phoneNumbers.ts`, `publicProfiles.ts`, `publicApi/platformKeys.ts`), `packages/shared/src/billing.ts`, `packages/agent-core/src/tools.ts`, `packages/agent-core/src/instructions.ts`, `packages/agent-core/src/live/session.ts`, `apps/worker/src/handlers.ts`, `scripts/platform-key.ts`, `packages/cli/src/` (`account.ts`, `commands.ts`, `config.ts`, `manifest.ts`, `onboard.ts`), `mintlify/api/cli.mdx`, `docs/branding.md`, `docs/voice/runtime.md`, and the dashboard's English labels in `apps/admin/public/locales/en/`.
