# Publish a business's page and QR code

Each business can publish a public page at `/profile/<slug>` on its deployment, with the website chat and call built in, and print QR code signs that open it. Both came from the fork (fork PRs #28, #29 and #33). Checked against `main` at `da1f548`.

## Publish the public profile

An owner or admin opens **Settings > Public profile** (`/settings/profile`), fills in what the page shows and publishes it. The page lives at `<dashboard domain>/profile/<slug>`, where `<slug>` is the business's existing unique slug. A new business's slug is made from its name. When another business has it, the new one gets a 12-character suffix, and since fork PR #104 so does a business whose slug another sign-up is creating at the same moment, instead of waiting for that sign-up to finish (`insertBusinessInTransaction` in `packages/domain/src/server/tenancy.ts`).

The page shows, in the deployment brand's colour:

- the business's name, a short description and its "Call now", "Book a visit" and "Send a message" actions;
- whether it is open now and when it next opens, from its opening hours (cached for 5 minutes);
- its services, hours and location, with a Google map when `GOOGLE_MAPS_EMBED_API_KEY` is set on the admin, or a drawn map that links to Google Maps without it;
- the website widget, docked into the page, using the business's widget key. The widget API accepts the deployment's own origin only for the key of a published page;
- a footer that links to the brand's website.

Unpublished pages answer 404. Publishing writes an audit log entry. The page has its own root layout (`apps/admin/app/(profile)`) and allows Google's map frame in its content security policy.

| Piece | Where |
| --- | --- |
| Table | `business_public_profiles` (migration `0100`), opt-in, with forced row-level security; `app.resolve_public_profile` finds a published page by slug. |
| Logic | `packages/domain/src/server/publicProfiles.ts`. |
| Dashboard API | `GET` and `PUT /api/business-profile`. |
| v1 API (fork PR #33) | `GET` and `PATCH /public-profile` (`business:read`, `business:write`). The first `PATCH` saves the dashboard's defaults, and a `PATCH` that changes nothing writes nothing. |
| CLI | `lobbystack public-profile get`, `set`, `address`, `publish` and `unpublish`, and `public_profile:` in a `lobbystack onboard` manifest. |

Not built: changing a business's slug, custom domains or subdomains per business.

## Print QR code signs

**Settings > QR code** (`/settings/qrcode`, fork PR #29) makes printable signs for the public page's address, in the browser. Nothing is stored.

- Templates: Signal, Front desk and Night.
- Sizes on an A4 sheet: one A4, two A5, four A6 or eight A7, with cut lines, each piece 5 mm inside its edge.
- In the centre of the code: the business's name, the brand's logo or nothing. A dark logo gets a white tile on black.
- A message of up to 80 characters, and the sign's language.
- Downloads: the code alone as PNG or SVG.
- If the page isn't published, the tab says so, since the code would open a 404.

The centre mark covers part of the code, so it fits only codes up to version 6, which holds an address of up to 58 bytes. A longer address gets a plain code with more error correction.

The code is in `apps/admin/src/lib/qr-code*.ts` and `apps/admin/src/components/qr-code/`. The browser test `apps/admin/e2e/qr-code-settings.e2e.ts` prints all 12 template and size combinations to PDF, checks each is one A4 page with its margins, and scans the codes.

## Know what to check

- A business needs a published page and a widget key for the page's chat. For the call button it also needs its phone number in its context snapshot ([website widget](website-widget.md#switch-it-on)).
- On a deployment with a long domain, check that the page's address is 58 bytes or less if you want the brand's mark in the code.
