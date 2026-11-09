# Set up a business in onboarding

Onboarding takes a new account from sign-up to the dashboard: the business's name, its website, its first documents, the greeting callers hear, the plan, a phone number, and how the owner heard about the app. Since fork PR #127 the website step only saves the address the owner types and reads nothing, so onboarding never starts the crawler: the maintainer asked for that, and may offer reading the website during onboarding again later as an option ([roadmap](../roadmap/onboarding-website-option.md)). The crawler itself is unchanged, and the Knowledge page, the API, the `lobbystack` command and demos still use it. Checked against the code of fork PR #128.

## Know the steps

The bar at the top shows eight dots: the first is sign-up, and each of the others is a step. Signing in again opens the step the business is on, and a dot before it opens that step again to change it.

| Dot | Step | Address | Stage | Notes |
| --- | --- | --- | --- | --- |
| 1 | Sign up and verify the email | `/signup` | None yet | |
| 2 | **Make this app your own** | `/onboarding/brand` | None yet | Only for the first account on an instance with no brand of its own ([guide 6.2](../deployment/guide/part-6-first-run.md#62-the-brand-step)) |
| 2 | The business's name | `/onboarding/business` | `create_business` | Creates the business, which starts on `website`. A claimed demo starts here with its business already made |
| 3 | "What is your business's website?" | `/onboarding/website` | `website` | **Continue** saves the address; **I don't have a website** skips. Neither reads the site ([below](#know-what-the-website-step-saves)) |
| 4 | **Add training documents** | `/onboarding/knowledge` | `knowledge` | Upload files or paste text, or **Skip for now** |
| 5 | The greeting | `/onboarding/greeting` | `greeting` | Also sets the language calls open in |
| 6 | The plan | `/onboarding/plan` | `plan` | **Start free** goes on to dot 8; a paid plan to dot 7, and so does a prepaid pack where packs are on sale ([below](#buy-prepaid-minutes-on-the-plan-step)) |
| 7 | The phone number | `/onboarding/number` | `phone_number`, `phone_number_claiming` | A plan without a number, such as Free, is sent back to dot 6 |
| 8 | How you heard about the app | `/onboarding/attribution` | `attribution` | Then the dashboard opens, at stage `complete` |

The stage is `businesses.onboarding_stage`. A step moves it with `POST /api/onboarding/stage`, which accepts only the next stage, so no step can be skipped, and only an owner or an admin can move it (`packages/domain/src/server/onboarding.ts`). The v1 API and the `lobbystack` command show the same stage ([integrations](api-cli-integrations.md)). The [route catalog](../reference/routes.md#4-onboarding-pages) has each address and what it checks. The [deployment guide](../deployment/guide/part-6-first-run.md#63-set-up-the-first-business) walks through the steps as an owner sees them.

A business stored on `verify_phone` or `verify_phone_code`, steps removed before the fork with personal phone verification, resumes on `plan` (`normalizeOnboardingStage`).

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

## Buy prepaid minutes on the plan step

A deployment that sells prepaid minute packs offers them on the plan step too, under the plan cards, as **Prefer prepaid minutes?**: a choice of minutes and of how long they last, the price, paid once, and **Buy pack** (`apps/admin/src/components/onboarding-plan-surface.tsx`). A deployment that sells no packs shows none of it, and neither does an operator-managed account or a plan the packs aren't sold with, so for them the step looks as it did before packs. A pack that can't be bought right now shows with its button turned off and the reason under it.

- **Buy pack** asks for a checkout with `POST /api/billing/packs/checkout`, follows it with `GET /api/billing/packs/checkout` and opens the payment page once it's ready, as the paid plans do. When the provider turns down the payer's email, such as one it already has for another business, the step asks for a billing email and starts again with it.
- The provider sends the owner back to `/onboarding/plan?pack=success&packCheckoutId=<id>`. The step says "Adding your minutes..." and reads the checkout until it's paid, then moves the business to `phone_number` and opens the number step, as a paid plan does.
- A payment that failed says so and shows the plans again. One that hasn't arrived after 90 seconds (`PLAN_CHANGE_SYNC_MS`) says it's still processing and offers **Check again**.
- A business already on a pack sees "This business already has prepaid minutes." and one **Continue** button to the number step, like a business already on a paid plan.
- The step's product events say `plan: "prepaid"` for a pack: `web.onboarding.plan_selected` and `web.onboarding.plan_checkout_started` on **Buy pack**, and `web.onboarding.plan_checkout_completed` once on the paid return.

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
- `apps/admin/src/components/onboarding-plan-surface.test.tsx` checks that the plan step offers no pack when none is on sale, and that a pack's checkout, its paid, failed and processing returns, and a business already on a pack each go where the list above says.
- `pnpm replacement:onboarding` (`scripts/replacement-onboarding-check.ts`) runs a business through the steps against a real database, with four website saves at once, and checks that none queues a crawl.
- The browser tests in `apps/admin/e2e/operator-auth.e2e.ts` sign up, click **I don't have a website**, and go on to the dashboard.
- `pnpm dev:onboarding:website <businessId>` puts a local business back on the website step to try it by hand.
