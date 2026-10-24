# Weigh a QR place guide

On 2026-10-10 a market study looked at a no-login AI guide that anyone reaches by scanning a QR code or tapping an NFC tag at a place, such as an office lobby, a mall, a downtown or a historic site, and at how it could be billed: by placement, by promotion or per lead. It covered the US and Canada, drew on about 120 sources, and changed no code. Figures are in US dollars and October 2026 prices. **Its verdict: there is a market only if place owners pay.** Whether to run the pilot it proposes, and whether to build the guide, is undecided ([open items](../project/open-items.md)).

## Know the answer

- **Owner-paid guides fit; ad-funded ones don't.** A passive sign turns under 2% of passers-by into scans, too few for advertising or lead fees to carry the product alone.
- **Sell first to downtown business improvement districts** (BIDs in the US, BIAs in Canada), co-sold with the local tourism board. The median New York BID spends $114,000 a year on marketing, and BIDs exist to send visitors to their members, who become the sponsor and lead buyers.
- **Lead with an annual owner subscription:** $199 a month per site or $499 per district or large venue. Upsell labelled sponsor slots at $149 a month and lead fees of $8 to $39.
- **The risks:** thin traffic per sign, incumbents adding chat to venue maps and screens, and liability for wrong answers.
- **Next step proposed:** a 90-day paid pilot with one BID, 15 signs and a $1,500 fee, stopped if the median sign draws under 5 scans a week.

## Know the demand

People already scan for information and ask AI: 75% of US consumers say information is their top reason to scan, and about 49% of US adults used AI chatbots in early 2026. But only 7% act on AI advice about local businesses without checking it, and sign traffic is thin: about 18 scans a sign a week across 150 tourist signs in Paphos, about 3 on California trail signs. No source measures scan rates in North American lobbies or malls, so the pilot has to. Waiting is common (85% of US consumers queue a few times a month), indoor mall visits grew through 2025, and office lobbies are thinner, at about 55% occupancy.

## Know who already does this

The AI layer is already a commodity, sold from $33 a month, and nobody found sells a no-login guide for a private building or mall paid for by sponsors or leads. The closest match, Hello Lamp Post, licenses talking-object guides to cities, BIDs and airports. Museum guides (Smartify, Xsite, Ask Mona) sell to institutions; hotel guides to hotels; tenant apps to landlords, behind a login. Big platforms now answer place questions in conversation (Google's Ask Maps and Yelp's assistant, both 2026), but from listing-level data: suites, building rules and tenant events are the gap a place guide can own. Past waves failed on friction, from beacons to a 2017 mall chatbot. The real threat is an incumbent adding chat, such as an indoor-map vendor or a screen network with exclusive mall ad rights; the defensible assets are owner relationships, curated place data and local advertisers, not the AI.

## Rank the segments

| Priority | Segment | Payer | Why this rank |
| --- | --- | --- | --- |
| 1 | Downtown BIDs and BIAs (about 1,000 in the US, 500 in Canada) | The director, from assessments | A fast sale; members buy promotion |
| 2 | Tourism boards, as co-funders | Public tax revenue | The most money; a crowded website-chat market, so sell the on-street layer |
| 3 | Class A office lobbies | The landlord's amenity budget | Budget exists; few leads |
| 4 | Boutique hotels inside BIDs | Operations | Tourists ask where to eat |
| 5 | Independent malls | The tenant marketing fund | Large owners sell exclusive media rights |
| 6 | Historic sites and museums | Shrinking grants | A content partner, not a payer |

## Price it

| Item | Starting price | Benchmark |
| --- | --- | --- |
| Site, 1 to 5 signs, text | $199 a month, billed yearly | A tour platform's $199 a month |
| District or large venue, 25 signs, voice | $499 a month, billed yearly | 5% of the median New York BID's marketing |
| Setup per site | $750 once | A museum guide's content workshop |
| Sponsor slot, per category per place | $149 a month | Elevator screens at $200 to $2,000 a month |

Price a qualified lead at about 30% of Google's search cost per lead in its vertical: $8 for arts and entertainment, $12 beauty, $20 health and fitness, $22 dentists, $28 business services, $31 real estate, $39 legal. Restaurants pay $1 to $1.50 per seated diner, as on OpenTable.

A **billable lead** is a visitor-initiated hand-off to one named business: tapping "Send my details to X", requesting a booking, or a call lasting over 20 seconds. Clicks, spam and repeats within 15 days are free, and invalid leads are credited within 30 days.

**Label and consent.** Each sponsored item gets its own card with "Ad" shown or spoken first, never changes the organic answer, and never appears in health, finance or politics answers (FTC guidance). Each lead needs one tap per named business with the referral fee disclosed: Canada's anti-spam law bans pre-checked boxes, Quebec needs consent per purpose, California treats a paid hand-off as a sale unless the visitor directs it, and US follow-up texts need written consent. Owner subscriptions face neither rule.

## Know the unit economics

Running costs are small: about $0.01 for a text conversation on a fast model and $0.15 for a three-minute GPT-Live voice session. With 20% of sessions on voice, 1,000 conversations cost about $38, 78% of it voice.

