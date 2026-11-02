# Read the business's website in onboarding again, as an option

Until fork PR #126, onboarding's second step asked for the business's website and read a sample of 10 pages, so the receptionist could answer from it from the first call, and AI could write the business summary and fill in the opening hours from it. The maintainer took the step out on 2026-11-02 to make onboarding shorter, kept the crawler, and plans to offer reading the website again later as an option. Until then, an owner adds the website in **Knowledge** ([onboarding](../features/onboarding.md#where-websites-are-read)).

- **Status:** waiting on the maintainer's decisions.
- **Effort:** not estimated. Most of what the option needs is still in the code (below), so the work is mostly a screen and its wording.

## Know what it could reuse

- **Reading a sample and saving the website:** `POST /api/knowledge` with `onboarding: true` reads 10 pages and saves the address as the business's own website, which its public page links to (`createKnowledgeDocumentInTransaction` in `packages/domain/src/server/knowledge.ts`). Nothing sends it since fork PR #126.
- **Showing the progress:** `WebsiteImportProgress` (`apps/admin/src/components/website-import-progress.tsx`), which the documents and greeting steps and the dashboard's activation card still show while a website is being read.
- **Reading the rest:** **Getting started** > **Read the rest of your site**, which reads a sampled site in full, up to 50 pages, as the API's `POST /knowledge/sources/{source_id}/expand` does.
- **The removed step,** in git history at `99ab598`, the commit before fork PR #126: `apps/admin/src/components/onboarding-website-surface.tsx` and its test, the `website` section of each `apps/admin/public/locales/<language>/onboarding.json`, the `website_url_invalid` message in `apps/admin/src/lib/onboarding-errors.ts`, the `web.onboarding.website_submitted` and `web.onboarding.website_skipped` events, and `scripts/prepare-onboarding-website.ts`.

## Choose where it goes

| Option | What an owner sees | What changes |
| --- | --- | --- |
| A **Website** tab in the documents step | **Upload files**, **Paste text** and **Website** side by side, with no extra step | The documents step sends `onboarding: true` from its new tab; the bar keeps seven dots |
| Its own step again, on deployments that turn it on | The website question before the documents, where a setting asks for it | The `website` stage comes back, along with its address and a setting to read; the bar's count depends on the setting |
| After onboarding only | A **Getting started** step, or a card on Home, that asks for the website | **Getting started** gets a step that reads a website, beside the one that reads the rest |

## Decide these

- Where should it go: a tab in the documents step, its own step, or only after onboarding?
- Should every deployment get it, or should a setting or the brand's file turn it on?
- Should the dashboard let an owner set the business's own website without reading it, such as in **Settings > Public profile**? Since fork PR #126 nothing in the dashboard sets it, so a new business's public page links to no website unless the API sets `website_url`.
- Should **Getting started** hide **Read the rest of your site** when no website was sampled, instead of showing it ticked from the start?
