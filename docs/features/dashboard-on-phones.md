# Use the dashboard on a phone

The dashboard works in a phone's browser, such as Chrome on Android. Below 768 pixels wide (Tailwind's `md`), the sidebar folds away behind a menu button at the top of every page, and tables that don't fit scroll sideways inside their card. Since fork PR #109 the top of each page takes less room on a phone: the menu button's row is 48 pixels tall instead of 64, the page starts right under it, and page titles begin 56 pixels from the top of the screen instead of 88. Screens 768 pixels wide or more look the same as before. Checked against the code of fork PR #109.

## Know what the top of a page looks like

| On a phone | Before fork PR #109 | Since |
| --- | --- | --- |
| The menu button's row | 64 px, with the 36 px button in the middle | 48 px, with 6 px above and below the button |
| Space between the row and the page | 16 px | None: the page's first line brings its own 8 px |
| Where a page title starts | 88 px from the top | 56 px |
| A short action beside the title, such as the live call count on **Calls** or **Add endpoint** on **Webhooks** | On its own line under the title | On the title's line at the right, and under it only when it doesn't fit |
| A call's or a contact's page, which opens with a back link | Title at 128 px | Title at 104 px |

The row stays at the top while a page scrolls, with the page blurred behind it, as before, and it's 16 pixels thinner there too. On **Calls**, the first screen shows about one more call than before.

## Keep it this way when you change a page

- **The page has no top padding on a phone.** `Main` (`apps/admin/src/components/layout/main.tsx`) starts right under the menu button's row below `md`, and keeps its 24 pixels from `md` up. So the first thing on a page brings its own space: `PageHeader` has `py-2`, as do the headers of **Messages** and **Analytics**; a back link has `mt-2 md:mt-0` (`BackLink` in `apps/admin/src/components/detail-fields.tsx`, and the link on **Webhooks**); and **Messages** gives its list and an open conversation `pt-2 md:pt-0`. A new page that starts with something else should give it `mt-2 md:mt-0`, and its loading skeleton too, as the call and contact pages' skeletons do, so nothing jumps when the data arrives.
- **The row needs `shrink-0`.** The dashboard's scrolling column (`SidebarInset`) is a flex column, so without it any page long enough to scroll squeezes the row (`SiteHeader` in `apps/admin/src/components/site-header.tsx`) down to the button's height. `site-header.test.tsx` checks the row's height and `shrink-0`.
- **`PageHeader` wraps on a phone.** Below 640 pixels (`sm`) the title and its actions share a line while they fit (`apps/admin/src/components/page-header.tsx`). From `sm` up it lays them out as before: the title at the left and the actions at the right, aligned to the top, on one line.

## Know the gaps on a phone

- **Wide tables scroll sideways.** The **Calls** table is at least 56rem (896 pixels) wide, so on a phone its purpose column is cut off until you swipe the table. A list of cards below `md`, with the caller, the time and the purpose stacked, would show each call without scrolling.
- **Three buttons are computer-only.** **Test Call**, the gift that opens **Affiliate Program**, and **Feedback** sit at the top right of every page from `md` up (`DashboardUtilityBar` in `apps/admin/src/components/dashboard-utility-bar.tsx` is `hidden md:block`). A phone doesn't show them anywhere, though the menu button's row has room for them at its right.
- **The title could share the menu button's row.** Putting each page's title beside the button, as phone apps do, would save another 48 pixels, but every page would have to hand its title to the row, so it isn't done.

## Know how it's tested

- **The row:** `apps/admin/src/components/site-header.test.tsx` checks that it's 48 pixels tall, can't shrink and hides from `md` up, and its shadow and blur once the page scrolls.
- **The layout:** fork PR #109 measured every kind of page on a local dashboard at 412 by 780 pixels with touch, the size Chrome on an Android phone gives the dashboard, at 700 pixels and at 1440 pixels: Home, **Calls**, a call's page, **Messages** with and without an open conversation, **AI settings**, **Analytics** and **Webhooks**. Below 768 pixels every title moved up 24 to 32 pixels. At 1440 pixels the screenshots before and after match pixel for pixel, apart from two small spots that also differ between two shots of the same code.
