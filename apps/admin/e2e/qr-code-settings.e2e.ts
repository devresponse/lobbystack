import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";

import { businesses, createDatabaseClient } from "@lobbystack/db";

import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import settings from "../public/locales/en/settings.json" with { type: "json" };
import frenchSettings from "../public/locales/fr/settings.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Qr-Code-Password-123!";
const prefix = "qr-code";
const jsQrSource = readFileSync(createRequire(import.meta.url).resolve("jsqr"), "utf8");
const copy = settings.qrCode;
const SIZES = ["a4", "a5", "a6", "a7"] as const;
const TEMPLATES = ["signal", "frontDesk", "night"] as const;
// A4 in PDF points, either way up.
const A4_POINTS = { width: 595.28, height: 841.89 };

// Twice the pixels, so a screenshot of the smallest printed code still reads like a photo of the paper.
test.use({ deviceScaleFactor: 2 });

function migrator() {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  return createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
}

// Removes only this test's user and business, so copies running in parallel keep theirs.
async function removeFixtures(database: ReturnType<typeof migrator>, email: string, businessId: string | undefined): Promise<void> {
  if (businessId) {
    await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId}`);
    await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
  }
  await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
  await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
  await database.db.execute(sql`delete from public.users where email = ${email}`);
}

/** Picks a choice by clicking it, as a person does: the template radios themselves are visually hidden. */
async function choose(page: Page, name: string): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: true });
  await page.locator("label").filter({ has: radio }).click();
  await expect(radio).toBeChecked();
}

/** Reads the QR code in a PNG, the way a phone reads a photo of it. */
async function readQrCode(page: Page, png: Buffer): Promise<string | null> {
  const reader = await page.context().newPage();
  try {
    await reader.setContent("<!doctype html><title>QR reader</title>");
    await reader.addScriptTag({ content: jsQrSource });
    return await reader.evaluate(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#FFFFFF";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      const jsQR = (window as unknown as { jsQR: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null }).jsQR;
      return jsQR(data, width, height)?.data ?? null;
    }, `data:image/png;base64,${png.toString("base64")}`);
  } finally {
    await reader.close();
  }
}

/** The printed sheet's size, its pieces, and anything printed within 5 mm of a piece's edge. */
async function printedSheet(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".qr-print-root [data-qr-sheet]")!;
    const pieces = [...sheet.children].filter((child) => child.getAttribute("aria-hidden") !== "true");
    const margin = (5 * 96) / 25.4 - 0.5;
    const tooClose = pieces.flatMap((piece) => {
      const edge = piece.getBoundingClientRect();
      const boxes: Array<{ what: string; box: DOMRect; sides: string[] }> = [...piece.querySelectorAll("*")].map((element) => ({ what: element.tagName, box: element.getBoundingClientRect(), sides: ["left", "right", "top", "bottom"] }));
      // A line of text can run wider than the box it sits in, so its width is measured too. Its height
      // includes room above the letters, so the box it sits in holds it to the margin top and bottom.
      const walker = document.createTreeWalker(piece, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        boxes.push({ what: `"${node.textContent.slice(0, 40)}"`, box: range.getBoundingClientRect(), sides: ["left", "right"] });
      }
      const mm = (px: number) => `${Math.round((px * 254) / 96) / 10} mm`;
      return boxes.filter(({ box }) => box.width > 0 && box.height > 0).flatMap(({ what, box, sides }) => {
        const gaps: Record<string, number> = { left: box.left - edge.left, right: edge.right - box.right, top: box.top - edge.top, bottom: edge.bottom - box.bottom };
        return sides.filter((side) => gaps[side]! < margin).map((side) => `${what} ${side} ${mm(gaps[side]!)}`);
      });
    });
    const box = sheet.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height), pieces: pieces.length, tooClose };
  });
}

function pdfPages(pdf: Buffer): { count: number; width: number; height: number } {
  const text = pdf.toString("latin1");
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  return { count: text.match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0, width: Number(box?.[1]), height: Number(box?.[2]) };
}

test("an owner prints the business's QR code signs, which open its public profile", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  const name = `Acme Dental ${randomUUID().slice(0, 8)}`;
  let businessId: string | undefined;
  try {
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
    businessId = (await (await created).json() as { businessId: string }).businessId;
    // The rest of onboarding has its own journeys.
    await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));
    const slug = (await database.db.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, businessId)))[0]!.slug;
    const profileUrl = new URL(`/profile/${slug}`, page.url()).toString();

    // The settings tab says where the code goes, and that the page isn't published yet.
    await page.goto("/settings/usage");
    await page.getByRole("link", { name: settings.sections.qrCode, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/qrcode$/);
    await expect(page.getByText(copy.card.title, { exact: true })).toBeVisible();
    await expect(page.getByText(profileUrl, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.unpublished.title)).toBeVisible();
    await expect(page.getByRole("link", { name: copy.unpublished.link })).toHaveAttribute("href", "/settings/profile");
    await expect(page.getByRole("link", { name: copy.preview, exact: true })).toHaveAttribute("href", profileUrl);

    // Whatever the owner types is the sign's headline, line breaks included.
    const preview = page.getByRole("img", { name: /^Preview of the / });
    await page.getByLabel(copy.message.label, { exact: true }).fill("Walk-ins welcome\nAsk at the front desk");
    await expect(preview.getByText("Walk-ins welcome", { exact: true })).toBeVisible();
    await expect(preview.getByText("Ask at the front desk", { exact: true })).toBeVisible();
    await expect(preview.getByText(copy.sign.scanPage, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("qr-code-settings.png"), fullPage: true });

    // Every template and size prints on one A4 page, with nothing too close to the edge of a piece.
    for (const template of TEMPLATES) {
      await choose(page, copy.template[template]);
      for (const size of SIZES) {
        await choose(page, copy.size[size]);
        await expect(preview).toHaveAttribute("aria-label", `Preview of the ${copy.template[template]} template, ${copy.size[size]}`);
        await preview.screenshot({ path: testInfo.outputPath(`preview-${template}-${size}.png`) });
        await page.emulateMedia({ media: "print" });
        const landscape = size === "a5" || size === "a7";
        expect(await printedSheet(page)).toEqual({ width: landscape ? 1123 : 794, height: landscape ? 794 : 1123, pieces: { a4: 1, a5: 2, a6: 4, a7: 8 }[size], tooClose: [] });
        const pdf = await page.pdf({ preferCSSPageSize: true });
        const pages = pdfPages(pdf);
        expect(pages.count).toBe(1);
        expect(Math.abs(pages.width - (landscape ? A4_POINTS.height : A4_POINTS.width))).toBeLessThan(1);
        expect(Math.abs(pages.height - (landscape ? A4_POINTS.width : A4_POINTS.height))).toBeLessThan(1);
        writeFileSync(testInfo.outputPath(`print-${template}-${size}.pdf`), pdf);
        await page.emulateMedia({ media: "screen" });
      }
    }

    // The smallest printed code still opens the profile.
    await choose(page, copy.template.signal);
    await page.emulateMedia({ media: "print" });
    const smallest = page.locator(".qr-print-root [data-qr-sheet] svg[shape-rendering='crispEdges']").first();
    expect(await readQrCode(page, await smallest.screenshot())).toBe(profileUrl);
    await page.emulateMedia({ media: "screen" });

    // Print opens the browser's print window.
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => { (window as unknown as { printed: number }).printed += 1; };
    });
    await page.getByRole("button", { name: copy.print, exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);

    // The code alone downloads as a PNG that opens the profile.
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: copy.png, exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`${slug}-qr-code.png`);
    const png = readFileSync(await download.path());
    expect(await readQrCode(page, png)).toBe(profileUrl);

    // The sign can be in another language than the dashboard.
    await page.getByLabel(copy.language.label, { exact: true }).selectOption("fr");
    await expect(preview.getByText(frenchSettings.qrCode.sign.scanPage, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: copy.print, exact: true })).toBeVisible();
    // The typed message stays as typed.
    await expect(page.getByLabel(copy.message.label, { exact: true })).toHaveValue("Walk-ins welcome\nAsk at the front desk");
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
