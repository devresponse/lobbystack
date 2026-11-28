# RealInfoBot's sales knowledge base

Everything a RealInfoBot business needs to sell RealInfoBot to the people who visit realinfobot.com or call about it: real estate agents, teams, brokerages, landlords and property managers. It holds the pitch, the benefits, every feature with how to explain it, use-case scenarios, the plans and which one fits whom, honest answers to common concerns, comparisons, trust and privacy, and the next steps. One command loads it into a business through the API and makes that business's AI agent RealInfoBot's sales assistant.

It's for prospects only. Existing customers' how-to and billing questions belong to the support knowledge base in [`../realinfobot/`](../realinfobot/README.md), which has a guide to every screen of the app.

## What's in this folder

| Path | What it is |
| --- | --- |
| `realinfobot-sales-kb.yaml` | The import file for `lobbystack onboard`: the 12 documents, 8 sales FAQs, and the sales assistant's greeting, summary and instructions. |
| `guides/` | 12 sales guides, written from the app, its billing settings, realinfobot.com, its free guide for agents and the support guides. Edit them by hand. |
| `questions.yaml` | 100 questions worded the way prospects ask them, each with the documents that answer it. |

Together that's about 90 KB of text, which the knowledge base cuts into about 130 passages.

## How it sells

The sales assistant's instructions, in the manifest's `chat_instructions` and `voice_instructions`, give it a way to run every conversation:

1. **Find out who it's talking to,** one question at a time: a solo agent, a team, a brokerage or a landlord; how many listings now and over a year; what happens today when they can't answer a call from the sign.
2. **Lead with what the person gets,** then the feature that gives it, with a short example from their day: the 8 pm drive-by, a call during a showing, the open house, a buyer who speaks another language.
3. **Recommend a plan** and say why: one listing, the 1-listing pack; two or three at once, the 3-listing pack; four or more, the 6-listing pack; just exploring, the free plan; a brokerage or more than six at once, RealInfoBot's team.
4. **Answer concerns honestly,** from `guides/08-concerns-and-honest-answers.md`, without pressure or criticizing anyone.
5. **Offer one next step,** matched to where the person is: the sample listing on https://realinfobot.com/ca, the free guide, sign-up at https://ca.realinfobot.com/en/signup, setup help from support@realinfobot.com, or a message for RealInfoBot's team to call back, with the person's name, number and what they want.

The guides carry selling notes on lines that start with **Say it simply:** (a line the assistant can use as is), **Example:** (a short scenario), **Good question to ask:** (a discovery question), **Best fit:** (the plan that usually fits) and **Next step:** (what to offer). The instructions tell the assistant to use them and never read out the labels. The app treats knowledge as reference data, not instructions, which is why the guidance on how to use them sits in the assistant's own instructions.

Every fact follows the app, as the maintainer chose on 2026-11-28 for the support knowledge base: the assistant says plainly that the AI doesn't reply to texts, that it answers its own RealInfoBot number rather than the agent's, that an account has one number, and that there's no MLS connection, and it never invents a number, a customer or a result.

## Before you load it

1. **Make a business for sales alone,** such as "RealInfoBot Sales", separate from the support business. Documents, FAQs, rules and the business summary are shared by every AI agent of a business, so support and sales in one business would mix their answers, and both sets of FAQs would compete for the 8 every chat and call keeps ready.
2. **Give it room.** On the free plan the assistant answers 5 website chats and 30 voice minutes a month, then stops. A managed plan has no allowances: with the deployment's operator platform key, run `pnpm -s lobbystack billing managed-plan --business <business id>`.
3. **Make an API key** in that business, as an owner or admin: **Settings** > **API keys**, with `business:read`, `business:write`, `knowledge:read` and `knowledge:write`.
4. **Match the name and time zone.** `business.name` and `business.timezone` in `realinfobot-sales-kb.yaml` are set for RealInfoBot's sales business on ca.realinfobot.com. For any other business, make them its own, letter for letter. A different name stops the run before anything changes, but a different time zone, or the same name in other capitals, changes the business. `pnpm -s lobbystack business get` shows both.

## Load it

Run these from the repository's folder. In PowerShell:

