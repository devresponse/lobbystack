# Help pages for every screen

The app has a help center: one page for each screen, written for the people who use the dashboard, for support and for training. Each page says what the screen is for, what is on it, which fields it needs and how to do the common jobs there. A question mark at the top right of every screen opens that screen's page in a panel beside it, and the same pages are public at `/{locale}/help/{screen}`, such as `/en/help/website-widget`, with an index at `/{locale}/help` and every page in one Markdown file at `/{locale}/help.md` for AI assistants. The text fits any brand: it names the screen, its fields and what they do, never a brand, a price, a provider or a deployment setting. The first pass is in English only. Built on `releases/r2`.

## Open help from a screen

- **The question mark** sits at the top right of every screen, as the last of the buttons there: in the dashboard's top bar, after **Feedback**, as soon as the screen shows, and it stays put when the business's buttons appear beside it once the business has loaded; on a phone, at the right end of the menu button's row; at the top right of the sign-in, sign-up and onboarding screens and the pages that open from an email, after **Sign out** on an onboarding step; at the right end of a prospect's demo page header, after **Try for free**; and at the top right while a demo is claimed. Below 768 px those screens keep 80 px above the logo, so when one is taller than the window, its logo stays clear of **Sign out** and the question mark. To make room for it on a phone, the demo page's header leaves out its **Log in** link below 640 px, and a long brand name there ends in an ellipsis.
- **The panel** opens from the right, over the screen, with the screen's help page: a third of a large screen (never narrower than 448 px or wider than 640 px), two thirds of a tablet's and, on a phone, all but a 56 px strip at the left. The screen stays in view beside it under a light shade, so the steps can be followed against it. Its close button stays at the top right however far the page scrolls, and Escape, a click on the shaded screen or moving to another screen close it too.
- **From the keyboard,** the panel's title takes the focus when the panel opens and after each move inside it, and stays at the top as the page scrolls, so the arrow keys, Page Down and Space scroll the help from the start. The page keeps clear of the title: Page Down skips no line under it, a topic reached with Tab or Shift+Tab is never hidden by it, and **Back** or the title takes the focus without moving the page.
- **Inside the panel,** **All help topics** lists every page by section, a related page or a topic opens in the panel, and **Back** returns to the one before. **Open in a new tab** opens the page on its own, at its public address.
- **Which page:** each help page lists the app addresses it explains (`screenPaths`), such as `/calls/{callId}` for one call's page, and the panel picks the page whose address matches the screen's, without the language, query or a trailing slash. A screen no page explains opens **All help topics**.
- **Languages:** the panel's own buttons are in the interface's language, and the help text is in English. Where the interface is in another language, the panel says that help is in English for now.
- **Speed:** the help text is not part of the screens. It arrives in one file the first time the panel opens, or as soon as the pointer or keyboard reaches the question mark, and stays for the rest of the visit. If it can't load, the panel says so and offers **Try again** and the help center in a new tab.

Until this change, a question mark at the top right of the dashboard opened the brand's documentation site. The help center's question mark takes its place; the documentation link stays in the **Feedback** box ("see docs.").

## Read a help page

