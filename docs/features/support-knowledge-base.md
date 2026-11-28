# Answer support and sales questions about the app with its own AI agents

A brand can run its own support assistant: a business on the brand's deployment whose AI agent answers questions about the app itself, such as its screens, plans, billing and policies, from the deployment's own chat, browser calls and phone number. It can run a sales assistant too, in a business of its own, which talks with the people thinking of buying the app. Their knowledge lives in the repository, under `devops/kb/`, so it changes by pull request, and `lobbystack onboard` loads each into its business through the API in one run instead of one upload at a time.

RealInfoBot's are the first, both from fork PR #250 on `develop/r2`:

- **Support,** in [`devops/kb/realinfobot/`](../../devops/kb/realinfobot/README.md), from the maintainer's request of 2026-11-28 for a knowledge base that answers RealInfoBot customers' questions about the software, the service, its features and its billing.
- **Sales,** in [`devops/kb/realinfobot-sales/`](../../devops/kb/realinfobot-sales/README.md), from the maintainer's request the same day for a separate, sales-only knowledge base that powers a front-facing assistant helping to sell the app: how to sell each feature, why it helps, and use-case scenarios ([below](#sell-the-app-with-a-sales-assistant)).

Checked against `develop/r2` at `1b75c1f`.

## Know what a folder holds

| File | What it is |
| --- | --- |
| The manifest, such as `realinfobot-kb.yaml` | The import file for `lobbystack onboard`: the documents, the FAQs, and the default AI agent's greeting, summary, instructions and booking mode. `help-kb.json` names it; a folder without screen guides holds one named `<name>-kb.yaml` |
| `guides/` | Topic guides written by hand for the brand, from the app, its `billing.json`, its website and its legal pages |
| `screens/` | Support only: one screen guide for each help page, which `pnpm help:kb` writes |
| `help-kb.json` | Support only: the brand's name and dashboard address for the screen guides, the manifest and folder they go in, and the help pages left out under `skip`, each with why |
| `questions.yaml` | Questions worded the way customers, or for sales the people thinking of buying, ask them, each with the documents that answer it |
| `README.md` | How to load it, check it and keep it current |

`devops/kb/.gitignore` keeps the state files that `lobbystack onboard` writes beside a manifest out of the repository: they hold the IDs of one dashboard's uploads.

## Generate the screen guides from the help pages

`pnpm help:kb` reads each folder under `devops/kb/` that has a `help-kb.json`, and writes every [help page](help-pages.md) it doesn't skip as a Markdown document of its own, in the order of the help center. It also rewrites the manifest's lines between `# screens:start` and `# screens:end`, which list the documents, and removes a screen guide no help page writes any more, saying to delete its document from the knowledge base by hand, since `lobbystack onboard` never deletes. `pnpm help:kb --check` lists what is behind and changes nothing.

A screen guide is made for the knowledge base, which cuts a document at each heading and into passages of at most 1,800 characters, and finds and reads each passage on its own:

- Every heading names the screen, such as "How to invite someone to the team, on the Team screen", and the first one says it's the brand's app.
- The screen's address is a link with the brand's dashboard address, such as `https://ca.realinfobot.com/settings/team`, and an address with a part that changes stays as code.
- A section that would run past 1,500 characters carries on under its heading again, marked "(continued)", so each section stays one passage with its heading.
- "Related help", which only lists other pages, is left out.

`scripts/help-kb.test.ts` fails when a folder's screen guides or its manifest's list fall behind the help pages, so a pull request that changes a help page runs `pnpm help:kb` and commits what it writes. For every folder under `devops/kb/`, with screen guides or without, the test also checks that it has one manifest, that `lobbystack onboard` reads it and every document it lists, that it lists every document in the folder once, that no section of any document is longer than a passage, and that `questions.yaml` names only documents the manifest lists.

## Write documents the search finds

