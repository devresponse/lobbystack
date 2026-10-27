# Offer a QR place guide

A no-login AI guide that anyone reaches by scanning a QR code or tapping an NFC tag at a place, such as an office lobby, a mall, a downtown or a historic site, paid for by the place's owner. A market study on 2026-10-10 found a market only if place owners pay, and proposed a 90-day paid pilot with one downtown business improvement district before building anything ([QR place guide](../research/qr-place-guide-market.md)). The guide's brand became the project's: AlloPlace ([brand names](../research/brand-names.md)).

- **Status:** waiting on two decisions: whether to run the pilot, and whether to build the product.
- **Effort:** the pilot needs no code. In the study, a minimum product treating each place as one business was 16 to 23 developer-days, and a full marketplace 59 to 92; some of its gaps have narrowed since.

## Run the pilot with what exists

Each business can publish a page at `/profile/<slug>` with the chat and call docked in, and print QR code signs for it (fork PRs #28 and #29, [public page and QR code](../features/public-profile-and-qr.md)). That covers the pilot: one mid-size downtown district, 15 signs, a $1,500 fee credited to the first year, sponsor slots sold monthly and consented leads invoiced by hand. Stop if the median sign still draws under 5 scans a week after one round of moving signs, if fewer than 0.2 conversations follow each scan, or if the district won't renew at $199 a month.

## Build the rest

| Work | Developer-days in the study |
| --- | --- |
| QR and NFC placements, with attribution for each sign | 5 to 7 |
| Placement analytics | 6 to 10 |
| Scheduled knowledge refresh, and self-service for tenants | 10 to 15 |
| A place with many tenants, so one guide can route leads across them | 15 to 25 |
| Sponsored answers, labelled as ads | 8 to 12 |
| Lead routing and billing | 8 to 12 |
| A billing account for the place's owner | 2 to 3 |

Since the study, website chats count toward plan allowances and the per-address limits on website calls were raised, which narrowed two of its gaps. A website call still needs the business to have a phone number.

## Price it

An owner subscription, billed yearly: $199 a month for a site with 1 to 5 signs, $499 for a district or large venue with voice, and $750 to set up each site. On top, sponsor slots at $149 a month per category per place, labelled as ads, and lead fees of $8 to $39 depending on the trade. The AI costs little, about $38 for 1,000 conversations with 20% on voice; building each place's knowledge, mounting signs and selling are the real costs.

## Decide these

- Run the pilot?
- Build the minimum product, and which parts first?
