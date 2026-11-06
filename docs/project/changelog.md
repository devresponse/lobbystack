# Read the changelog

Every pull request merged into the fork's `main` since it was reset to the original project on 2026-10-11, newest first. Dates are the merge dates, in UTC. "Merge" is the merge commit on `main`, which `alloplace/r1` shares. "More" points to the page that describes the change as it works now.

To add a row, put the pull request under its merge date with its title, any migrations it adds and its merge commit, in the same pull request as the change if you can, or right after the merge.

[History](history.md) covers what came before, including fork PRs #2 to #4.

### 2026-11-04

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#137](https://github.com/devresponse/lobbystack/pull/137) | Read uploaded PDFs with an improved reader built on pdfjs-dist: a table's cells stay apart, footnote marks don't fuse into the amounts beside them, each page starts with a page line, and each page without text is read by OCR. `KNOWLEDGE_PDF_READER=original` on the worker goes back to the original reader, which also reads, in a new thread, any PDF the improved one can't |  | `c587715` | [docs](../knowledge/architecture.md#read-uploaded-pdfs) |
| [#136](https://github.com/devresponse/lobbystack/pull/136) | Add a command-line tool to test PDF readers, `devops/tools/pdf-parsing`: it reads a folder of PDFs with a byte-for-byte copy of the worker's reader or with pdfjs-dist, scores each reader's text, and uploads it to a test business to check the receptionist's search |  | `49181fa` | [docs](../knowledge/architecture.md#measure-how-pdfs-are-read) |

### 2026-11-03

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#131](https://github.com/devresponse/lobbystack/pull/131) | Save each knowledge search's answer in a folder from the CLI: `lobbystack knowledge search --log-dir <folder>`, or `LOBBYSTACK_KNOWLEDGE_LOG_DIR`, writes the request and the API's answer as a JSON file of its own |  | `6bb1b3c` | [docs](../features/api-cli-integrations.md#save-each-answer-in-a-folder) |
| [#130](https://github.com/devresponse/lobbystack/pull/130) | Search knowledge as the receptionist does through `POST /api/v1/knowledge/search` and `lobbystack knowledge search`, with every stage shown: the passages after ranking, the tool's result, what a call hears, and each search's scores |  | `bede2bc` | [docs](../features/api-cli-integrations.md#test-the-receptionists-knowledge-search) |

### 2026-11-02

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#128](https://github.com/devresponse/lobbystack/pull/128) | Ask for the business's website in the onboarding step's title: "What is your business's website?" in all four languages |  | `2a4004c` | [docs](../features/onboarding.md#know-what-changed-with-fork-pr-127) |
| [#127](https://github.com/devresponse/lobbystack/pull/127) | Bring the onboarding website step back, saving the address without reading the site: **Continue** calls `POST /api/onboarding/website`, which queues no crawl |  | `432a7e4` | [docs](../features/onboarding.md#know-what-the-website-step-saves) |
| [#126](https://github.com/devresponse/lobbystack/pull/126) | Take the website step out of onboarding, and keep the crawler. Fork PR #127 brought the step back the same day, saving the address and reading nothing, as the maintainer meant |  | `6c70332` | [docs](../features/onboarding.md#know-what-changed-with-fork-pr-127) |
| [#124](https://github.com/devresponse/lobbystack/pull/124) | Make the bootstrap script's `connect` use `APP_BASE_URL` whenever the settings name one, and the admin's current Railway address, read from Railway |  | `a771db6` | [docs](../../devops/bootstrap.md#6-connect-the-incoming-call-webhook-and-make-the-platform-key) |
| [#123](https://github.com/devresponse/lobbystack/pull/123) | Give a Railway template's Postgres and Redis their passwords from the start, and remove a database deployment that isn't running before deploying again, so two Postgres deployments never share the volume |  | `373c5fc` | [docs](../../devops/bootstrap.md#what-isnt-confirmed) |
| [#122](https://github.com/devresponse/lobbystack/pull/122) | Wait for Railway to finish applying a template, deploy Postgres and Redis through the API, and wait for migrate to pass |  | `60de5d1` | [docs](../../devops/bootstrap.md#4-set-it-up) |
| [#121](https://github.com/devresponse/lobbystack/pull/121) | Deploy a Railway template again with the code services' source when Railway accepts the deploy and then fails it |  | `2b9e60f` | [docs](../../devops/bootstrap.md#optional-a-private-railway-template) |
| [#120](https://github.com/devresponse/lobbystack/pull/120) | Fill the plain values Railway drops from a template before `up` deploys it, never reuse a Railway project that's being deleted, and forget the old project when its steps are redone |  | `27205df` | [docs](../../devops/bootstrap.md#running-it-again-is-safe) |
| [#119](https://github.com/devresponse/lobbystack/pull/119) | Add `TEMPLATE_REPO`, so the bootstrap template can come from a repository Railway's GitHub access reaches, and stop with what to do when it can't |  | `8593e6e` | [docs](../../devops/bootstrap.md#optional-a-private-railway-template) |
| [#118](https://github.com/devresponse/lobbystack/pull/118) | Link the bootstrap template project's code services to the repository when Railway asks, connecting them as a last resort |  | `14127e7` | [docs](../../devops/bootstrap.md#optional-a-private-railway-template) |
| [#117](https://github.com/devresponse/lobbystack/pull/117) | Give the bootstrap template project's code services a source before Railway makes the template, and deploy a template without them |  | `562f532` | [docs](../../devops/bootstrap.md#optional-a-private-railway-template) |
| [#116](https://github.com/devresponse/lobbystack/pull/116) | Let the bootstrap script make a private Railway template of the layout (`template`) and deploy it (`RAILWAY_TEMPLATE`) |  | `993b35e` | [docs](../../devops/bootstrap.md#optional-a-private-railway-template) |
| [#115](https://github.com/devresponse/lobbystack/pull/115) | Fix three bootstrap problems from its first real run: the Cloudflare zone is its domain name, GitHub's workflows are read before being turned on, and Railway's workspace ID is required and listed |  | `1ea637a` | [docs](../../devops/bootstrap.md) |

### 2026-11-01

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#114](https://github.com/devresponse/lobbystack/pull/114) | Fix the bootstrap script's tool calls on Windows, where arguments with spaces were split, and keep `status` from writing the log |  | `5e237f0` | [docs](../../devops/bootstrap.md) |
| [#111](https://github.com/devresponse/lobbystack/pull/111) | Ignore the admin's generated `next-env.d.ts`, run `next typegen` before the admin typecheck, and keep AlloPlace's Zapier logo |  | `70e3ce5` | [docs](../development/README.md) |
| [#113](https://github.com/devresponse/lobbystack/pull/113) | Add a bootstrap script that sets up a Railway environment and its outside services by API, safe to run again |  | `0ee8167` | [docs](../../devops/bootstrap.md) |
| [#112](https://github.com/devresponse/lobbystack/pull/112) | Add the RealInfoBot brand for realinfobot.com, so an address no brand claims needs `BRAND_PRESET` |  | `dd5ed7d` | [docs](../branding.md) |

### 2026-10-31

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#110](https://github.com/devresponse/lobbystack/pull/110) | Add a script that resets a test deployment's database and Redis to a freshly migrated state |  | `cf4cb87` | [docs](../deployment/guide/part-7-operations.md#728-reset-a-test-environment) |
| [#109](https://github.com/devresponse/lobbystack/pull/109) | Reduce the white space above page titles on phones |  | `0f68330` | [docs](../features/dashboard-on-phones.md) |
| [#108](https://github.com/devresponse/lobbystack/pull/108) | Archive conversations on the Messages page after a confirmation dialog | `0132` | `15f0b52` | [docs](../features/messages.md) |
| [#107](https://github.com/devresponse/lobbystack/pull/107) | Move unanswered questions to their own Questions page |  | `fd51424` | [docs](../features/unanswered-questions.md#answer-or-dismiss-a-question) |
| [#106](https://github.com/devresponse/lobbystack/pull/106) | Save the questions the receptionist said it couldn't answer |  | `94a3058` | [docs](../features/unanswered-questions.md#know-what-gets-saved) |

### 2026-10-30

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#104](https://github.com/devresponse/lobbystack/pull/104) | Log sign-ins and account changes, and report auth outages with an Error ID |  | `7ae7c43` | [docs](../features/observability.md#follow-a-sign-in) |
| [#105](https://github.com/devresponse/lobbystack/pull/105) | Port seven small fixes and the unanswered questions inbox from upstream | `0131` | `ea1449b` | [docs](../features/unanswered-questions.md) |
| [#103](https://github.com/devresponse/lobbystack/pull/103) | Add the cancel-account page to the admin page inventory |  | `3a13e4a` | [docs](../features/account-cancellation.md) |
| [#102](https://github.com/devresponse/lobbystack/pull/102) | Let an owner cancel their account's last business, deleting nothing | `0130` | `ea56853` | [docs](../features/account-cancellation.md) |
| [#101](https://github.com/devresponse/lobbystack/pull/101) | Let owners delete a business, never an account's first | `0129` | `4194360` | [docs](../features/business-deletion.md) |
| [#100](https://github.com/devresponse/lobbystack/pull/100) | Archive calls from the call page after a confirmation dialog | `0128` | `50de45a` | [docs](../features/calls.md#archive-a-call) |

### 2026-10-29

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#99](https://github.com/devresponse/lobbystack/pull/99) | Answer OpenAI's call webhook once the call is accepted |  | `23883d2` | [docs](../voice/runtime.md#follow-a-phone-call) |
| [#98](https://github.com/devresponse/lobbystack/pull/98) | Time the greeting fallback by the session's clock, and open for a caller who speaks first |  | `524d641` | [docs](../voice/runtime.md#greet-the-caller-before-they-speak) |
| [#97](https://github.com/devresponse/lobbystack/pull/97) | Record call openings with GPT-Live instead of the speech model |  | `2312ae2` | [docs](../voice/runtime.md#make-a-recording) |
| [#96](https://github.com/devresponse/lobbystack/pull/96) | Open phone calls with the recorded greeting |  | `4493bc8` | [docs](../features/calls.md#open-calls-with-a-recorded-greeting) |
| [#95](https://github.com/devresponse/lobbystack/pull/95) | Build the Make app under each brand's own name |  | `7f1f3c1` | [docs](../features/api-cli-integrations.md#connect-make) |
| [#94](https://github.com/devresponse/lobbystack/pull/94) | Publish the Zapier integration under each brand's own name |  | `5682041` | [docs](../features/api-cli-integrations.md#connect-zapier) |

### 2026-10-28

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#93](https://github.com/devresponse/lobbystack/pull/93) | Port the original's database audit fixes | `0120`, `0121`, `0122`, `0123`, `0124`, `0125`, `0126`, `0127` | `e788004` | [docs](../deployment/guide/part-7-operations.md#73-database-migrations) |
| [#92](https://github.com/devresponse/lobbystack/pull/92) | Skip Comcast's support site in the landing link check |  | `e301aae` | [docs](../deployment/guide/appendix-f-sites.md) |
| [#91](https://github.com/devresponse/lobbystack/pull/91) | Move to pnpm 12.15.0, and have Dependabot wait 3 days for a new version |  | `18a1ca4` | [docs](../deployment/guide/part-7-operations.md#722-upgrade-pinned-versions) |
| [#90](https://github.com/devresponse/lobbystack/pull/90) | Build the images on Node 26.12.1, and take nodemailer 10.1.4 and zod 4.6.6 |  | `2dcc83c` | [docs](../deployment/guide/part-7-operations.md#722-upgrade-pinned-versions) |

### 2026-10-27

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#89](https://github.com/devresponse/lobbystack/pull/89) | Show a yearly price's month in whole units, and the months it leaves free | `0119` | `9cddd87` | [docs](../billing/README.md#know-the-plans) |
| [#86](https://github.com/devresponse/lobbystack/pull/86) | Raise Starter to $37 and lower Pro to $87 a month |  | `fabb536` | [docs](../billing/README.md#know-the-plans) |
| [#88](https://github.com/devresponse/lobbystack/pull/88) | Show the brand's billing.json plans before a deployment's first apply |  | `edad2bf` | [docs](../billing/README.md#know-the-plans) |
| [#87](https://github.com/devresponse/lobbystack/pull/87) | Use the only brand folder where no address or preset picks one |  | `141a4cd` | [docs](../branding.md) |
| [#85](https://github.com/devresponse/lobbystack/pull/85) | Add a roadmap of the researched features to docs |  | `cccf0ac` | [docs](../roadmap/README.md) |

### 2026-10-26

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#84](https://github.com/devresponse/lobbystack/pull/84) | Email the team after each call, and say calls are with an AI and recorded | `0117`, `0118` | `c074ae4` | [docs](../features/email.md#email-the-team-after-each-call) |

### 2026-10-25

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#83](https://github.com/devresponse/lobbystack/pull/83) | Keep Linux line endings in Windows checkouts |  | `62517d2` | [docs](../voice/local-debugging.md#line-endings-on-windows) |
| [#82](https://github.com/devresponse/lobbystack/pull/82) | Let calls open in any of 13 languages |  | `f933e19` | [docs](../features/calls.md#know-which-language-a-call-uses) |
| [#78](https://github.com/devresponse/lobbystack/pull/78) | Keep calls in the caller's language and test it in Spanish, merged with #82 |  | `f933e19` | [docs](../features/calls.md#know-which-language-a-call-uses) |
| [#81](https://github.com/devresponse/lobbystack/pull/81) | Answer website chats in the visitor's language |  | `a2e57ff` | [docs](../features/website-widget.md#know-which-language-the-chat-uses) |
| [#80](https://github.com/devresponse/lobbystack/pull/80) | Leave GPT-Live's sound tags out of call captions and transcripts |  | `f30fce3` | [docs](../features/calls.md) |
| [#79](https://github.com/devresponse/lobbystack/pull/79) | Say why a website chat reply failed |  | `8280dab` | [docs](../features/website-widget.md#find-out-why-a-reply-failed) |

### 2026-10-24

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#77](https://github.com/devresponse/lobbystack/pull/77) | Make docs/ the project's source of truth |  | `1a2c81b` | [docs](../README.md) |
| [#76](https://github.com/devresponse/lobbystack/pull/76) | Bring the Polar token note and two billing docs up to date |  | `da1f548` | [docs](../providers/polar.md) |
| [#75](https://github.com/devresponse/lobbystack/pull/75) | Send usage corrections to Polar and make billing changes take turns | `0116` | `24e211d` | [docs](../billing/design-history.md) |
| [#74](https://github.com/devresponse/lobbystack/pull/74) | Limit checkouts and the portal, and keep tokens off the webhook secret |  | `7d20322` | [docs](../billing/design-history.md) |
| [#73](https://github.com/devresponse/lobbystack/pull/73) | Invoice annual plans' overage monthly and pin the Polar API version |  | `35af54b` | [docs](../billing/design-history.md) |
| [#72](https://github.com/devresponse/lobbystack/pull/72) | Give each business its own Polar customer | `0115` | `cc0c65d` | [docs](../billing/design-history.md) |
| [#71](https://github.com/devresponse/lobbystack/pull/71) | Run billing work again when its job gives up or its worker dies | `0114` | `1d4c172` | [docs](../billing/design-history.md) |

### 2026-10-23

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#70](https://github.com/devresponse/lobbystack/pull/70) | One promo code use per business, a per-key code limit, and one included number | `0113` | `fa0aa11` | [docs](../billing/design-history.md) |
| [#69](https://github.com/devresponse/lobbystack/pull/69) | Bill monthly plans' overage each month, without Polar Credits |  | `91d5c3a` | [docs](../billing/design-history.md) |
| [#68](https://github.com/devresponse/lobbystack/pull/68) | Spending cap refuses only usage that pushes spend past it |  | `de62667` | [docs](../billing/design-history.md) |
| [#67](https://github.com/devresponse/lobbystack/pull/67) | Billing review: fix bugs, comments and docs across the billing workflow |  | `40435d2` | [docs](../billing/design-history.md) |
| [#66](https://github.com/devresponse/lobbystack/pull/66) | Billing step 10: optional product ID variables, number claims by allowance | `0112` | `d800141` | [docs](../billing/design-history.md) |
| [#65](https://github.com/devresponse/lobbystack/pull/65) | Billing step 9: promo plans end at the renewal after their months | `0111` | `68b74ba` | [docs](../billing/design-history.md) |
| [#64](https://github.com/devresponse/lobbystack/pull/64) | Give promo plans their own allowances | `0110` | `3abf71a` | [docs](../billing/design-history.md) |
| [#63](https://github.com/devresponse/lobbystack/pull/63) | Sell money-off promo codes with a "Have a promo code?" link | `0109` | `6120baf` | [docs](../billing/design-history.md) |

### 2026-10-22

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#62](https://github.com/devresponse/lobbystack/pull/62) | Enforce the billing catalog's allowances, rates, storage and numbers |  | `a067534` | [docs](../billing/design-history.md) |
| [#61](https://github.com/devresponse/lobbystack/pull/61) | Show the billing catalog's plans on the plan screens and sell its linked products |  | `b6ba2aa` | [docs](../billing/design-history.md) |
| [#60](https://github.com/devresponse/lobbystack/pull/60) | Upgrade a paying Starter business to Pro on its own Polar subscription |  | `a6ff674` | [docs](../billing/design-history.md) |
| [#59](https://github.com/devresponse/lobbystack/pull/59) | Set Polar up from billing.json, link it to the catalog and check it daily |  | `a44f995` | [docs](../billing/design-history.md) |

### 2026-10-21

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#58](https://github.com/devresponse/lobbystack/pull/58) | Add the billing catalog: billing.json, its tables and the apply API | `0108` | `4a8204a` | [docs](../billing/design-history.md) |

### 2026-10-20

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#57](https://github.com/devresponse/lobbystack/pull/57) | Show the deployed commit under the sidebar's account menu |  | `fa94777` | [docs](overview.md#know-where-it-runs) |
| [#56](https://github.com/devresponse/lobbystack/pull/56) | Point the Messages send arrow right and widen two AI settings fields |  | `52bcf45` |  |
| [#55](https://github.com/devresponse/lobbystack/pull/55) | Text from the business's own number when it has one | `0107` | `35752f7` | [docs](../features/sms.md) |
| [#54](https://github.com/devresponse/lobbystack/pull/54) | Warn callers before the time limit and say goodbye before hanging up |  | `9b66d01` | [docs](../features/calls.md) |

### 2026-10-19

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#53](https://github.com/devresponse/lobbystack/pull/53) | Keep knowledge after the matched chunk in call answers |  | `dfce1a2` | [docs](../features/calls.md) |
| [#47](https://github.com/devresponse/lobbystack/pull/47) | Give Docker Compose businesses the self-hosted plan and fix the local setup steps |  | `7893d2e` | [docs](../deployment/guide/README.md) |
| [#52](https://github.com/devresponse/lobbystack/pull/52) | Play the recorded greeting once the caller's audio connects, and caption it |  | `3202c18` | [docs](../features/calls.md) |
| [#51](https://github.com/devresponse/lobbystack/pull/51) | Keep an AI debug trace of each chat reply and call turn | `0106` | `1eeff31` | [docs](../adr/0009-ai-conversation-traces.md) |
| [#50](https://github.com/devresponse/lobbystack/pull/50) | Stop voice calls inventing names from short knowledge answers |  | `f1861ee` | [docs](../features/calls.md) |

### 2026-10-18

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#49](https://github.com/devresponse/lobbystack/pull/49) | Say why a website call didn't start, and allow more of them |  | `d18f916` | [docs](../features/website-widget.md) |
| [#48](https://github.com/devresponse/lobbystack/pull/48) | Run a transaction's queries one at a time |  | `2f6b240` | [docs](../development/README.md#keep-a-transactions-queries-in-order) |
| [#45](https://github.com/devresponse/lobbystack/pull/45) | Open browser calls with a recording of the greeting |  | `ae3faf6` | [docs](../features/calls.md) |
| [#46](https://github.com/devresponse/lobbystack/pull/46) | Lay out every email on separate lines and say why it was sent |  | `160b18a` | [docs](../features/email.md) |
| [#44](https://github.com/devresponse/lobbystack/pull/44) | Recheck Twilio prices later and report a missing one as a warning |  | `6052282` | [docs](../features/sms.md) |
| [#43](https://github.com/devresponse/lobbystack/pull/43) | Keep Messages and the website chat updating after a dropped connection |  | `4acd319` | [docs](../features/website-widget.md) |
| [#42](https://github.com/devresponse/lobbystack/pull/42) | Fix main's release checks and the 24 other approved review issues | `0104`, `0105` | `ca9a6e0` | [docs](../reviews/codebase-2026-10-18.md) |
| [#41](https://github.com/devresponse/lobbystack/pull/41) | Tag logs, errors, spans and jobs with the call they belong to | `0103` | `7a63397` | [docs](../features/observability.md) |

### 2026-10-17

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#40](https://github.com/devresponse/lobbystack/pull/40) | Remove the old BRAND_* and NEXT_PUBLIC_* branding variables |  | `6962ae5` | [docs](../branding.md) |
| [#26](https://github.com/devresponse/lobbystack/pull/26) | Start the widget's conversation with the visitor's first message |  | `432ab8a` | [docs](../features/website-widget.md) |
| [#39](https://github.com/devresponse/lobbystack/pull/39) | Finish brand files: email logo, sender name, share image |  | `1860c1e` | [docs](../branding.md) |
| [#38](https://github.com/devresponse/lobbystack/pull/38) | Pick each deployment's brand from brand files by its domain |  | `9d12555` | [docs](../branding.md) |
| [#37](https://github.com/devresponse/lobbystack/pull/37) | Name the deployment, not LobbyStack, in the API, MCP, demos and Zapier | `0102` | `450a173` | [docs](../branding.md) |
| [#36](https://github.com/devresponse/lobbystack/pull/36) | Call the app by the deployment's name in emails and texts |  | `3ffc6a9` | [docs](../branding.md) |
| [#35](https://github.com/devresponse/lobbystack/pull/35) | Show the dashboard's onboarding stage on GET /business and GET /businesses |  | `3ee2425` | [docs](../features/api-cli-integrations.md) |
| [#34](https://github.com/devresponse/lobbystack/pull/34) | Add the fields the v1 API was missing from the database |  | `1992e13` | [docs](../features/api-cli-integrations.md) |
| [#33](https://github.com/devresponse/lobbystack/pull/33) | Add the public profile page to the v1 API and the CLI |  | `7c664c1` | [docs](../features/api-cli-integrations.md) |
| [#32](https://github.com/devresponse/lobbystack/pull/32) | Say why a phone number pick failed, and log the real error |  | `45f7e7f` | [docs](../features/phone-numbers.md) |
| [#31](https://github.com/devresponse/lobbystack/pull/31) | Show the business ID above the API keys |  | `05347bc` | [docs](../features/api-cli-integrations.md) |
| [#30](https://github.com/devresponse/lobbystack/pull/30) | Show the browser call button as soon as a business gets its number | `0101` | `024eed2` | [docs](../features/website-widget.md) |
| [#29](https://github.com/devresponse/lobbystack/pull/29) | Add a QR code settings tab with printable signs |  | `6d93ffb` | [docs](../features/public-profile-and-qr.md) |

### 2026-10-16

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#28](https://github.com/devresponse/lobbystack/pull/28) | Give each business a public profile page | `0100` | `465e683` | [docs](../features/public-profile-and-qr.md) |
| [#27](https://github.com/devresponse/lobbystack/pull/27) | Send the dashboard's outside links to alloplace.com |  | `7335f25` | [docs](../branding.md) |
| [#25](https://github.com/devresponse/lobbystack/pull/25) | Check the widget's chat and call allowances without writing |  | `62ebb2b` | [docs](../features/website-widget.md) |
| [#24](https://github.com/devresponse/lobbystack/pull/24) | Register the widget visitor and mark its key once per session |  | `c5f0c5d` | [docs](../features/website-widget.md) |
| [#23](https://github.com/devresponse/lobbystack/pull/23) | Load the widget's chat history at the same time as its settings |  | `696331b` | [docs](../features/website-widget.md) |

### 2026-10-15

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#22](https://github.com/devresponse/lobbystack/pull/22) | Fix six website widget bugs and keep PostHog out of the widget |  | `9f9c30e` | [docs](../features/website-widget.md) |
| [#21](https://github.com/devresponse/lobbystack/pull/21) | Make web addresses in the website chat clickable |  | `508f659` | [docs](../features/website-widget.md) |
| [#20](https://github.com/devresponse/lobbystack/pull/20) | Point the website chat's send arrow to the right |  | `d5e444c` | [docs](../features/website-widget.md) |

### 2026-10-14

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#19](https://github.com/devresponse/lobbystack/pull/19) | Live chat with your team in the website widget | `0099` | `84e3388` | [docs](../features/website-widget.md) |
| [#18](https://github.com/devresponse/lobbystack/pull/18) | Tell the receptionist when a call or chat can't be transferred |  | `3360ba0` | [docs](../features/website-widget.md) |
| [#17](https://github.com/devresponse/lobbystack/pull/17) | Default the app name and logo to AlloPlace |  | `38d8f6d` | [docs](../branding.md) |
| [#16](https://github.com/devresponse/lobbystack/pull/16) | Make the app name and logo configurable | `0098` | `fb105ad` | [docs](../branding.md) |

### 2026-10-13

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#15](https://github.com/devresponse/lobbystack/pull/15) | Add a guide to run and debug LobbyStack locally with Docker |  | `a0afd44` | [docs](../voice/local-debugging.md) |
| [#14](https://github.com/devresponse/lobbystack/pull/14) | Set and generate contact keypad PINs through the API |  | `4af21ae` | [docs](../features/caller-authentication.md) |
| [#13](https://github.com/devresponse/lobbystack/pull/13) | Let callers change appointments with a keypad PIN | `0097` | `69799bf` | [docs](../features/caller-authentication.md) |
| [#12](https://github.com/devresponse/lobbystack/pull/12) | Send replies from Messages to customers who texted first |  | `c82f0cf` | [docs](../features/sms.md) |

### 2026-10-12

| PR | What changed | Migrations | Merge | More |
| --- | --- | --- | --- | --- |
| [#11](https://github.com/devresponse/lobbystack/pull/11) | Widget: load in the widget's color without moving anything |  | `8b5aebd` | [docs](../features/website-widget.md) |
| [#10](https://github.com/devresponse/lobbystack/pull/10) | Keep the website chat one size, follow streaming replies, and add a Say Allo! call button |  | `4d405b2` | [docs](../features/website-widget.md) |
| [#9](https://github.com/devresponse/lobbystack/pull/9) | Show live captions during widget voice calls and ask before leaving |  | `90d82c2` | [docs](../features/website-widget.md) |
| [#8](https://github.com/devresponse/lobbystack/pull/8) | Keep the receptionist on topic and cap website chat replies |  | `4813f36` | [docs](../features/website-widget.md) |
| [#7](https://github.com/devresponse/lobbystack/pull/7) | Let the dashboard set the widget bubble's look and show the snippet again | `0096` | `5c82648` | [docs](../features/website-widget.md) |
| [#6](https://github.com/devresponse/lobbystack/pull/6) | Show Widgets in the dashboard menu and validate the widget settings |  | `72c818b` | [docs](../features/website-widget.md) |
| [#5](https://github.com/devresponse/lobbystack/pull/5) | Onboard businesses through the API and the lobbystack CLI | `0092`, `0093`, `0094`, `0095` | `ba5b16a` | [docs](../features/api-cli-integrations.md) |

### Direct commits on `main`

These commits reached `main` without a pull request:

| Date | Commit | What changed |
| --- | --- | --- |
| 2026-10-12 | `2d8532a` | Keep the API route and MCP tests off the real per-key rate limiter: with `REDIS_URL` set, as in CI, they shared one key's 120 requests a minute and failed with 429s. |
| 2026-10-12 | `044e8f3` | Run the original project's production release job only in the original's repository. |
| 2026-10-12 | `85adb66` | Tell GPT-Live that only the backend can transfer a call, after it said "Connecting you now" on two demo calls without asking the backend to transfer. |
| 2026-10-15 | `acaab6a` | A comment in `packages/db/src/index.ts`, so a push rebuilds and redeploys the admin, worker and migrator, which all watch that path. |
| 2026-10-27 | `37c35d2` | Let Way B's image build read a `pnpm-lock.yaml` with Windows line endings, from a Windows clone made before fork PR #83, and say how to give such a clone Linux line endings everywhere ([line endings on Windows](../voice/local-debugging.md#line-endings-on-windows)). |
| 2026-10-27 | `5312092` | Note Way B's first run, on Windows, and add IIS holding port 80 and Docker Desktop restarting mid-build to the local troubleshooting table ([2.10](../deployment/guide/part-2-local-development.md#210-if-something-fails-locally)). |
| 2026-10-27 | `fd36d0a` | Line up the columns of the tables in `docs/README.md` and `docs/project/overview.md`. |
| 2026-10-27 | `26c582d` | Add the maintainer's `polar-setup.mjs` and `railway-vars.mjs` to `devops/`, and point the billing docs and the guide at them. |
| 2026-10-27 | `d6fb078` | List `26c582d` in this table. |
| 2026-10-27 | `0beb75b` | Add two of the maintainer's PowerShell scripts to `devops/`: `delete-kb.ps1` deletes one business's whole knowledge base through the `lobbystack` command, and `reload-kb-from-pdfs.ps1` does the same, then uploads every PDF in a folder to be read again. |
| 2026-11-02 | `b26ac4a` | Give the bootstrap script an `APP_BASE_URL` setting, the dashboard's own address (`CUSTOM_HOST` still works), and a phase after the deploy that makes sure its CNAME is in Cloudflare, that the admin's and the worker's addresses and `AUTH_TRUSTED_ORIGINS` match the settings, and that the Turnstile widget lists both addresses ([set it up](../../devops/bootstrap.md#4-set-it-up)). The commit after it tidies the certificate message, records the first run with it, and lists it here. |
| 2026-11-02 | `099fd24` | Tidy the bootstrap script's certificate message, and record its first run with `APP_BASE_URL` in its docs ([what isn't confirmed](../../devops/bootstrap.md#what-isnt-confirmed)). |
| 2026-11-02 | `9622842` | Fix what a review of the bootstrap script found: a lock and a check so two runs never write over each other's progress, **BY HAND** steps that stay open under `--yes`, a stop on a deleted Railway project, a `redo railway.project` that clears every step of the project, DNS records named in full, and a webhook step that names the OpenAI project. Its messages and docs now point at this repository's deployment guide ([bootstrap](../../devops/bootstrap.md)). |
| 2026-11-02 | `970ba1b` | List `9622842` in this table. |
| 2026-11-02 | `df0a0ed` | Record the first answered phone call: guide 3.2 and 4.9 say to check the webhook's project before asking OpenAI support, and the bootstrap's roadmap page and decision now cover only the four fork changes still proposed ([what isn't confirmed](../../devops/bootstrap.md#what-isnt-confirmed)). |
| 2026-11-02 | `efca2f4` | Name a deployment's projects after `APP_BASE_URL`, with `NAME` as the fallback, and keep each name once used, so a changed setting renames nothing; find things by their recorded IDs and stop on a name that matches two; pass a redone value on to Railway; and on a running deployment set only the variables that differ ([what things are named](../../devops/bootstrap.md#what-things-are-named)). |
| 2026-11-02 | `99ab598` | List `efca2f4` in this table. |
