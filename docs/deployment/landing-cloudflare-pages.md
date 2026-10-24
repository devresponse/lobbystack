# Deploy the landing site on Cloudflare Pages

> **The original project's site.** `apps/landing` is the original project's marketing website, which this fork doesn't publish. This page keeps how the original deployed it, without its addresses, in case the fork ever builds a site of its own from it. Its pages, host names and defaults still name the original project: see [what still points at the original](../project/open-items.md#clean-up-what-still-points-at-the-original).

The site deploys through Cloudflare Pages' Git integration, with no Wrangler deploy step.

## Configure Cloudflare Pages

Connect a Pages project to this repository with:

- Production branch: `main`
- Root directory: `apps/landing`
- Build command: `pnpm build`
- Build output directory: `dist`
- Node version: `26`
- pnpm version: `10.30.3`
- Automatic production deployments: enabled
- Preview deployments: all branches
- Build watch paths:
  - `apps/landing/**`
  - `package.json`
  - `pnpm-lock.yaml`
  - `pnpm-workspace.yaml`

The `apps/landing/.nvmrc` file pins the Node version for build environments that read it from the project root directory.

## Configure environment variables

- `PUBLIC_POSTHOG_ENABLED=true` and `PUBLIC_POSTHOG_KEY`, to send analytics to PostHog.
- `PUBLIC_POSTHOG_HOST`: where the site sends analytics. Without it, the site uses the original project's PostHog relay.
- `PUBLIC_POSTHOG_UI_HOST=https://us.posthog.com`
- `PUBLIC_LIVE_CALL_ENDPOINT`: the dashboard's `/api/voice/live/session` address for the demo call on the home page, and `PUBLIC_WEB_CALL_BUSINESS_SLUG`, the business that answers it. Without them, the demo calls the original project's dashboard and business.
- `INDEXNOW_KEY`
- `GOOGLE_SITE_VERIFICATION`, if Google Search Console verification is needed
- `BING_SITE_VERIFICATION`, if Bing verification is needed

`apps/landing/functions/_middleware.js` names the site's canonical host, and redirects its `www` and `pages.dev` hosts there. Change all three before serving the site from another domain.

## Verify the site locally

From the monorepo root:

```bash
pnpm landing:typecheck
pnpm landing:build
pnpm landing:preview
```

The build output is `apps/landing/dist`, the directory Cloudflare Pages publishes.