```powershell
# Once: save the sales business's key as its own profile. Paste it into key.txt, then delete key.txt.
Get-Content key.txt | pnpm -s lobbystack login --url https://ca.realinfobot.com --key-stdin --profile realinfobot-sales
pnpm -s lobbystack whoami --profile realinfobot-sales
pnpm -s lobbystack business get --profile realinfobot-sales

# What a run would change. This changes nothing.
pnpm -s lobbystack onboard devops/kb/realinfobot-sales/realinfobot-sales-kb.yaml --plan --profile realinfobot-sales

# Load it.
pnpm -s lobbystack onboard devops/kb/realinfobot-sales/realinfobot-sales-kb.yaml --profile realinfobot-sales
```

In bash, log in with `pnpm -s lobbystack login --url https://ca.realinfobot.com --key-stdin --profile realinfobot-sales < key.txt`. Keep `--profile realinfobot-sales` on every command, so nothing lands in the support business by mistake.

Check the `--plan` output before the real run: `business found` names the sales business, `details unchanged`, `receptionist would update` lists the greeting, summary, voice and chat instructions and booking mode, and there are 12 `files would upload` lines and 8 `FAQs would add` lines.

The run writes `realinfobot-sales-kb.state.json` next to the manifest, which git ignores. Keep it: the next run uses it to replace only what changed, and without it every document uploads again as a second copy. The support README's [state file](../realinfobot/README.md#the-state-file) section says what to do if it's lost.

## Put it in front of prospects

- **On realinfobot.com:** in the sales business, create a widget on the **Website widget** screen, with every address the website is served from in **Allowed origins**, such as `https://realinfobot.com` and `https://www.realinfobot.com`, and give its snippet to whoever runs the website. Tick **Ask visitors for their contact details**, shown as **Lead form** on the widget's card, so the chat asks for a name, email and phone number.
- **On its own page:** choose the widget on **Settings** > **Public profile** and select **Publish page**, then share the page's link.
- **By phone:** pick a number on **Settings** > **Phone Number**, and the assistant answers it with the voice instructions.

Messages the assistant takes for a call back land on the sales business's **Home** screen under **Action required**, and on **Messages**. Turn on alerts on **Settings** > **Notifications** for whoever follows up.

## Check it

- **Search:** `pnpm -s lobbystack knowledge search "Which package should I get with 2 listings?" --profile realinfobot-sales` shows the passages a chat or call would find. The documents under `answered_by` in `questions.yaml` should be among them.
- **Talk to it:** select **Test Call** at the top right of the dashboard, or chat on the published page, and play a prospect: a solo agent with one listing, a team with eight, someone who thinks it's too expensive.
- **Fill the gaps:** **Agent** > **Questions** lists what the assistant couldn't answer. Add the answer to the guide it belongs in, and run the import again.

A keyword-only run of the 100 questions, with the app's own passage cutting and keyword ranking, found a document that answers 97 of them among the first 6 passages. The other 3, "Who is this for?", "What can't it do?" and "How much is it?", are made only of words the keyword search leaves out; the meaning-based half of the search, which runs alongside it in the app, and the FAQ on prices answer them.

## How it's written

The same rules as the support knowledge base's [How it's written](../realinfobot/README.md#how-its-written): one question per section in the words a prospect would use, each section standing alone and naming RealInfoBot, full links, "Also asked as" lines with other words for the subject, and no section over 1,500 characters. `pnpm test:scripts` checks the section lengths, that the manifest lists every document once and reads as `lobbystack onboard` reads it, and that `questions.yaml` names only documents the manifest lists.

The 8 FAQs, at priority 100 down to 93, are the questions prospects ask most: the price, what it is, how to start, which plan, subscription and refund, calls and texts, what the assistant will and won't say, and how to reach a person.

## Keep it current

- **A price or a plan changed:** edit `guides/07-plans-and-choosing.md`, the plan advice in `guides/05-use-case-scenarios.md`, `guides/06-who-its-for.md` and `guides/08-concerns-and-honest-answers.md`, the business summary and both sets of instructions in the manifest, and the FAQs on price and plans. Then run the import again.
- **A feature changed:** edit the guide that sells it, usually `guides/03-features-buyers-use.md` or `guides/04-features-agents-use.md`, and `guides/12-quick-facts.md`. The support guides in `../realinfobot/guides/` are the facts to check against.
- **realinfobot.com changed its message:** the pitch is in `guides/01-why-realinfobot.md`. Where the website and the app differ, follow the app.
- **A document left the manifest:** the import never deletes, so delete it on the **Knowledge** screen.
