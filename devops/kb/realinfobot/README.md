# RealInfoBot's support knowledge base

Everything a RealInfoBot business needs to answer questions about RealInfoBot itself: what it does, setting it up, every screen of the app, plans, prices and billing, privacy and the terms, and fixing common problems. One command loads it into a business through the API and makes that business's AI agent RealInfoBot's support assistant.

## What's in this folder

| Path | What it is |
| --- | --- |
| `realinfobot-kb.yaml` | The import file for `lobbystack onboard`: the 60 documents, 8 FAQs, and the support assistant's greeting, summary and instructions. |
| `guides/` | 19 topic guides, written for this knowledge base from the app, its billing settings, realinfobot.com and the legal pages. Edit them by hand. |
| `screens/` | 41 screen guides, one for each help page of the app. `pnpm help:kb` writes them from the help center, so don't edit them by hand. |
| `help-kb.json` | The settings `pnpm help:kb` reads: the app's name and address, and the help pages left out, each with why. |
| `questions.yaml` | 86 support questions worded the way agents ask them, each with the documents that answer it. |

Together that's about 580 KB of text, which the knowledge base cuts into about 1,060 passages.

## Before you load it

1. **Pick the business.** Use a business that exists only for RealInfoBot support. The documents are for every AI agent of the business, and the run rewrites the default AI agent's greeting, summary, instructions and booking mode, so a business with real listings would start answering its buyers about RealInfoBot.
2. **Give it room.** On the free plan the assistant answers 5 website chats and 30 voice minutes a month, then stops, and the documents take about 0.6 MB of the plan's 1 MB. A managed plan has no allowances: with the deployment's operator platform key, run `pnpm -s lobbystack billing managed-plan --business <business id>`. A listing pack works too.
3. **Make an API key.** As an owner or admin of the business, open **Settings** > **API keys**, create a key with `business:read`, `business:write`, `knowledge:read` and `knowledge:write`, and copy it.
4. **Match the name and time zone.** `business.name` and `business.timezone` in `realinfobot-kb.yaml` must be the business's own, letter for letter. A different name stops the run before anything changes, but a different time zone, or the same name in other capitals, changes the business. `pnpm -s lobbystack business get` shows both.

## Load it

Run these from the repository's folder. In PowerShell:

```powershell
# Once: save the key as its own profile. Paste it into key.txt, then delete key.txt.
Get-Content key.txt | pnpm -s lobbystack login --url https://ca.realinfobot.com --key-stdin --profile realinfobot-support
pnpm -s lobbystack whoami
pnpm -s lobbystack business get

# What a run would change. This changes nothing.
pnpm -s lobbystack onboard devops/kb/realinfobot/realinfobot-kb.yaml --plan

# Load it.
pnpm -s lobbystack onboard devops/kb/realinfobot/realinfobot-kb.yaml
```

In bash, log in with `pnpm -s lobbystack login --url https://ca.realinfobot.com --key-stdin --profile realinfobot-support < key.txt`. The login makes `realinfobot-support` the profile every later command uses; add `--profile realinfobot-support` to a command to be sure.

Check the `--plan` output before the real run:

- `business found` names the support business.
- `details unchanged`. If it says `would update`, fix the name or time zone in the manifest first.
- `receptionist would update` lists greeting, summary, voice_instructions, chat_instructions and booking_mode.
- 60 `files would upload` lines and 8 `FAQs would add` lines.

The run uploads the 60 documents one by one, which takes a few minutes, and the app reads each one soon after. `pnpm -s lobbystack knowledge sources` shows each document's status, and they're all ready once every one says `indexed`.

### The state file

The run writes `realinfobot-kb.state.json` next to the manifest, with the IDs of what it uploaded. Git ignores it, so it stays on your computer. Keep it: the next run uses it to replace only the documents that changed. Without it, a run uploads every document again as a second copy. If it's lost, delete the old documents on the **Knowledge** screen first, or start over with `devops/delete-kb.ps1 -Business <business id> -Profile realinfobot-support -StateFile <state file> -DryRun`, which lists everything it would delete of the business's knowledge; without `-DryRun` it deletes it all.

A state file belongs to one dashboard. To load the same knowledge into a test deployment too, give each its own with `--state`, such as `--state devops/kb/realinfobot/dev2.state.json`.

