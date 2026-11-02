# Set up a business in onboarding

Onboarding takes a new account from sign-up to the dashboard: the business's name, its first documents, the greeting callers hear, the plan, a phone number, and how the owner heard about the app. Since fork PR #126 it doesn't ask for the business's website and reads none: the maintainer took the website step out to make onboarding shorter, and may offer it again later as an option ([roadmap](../roadmap/onboarding-website-option.md)). The crawler that reads websites is unchanged, and the Knowledge page, the API, the `lobbystack` command and demos still use it. Checked against the code of fork PR #126.

## Know the steps

The bar at the top shows seven dots: the first is sign-up, and each of the others is a step. Signing in again opens the step the business is on, and a dot before it opens that step again to change it.

| Dot | Step | Address | Stage | Notes |
| --- | --- | --- | --- | --- |
| 1 | Sign up and verify the email | `/signup` | None yet | |
| 2 | **Make this app your own** | `/onboarding/brand` | None yet | Only for the first account on an instance with no brand of its own ([guide 6.2](../deployment/guide/part-6-first-run.md#62-the-brand-step)) |
| 2 | The business's name | `/onboarding/business` | `create_business` | Creates the business, which starts on `knowledge`. A claimed demo starts here with its business already made |
| 3 | **Add training documents** | `/onboarding/knowledge` | `knowledge` | Upload files or paste text, or **Skip for now** |
| 4 | The greeting | `/onboarding/greeting` | `greeting` | Also sets the language calls open in |
| 5 | The plan | `/onboarding/plan` | `plan` | **Start free** goes on to dot 7; a paid plan to dot 6 |
| 6 | The phone number | `/onboarding/number` | `phone_number`, `phone_number_claiming` | A plan without a number, such as Free, is sent back to dot 5 |
| 7 | How you heard about the app | `/onboarding/attribution` | `attribution` | Then the dashboard opens, at stage `complete` |

The stage is `businesses.onboarding_stage`. A step moves it with `POST /api/onboarding/stage`, which accepts only the next stage, so no step can be skipped, and only an owner or an admin can move it (`packages/domain/src/server/onboarding.ts`). The v1 API and the `lobbystack` command show the same stage ([integrations](api-cli-integrations.md)). The [route catalog](../reference/routes.md#4-onboarding-pages) has each address and what it checks. The [deployment guide](../deployment/guide/part-6-first-run.md#63-set-up-the-first-business) walks through the steps as an owner sees them.

## Know what happens to a removed step

Two steps have left onboarding. A business stored on one resumes on the step that took its place, so nobody is stuck on a page that no longer exists:

| Stored stage | Removed | Resumes on |
| --- | --- | --- |
| `verify_phone`, `verify_phone_code` | Before the fork, with personal phone verification | `plan` |
| `website` | Fork PR #126 | `knowledge` |

`normalizeOnboardingStage` makes the switch whenever the stage is read, so the dashboard, the API and the `lobbystack` command never show a removed stage. The stored value is rewritten the next time a step saves: a business on `website` that finishes the documents step is stored as `greeting`, as any other would be. The old address `/onboarding/website` sends whoever opens it to their current step, or to the dashboard once onboarding is done. No migration changes stored stages, since the column has no list of allowed values.

## Where websites are read

Reading a website needs `FIRECRAWL_API_KEY` on the worker ([guide 3.7](../deployment/guide/part-3-outside-services.md#website-import-firecrawl)). These still read one:

| Where | Pages | Saves it as the business's website |
| --- | --- | --- |
| **Knowledge** > **Add Knowledge** > **Website** in the dashboard | Up to 50 | No |
| `POST /knowledge/sources` in the v1 API, and `knowledge.websites` in a `lobbystack onboard` manifest, which uses it | A sample of 10; `POST /knowledge/sources/{source_id}/expand`, or **Getting started**, reads the rest, up to 50 | No |
| A demo made on the **Demos** page | The demo's website | Yes, on the demo's own business |
| `POST /api/knowledge` with `onboarding: true` | A sample of 10 | Yes |

Nothing sends `onboarding: true` since fork PR #126, but it stays, with the progress panel that the documents and greeting steps still show while a website is being read (`apps/admin/src/components/website-import-progress.tsx`), for a later option to use ([roadmap](../roadmap/onboarding-website-option.md#know-what-it-could-reuse)).

AI still writes the business summary and fills in opening hours from what the receptionist knows. The worker queues both whenever a document, a website or a text entry finishes reading, or one is deleted, so files and text added in the documents step feed them as a website did (`enqueueKnowledgeDerivedRefresh` in `packages/domain/src/server/businessHours.ts`).

## Know what changed with the website step

- **The business's own website stays empty.** Onboarding was the only place in the dashboard that set it. A business created since fork PR #126 has none until the v1 API's `PATCH /business` or a `lobbystack onboard` manifest sets `website_url`, so its public page shows no link to a website ([public page](public-profile-and-qr.md)). A website added in **Knowledge** isn't saved as the business's website.
- **Getting started's first step starts ticked.** **Read the rest of your site** is done when no website was sampled, so for a new business it's ticked from the start. It opens only while a website is still being read or has failed, or once the API has read the first 10 pages of one (`loadSetupGuideInTransaction` in `packages/domain/src/server/activation.ts`). A business that clicked **I don't have a website** before saw the same.
- **Two product events are gone:** `web.onboarding.website_submitted` and `web.onboarding.website_skipped`. A PostHog funnel that used them gets nothing new from them; `web.onboarding.business_name_submitted` is now followed by `web.onboarding.knowledge_uploaded` or `web.onboarding.knowledge_skipped`.
- **New businesses start on `knowledge`,** whether made in the dashboard or with the v1 API's `POST /businesses`, and the API's list of stages no longer has `website`.

## Know how it's tested

- `packages/domain/src/server/onboarding.test.ts` checks the order of the stages and that `website` resumes on `knowledge`.
- `apps/admin/src/components/onboarding-business-surface.test.tsx` and `replacement-onboarding-shell.test.tsx` check that the name step goes to the documents step and that the bar has seven dots.
- `packages/domain/src/server/publicApi/publicApi.integration.test.ts` checks that a business stored on `website` reads as `knowledge` through the API, and that adding a website through the API changes neither the stage nor the business's website.
- `pnpm replacement:onboarding` (`scripts/replacement-onboarding-check.ts`) runs a business stored on `website` through the steps against a real database.
- The browser tests in `apps/admin/e2e/operator-auth.e2e.ts` sign up, check that the name step leads to the documents step and that `/onboarding/website` sends you there, and go on to the dashboard.
