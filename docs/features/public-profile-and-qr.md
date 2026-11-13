# Publish a business's page and QR code

Each business can publish a public page at `/profile/<slug>` on its deployment, with the website chat and call built in, and print QR code signs that open it. Both came from the fork (fork PRs #28, #29 and #33). Since fork PR #129, a business with several receptionists also has a page for each receptionist, and QR links that open one and count the sign's scans ([receptionists](receptionists.md)). Checked against `main` at `da1f548`, and the receptionist parts against the code of fork PR #129.

## Publish the public profile

An owner or admin opens **Settings > Public profile** (`/settings/profile`), fills in what the page shows and publishes it. The page lives at `<dashboard domain>/profile/<slug>`, where `<slug>` is the business's existing unique slug. A new business's slug is made from its name. When another business has it, the new one gets a 12-character suffix, and since fork PR #105 so does a business whose slug another sign-up is creating at the same moment, instead of waiting for that sign-up to finish (`insertBusinessInTransaction` in `packages/domain/src/server/tenancy.ts`).

The page shows, in the deployment brand's colour:

- the business's name, a short description and its "Call now", "Book a visit" and "Send a message" actions;
- whether it is open now and when it next opens, from its opening hours (cached for 5 minutes);
- its services, hours and location, with a Google map when `GOOGLE_MAPS_EMBED_API_KEY` is set on the admin, or a drawn map that links to Google Maps without it;
- the website widget, docked into the page, using the business's widget key. The widget API accepts the deployment's own origin only for the key of a published page;
- a footer that links to the brand's website.

The business's name heads the page at 40 px on a phone and, from 1,024 px wide, at 5% of the window's width, between 48 and 68 px (`apps/admin/src/components/public-profile/profile-page.tsx`). Fork PR #162 on `releases/r2` made it about a fifth smaller, from 48 px and 56 to 88 px, so that a long name, such as a street address, no longer fills the top of the page.

Unpublished pages answer 404. **Publish page** in **Settings > Public profile** saves the form and publishes the page at once, and then reads **Unpublish page**, which saves the form too. Publishing or unpublishing writes an audit log entry and refreshes the business's snapshot, whose links chats give only while the page is public. The page has its own root layout (`apps/admin/app/(profile)`) and allows Google's map frame in its content security policy.

With several receptionists, the default one answers the business page, and a **You're talking to** dropdown under the business's name lets visitors pick one of the others the business listed in the **Receptionists on your page** card, in **Settings > Public profile**. Each receptionist also has its own page, `/profile/<slug>/<handle>`, answered by it whether it's listed or not; its chat and browser call go to that receptionist through a signed token ([what visitors see](receptionists.md#know-what-visitors-see)). Both pages show the same business; what differs is who answers, which the dropdown and the page's title name, and the phone number: a receptionist's own, or the business's main line, the default receptionist's, when it has none.

| Piece | Where |
| --- | --- |
| Table | `business_public_profiles` (migration `0100`), opt-in, with forced row-level security; `app.resolve_public_profile` finds a published page by slug. |
| Logic | `packages/domain/src/server/publicProfiles.ts`. `getPublicProfilePage` reads a page, and with a handle a receptionist's page. |
| Pages | `apps/admin/app/(profile)/profile/[slug]/page.tsx` and, since fork PR #129, `[slug]/[handle]/page.tsx`, both rendered by `apps/admin/src/components/public-profile/profile-route.tsx`, with the dropdown in `receptionist-picker.tsx`. |
| Dashboard API | `GET` and `PUT /api/business-profile`, and since fork PR #129 `PUT /api/receptionists/listed` for the receptionists the page lists and their order. |
| v1 API (fork PR #33) | `GET` and `PATCH /public-profile` (`business:read`, `business:write`). The first `PATCH` saves the dashboard's defaults, and a `PATCH` that changes nothing writes nothing. |
| CLI | `lobbystack public-profile get`, `set`, `address`, `publish` and `unpublish`, and `public_profile:` in a `lobbystack onboard` manifest. |

Not built: changing a business's slug, custom domains or subdomains per business.

## Print QR code signs

**Settings > QR code** (`/settings/qrcode`, fork PR #29) makes printable signs, in the browser. Until fork PR #129 a sign could only carry the public page's address, and nothing was stored. Since then the page starts with **Your QR codes**: the business page's own address, then the business's QR links, each a short address, `/q/<code>`, stored in `entry_links`, that opens one receptionist's page and counts the scans of the signs that carry it. The sign below the table is made for the address picked in its **Link** dropdown, and a link's sign has a chart of its scans per day ([use QR links](receptionists.md#use-qr-links)). A sign printed before QR links carries the business page's address, which keeps working.

- Templates: Signal, Front desk and Night.
- Sizes on an A4 sheet: one A4, two A5, four A6 or eight A7, with cut lines, each piece 5 mm inside its edge.
- In the centre of the code: the business's name, the brand's logo or nothing. A dark logo gets a white tile on black.
- A message of up to 80 characters, and the sign's language.
- Downloads: the code alone as PNG or SVG.
- If the page isn't published, the tab says so, since the code would open a 404.
- A link's sign opens with its receptionist's name, such as "Questions? Ask Sales.", and names the file it downloads for the business, the link's label and its code.

The centre mark covers part of the code, so it fits only codes up to version 6, which holds an address of up to 58 bytes. A longer address gets a plain code with more error correction. A QR link's address, the domain followed by `/q/` and 6 characters, is usually shorter than the business page's, so it keeps the mark on longer domains.

The code is in `apps/admin/src/lib/qr-code*.ts` and `apps/admin/src/components/qr-code/`, with the links in `qr-links.tsx` and `scans-chart.tsx`, their routes in `apps/admin/app/api/entry-links/` and `apps/admin/app/q/[code]/route.ts`, and their logic in `packages/domain/src/server/entryLinks.ts`. The browser test `apps/admin/e2e/qr-code-settings.e2e.ts` prints all 12 template and size combinations to PDF, checks each is one A4 page with its margins, and scans the codes.

## Know what to check

- A business needs a published page and a widget key for the page's chat. For the call button it also needs its phone number in its context snapshot ([website widget](website-widget.md#switch-it-on)).
- On a deployment with a long domain, check that the page's address is 58 bytes or less if you want the brand's mark in the code, or print a QR link's sign, whose address is shorter.
- A QR link counts a scan only when a phone opens it with `GET` while the page is published. Link previews that ask with `HEAD` aren't counted, nor are scans while the page isn't published, which answer 404, and the business page's own address is never counted.
