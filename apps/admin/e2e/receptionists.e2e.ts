import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { billingAccounts, businesses, createDatabaseClient, entryLinkDailyScans, receptionistProfiles } from "@lobbystack/db";
import { refreshBusinessSnapshot } from "@lobbystack/domain";

import agent from "../public/locales/en/agent.json" with { type: "json" };
import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import profileCopy from "../public/locales/en/profile.json" with { type: "json" };
import receptionistsCopy from "../public/locales/en/receptionists.json" with { type: "json" };
import settings from "../public/locales/en/settings.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Receptionists-Password-123!";
const prefix = "receptionists";
const copy = receptionistsCopy;
const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)), text);

function migrator() {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  return createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
}

type Database = ReturnType<typeof migrator>;

// Removes only this test's user and business, so copies running in parallel keep theirs.
async function removeFixtures(database: Database, email: string, businessId: string | undefined): Promise<void> {
  if (businessId) {
    await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId}`);
    await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
  }
  await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
  await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
  await database.db.execute(sql`delete from public.users where email = ${email}`);
}

/** Signs up, names the business, and skips the rest of onboarding, which has its own journeys. */
async function signUpWithBusiness(page: Page, testInfo: TestInfo, database: Database, email: string, name: string): Promise<string> {
  await page.addInitScript(() => localStorage.setItem("lobbystack.locale", "en"));
  await isolateAuthRateLimit(page, email, testInfo);
  await page.goto("/en/signup");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  const signedUp = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST");
  await page.locator('button[type="submit"]').click();
  expect((await signedUp).ok()).toBe(true);
  await completeSignupEmailVerification(page, email, password);
  await expect(page).toHaveURL(/\/onboarding\/business$/);
  await page.getByLabel(onboarding.businessName.label).fill(name);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
  await page.getByRole("button", { name: onboarding.businessName.continue }).click();
  const businessId = (await (await created).json() as { businessId: string }).businessId;
  await database.db.update(businesses).set({ onboardingStage: "complete", timezone: "America/Vancouver" }).where(eq(businesses.id, businessId));
  return businessId;
}

/** Puts the business on Pro, which includes 5 active receptionists, as Polar's webhook would. */
async function subscribeToPro(database: Database, businessId: string): Promise<void> {
  await database.db.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "pro", subscriptionState: "active", billingInterval: "month" })
    .onConflictDoUpdate({ target: billingAccounts.businessId, set: { plan: "pro", subscriptionState: "active", billingInterval: "month" } });
}

async function receptionistRows(database: Database, businessId: string) {
  return await database.db.select({ id: receptionistProfiles.id, name: receptionistProfiles.name, handle: receptionistProfiles.handle, greeting: receptionistProfiles.greeting, isDefault: receptionistProfiles.isDefault, status: receptionistProfiles.status, listed: receptionistProfiles.listed, archivedAt: receptionistProfiles.archivedAt })
    .from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId));
}

test("an owner adds receptionists once the plan allows more, gives one its own greeting, and archives one only after confirming", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  let businessId: string | undefined;
  try {
    businessId = await signUpWithBusiness(page, testInfo, database, email, `Kitsilano Physio ${randomUUID().slice(0, 8)}`);
    const sidebar = page.locator('[data-slot="sidebar"]');
    const rowOf = (name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
    const menuOf = (name: string) => page.getByRole("button", { name: fill(copy.table.moreOptions, { name }), exact: true });

    // The page sits right below AI settings in the sidebar.
    await page.goto("/");
    await sidebar.getByRole("link", { name: agent.sections.receptionists.title, exact: true }).click();
    await expect(page).toHaveURL(/\/agent\/receptionists$/);
    await expect(page.getByRole("heading", { level: 1, name: agent.sections.receptionists.title, exact: true })).toBeVisible();
    const labels = (await sidebar.getByRole("link").allInnerTexts()).map((label) => label.trim());
    expect(labels.indexOf(agent.sections.receptionists.title)).toBe(labels.indexOf(agent.sections.basicSettings.title) + 1);

    // A new business has one receptionist, its default, named "Front desk" in the business's language.
    await expect(rowOf("Front desk")).toContainText(copy.table.default);
    expect(await receptionistRows(database, businessId)).toEqual([expect.objectContaining({ name: "Front desk", isDefault: true, handle: null, status: "active" })]);

    // The free plan includes one, so the page offers an upgrade, and so does Add receptionist.
    await expect(page.getByText(copy.allowance.upgradeTitle, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: copy.toolbar.add, exact: true }).click();
    const upgrade = page.getByRole("dialog", { name: settings.billing.upgradeDialog.title });
    await expect(upgrade).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(upgrade).toHaveCount(0);

    // On Pro the page counts the active receptionists against the plan's 5.
    await subscribeToPro(database, businessId);
    await page.reload();
    await expect(page.getByText(fill(copy.allowance.used_other, { active: 1, count: 5 }), { exact: true })).toBeVisible();
    await expect(page.getByText(copy.allowance.upgradeTitle, { exact: true })).toHaveCount(0);

    // Two more, each with what it helps with; the first page address comes from the name.
    const add = async (name: string, description: string) => {
      await page.getByRole("button", { name: copy.toolbar.add, exact: true }).click();
      const editor = page.getByRole("dialog", { name: copy.editor.addTitle });
      await editor.getByLabel(copy.editor.name, { exact: true }).fill(name);
      await editor.getByLabel(copy.editor.description, { exact: true }).fill(description);
      const added = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/receptionists" && response.request().method() === "POST");
      await editor.getByRole("button", { name: copy.editor.add, exact: true }).click();
      const response = await added;
      expect(response.status()).toBe(201);
      await expect(page.getByText(fill(copy.toast.added, { name }), { exact: true })).toBeVisible();
      await expect(editor).toHaveCount(0);
      return (await response.json() as { receptionist: { id: string; handle: string } }).receptionist;
    };
    const kitsilano = await add("Kitsilano clinic", "Bookings at our West 4th clinic");
    expect(kitsilano.handle).toBe("kitsilano-clinic");
    await add("Billing", "Invoices and insurance claims");
    await expect(rowOf("Kitsilano clinic")).toContainText("Bookings at our West 4th clinic");
    await expect(rowOf("Kitsilano clinic")).toContainText(`/profile/`);
    await expect(rowOf("Kitsilano clinic")).toContainText("/kitsilano-clinic");
    await expect(page.getByText(fill(copy.allowance.used_other, { active: 3, count: 5 }), { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("receptionists-page.png"), fullPage: true });

    // AI settings opens on the receptionist chosen in its menu, and its greeting is its own.
    await menuOf("Kitsilano clinic").click();
    await page.getByRole("menuitem", { name: copy.actions.aiSettings }).click();
    await expect(page).toHaveURL(new RegExp(`/agent\\?receptionist=${kitsilano.id}$`));
    // The section with each receptionist's own settings starts with the dropdown; Test Call has one of its own.
    const own = page.getByRole("region", { name: agent.receptionists.own.title });
    const picker = own.getByRole("combobox", { name: new RegExp(`^${agent.receptionists.picker}\\b`) });
    await expect(picker).toContainText("Kitsilano clinic");
    await page.getByRole("button", { name: fill(agent.actions.editField, { field: agent.fields.greeting.label }), exact: true }).click();
    const greetingDialog = page.getByRole("dialog", { name: agent.fields.greeting.label });
    const greeting = "Hi, you've reached our Kitsilano clinic. How can I help?";
    await greetingDialog.getByRole("textbox").fill(greeting);
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent" && response.request().method() === "PATCH");
    await greetingDialog.getByRole("button", { name: agent.actions.save, exact: true }).click();
    const savedResponse = await saved;
    expect(savedResponse.ok()).toBe(true);
    expect(new URL(savedResponse.url()).searchParams.get("receptionist")).toBe(kitsilano.id);
    const greetings = Object.fromEntries((await receptionistRows(database, businessId)).map((row) => [row.name, row.greeting]));
    expect(greetings["Kitsilano clinic"]).toBe(greeting);
    expect(greetings["Front desk"]).not.toBe(greeting);
    expect(greetings.Billing).not.toBe(greeting);

    // Choosing the default receptionist shows its own greeting again.
    await picker.click();
    await page.getByRole("option", { name: /Front desk/ }).click();
    await expect(page).toHaveURL(/\/agent$/);
    await expect(picker).toContainText("Front desk");

    // Archiving asks first; Cancel keeps the receptionist.
    await page.goto("/agent/receptionists");
    await menuOf("Billing").click();
    await page.getByRole("menuitem", { name: copy.actions.archive }).click();
    let confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText(fill(copy.archive.title, { name: "Billing" }), { exact: true })).toBeVisible();
    await confirm.getByRole("button", { name: copy.actions.cancel, exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(rowOf("Billing")).toBeVisible();
    expect((await receptionistRows(database, businessId)).find((row) => row.name === "Billing")?.archivedAt).toBeNull();

    // Confirming archives it: it leaves the list and waits under Archived.
    await menuOf("Billing").click();
    await page.getByRole("menuitem", { name: copy.actions.archive }).click();
    confirm = page.getByRole("alertdialog");
    await confirm.getByRole("button", { name: copy.archive.confirm, exact: true }).click();
    await expect(page.getByText(fill(copy.toast.archived, { name: "Billing" }), { exact: true })).toBeVisible();
    await expect(rowOf("Billing")).toHaveCount(0);
    expect((await receptionistRows(database, businessId)).find((row) => row.name === "Billing")?.archivedAt).toBeInstanceOf(Date);
    await page.getByLabel(copy.toolbar.status, { exact: true }).selectOption("archived");
    await expect(rowOf("Billing")).toContainText(copy.status.archived);

    // Restore brings it back, active again.
    await menuOf("Billing").click();
    await page.getByRole("menuitem", { name: copy.actions.restore }).click();
    await expect(page.getByText(fill(copy.toast.restored, { name: "Billing" }), { exact: true })).toBeVisible();
    await expect(page.getByText(copy.table.emptyArchived, { exact: true })).toBeVisible();
    expect((await receptionistRows(database, businessId)).find((row) => row.name === "Billing")).toEqual(expect.objectContaining({ archivedAt: null, status: "active" }));
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});

test("visitors pick a listed receptionist on the business page, each receptionist's page and QR link opens it, and its chat answers as it", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  const name = `Northside Bikes ${randomUUID().slice(0, 8)}`;
  let businessId: string | undefined;
  const visitor = await browser.newContext();
  try {
    businessId = await signUpWithBusiness(page, testInfo, database, email, name);
    await subscribeToPro(database, businessId);
    const slug = (await database.db.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, businessId)))[0]!.slug;
    const origin = new URL(page.url()).origin;
    const api = async (method: "POST" | "PUT", path: string, data: object) => {
      const response = await page.request.fetch(`${path}${path.includes("?") ? "&" : "?"}businessId=${encodeURIComponent(businessId!)}`, { method, headers: { origin }, data });
      expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
      return await response.json() as Record<string, unknown>;
    };

    // Two receptionists besides Front desk, both listed on the business page, and a widget for the page's chat.
    const kitsilano = (await api("POST", "/api/receptionists", { name: "Kitsilano store", description: "Repairs and rentals on West 4th" })).receptionist as { id: string; handle: string };
    const billing = (await api("POST", "/api/receptionists", { name: "Billing", description: "Invoices and refunds" })).receptionist as { id: string; handle: string };
    expect([kitsilano.handle, billing.handle]).toEqual(["kitsilano-store", "billing"]);
    await api("POST", "/api/widget-keys", { label: "Main website", allowedOrigins: ["https://northside.example"], config: { title: "Ask Northside" } });
    // The worker rebuilds the receptionist's snapshot after these changes; here the test does it.
    await refreshBusinessSnapshot({ db: database.db }, { businessId });

    // Publish the page.
    await page.goto("/settings/profile");
    await expect(page.getByLabel(settings.publicPage.chat.widget)).toHaveValue(/.+/);
    await page.getByLabel(settings.publicPage.details.category).fill("Bike shop");
    await page.getByLabel(settings.publicPage.details.line1).fill("2150 West 4th Ave");
    await page.getByLabel(settings.publicPage.details.city).fill("Vancouver");
    await page.getByLabel(settings.publicPage.details.region).fill("BC");
    await page.getByLabel(settings.publicPage.details.country).selectOption("CA");
    await page.getByRole("switch", { name: settings.publicPage.publish.label }).click();
    const published = page.waitForResponse((response) => response.url().includes("/api/business-profile?") && response.request().method() === "PUT");
    await page.getByRole("button", { name: settings.publicPage.save, exact: true }).click();
    expect((await published).ok()).toBe(true);

    // The page's card lists who visitors can pick, Front desk always first; taking Billing off saves at once.
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText(copy.pageList.title, { exact: true }) });
    const onPage = card.getByRole("list", { name: copy.pageList.onPage });
    await expect(onPage.getByRole("listitem")).toHaveCount(3);
    await expect(onPage.getByRole("listitem").first()).toContainText("Front desk");
    await expect(onPage.getByRole("listitem").first()).toContainText(copy.pageList.alwaysFirst);
    const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/receptionists/listed" && response.request().method() === "PUT");
    await card.getByRole("button", { name: fill(copy.multi.remove, { name: "Billing" }), exact: true }).click();
    expect((await listed).ok()).toBe(true);
    await expect(onPage.getByRole("listitem")).toHaveCount(2);
    await expect(onPage).not.toContainText("Billing");
    expect((await receptionistRows(database, businessId)).find((row) => row.name === "Billing")?.listed).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("receptionists-on-your-page.png"), fullPage: true });

    // A visitor on the business page talks to Front desk, and can pick Kitsilano store, not the unlisted Billing.
    const visitorPage = await visitor.newPage();
    const chatReceptionist = async (path: string) => {
      const config = visitorPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/widget/config" && response.ok());
      const opened = await visitorPage.goto(path);
      expect(opened?.status()).toBe(200);
      return ((await (await config).json()) as { receptionist?: { name: string } }).receptionist?.name;
    };
    expect(await chatReceptionist(`/profile/${slug}`)).toBe("Front desk");
    const talkingTo = (who: string) => visitorPage.getByRole("button", { name: `${profileCopy.receptionists.label} ${who}`, exact: true });
    await expect(talkingTo("Front desk")).toBeVisible();
    const choices = visitorPage.getByRole("list", { name: profileCopy.receptionists.choose });
    await expect(choices).toBeHidden();
    await talkingTo("Front desk").click();
    await expect(choices.getByRole("link")).toHaveText([/Front desk/, /Kitsilano store/]);
    await expect(choices.getByRole("link", { name: /Front desk/ })).toHaveAttribute("aria-current", "page");
    await visitorPage.setViewportSize({ width: 390, height: 844 });
    await visitorPage.screenshot({ path: testInfo.outputPath("business-page-picker-phone.png"), fullPage: true });
    await visitorPage.setViewportSize({ width: 1280, height: 900 });

    // Picking one opens its own page, which its chat answers through the page's signed token.
    const kitsilanoPath = `/profile/${slug}/kitsilano-store`;
    const config = visitorPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/widget/config" && response.ok());
    await choices.getByRole("link", { name: /Kitsilano store/ }).click();
    await expect(visitorPage).toHaveURL(new RegExp(`${kitsilanoPath}$`));
    expect(((await (await config).json()) as { receptionist?: { name: string } }).receptionist?.name).toBe("Kitsilano store");
    await expect(visitorPage).toHaveTitle(new RegExp(`^Kitsilano store · ${name}`));
    await expect(talkingTo("Kitsilano store")).toBeVisible();
    expect(await visitorPage.locator("script[data-receptionist-token]").count()).toBe(1);

    // An unlisted receptionist's page still opens, and its chat answers as it.
    expect(await chatReceptionist(`/profile/${slug}/billing`)).toBe("Billing");
    await expect(talkingTo("Billing")).toBeVisible();
    // A page address no receptionist has is not found.
    expect((await visitorPage.goto(`/profile/${slug}/no-such-receptionist`))?.status()).toBe(404);

    // A QR link for a sign in the store's window, answered by Kitsilano store.
    await page.goto("/settings/qrcode");
    await expect(page.getByText(settings.qrCode.links.title, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: settings.qrCode.links.new, exact: true }).click();
    const linkDialog = page.getByRole("dialog", { name: settings.qrCode.links.dialog.newTitle });
    await linkDialog.getByLabel(settings.qrCode.links.dialog.label, { exact: true }).fill("Front window");
    await linkDialog.getByRole("combobox", { name: new RegExp(`^${settings.qrCode.links.dialog.answeredBy}\\b`) }).click();
    await page.getByRole("option", { name: /Kitsilano store/ }).click();
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/entry-links" && response.request().method() === "POST");
    await linkDialog.getByRole("button", { name: settings.qrCode.links.dialog.create, exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.ok()).toBe(true);
    const link = (await createdResponse.json() as { link: { id: string; code: string; receptionistId: string } }).link;
    expect(link.receptionistId).toBe(kitsilano.id);
    await expect(page.getByText(fill(settings.qrCode.links.toast.created, { name: "Front window" }), { exact: true })).toBeVisible();
    const linkRow = page.getByRole("row").filter({ has: page.getByText("Front window", { exact: true }) });
    await expect(linkRow).toContainText(`/q/${link.code}`);
    await expect(linkRow).toContainText("Kitsilano store");
    await expect(page.getByText(fill(settings.qrCode.signCard.linkTitle, { name: "Front window" }), { exact: true })).toBeVisible();

    // A scan opens the receptionist's page; a link preview's HEAD isn't counted.
    const scans = async () => (await database.db.select({ scans: entryLinkDailyScans.scans }).from(entryLinkDailyScans).where(and(eq(entryLinkDailyScans.entryLinkId, link.id), eq(entryLinkDailyScans.businessId, businessId!))))
      .reduce((total, row) => total + row.scans, 0);
    const looked = await visitor.request.head(`/q/${link.code}`, { maxRedirects: 0 });
    expect(looked.status()).toBe(307);
    expect(await scans()).toBe(0);
    const scanned = await visitor.request.get(`/q/${link.code}`, { maxRedirects: 0 });
    expect(scanned.status()).toBe(307);
    expect(scanned.headers().location).toBe(kitsilanoPath);
    expect(scanned.headers()["cache-control"]).toBe("private, no-store");
    expect(scanned.headers()["referrer-policy"]).toBe("no-referrer");
    expect(await scans()).toBe(1);
    await visitorPage.goto(`/q/${link.code}`);
    await expect(visitorPage).toHaveURL(new RegExp(`${kitsilanoPath}$`));
    await expect(talkingTo("Kitsilano store")).toBeVisible();
    expect(await scans()).toBe(2);

    // The table counts the link's scans: Link, Answered by, Opens, then Scans.
    await page.reload();
    await expect(page.getByRole("row").filter({ has: page.getByText("Front window", { exact: true }) }).getByRole("cell").nth(3)).toHaveText("2");

    // While its receptionist is paused, the sign opens the business page instead.
    await api("POST", `/api/receptionists/${kitsilano.id}`, { action: "pause" });
    const whilePaused = await visitor.request.get(`/q/${link.code}`, { maxRedirects: 0 });
    expect(whilePaused.status()).toBe(307);
    expect(whilePaused.headers().location).toBe(`/profile/${slug}`);
    // So does the paused receptionist's own page, where nobody else is listed now, so there's nothing to pick.
    await visitorPage.goto(kitsilanoPath);
    await expect(visitorPage).toHaveURL(new RegExp(`/profile/${slug}$`));
    await expect(visitorPage.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(visitorPage.getByText(profileCopy.receptionists.label, { exact: true })).toHaveCount(0);

    // A code no link has opens a page that says so.
    const unknown = await visitorPage.goto("/q/zzzzzz");
    expect(unknown?.status()).toBe(404);
    await expect(visitorPage.getByRole("heading", { name: profileCopy.entryLink.notFound.title })).toBeVisible();
  } finally {
    await visitor.close();
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
