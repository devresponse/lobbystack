# Find the reviews

Each review looked at part of the system on a given date and listed what it found. These pages keep the findings and what happened to each since, so they stay useful as the code moves on. For how things work now, follow the links to the feature pages; for what the reviews recommended and nobody has built yet, see the [roadmap](../roadmap/README.md).

| Date | Review | Found | Since |
| --- | --- | --- | --- |
| 2026-10-06 | [The phone call path](phone-calls-2026-10-06.md) | Twelve findings, from deploys hanging up calls to lost conversation starts, and a study of moving off OpenAI | Most fixed in the original before the reset or in the fork |
| 2026-10-15 | [The website widget](widget-2026-10-15.md) | Six bugs visitors could hit, settings to change, eleven improvements | Bugs fixed in fork PR #22; improvements 1 to 4 and 7 done |
| 2026-10-15 | [How far the widget scales](widget-scalability-2026-10-15.md) | One admin process serves about 400 people chatting at once; per-business limits bind first; abuse risks of a public key | Recommendations not started |
| 2026-10-18 | [The whole codebase](codebase-2026-10-18.md) | 32 issues | 25 fixed in fork PR #42 |
| 2026-10-18 | [What limits scale](scalability-2026-10-18.md) | Connections, the single admin process, per-business jobs and shared provider accounts break before the database | Analysis only, apart from billing fixes |
| 2026-10-23 | [The billing code](../billing/design-history.md#review-the-billing-code-2026-10-23) | 33 fixes and five decisions | Fork PRs #67 to #70 |
| 2026-10-23 | [Billing, a second pass](../billing/design-history.md#make-a-second-pass-2026-10-23) | Findings on Polar, calls, security, deployments and four instances | Five fixes, fork PRs #71 to #75 |
