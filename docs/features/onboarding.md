# Set up a business in onboarding

Onboarding takes a new account from sign-up to the dashboard: the business's name, the plan, its website, its first documents, the greeting callers hear, a phone number, and how the owner heard about the app. Since fork PR #224 the plan comes right after the name, so the kind of account is chosen before anything else about the business, and a deployment that takes no payments has no plan step ([below](#choose-the-plan-right-after-the-name)). Since fork PR #127 the website step only saves the address the owner types and reads nothing, so onboarding never starts the crawler: the maintainer asked for that, and may offer reading the website during onboarding again later as an option ([roadmap](../roadmap/onboarding-website-option.md)). The crawler itself is unchanged, and the Knowledge page, the API, the `lobbystack` command and demos still use it. Checked against the code of fork PR #128, and the order of the steps against fork PR #224's.

## Know the steps

The bar under each step shows eight dots on a deployment that takes payments: the first is sign-up, and each of the others is a step. A deployment that takes none has no plan step, so it shows seven, and the dot in brackets is the step's there. Signing in again opens the step the business is on, and a dot before it opens that step again to change it.

| Dot | Step | Address | Stage | Notes |
| --- | --- | --- | --- | --- |
| 1 | Sign up and verify the email | `/signup` | None yet | Draws eight dots on every deployment ([below](#know-which-deployments-have-the-plan-step)) |
| 2 | **Make this app your own** | `/onboarding/brand` | None yet | Only for the first account on an instance with no brand of its own ([guide 6.2](../deployment/guide/part-6-first-run.md#62-the-brand-step)) |
| 2 | The business's name | `/onboarding/business` | `create_business` | Creates the business, which starts on `plan`, or on `website` where there is no plan step. A claimed demo starts here with its business already made, and goes on the same way. An account that owns as many businesses as its plans allow is told so here, and that a higher plan on one of them allows more when one does, and can't create another ([businesses per account](multitenancy.md#limit-how-many-businesses-an-account-owns)) |
| 3 | The plan | `/onboarding/plan` | `plan` | Only on a deployment that takes payments. **Start free**, a paid plan once its payment arrives, and a prepaid pack where packs are on sale ([below](#buy-a-prepaid-plan-on-the-plan-step)) all go on to dot 4 |
| 4 (3) | "What is your business's website?" | `/onboarding/website` | `website` | **Continue** saves the address; **I don't have a website** skips. Neither reads the site ([below](#know-what-the-website-step-saves)) |
| 5 (4) | **Add training documents** | `/onboarding/knowledge` | `knowledge` | Upload files or paste text, or **Skip for now** |
| 6 (5) | The greeting | `/onboarding/greeting` | `greeting` | Also sets the language calls open in. **Continue** goes on to dot 7 for a paid plan or a pack that includes a number, and to dot 8 for any other plan, such as Free |
| 7 (6) | The phone number | `/onboarding/number` | `phone_number`, `phone_number_claiming` | A business stored here on a plan without a number, such as Free, is sent back to dot 3, or stays here, where the step can be skipped, on a deployment without a plan step |
| 8 (7) | How you heard about the app | `/onboarding/attribution` | `attribution` | Then the dashboard opens, at stage `complete` |

The stage is `businesses.onboarding_stage`. A step moves it with `POST /api/onboarding/stage`, which accepts only the next stage, so no step can be skipped, and only an owner or an admin can move it (`packages/domain/src/server/onboarding.ts`). The route answers `{ "ok": true, "stage": "<stage>" }` with the step to open next, since the server picks it where two could follow ([below](#let-the-server-pick-the-next-step)). The v1 API and the `lobbystack` command show the same stage ([integrations](api-cli-integrations.md)). The [route catalog](../reference/routes.md#4-onboarding-pages) has each address and what it checks. The [deployment guide](../deployment/guide/part-6-first-run.md#63-set-up-the-first-business) walks through the steps as an owner sees them.

A business stored on `verify_phone` or `verify_phone_code`, steps removed before the fork with personal phone verification, resumes on `plan` (`normalizeOnboardingStage`), which is now the step after the name.

## Choose the plan right after the name

Until fork PR #224 the plan was the sixth dot, after the greeting, so a new owner typed the business's website, documents and greeting before learning what the account costs. The maintainer asked on 2026-11-21 for the kind of account to be picked up front. Of the two orders looked at, the plan before the name and the plan after it, the maintainer chose **name first, then plan**: a plan, its billing account and its payment all belong to a business, so the business is made first, from its name alone, and nothing else is asked before the plan.

- **Paying happens on the plan step,** right after the name. A plan with a price opens the provider's payment page; after paying, the owner comes back to `/onboarding/plan?checkout=success&requestId=<id>`, the step waits for the payment, and the website step opens.
- **Leaving the payment page without paying** brings the owner back to the plan cards, to try again or to pick Free. Nothing is charged and the business stays on the plan step.
- **Promo codes** are entered on the plan step, under **Have a promo code?**, as before. A code that came with a sign-up link is filled in and checked when the step opens, which is now right after the name.
- **A claimed demo** keeps the same order: the name step shows the demo's name to keep or change, then the plan step opens.
- **The product events are the same** (`web.onboarding.plan_selected`, `web.onboarding.plan_checkout_started`, `web.onboarding.plan_checkout_completed`), but they now come before the website's, so a funnel built on the old order needs its steps moved.

### Know which deployments have the plan step

`onboardingHasPlanStep()` (`packages/domain/src/server/onboarding.ts`) says whether the deployment takes payments from the businesses it makes: it isn't a self-hosted server (`DEPLOYMENT_MODE` isn't `self_hosted_standard`), and its billing provider is set up (`billingProviderConfigured` in `packages/domain/src/server/billingPlans.ts`: `POLAR_ACCESS_TOKEN` and `POLAR_ORGANIZATION_ID`, or with `BILLING_PROVIDER=stripe`, `STRIPE_API_KEY` and `STRIPE_ACCOUNT_ID`, [billing](../billing/README.md)). The admin reads its own settings on each request, so nothing is built in and no migration is needed.

Where the answer is no, the step would offer only the plan the business already has: a self-hosted server's businesses get its unlimited plan, and a deployment with no provider sells nothing. So there:

- the name is followed by the website step, and the bar has seven dots;
- `/onboarding/plan` sends everyone to the step their business is on;
- a business stored on `plan`, left there by an earlier release or from before the deployment stopped taking payments, is on the website step, and the next move stores that (`currentOnboardingStage`).

The sign-up page is prerendered, before the server's settings can be read, so it draws eight dots on every deployment. On one without a plan step the count drops to seven from the name step on.

### Let the server pick the next step

Two steps have more than one step that can follow, and `advanceOnboardingStage` picks between them, whatever the screen asked for (`onboardingStepFor`). It returns the step to open, and `POST /api/onboarding/stage` answers with it, so a screen showing old data can't send a business the wrong way:

- **After the name:** the plan step where the deployment has one, else the website step.
- **After the greeting:** the number step only when the plan in force is Starter, Pro, Enterprise or a prepaid pack, and includes a number (`takesNumberStep`). Any other plan goes to the last step: Free includes no number, and a self-hosted business adds its number in **Settings**.

A request for a step the business already reached moves nothing and is answered with that step, so going back to an earlier form never takes progress back.

### Come back to the plan step

The third dot opens the plan step again from any later step. A business on Free sees the cards and can pay for a plan there; one that already has a paid plan or a pack sees that it does, with **Continue**. Leaving the step again depends on the stage the business is stored on (`leavePlanStep` in `apps/admin/src/components/onboarding-plan-surface.tsx`):

- **Stored on the plan step:** it moves on to the website step.
- **Stored on the website, documents or greeting step:** it returns to that step and nothing moves, so changing the plan repeats no step.
- **Stored on the number step or later:** it goes to the number step when the plan it has now includes a number to pick, else to the last step. A business sent back from the number step because Free includes no number comes this way: Free goes on to the last step, and a paid plan to the number step.

### Businesses made another way

A business made through the v1 API or the `lobbystack` command starts on `website`, as before: whoever made it sets its plan, so it has no plan step to pass. Its owner can still open the plan step from the third dot. `GET /business`, `GET /businesses` and `GET /onboarding` show the stage the dashboard shows, so a business stored on `plan` reads as `website` on a deployment without a plan step.

### Businesses that were part-way through

No stored stage was changed, so a business that was in onboarding when fork PR #224 reached its deployment goes on from where it was:

- **On the website, documents or greeting step:** it never passes the plan step. It finishes on the plan it has, Free for most, and goes from the greeting to the last step. Its owner can open the plan step from the third dot before finishing, or change the plan afterwards in **Settings > Plan**.
- **On the plan step,** having finished the greeting under the old order: it chooses a plan, then meets the website, documents and greeting steps again, each showing what was saved, and one **Continue** on each goes on.
- **On the number step or later:** nothing changes.

## Know what the website step saves

**Continue** sends the address to `POST /api/onboarding/website`, and `saveOnboardingWebsite` (`packages/domain/src/server/onboarding.ts`):

1. Checks the address as the crawler would (`normalizeWebsiteSourceUrl` in `packages/domain/src/server/knowledgeUrl.ts`): it adds `https://` when there's no scheme, and turns down anything but a public web address, such as `localhost`, an IP address or a `file:` link, with 422 `website_url_invalid`, which the step shows as "Enter your website address, like yourcompany.com."
2. Checks that the person is an owner or an admin of the business.
3. Saves the address as the business's website (`businesses.website_url`), which its public page links to ([public page](public-profile-and-qr.md)).
4. Moves a business on `website` to `knowledge`. A business already past the step keeps its stage, so going back to change the address loses no progress.

That is all it does. It adds no knowledge source, makes no website import and queues no crawl, so the receptionist knows nothing from the site until it's read, and the documents and greeting steps show no reading progress. To have the receptionist read the site, the owner adds it in **Knowledge** > **Add Knowledge** > **Website** once the dashboard opens.

**I don't have a website** moves the stage to `knowledge` with `POST /api/onboarding/stage` and saves nothing.

## Where websites are read

Reading a website needs `FIRECRAWL_API_KEY` on the worker ([guide 3.7](../deployment/guide/part-3-outside-services.md#website-import-firecrawl)). These read one:

| Where | Pages | Saves it as the business's website |
| --- | --- | --- |
| **Knowledge** > **Add Knowledge** > **Website** in the dashboard | Up to 50 | No |
| `POST /knowledge/sources` in the v1 API, and `knowledge.websites` in a `lobbystack onboard` manifest, which uses it | A sample of 10; `POST /knowledge/sources/{source_id}/expand`, or **Getting started**, reads the rest, up to 50 | Only for a business still on the website step, which it also moves on to the documents step |
| A demo made on the **Demos** page | The demo's website | Yes, on the demo's own business |
| `POST /api/knowledge` with `onboarding: true` | A sample of 10 | Yes |

Until fork PR #127 the website step sent `POST /api/knowledge` with `onboarding: true`, which read 10 pages right away. Nothing in the dashboard sends it now, but it stays for a later option to use, with the progress panel that the documents and greeting steps show while a website is being read (`apps/admin/src/components/website-import-progress.tsx`) ([roadmap](../roadmap/onboarding-website-option.md#know-what-it-could-reuse)).

AI still writes the business summary and fills in opening hours from what the receptionist knows. The worker queues both whenever a document, a website or a text entry finishes reading, or one is deleted, so files and text added in the documents step feed them, and so does a website once it's added in **Knowledge** (`enqueueKnowledgeDerivedRefresh` in `packages/domain/src/server/businessHours.ts`).

## Buy a prepaid plan on the plan step

A deployment that sells prepaid packs, plans paid once for a number of days ([prepaid packs](prepaid-packs.md#know-what-a-pack-is)), offers them on the plan step as cards drawn as the plans' are, part for part (`apps/admin/src/components/onboarding-plan-surface.tsx`): the pack's name, its price followed by its length, such as CA$99/180 days, where a plan's is followed by /mo, a line on what it is, its button, such as **Start for 180 days**, and what it includes for its whole length in a plan card's words. After the plans' cards they come under **Prepaid plans**, with a tab for each length, the shortest first, as the plans have Monthly and Annual, and no tabs when every pack lasts as long. Where the brand's `billing.json` gives packs cards of their own, as RealInfoBot's does, they sit among the plans' cards in its order instead, with its words, and the section doesn't show ([below](#word-the-plan-step-from-billingjson)). A deployment that sells no packs shows none of it, and neither does an operator-managed account or a plan the packs aren't sold with, so for them the step looks as it did before packs. A pack that can't be bought right now shows with its button turned off and the reason under it.

- A pack card's button asks for a checkout with `POST /api/billing/packs/checkout`, follows it with `GET /api/billing/packs/checkout` and opens the payment page once it's ready, as the paid plans do. When the provider turns down the payer's email, such as one Polar doesn't take as an email, the step asks for a billing email and starts again with it. A payer's email that already pays for another business works, since each business's Polar customer is a team customer the email owns.
- The provider sends the owner back to `/onboarding/plan?pack=success&packCheckoutId=<id>`. The step says "Adding your minutes..." and reads the checkout until it's paid, then leaves the step as a paid plan does: a business on the plan step moves to `website` and the website step opens, and one that came back from a later step goes where [coming back](#come-back-to-the-plan-step) says. It also has billing read again, so the next screen shows the pack rather than the plan the business had before the payment. When a plan the business bought started before the payment arrived, the pack gave way to it at once (`packStatus` `replaced`): the step says "A plan started before this payment arrived, so no pack was added. The payment will be refunded." and moves on the same way, on that plan, and the operator refunds the payment ([prepaid packs](prepaid-packs.md#switch-between-a-pack-and-a-subscription)). A payment made on a page that plan's start closed reads the same once it arrives, or after 90 seconds if it hasn't.
- A payment that failed says so and shows the plans again, and so does one refunded or charged back before it arrived (`packStatus` `refunded`), with its own notice. One that hasn't arrived after 90 seconds (`PLAN_CHANGE_SYNC_MS`) says it's still processing and offers **Check again**.
- A business already on a pack sees "This business already has a prepaid plan." and one **Continue** button, like a business already on a paid plan. **Continue** leaves the step the same way: on to the website step, or back to the later step the business is on. From the number step or later, the server opens the number step only when the plan in force includes a number (`takesNumberStep`), so a pack sold without one, or a promo plan without one, goes to the last step.
- The step's product events say `plan: "prepaid"` for a pack: `web.onboarding.plan_selected` and `web.onboarding.plan_checkout_started` on a pack card's button, and `web.onboarding.plan_checkout_completed` once on the paid return.

## Word the plan step from billing.json

The plan step's cards and comparison come from the `display` section of the brand's `billing.json` where it has one, and otherwise are the built-in ones: Free, Starter, Pro marked **Popular**, and Enterprise, opening on Annual, with the built-in table under them. The section decides which plans and prepaid packs get a card and in what order, which one is popular and the words of its badge, the tab the step opens on, each card's description, button and bullets, the table's groups, rows and columns, its title and the line under it, and the words of the **Prepaid plans** section ([how to write it](../../brands/README.md#the-plan-screens-words)). It sells nothing: the prices, the Annual tab's badge, which intervals can be bought and every number still come from the plan list in `GET /api/billing`, a pack's from the packs on sale in the same answer (`packOffers`), and the section reaches the step as `planDisplay` in the same answer. A pack's card shows only while its pack is on sale, and a section that gives any pack a card shows no **Prepaid plans** section. RealInfoBot's section shows the Free card and a card for each of its three listing packs, as on its pricing table: **Try it: 1 listing, 180 days** at CA$99/180 days, **3 listings, 365 days** at CA$249/365 days, marked **Best value**, and **Pro: 6 listings, 365 days** at CA$449/365 days, with no tabs and no table ([the packs on sale](prepaid-packs.md#know-the-packs-on-sale)). Until an apply puts its packs on sale, it shows the Free card alone. The tests' example file, `packages/shared/src/brands/testing/plans-and-packs.billing.json`, has a section that copies the built-in words.

- **A tab for each interval a plan has a price for.** Where no plan with a card has a yearly price, as on Stripe as the merchant of record once its file is applied, the step shows Monthly alone. It used to show Annual too: turned off where a plan could be bought monthly, and otherwise open first, with "—" for the paid prices. That holds without a section too.
- **The same section words the Upgrade plan dialog.** Its cards, their order, the popular one, the opening tab and the bullets follow the section, so a business reads the same words in both places; its short line under each price and its buttons stay its own. With a section that copies the built-in words, the dialog's bullets take the plan step's wording where the two differed: the support lines in French, Enterprise's in Spanish, and the alert texts in Serbian. Its English is unchanged. A pack's card sells its pack in the dialog too, and packs without cards follow the plans there under **Prepaid plans**, as on the step, so RealInfoBot's shows Free and its three listing packs: the card's button opens the pack's checkout, asks first when paying for the pack ends the business's Starter or Pro plan, and asks for a billing email when the provider turns the payer's down, and the provider sends the person back to **Settings > Plan**, which waits for the payment (`apps/admin/src/components/live-upgrade-plan-provider.tsx`). The dialog shows a badge only where the section words one, as RealInfoBot's **Best value**.
- **The short-call row says the seconds the code bills from** (`MIN_BILLABLE_VOICE_DURATION_SECONDS`), in the built-in table too, and a **Website chats** row (`chatAiUnits`) is there for a section to name.

## Know what changed with fork PR #127

- **Onboarding reads no website.** A business that gives its website during onboarding has it saved, but its receptionist answers only from the documents and text added in the next step until the site is added in **Knowledge**.
- **Getting started's first step starts ticked.** **Read the rest of your site** is done when no website was sampled, so for a new business it's ticked from the start. It opens only while a website is still being read or has failed, or once the API has read the first 10 pages of one (`loadSetupGuideInTransaction` in `packages/domain/src/server/activation.ts`). A business that clicked **I don't have a website** saw the same before.
- **The button says "Saving..."** while it works, where it said "Starting import...", and a failure says "We couldn't save your website right now. Please try again.", in all four languages.
- **The title asks for the website.** It said "Now let's train <app name> on your website" until fork PR #128 changed it to "What is your business's website?", in all four languages, since the step no longer trains the receptionist.
- **The product events are the same:** `web.onboarding.website_submitted` now means the address was saved, not that a read started, and `web.onboarding.website_skipped` still means **I don't have a website**.
- **Fork PR #126 had taken the website step out,** with a seven-dot bar and new businesses starting on `knowledge`. The maintainer wanted the step kept and only the crawl stopped, so fork PR #127 brought the step back as it was, apart from what **Continue** does.

## Know how it's tested

- `packages/domain/src/server/onboardingWebsite.integration.test.ts`, against a real database, checks that saving the website stores the cleaned address, moves the business to `knowledge`, and leaves no knowledge source, website import or crawl message behind; that coming back later changes only the address; that a bad address saves nothing; and that a viewer is turned away.
- `apps/admin/app/api/onboarding/website/route.test.ts` checks the route's answers, and `apps/admin/src/components/onboarding-website-surface.test.tsx` checks that **Continue** calls `POST /api/onboarding/website` and never the knowledge API.
- `packages/domain/src/server/onboarding.test.ts` checks the order of the stages, which deployments have the plan step and what a stored stage shows as, and `packages/domain/src/server/onboardingStages.integration.test.ts`, against a real database, walks a business through the steps on a deployment that takes payments, on one that takes none and on a self-hosted server: where a new business starts, which step the server picks after the name and after the greeting for each plan, that a revisit moves nothing, that a number can't be searched or skipped before the number step, and that a stored `plan` is repaired where there is no plan step.
- `apps/admin/app/api/onboarding/stage/route.test.ts` checks that the route answers with the step the server picked, and `apps/admin/src/lib/onboarding-route.test.ts` which onboarding page opens for a business on each stage, with and without a plan step. `apps/admin/src/lib/onboarding-steps.test.ts` and `apps/admin/src/components/replacement-onboarding-shell.test.tsx` check the dots, eight or seven.
- `apps/admin/src/components/onboarding-business-surface.test.tsx` and `apps/admin/src/components/onboarding-greeting-surface.test.tsx` check that the name and greeting steps open the step the server answers with.
- `apps/admin/src/components/onboarding-plan-surface.test.tsx` checks where the plan step leads by the stage the business is stored on, after Free, a payment, a pack and **Continue**; that the plan step offers no pack when none is on sale; that packs without cards of their own follow the plans under **Prepaid plans**, priced for their length, with the built-in bullets and a tab for each length; that a section's pack cards show beside the plans' in its order, in place of that section, priced and filled from the packs on sale, only while their pack is on sale, each buying its own pack, asking first when the pack ends the plan, and with the reason under a button turned off; and that a pack's checkout, its paid, failed and processing returns, a pack that gave way to a plan or was refunded first, and a business already on a pack each go where the list above says.
- `apps/admin/src/components/plan-display-screens.test.tsx` renders the plan step in all four languages, on both tabs, with the example file's section and with the built-in words, and checks they're the same page; it checks a section's own cards, words, bullets, comparison and **Prepaid plans** words, the Upgrade plan dialog with the same cards and bullets, no Annual tab where plans sell monthly only, and RealInfoBot's step in English and French, with its packs as an apply puts them on sale: the Free card and a card for each pack with its name, price, words, bullets and button, the middle one under **Best value**, no tabs, table or **Prepaid plans** section, and the Free card alone before an apply; and the dialog with the same cards, each buying its pack; and that a pack's card is drawn as a plan's, part for part, on the plan step and in the dialog. `apps/admin/src/components/upgrade-plan-dialog.test.tsx` and `apps/admin/src/components/live-upgrade-plan-provider.test.tsx` check the dialog's pack cards, among the plans' or under **Prepaid plans** with a tab for each length: a pack not on sale shows no card, a button turns off with the reason when its pack can't be bought, buying opens the pack's payment page, and paying for a pack that ends the plan asks first.
- `pnpm replacement:onboarding` (`scripts/replacement-onboarding-check.ts`) runs a business through the steps against a real database, with and without a plan step, with four website saves at once, and checks that none queues a crawl. `pnpm replacement:phone-onboarding` checks that a number can't be searched from the plan step and that a paid business reaches the number step after the greeting.
- The browser tests in `apps/admin/e2e/operator-auth.e2e.ts` sign up on a server that takes no payments, click **I don't have a website**, and go from the greeting to the last step and the dashboard, with seven dots. `apps/admin/e2e/onboarding-plan-step.e2e.ts` runs against a server of its own, started with a billing provider's settings (`pnpm --filter @lobbystack/admin e2e:plan-step`, [browser journeys](../development/README.md)): the plan step follows the name as the third of eight dots, nothing after it opens before a plan is chosen, **Start free** goes on to the website step, the third dot opens the plan step again and returns to the step the business is on, and Free goes from the greeting to the last step.
- `pnpm dev:onboarding:website <businessId>` puts a local business back on the website step to try it by hand.
