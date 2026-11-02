# Read the business's website during onboarding, as an option

Until fork PR #127, **Continue** on onboarding's website step read a sample of 10 pages of the site right away, so the receptionist could answer from it from the first call, and AI could write the business summary and fill in the opening hours from it. Since fork PR #127 the step only saves the address as the business's website and starts no crawl, as the maintainer asked on 2026-11-02, and the maintainer plans to offer reading the website during onboarding again later as an option. Until then, an owner adds the website in **Knowledge** once the dashboard opens ([onboarding](../features/onboarding.md#know-what-the-website-step-saves)).

- **Status:** waiting on the maintainer's decisions.
- **Effort:** not estimated. Most of what the option needs is still in the code (below), so the work is mostly a control on a screen and its wording.

## Know what it could reuse

- **The saved address:** the website step now saves it in `businesses.website_url` before anything reads it, so an option can read it at any time without asking again.
- **Reading a sample and saving the website:** `POST /api/knowledge` with `onboarding: true` reads 10 pages and saves the address as the business's website (`createKnowledgeDocumentInTransaction` in `packages/domain/src/server/knowledge.ts`). Until fork PR #127 the website step sent it; nothing in the dashboard does now.
- **Showing the progress:** `WebsiteImportProgress` (`apps/admin/src/components/website-import-progress.tsx`), which the documents and greeting steps and the dashboard's activation card show while a website is being read.
- **Reading the rest:** **Getting started** > **Read the rest of your site**, which reads a sampled site in full, up to 50 pages, as the API's `POST /knowledge/sources/{source_id}/expand` does.
- **The step as it read the site,** in git history at `99ab598`, before fork PRs #126 and #127: `apps/admin/src/components/onboarding-website-surface.tsx` and its test, and in each `apps/admin/public/locales/<language>/onboarding.json` the "Starting import..." button and the title "Now let's train {{appName}} on your website", which fork PR #128 changed to "What is your business's website?" since nothing reads the site now. An option that reads it could bring that title back.

## Choose where it goes

| Option | What an owner sees | What changes |
| --- | --- | --- |
| A choice on the website step | A box under the address, such as "Read my site now so the receptionist can answer from it" | When it's ticked, **Continue** also sends `POST /api/knowledge` with `onboarding: true`; the documents and greeting steps show the progress again |
| A setting for the whole deployment | The step as before fork PR #127, on deployments that turn it on | A setting, or the brand's file, decides whether **Continue** reads the site; the step looks the same either way |
| After onboarding only | A **Getting started** step, or a card on Home, that offers to read the saved website | **Getting started** gets a step that reads `website_url`, beside the one that reads the rest |

## Decide these

- Where should it go: a choice on the step, a deployment setting, or only after onboarding?
- If it's a choice on the step, should the box start ticked?
- Should **Getting started** offer to read a website that was saved but never read, instead of showing **Read the rest of your site** ticked from the start?