### Knowledge only

To load the documents and FAQs without changing the AI agent, delete the `receptionist:` section from the manifest before you run it. The knowledge works without it, but the agent keeps its own greeting and instructions, which were written for a listing, not for support.

## Check it

- **Search:** `pnpm -s lobbystack knowledge search "How much does the 3-listing pack cost?"` runs the search a chat or call runs and shows the passages it finds. Try the questions in `questions.yaml`: the documents under `answered_by` should be among the passages.
- **Talk to it:** select **Test Call** at the top right of the dashboard, or chat on the business's public page once a widget is chosen on **Settings** > **Public profile**.
- **Fill the gaps:** **Agent** > **Questions** lists what the assistant couldn't answer. Answer a question there, or add the answer to the guide it belongs in and run the import again.

## How it's written

The knowledge base cuts every document at each Markdown heading, then into passages of at most 1,800 characters. A search finds passages, not documents, and hands the AI agent a handful of them. So the documents are written for that:

- **One question per section.** Every heading is a question in the words an agent would use, such as "Can I get a refund?", and the section under it answers that question alone. No section is longer than 1,500 characters, so each one stays a single passage with its heading.
- **Each passage stands alone.** Sections name RealInfoBot, the screen and the buttons rather than saying "it" or "above", and give links in full, such as https://ca.realinfobot.com/settings/plan.
- **"Also asked as" lines** list other words for a section's subject, such as "money back, refund policy, return, cancel my purchase" under "Can I get a refund?", so the keyword half of the search finds it whatever words the person uses.
- **The screen guides** each name their screen in every heading, such as "How to invite someone to the team, on the Team screen", because a passage from the middle of a document is read without the document's first lines. `pnpm help:kb` leaves out the help pages listed in `help-kb.json`, such as monthly plans and the spending cap, which RealInfoBot doesn't sell. `guides/19-plan-and-usage-screens.md` describes RealInfoBot's own Plan and Usage screens instead.
- **The 8 FAQs** are the questions asked most. Every chat and call has the 8 FAQs with the highest priority ready, without a search, so the manifest gives these 93 to 100. Keep it at 8: a ninth with a lower priority is used only when a search leaves room.
- **Order:** a chat or call names the 40 documents added or changed last as what it can look up, so the manifest lists the screen guides first and the topic guides last, which uploads the topic guides last.

A keyword-only run of the 86 questions in `questions.yaml`, with the app's own passage cutting and keyword ranking, found a document that answers 85 of them among the first 6 passages. The one it missed, "What is a receptionist?", is answered by the assistant's instructions. The meaning-based half of the search, which needs the deployment's embeddings, runs alongside it in the app.

## Keep it current

- **A help page changed:** run `pnpm help:kb`, which rewrites the screen guides and the list of them in the manifest. A test fails until you do. Then run the import again: only the changed documents are uploaded, and their old copies deleted.
- **A fact changed,** such as a price: edit the guides that give it and the FAQ answers, then run the import again. Prices are in `guides/04-plans-and-pricing.md`, `guides/05-billing-and-payments.md`, `guides/16-quick-answers.md`, `guides/19-plan-and-usage-screens.md` and the first FAQ.
- **A document left the manifest:** the import never deletes, so delete the document on the **Knowledge** screen. `pnpm help:kb` says so when it removes a screen guide.
- **A guide or FAQ changed:** run the import again. A changed FAQ answer, priority or label is updated in place.

## Where the website and the app differ

Where realinfobot.com or the legal pages say something the app doesn't do, the knowledge base follows the app, and summarizes the legal pages without the parts that differ. The maintainer chose this on 2026-11-28, and the website and the legal pages are to change to match the app:

- The Terms of Service describe a Listing Pass in US dollars, with 300 minutes and 500 text replies, and credits that expire after 12 months. The app sells packs in Canadian dollars: 250 minutes and 300 website chats for 180 days, or 3 or 6 listings at once for 365 days.
- The website and its blog say buyers can text the listing and get answers. The AI never answers texts: they wait on the **Messages** screen for a person.
- The United States pages show US dollars, but the app charges Canadian dollars.
- The website says RealInfoBot reads a listing from its link. The website step of setup only saves the address, and the assistant learns from documents and text.