The topic guides follow the rules in [the RealInfoBot folder's README](../../devops/kb/realinfobot/README.md#how-its-written): one question per section, in the words a customer would use, each section standing alone with full links, "Also asked as" lines with other words for the subject, and no section over 1,500 characters. Where the website or the legal pages differ from the app, the guides follow the app, as the maintainer chose on 2026-11-28 ([decisions](../project/decisions.md#choose-what-to-build)).

The knowledge search runs a keyword search and a meaning-based search together ([knowledge](../knowledge/architecture.md)). A keyword-only run of RealInfoBot's 86 test questions, with the app's own passage cutting and ranking on a local PostgreSQL, found a document that answers 85 of them among the first 6 passages, after "Also asked as" lines were added for the 14 it first missed.

## Rank the FAQs every call keeps ready

Every chat and call has a business's FAQs and text entries with the highest priority ready in its instructions, 8 at most, without a search, and uses the others only when a search leaves room. Since fork PR #250 a manifest gives each entry under `knowledge.faqs` and `knowledge.texts` a `priority`, from -100 to 100, and `tags`, its labels. `lobbystack onboard` sets them with `PATCH /knowledge/{entry_id}` right after it creates the entry, since `POST /knowledge` takes neither, and on a rerun changes only the answer, priority or labels that differ. A run that stops between the two sends them on the next run. An entry whose manifest leaves either out keeps what it has, and the `faq` label that marks an FAQ is never compared or sent. RealInfoBot's manifest has 8 FAQs, at 100 down to 93.

## Load it

The [support README](../../devops/kb/realinfobot/README.md#load-it) and the [sales README](../../devops/kb/realinfobot-sales/README.md#load-it) have the steps: an API key with `business:read`, `business:write`, `knowledge:read` and `knowledge:write`, `lobbystack login`, then `lobbystack onboard <manifest> --plan` and the run. Four things to know first:

- **A business of its own.** The documents are for every AI agent of the business, and the manifest's `receptionist:` section rewrites the default agent's settings. Leave that section out to load the knowledge alone.
- **Room on its plan.** RealInfoBot's free plan has 5 website chats and 30 voice minutes a month and 1 MB of knowledge; the support documents take about 0.6 MB, and the sales ones about 0.1 MB. A managed plan, which an operator's platform key sets with `lobbystack billing managed-plan`, has no allowances.
- **The business's own name and time zone in the manifest.** With a business key, a different name stops the run before anything changes, but a different time zone, or the name in other capitals, changes the business.
- **The state file.** Without it, a run uploads every document again as a second copy.

The digest of documents that a chat or call names as what it can look up holds the 40 added or changed last, so a manifest lists its screen guides first and its topic guides last, which uploads the topic guides last.

## Sell the app with a sales assistant

RealInfoBot's sales knowledge base is for prospects only: 12 guides, about 90 KB, with no screen guides and no `help-kb.json`. They cover the pitch, the benefits, the features buyers use and the features agents use, 11 use-case scenarios, who it's for and when it isn't a fit, the plans with which one fits whom, 13 concerns with honest answers, comparisons with voicemail, answering services and other options, trust and privacy, the next steps, and quick facts. The facts follow the app, as the support guides do, and the guides name no other company.

- **Selling notes.** Many sections carry lines that start with "Say it simply:", "Example:", "Good question to ask:", "Best fit:" or "Next step:". The app hands knowledge to the AI as reference data, not instructions (`packages/agent-core/src/instructions.ts`), so the manifest's own instructions tell the assistant to use those lines and never read out the labels.
- **A way to run each conversation,** in `chat_instructions` and `voice_instructions`: find out, one question at a time, who the person is and how many listings they have; lead with what they get; recommend a plan from what they said; answer concerns honestly; and offer one next step, from the sample listing on the website to sign-up, setup help, or a message for the team to call back.
- **Its own business.** Documents, FAQs, rules and the business summary are shared by every AI agent of a business, so sales and support in one business would mix their answers, and the two sets of 8 FAQs would compete for the 8 every chat and call keeps ready. Its manifest names the business "RealInfoBot Sales", a guess to replace with the real name.
- **Checked the same way.** A keyword-only run of its 100 test questions found a document that answers 97 among the first 6 passages; the other 3 are made only of words the keyword search leaves out.

The [sales README](../../devops/kb/realinfobot-sales/README.md) has the steps to load it, put its chat on realinfobot.com and keep it current.

## Add a brand

1. Make `devops/kb/<brand>/` with a `help-kb.json`: `appName`, `appUrl` (the dashboard's address), `manifest`, `folder` and `skip`.
2. Write the manifest, with the business's name and time zone, a `# screens:start` line and a `# screens:end` line under `knowledge.files`, and the topic guides after them.
3. Run `pnpm help:kb`, then `pnpm test:scripts`.

A knowledge base without screen guides, such as a sales one, is a folder under `devops/kb/` with a manifest named `<name>-kb.yaml`, its documents in subfolders, and a `questions.yaml`. `pnpm test:scripts` checks it the same way.

## Code map

- `scripts/help-kb.ts`: the screen guides, the manifest's list and the drift check, run by `pnpm help:kb`.
- `scripts/help-kb.test.ts`: the guides' format, each folder's manifest as `lobbystack onboard` reads it, and the screen guides kept current.
- `packages/cli/src/manifest.ts` and `packages/cli/src/onboard.ts`: `priority` and `tags` on FAQs and text entries.
