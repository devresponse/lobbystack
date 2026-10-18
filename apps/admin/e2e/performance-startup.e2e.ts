import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import en from "../public/locales/en/contacts.json" with { type: "json" };
import fr from "../public/locales/fr/contacts.json" with { type: "json" };

test("server-provided French auth copy survives unavailable client translation files", async ({ page }) => {
  const requested = new Set<string>();
  await page.route("**/locales/**", route => { requested.add(new URL(route.request().url()).pathname.split("/").at(-1)!); return route.fulfill({ status: 404, body: "Unavailable" }); });
  await page.route("**/api/preferences/locale", route => route.fulfill({ status: 401, body: "{}" }));
  await page.goto("/fr/login");
  await expect(page.getByRole("heading", { name: "Bon retour" })).toBeVisible();
  await expect(page.getByLabel("Courriel", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Réessayer le chargement" })).toHaveCount(0);
  for (const namespace of ["dashboard.json", "calls.json", "contacts.json", "knowledge.json"]) expect(requested.has(namespace)).toBe(false);
});

/**
 * The dashboard ships every namespace of the page's language with the first
 * page, so the browser only fetches translations when the language changes.
 * The page opens in Spanish, then the operator's saved French preference
 * switches it, which loads the French namespaces.
 */
async function openInSpanishThenSwitchToFrench(context: BrowserContext, page: Page, baseURL: string) {
  await context.addCookies([{ name: "lobbystack.locale", value: "es", url: baseURL }]);
  await page.route("**/api/preferences/locale", route => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locale: "fr" }) })
    : route.continue());
  await page.goto(`${baseURL}/contacts`);
}

test("a French namespace that fails to load after a language change uses its English fallback", async ({ browser, baseURL }) => {
  const state = process.env.PARITY_PORT_OPERATOR_STORAGE_STATE_FR;
  test.skip(!state, "Requires a disposable French operator with completed onboarding.");
  const context = await browser.newContext({ storageState: state!, locale: "fr" });
  try {
    const page = await context.newPage();
    let intercepted = 0;
    await page.route(url => url.pathname === "/locales/fr/contacts.json", route => { intercepted++; return route.fulfill({ status: 404, body: "Unavailable" }); });
    await openInSpanishThenSwitchToFrench(context, page, baseURL!);
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(page.getByPlaceholder(en.page.searchPlaceholder)).toBeVisible();
    await expect(page.getByRole("button", { name: "Réessayer le chargement" })).toHaveCount(0);
  } finally { await context.close(); }
});

test("a translation failure after a language change exposes retry without leaving French", async ({ browser, baseURL }) => {
  const state = process.env.PARITY_PORT_OPERATOR_STORAGE_STATE_FR;
  test.skip(!state, "Requires a disposable French operator with completed onboarding.");
  const context = await browser.newContext({ storageState: state!, locale: "fr" });
  try {
    const page = await context.newPage();
    let failed = true;
    let intercepted = 0;
    await page.route(url => /^\/locales\/[^/]+\/contacts\.json$/.test(url.pathname), route => {
      intercepted++;
      return failed ? route.fulfill({ status: 404, body: "Unavailable" }) : route.continue();
    });
    await openInSpanishThenSwitchToFrench(context, page, baseURL!);
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Réessayer le chargement" })).toBeVisible();
    await expect(page.getByPlaceholder(fr.page.searchPlaceholder)).toHaveCount(0);
    failed = false;
    await page.getByRole("button", { name: "Réessayer le chargement" }).click();
    await expect(page.getByPlaceholder(fr.page.searchPlaceholder)).toBeVisible();
    await expect(page.getByRole("button", { name: "Réessayer le chargement" })).toHaveCount(0);
  } finally { await context.close(); }
});