| A month | Quiet lobby, 200 conversations | Busy district, 2,000 conversations |
| --- | --- | --- |
| Owner subscription | $199 | $499 |
| AI, 20% voice | $8 | $77 |
| Signs, spread over 7 to 10 years | $1 to $5 | $5 to $14 |
| Knowledge refresh | $0.26 | $0.26 |
| Gross margin before labour | 94% to 96% | 82% to 84% |

The real costs are human: building each place's knowledge, mounting signs and selling, which no source prices. Voice needs per-place caps and budgets: at an assumed 30 three-minute voice sessions a day per place, 10,000 places would average about 1,250 sessions at once, past GPT-Live's 500 on its Grow tier.

Keeping knowledge fresh is cheap to automate (about $0.19 to $0.26 a place a month at 10,000 places for a weekly crawl of 50 pages, place-data lookups, embeddings and change extraction), but wrong facts are the hazard: listings get opening hours wrong in nearly half of cases. Give every fact a source and a "last verified" date, keep tenant directories as structured records as LobbyStack already does for hours and services ([ADR 0005](../adr/0005-structured-facts-over-rag.md)), let owners confirm the directory monthly, isolate each place as a hard tenant boundary, and run nightly golden-question tests. Google Business Profile data comes only through the owner's verified account, and Google Places content may not be cached.

## Know the risks

| Risk | Mitigation |
| --- | --- |
| Fake QR stickers (the FTC warned in September 2026) | Engraved codes, NFC tap checks, a printed short address, no payments |
| Liability for wrong answers (Air Canada was held liable for its chatbot) | Answer only from sources; show "last verified" dates |
| Grounded hallucination | Short, extractive answers; golden tests per place |
| Accessibility suits | WCAG 2.2 AA chat; no puzzle CAPTCHAs |
| Wiretap claims | Consent before the first message; no vendor reuse of chats |
| Cost abuse by bots | Per-place voice budgets; voice gated behind an NFC tap |
| Sign rights | Sell to whoever controls the common areas |

## Build it on LobbyStack

The study read the code at `ef553a2` and estimated 16 to 23 developer-days for a minimum product treating each place as one business, and 59 to 92 for a full marketplace with many tenants per place, sponsored answers and lead billing. Since then some gaps have narrowed:

| Gap at `ef553a2` | On `da1f548` |
| --- | --- |
| A QR code couldn't open the chat directly; the panel waits for a token from a parent page | Narrowed: each business can publish a page at `/profile/<slug>` with the chat and call docked in, and print QR code signs for it ([public page and QR code](../features/public-profile-and-qr.md)). That is the no-code pilot path; there is still no per-sign attribution |
| Website chat was restricted and never billed | Website chats now count toward each plan's allowance, once per conversation, but are never billed as overage ([billing](../billing/README.md#know-the-plans)) |
| The per-IP website call limit, 5 an hour, would block visitors on shared venue Wi-Fi | Raised by fork PR #49 to 20 an hour and 100 a day per address per business, with 10 an hour per visitor and 60 an hour per business ([website widget](../features/website-widget.md#know-the-limits)) |
| Everything is pinned to one business, so one agent can't route leads across tenants | Unchanged |
| Nothing models sponsorship, placements, lead sources or place-owner billing | Unchanged |
| Nothing schedules a re-crawl, so knowledge goes stale unless refreshed by hand | Unchanged |
| Website voice needs a business phone number; the AI speaks English and French only | Unchanged |

Remaining work, in developer-days: QR and NFC placements with attribution (5 to 7), placement analytics (6 to 10), scheduled refresh and tenant self-service (10 to 15), a multi-tenant place model (15 to 25), sponsored answers with disclosure (8 to 12), lead routing and billing (8 to 12), and a place-owner billing account (2 to 3). Each tenant the guide reaches is also a prospect for the receptionist itself.

## Run the pilot

One 90-day paid pilot in a mid-size downtown BID: 15 signs (8 on street wayfinding, 4 in hotel or office lobbies, 3 at historic markers), a $1,500 fee credited to year one, co-promoted by the tourism board. Out-of-pocket cost about $600 to $1,250 for signs, NFC tags and AI. Sell sponsor slots monthly and invoice consented leads by hand.

| Metric | Target | Stop below |
| --- | --- | --- |
| Scans per sign a week, median sign | 15 | 5 |
| Conversations per scan | 0.4 | 0.2 |
| Referral clicks per 100 conversations | 25 | 10 |
| Qualified leads per 1,000 conversations | 20 | 5 |
| Golden-question accuracy | 95% | 90% |
| Sponsor slots sold by week 4 | 5 | 2 |
| Sponsor renewals after month 1 | 60% | 40% |
| Owner's yearly plan, a month | $499 | $199 |

Stop if the median sign still draws under 5 scans a week after one round of moving signs, if fewer than 0.2 conversations follow each scan, or if the BID won't renew at $199 a month. If traffic passes but leads and renewals miss, keep owner subscriptions and drop promotion and lead fees. After a pass, scale through downtown associations, city small-business offices and tourism boards' technology partners; for office lobbies, building owners' associations. The brand for the signs was researched next ([brand names](brand-names.md)).