- **The index,** `/en/help`, lists every page under the app's own groups: Getting started (sign-up, sign-in, demos and onboarding), General, Agent, Manage, Settings and Your account (which also holds the pages that open from an email or another app).
- **A page** opens with the screen's name and one sentence on what it is for, then a box with where to find the screen, who can use it and its address in the app. Below come **What this screen is for**, **What you see**, **Fields and settings** (each field marked **Required**, **Optional** or **Sometimes required**), **How to**, **Good to know**, **Troubleshooting** and **Related help**. A page leaves out the parts it has nothing for. The panel shows the same parts, without the address and the search words.
- **The header** shows the deployment's own name and logo, as the sign-in pages do, and links to the index. They come from the brand file the deployment's build picks, its `brand.json` name and logo ([how a deployment picks its brand](../branding.md#how-a-deployment-picks-its-brand)), so a branded deployment never shows LobbyStack's logo there; LobbyStack's shows only on a deployment with no brand of its own. Nothing else on the page changes with the brand. Where the build has no brand file and the name comes from what onboarding saved, the name, its logo and its link to the app appear a moment after the page loads. `help-page-shell.test.tsx` checks the header with each brand file.
- **Pages are public and prerendered:** anyone can read them without signing in, and the server sends them like the sign-in pages, with the brand the build knows.
- **Other languages:** only English exists so far. `/fr/help/...`, `/es/help/...` and `/sr/help/...` send the reader to the English page (307, until that language has help), and an address without a language, such as `/help/rules`, goes to it too (308). Reading a help page never changes or saves the reader's interface language, even with `?lng=` in its address.

## Use the pages as a knowledge base

`/en/help.md` is every help page in one Markdown file, in the index's order, each page under its own heading with its address. It is made from the same content as the pages, so it is never out of step with them. Load it into an AI support assistant, a ticketing tool's knowledge base, or a business's own **Knowledge** screen (as an upload) for a receptionist that answers questions about the app. The HTML pages work for a crawler too: each is one article with plain headings, lists and no script-only content.

## Know which screens have a page

Every page of the app has a help page except these, which `help-content.test.ts` names:

- **Addresses that only send people elsewhere:** `/agent/integrations` (to `/agent`), `/settings` (to `/settings/usage`), and `/onboarding/verify-phone` and `/onboarding/verify-phone/code` (to the person's current onboarding step).
- **The help center itself.**
- **Pages a business's own callers and visitors see,** not its team: the website widget's chat window (`/embed/{key}`) and the business's public page and receptionist pages (`/profile/{slug}`, `/profile/{slug}/{handle}`).

## Write or change a help page

Each page is one TypeScript file in `apps/admin/src/lib/help/articles/en/`, named after its slug, which exports a `HelpArticle` (`apps/admin/src/lib/help/types.ts`). `apps/admin/src/lib/help/registry.ts` lists them in the index's order. The page, the panel, the index and the Markdown file all read the same objects.

### Keep it brand-neutral

The help pages must read true on every deployment, for every brand, now and later.

- **Name no brand.** No product name, company name, domain or support address. Say "the app", "the dashboard" or "your AI receptionist". Where the screen shows the app's name, describe the thing instead: "the app's address" rather than a brand's.
- **Name no provider the deployment chooses.** No payment, phone, AI, email or hosting provider. Say "the secure payment page", "the billing portal", "your phone number", "the AI". Outside apps that the business connects by name on the screen, such as Google Calendar, Zapier or Make, may be named.
- **Quote no plan, price or allowance from a brand's billing.** Plans, packs, prices, minutes and limits differ by brand and change. Say "your plan", "the plans on offer" or "depending on your plan". Limits fixed in the code for everyone, such as a 25 MB upload limit, may be stated.
- **Mention no deployment setting.** No environment variables, servers or operator steps. When an option can be missing, say so in the reader's terms: "If you don't see this option, it isn't available on your plan or for your account."
- **Leave out code.** No API addresses, role keys such as `business_admin`, database or setting names. Use the role names the screens use: owners, admins, schedulers and viewers.

`HELP_BANNED_TERMS` in `apps/admin/src/lib/help/validate.ts` holds the provider and deployment words the checks refuse; the test adds every brand's name, folder, domains and contact address from `brands/`, so a new brand is covered without a change here. A provider whose name is also a label on a screen is refused by its address instead: the email provider by `resend.com`, since **Resend** is a button on the **Webhooks** and **Notifications** screens.

### Write for the person at the screen

- **Use the screen's own words.** Name every button, tab, field and menu item exactly as the English screen shows it, in **bold**. The English labels are in `apps/admin/public/locales/en/`.
- **Check every statement against the code.** Read the screen's component and the route it saves through: what is required, what the limits are, who can change what, what happens after saving. Don't copy from older docs without checking; the original project's `mintlify/` pages are out of date.
- **Mark requirements honestly.** **Required** means the screen won't save or go on without it, because the form or the server refuses. **Optional** means it can be left empty. **Sometimes required** names when in the description. Switches, choices with a default and values the screen only shows have no mark.
- **Write plainly.** Second person, present tense, short sentences, no jargon. Explain what a setting does for the business, not how it is built. One idea per note.
- **Format.** Text is plain sentences with two marks: `**bold**` for a label and `` `code` `` for something typed exactly, such as an address. No links inside text (use `related`), no HTML, no dashes as punctuation, typed hyphens included (use a comma, a colon or a new sentence), and every sentence ends with a full stop, a question mark or an exclamation mark, never a colon. Titles, names, location steps and keywords take no full stop and no marks, since they show as plain text.
- **Cover the whole screen.** Every area, field and action the screen shows, including what only owners and admins see, and what changes when the business has several AI agents.
- **Fill in what helps.** `purpose` (one to four short paragraphs on why the screen exists), `areas` for what the screen shows, `fields` grouped as the screen groups them (a card, dialog or tab), `tasks` as numbered steps for the common jobs, `notes` for limits and what happens next, `troubleshooting` for the problems people meet, `related` for the pages to read next and `keywords` for the words people search with.

### Check it

`apps/admin/src/lib/help/help-content.test.ts` runs with the admin's tests and fails on a page that breaks the rules above (a banned word, also inside a name joined with underscores, a missing part, a sentence without a full stop, a dash, a `{{placeholder}}`, a code name, even in a code mark unless it's an API scope the screen shows, a mark in a name or title, an address with a language prefix, a related page that doesn't exist), on an article file the registry doesn't list, on two pages claiming one address or an address that isn't a page of the app, and on a page anywhere under `apps/admin/app/` that no help page explains and the test doesn't name. It checks the words around the pages, such as the index's introduction and the Markdown file's, for banned words and brand names too. `apps/admin/src/lib/help/validate.test.ts` checks the rules themselves. `apps/admin/src/components/screen-help-button.test.tsx` checks the panel, its focus and its related pages, and `apps/admin/e2e/help-pages.e2e.ts` opens the index, every page, the Markdown file and the panel in a browser, on a large screen and a phone, including a related page, scrolling from the keyboard and closing from the strip beside it.

### Add a page for a new screen

1. Copy an article such as `rules.ts`, rename it to the new slug and fill it in from the screen's code.
2. Add it to `apps/admin/src/lib/help/registry.ts`: its import, and its place in the list, which is its place in its section of the index.
3. Put the screen's address in `screenPaths`, with `{name}` for a part that changes, such as `/contacts/{contactId}`, so the question mark finds it.
4. Run `pnpm --filter @lobbystack/admin exec vitest run src/lib/help`.

## Code map

- **Content:** `apps/admin/src/lib/help/types.ts` (the model), `articles/en/*.ts` (one per page), `registry.ts` (the order, the lookups, the page for an address and the English words around the content), `screen-paths.ts` (matching an address to a page), `markdown.ts` (the Markdown file), `locales.ts` (the languages that have help and the help addresses) and `validate.ts` (the rules the test applies).
- **Pages:** `apps/admin/app/(help)/[locale]/help/page.tsx` (the index), `help/[screen]/page.tsx` (a page) and `help.md/route.ts` (the Markdown file). Their own layout, `app/(help)/[locale]/layout.tsx`, builds them only for the languages `locales.ts` lists. `apps/admin/src/components/help/` draws them: `help-page-shell.tsx` (with `help-brand-link.tsx` for the name and logo), `help-index-view.tsx`, `help-article-view.tsx` and `help-article-body.tsx`, which the panel shares.
- **The question mark and the panel:** `apps/admin/src/components/screen-help-button.tsx` and `apps/admin/src/components/help/help-panel.tsx`, placed by `dashboard-utility-bar.tsx`, `site-header.tsx` (phones), `replacement-onboarding-shell.tsx`, `demo-surface.tsx` (through the demo page's header, `marketing/landing-navbar.tsx`) and `claim-demo-surface.tsx`. Their words are under `help` in `apps/admin/public/locales/*/common.json`. While the panel is open, `apps/admin/app/theme.css` gives the page the panel's color, since a browser with a scrollbar's gutter paints only the page's own background in it, beside the panel.
- **Routing:** `help` and `help.md` are public route sections in `apps/admin/src/lib/locale-path.ts`, so the proxy gives them the sign-in pages' cache headers and sends an address without a language to one; the proxy sends the languages `locales.ts` doesn't list to English, and `replacement-locale-provider.tsx` leaves the reader's language alone on a help page.
