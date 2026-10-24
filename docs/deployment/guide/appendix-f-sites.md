# Appendix F. Optional: the marketing site and the docs site

**Status:** checked on 2026-10-19 against the code at `d18f916` and Cloudflare's and Mintlify's documentation. Neither site was built or deployed.

An instance needs neither site. The dashboard, the receptionist, calls, the website chat, emails and texts all work without them, and neither is part of the setup in [Part 4](part-4-test-environment.md) or [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose). Both belong to the original LobbyStack project: `apps/landing` is its marketing website, and `mintlify/` is its Help Center.

**The links that open LobbyStack's sites**

Without a brand of your own ([3.6](part-3-outside-services.md#36-your-brand)), these links open LobbyStack's pages:

- The sign-up page says that by creating an account, people agree to the Terms of Service and the Privacy Policy, and links to those of Lobbystack Inc., the original LobbyStack's company. Onboarding links to them too.
- The dashboard's help links, "see docs" and the **Help Center** button, open the original project's Help Center.
- The logo on the public demo page, and the footer of each public profile page, link to the original project's website.
- Replies to HELP texts name LobbyStack's website and email address, and the dashboard's feedback panel gives LobbyStack's address.

If people outside your team will sign up, publish your own terms and privacy policy, on any website. Then a developer adds your brand ([3.6](part-3-outside-services.md#36-your-brand)) with `links.terms`, `links.privacy`, `links.site`, `links.docs` and `contactEmail` in its `brand.json`, runs `pnpm brands:build`, and commits, and the next build of the admin and the worker uses them. The old `NEXT_PUBLIC_…_URL` variables do nothing any more (`docs/branding.md`). Emails and the website chat have no such links.

**The marketing site, `apps/landing`**

Don't publish it as it is. It's LobbyStack's own website: its name and logos, its prices, 168 blog posts, legal pages for Lobbystack Inc., and links to LobbyStack's app, Help Center and GitHub. The original project's address is written into its code in several places, so a developer has to rewrite it for your brand and domain first.

After that, it's built for Cloudflare Pages, whose free plan is enough *(not tried)*:

1. In Cloudflare, open **Workers & Pages** > **Create application** > **Pages** > **Connect to Git** (some of Cloudflare's pages call it **Import an existing Git repository**). Choose **GitHub** and your fork, click **Install & Authorize**, then **Begin setup**.
2. Set **Production branch** to `main`, **Build command** to `pnpm run build` and **Build output directory** to `dist`. Under **Root directory (advanced)**, set **Path** to `apps/landing`.
3. Under **Environment variables**, add `NODE_VERSION=26`, `PNPM_VERSION=10.30.3`, and `PUBLIC_APP_URL=https://<your address>`, where the site's **Log in** and **Sign up** buttons go. Click **Save and Deploy**.
4. If the build fails while it installs, add `SKIP_DEPENDENCY_INSTALL=1`, change the build command to `pnpm install --frozen-lockfile && pnpm run build`, and deploy again *(not tried: Cloudflare doesn't say how it installs a folder whose lockfile is at the top of the repository)*.
5. For your own domain, open the project's **Custom domains** tab and click **Set up a domain**. A main domain, such as `example.com`, must use Cloudflare's nameservers. A subdomain can stay with another DNS provider, with a CNAME record to `<project>.pages.dev`, added only after the domain is set up in Cloudflare.

- The site's values are built into its pages, so a change needs a new deploy.
- The home page's voice demo needs `PUBLIC_LIVE_CALL_ENDPOINT=https://<your address>/api/voice/live/session` and `PUBLIC_WEB_CALL_BUSINESS_SLUG=<slug>` on the site. The slug is the business's, as it ends its public profile address, `/profile/<slug>` ([6.5](part-6-first-run.md#65-put-the-chat-on-your-website)). The admin then needs `WEB_CALL_PUBLIC_BUSINESS_SLUG` with the same slug, and `WEB_CALL_ALLOWED_ORIGINS` with the site's address. Without them, the demo calls LobbyStack's own service, which refuses it.
- Leave the `PUBLIC_POSTHOG_…` values and `INDEXNOW_KEY` unset until a developer has changed the addresses written into the code: PostHog's default is the original project's own relay, and IndexNow reports pages for the original project's website.
- No GitHub workflow publishes the site. Pushes to the fork only build it and check its links.

**The docs site, `mintlify/`**

Most instances should skip it, and let the help links open LobbyStack's Help Center, which describes the same software, though it's written for LobbyStack's own hosted service. Publishing your own copy means first replacing LobbyStack's name, links and plan details, on about 1,200 lines, in English, French and Spanish.

Only Mintlify's hosting publishes it: Mintlify allows building it into files to host elsewhere only on its Enterprise plan. Mintlify's **Starter** plan is free, and includes a custom domain *(not tried)*:

1. Sign up at Mintlify, and install its GitHub app on your fork, choosing **Only select repositories**. It needs an owner or admin of the repository.
2. On the dashboard's **Git Settings** page, turn on "docs.json is in a subdirectory", set the path to `/mintlify`, and click **Save changes**. Each push to the branch you chose then publishes the docs, at an address ending in `.mintlify.site`.
3. For your own domain, use the dashboard's **Custom domain setup** page: add the two TXT records it shows, wait until both show as verified, then add a CNAME record to `cname.mintlify.builders`. With Cloudflare's DNS, set the CNAME to **DNS only**.

`pnpm docs:dev` shows the docs on your own computer only.

**Not yet confirmed:**

- Whether Cloudflare Pages installs the packages by itself for `apps/landing`, and whether its build image offers Node.js 26.
- The exact labels in Cloudflare's dashboard today, which its own pages name differently: **Connect to Git** or **Import an existing Git repository**, and **Environment variables** or **Variables and Secrets**.
- The label of Mintlify's subfolder switch, and whether the path takes its first slash: Mintlify's docs say "docs.json is in a subdirectory" with `/docs`, while `mintlify/README.md` says "Docs are in a subdirectory" with `mintlify`.
- Whether the free Starter plan shows Mintlify's own branding on the docs.

**Appendix F was checked against:** `apps/landing/README.md`, `apps/landing/package.json`, `apps/landing/astro.config.mjs`, `apps/landing/functions/_middleware.js`, `apps/landing/public/_headers`, `apps/landing/src/lib/app-links.ts`, `apps/landing/src/components/web-voice/LobbyStackWebVoiceWidget.tsx`, `apps/landing/src/lib/posthog.ts`, `apps/admin/src/lib/live-web-call.ts`, `apps/admin/src/lib/marketing-site-url.ts`, `apps/admin/src/components/auth-card.tsx`, `apps/admin/src/components/dashboard-feedback-widget.tsx`, `packages/shared/src/brandLinks.ts`, `packages/domain/src/server/sms.ts`, `brands/`, `docs/branding.md`, `mintlify/README.md`, `mintlify/docs.json`, `.github/workflows/landing-link-check.yml`, and Cloudflare's and Mintlify's pages as read on 2026-10-19.
