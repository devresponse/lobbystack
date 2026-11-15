# Carry the brand's colours into onboarding

Since the sign-in pages took the brand's colours on `releases/r2` ([Color the sign-in pages](../branding.md#color-the-sign-in-pages)), a new owner leaves a page in the brand's accent for onboarding's steps, which keep the centred page with black buttons and black progress dots. The design of 2026-11-15 recommended giving them the accent in a later, smaller change, so the brand carries on from sign-up to the dashboard.

- **Status:** ready when needed.
- **Effort:** about 1 day.

## Know what it would change

- **The shell:** `ReplacementOnboardingShell` (`apps/admin/src/components/replacement-onboarding-shell.tsx`) marks its root `data-brand-scope` with `brandScopeStyle()` from `apps/admin/src/components/auth-shell.tsx`, and its current progress dot takes `bg-brand`, as the sign-up page's does.
- **Each step's main button:** the business, website, documents, greeting, plan, number and attribution steps (`apps/admin/src/components/onboarding-*.tsx`) give their main button the accent with the text on it (`bg-brand text-brand-foreground` and the outline of `brandButton`), keeping their sizes. Outline and secondary buttons stay as they are.
- **What stays:** the layout, the logo above each step and every step's words. The brand panel stays on the signed-out pages, since onboarding's steps need the whole width, the plan step most of all.
- **Checks:** the onboarding tests that look for a button by its name still pass; the visual baselines of the onboarding pages in `docs/validation/admin-ui-parity.json` need refreshing.
