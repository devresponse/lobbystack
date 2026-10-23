import { describe, expect, it } from "vitest";

import { invitationSubject, promoEndingSubject, renderEmail, type RenderEmailInput, type TemplateName } from "./templates";

const base = "https://app.example.test";
const locales = ["en", "fr", "es", "sr"] as const;
// French elides "que" before a vowel.
const reasonOpeners = { en: "You're receiving this email because ", fr: "Vous recevez ce courriel parce qu", es: "Recibe este correo porque ", sr: "Ovaj imejl ste dobili jer " };
const htmlLang = { en: "en", fr: "fr", es: "es", sr: "sr-Latn" };

function render(input: Pick<RenderEmailInput, "template" | "variables"> & Partial<RenderEmailInput>) {
  return renderEmail({ subject: "Subject", to: "sam@example.test", appName: "AlloPlace", ...input });
}

/** Each email a person gets about their own account, with the links it carries. */
function accountEmails(locale: string): { name: string; template: TemplateName; variables: Record<string, string>; links: string[] }[] {
  return [
    { name: "existing account", template: "existing_account", variables: { locale, signInUrl: `${base}/${locale}/login`, resetUrl: `${base}/${locale}/forgot-password` }, links: [`${base}/${locale}/login`, `${base}/${locale}/forgot-password`] },
    { name: "account setup", template: "account_setup", variables: { locale, email: "sam@example.test", url: `${base}/${locale}/forgot-password` }, links: [`${base}/${locale}/forgot-password`] },
    { name: "verification code", template: "verify_email", variables: { locale, code: "482913" }, links: [] },
    { name: "email change", template: "verify_email", variables: { locale, purpose: "email_change", newEmail: "sam.lee@example.test", url: `${base}/api/auth/verify-email?token=t` }, links: [`${base}/api/auth/verify-email?token=t`] },
    { name: "new email address", template: "verify_email", variables: { locale, url: `${base}/${locale}/confirm-email-change?token=t&email=sam` }, links: [`${base}/${locale}/confirm-email-change?token=t&email=sam`] },
    { name: "reset code", template: "password_reset", variables: { locale, code: "482913" }, links: [] },
    { name: "reset link", template: "password_reset", variables: { locale, url: `${base}/reset-password/t` }, links: [`${base}/reset-password/t`] },
    { name: "invitation", template: "invitation", variables: { locale, url: `${base}/accept-invite?token=t`, businessName: "Maple Dental", inviterName: "Yuri", inviterEmail: "yuri@example.test", role: "viewer", transfersOwnership: "false" }, links: [`${base}/accept-invite?token=t`] },
  ];
}

describe("account emails", () => {
  // Gmail showed these as one long line: their plain text had no line breaks.
  it.each(locales)("are short paragraphs with each link on its own line and why it was sent, in %s", (locale) => {
    for (const email of accountEmails(locale)) {
      const { text, html } = render({ template: email.template, variables: email.variables });
      const parts = text.split("\n\n");
      expect(parts.length, email.name).toBeGreaterThanOrEqual(4);
      for (const link of email.links) expect(text.split("\n"), email.name).toContain(link);
      expect(parts.at(-1)?.startsWith(reasonOpeners[locale]), email.name).toBe(true);
      expect(html, email.name).toContain(`<html lang="${htmlLang[locale]}">`);
      expect(html, email.name).toContain(reasonOpeners[locale].replaceAll("'", "&#39;"));
      if (locale === "sr") expect(`${text}${html}`, email.name).not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  it("lays out the you-already-have-an-account email Gmail showed on one line", () => {
    const { text } = render({ template: "existing_account", variables: { locale: "en", signInUrl: `${base}/en/login`, resetUrl: `${base}/en/forgot-password` } });
    expect(text).toBe([
      "You already have an account",
      "Someone, probably you, tried to create a new AlloPlace account with sam@example.test. This address already has an account, so we didn't create another one.",
      `Sign in to AlloPlace:\n${base}/en/login`,
      `Forgot your password? Choose a new one:\n${base}/en/forgot-password`,
      "You're receiving this email because sam@example.test was entered on the AlloPlace sign-up page. If that wasn't you, you can ignore this email. Your account hasn't changed.",
    ].join("\n\n"));
  });

  it("puts a space before the colon that leads to a link in French", () => {
    const { text } = render({ template: "existing_account", variables: { locale: "fr", signInUrl: `${base}/fr/login`, resetUrl: `${base}/fr/forgot-password` } });
    expect(text).toContain(`Se connecter à AlloPlace :\n${base}/fr/login`);
    expect(text).toContain(`Mot de passe oublié? Choisissez-en un nouveau :\n${base}/fr/forgot-password`);
  });

  it("shows a code on its own, with how long it works", () => {
    const { text, html } = render({ template: "password_reset", variables: { code: "482913" } });
    expect(text.split("\n\n")).toContain("482913");
    expect(text).toContain("The code works for 10 minutes.");
    expect(html).toContain(">482913</p>");
  });

  it("names both addresses when an email change goes to the current one", () => {
    const { text } = render({ template: "verify_email", variables: { purpose: "email_change", newEmail: "sam.lee@example.test", url: `${base}/verify` } });
    expect(text).toContain("from sam@example.test to sam.lee@example.test");
    expect(text).toContain("we'll send a link to sam.lee@example.test to confirm it");
    expect(text).toContain("You're receiving this email because sam@example.test is the current sign-in email of this AlloPlace account.");
    // Queued before the change named the new address.
    expect(render({ template: "verify_email", variables: { purpose: "email_change", url: `${base}/verify` } }).text).toContain("we'll send a link to the new address");
  });

  it("names the address an account was made for", () => {
    const { text } = render({ template: "account_setup", to: "ignored@example.test", variables: { locale: "en", email: "owner@example.test", url: `${base}/en/forgot-password` } });
    expect(text).toContain("An account on AlloPlace was created for you with owner@example.test.");
    expect(text).toContain("On that page, enter owner@example.test.");
  });
});

describe("invitations", () => {
  const url = `${base}/accept-invite?token=t`;

  it("say who invited whom to which business, in what role", () => {
    const { text, html } = render({ template: "invitation", variables: { url, businessName: "Maple Dental", inviterName: "Yuri Maksymenko", inviterEmail: "yuri@example.test", role: "business_admin", transfersOwnership: "false" } });
    expect(text).toMatch(/^Join Maple Dental on AlloPlace\n\n/);
    expect(text).toContain("Yuri Maksymenko (yuri@example.test) invited you to join Maple Dental on AlloPlace as an admin.");
    expect(text).toContain("Maple Dental uses AlloPlace to answer its calls and messages with an AI receptionist.");
    expect(text).toContain(`Accept invitation:\n${url}`);
    expect(text).toContain("To accept, sign in or create an account with sam@example.test. The invitation expires in 7 days.");
    expect(html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it("explain a handover", () => {
    const { text } = render({ template: "invitation", variables: { url, businessName: "Maple Dental", inviterEmail: "yuri@example.test", role: "business_owner", transfersOwnership: "true" } });
    expect(text).toMatch(/^Take over Maple Dental on AlloPlace\n\n/);
    expect(text).toContain("yuri@example.test wants to hand Maple Dental over to you on AlloPlace. When you accept, you become its owner and they leave the team.");
  });

  it("leave out a name that is just the start of the address", () => {
    const { text } = render({ template: "invitation", variables: { url, businessName: "Maple Dental", inviterName: "yuri", inviterEmail: "yuri@example.test", role: "viewer" } });
    expect(text).toContain("yuri@example.test invited you to join Maple Dental on AlloPlace as a viewer.");
  });

  it("still read well when queued before they named the business", () => {
    const { text } = render({ template: "invitation", variables: { message: "", url } });
    expect(text).toMatch(/^Join AlloPlace\n\n/);
    expect(text).toContain("Someone on the team invited you to join a team on AlloPlace.");
    expect(text).toContain(`Accept invitation:\n${url}`);
  });

  it("have a subject that names the business, or a handover", () => {
    expect(invitationSubject({}, "AlloPlace")).toBe("You're invited to join AlloPlace");
    expect(invitationSubject({ businessName: "Maple Dental" }, "AlloPlace")).toBe("You're invited to join Maple Dental on AlloPlace");
    expect(invitationSubject({ businessName: "Maple Dental", transfersOwnership: "true" }, "AlloPlace")).toBe("Take over Maple Dental on AlloPlace");
    expect(invitationSubject({ businessName: "Maple Dental", locale: "sr" }, "AlloPlace")).toBe("Pozivnica za firmu Maple Dental na servisu AlloPlace");
  });
});

describe("alerts", () => {
  const alert = (variables: Record<string, string>, subject = "New voice message") => render({ template: "operator_alert", subject, to: "owner@example.test", variables });

  it("name the business, link to where to act, and say which setting sends them", () => {
    const { text, html } = alert({ message: "A caller left a voice message. Open the inbox to review it.", eventKind: "voiceMessage", businessName: "Maple Dental", appUrl: `${base}/` });
    expect(text).toBe([
      "Maple Dental\nNew voice message",
      "A caller left a voice message. Open the inbox to review it.",
      `Open the dashboard:\n${base}/`,
      `You're receiving this email because your AlloPlace account has email alerts on for voice messages at Maple Dental. To choose which alerts you get, go to Settings > Notifications:\n${base}/settings/notifications`,
    ].join("\n\n"));
    expect(html).toContain(`<a href="${base}/settings/notifications"`);
    expect(html).toContain('<html lang="en">');
  });

  it("quote a website visitor's message, escaped", () => {
    const { text, html } = alert({ message: "Do you open <b>Saturdays</b>?", eventKind: "widgetChat", businessName: "Maple Dental", appUrl: base }, "New website chat message");
    expect(text).toContain("A visitor wrote this in the chat on your website:\n\n> Do you open <b>Saturdays</b>?\n\n");
    expect(text).toContain(`Open Messages:\n${base}/messages`);
    expect(html).toContain("Do you open &lt;b&gt;Saturdays&lt;/b&gt;?");
    expect(html).not.toContain("<b>Saturdays</b>");
  });

  it("keep a daily summary's list on separate lines", () => {
    const { text, html } = alert({ message: "On Saturday, October 17, 2026, Maple Dental had 3 alerts:\n\nVoice messages: 1\nWebsite chat messages: 2", eventKind: "dailyDigest", businessName: "Maple Dental", appUrl: base }, "Daily summary for Maple Dental");
    // The heading names the business already.
    expect(text).toMatch(/^Daily summary for Maple Dental\n\nOn Saturday/);
    expect(text).toContain("\n\nVoice messages: 1\nWebsite chat messages: 2\n\n");
    expect(text).toContain("your AlloPlace account has the daily summary on for Maple Dental. To stop getting alerts by email, go to Settings > Notifications:");
    expect(html).toContain("Voice messages: 1<br />Website chat messages: 2");
  });

  it("split a message at blank lines, whatever ends its lines", () => {
    const { text } = alert({ message: "First line\r\nsame paragraph\r\n \r\n\r\nSecond", eventKind: "voiceMessage", businessName: "Maple Dental", appUrl: `${base}///` });
    expect(text.split("\n\n").slice(1, 4)).toEqual(["First line\r\nsame paragraph", "Second", `Open the dashboard:\n${base}/`]);
  });

  it("are just the message when queued without the business or kind", () => {
    const { text, html } = alert({ message: "Hi" }, "Test");
    expect(text).toBe("Test\n\nHi");
    expect(html).not.toContain("<a ");
  });
});

describe("promo endings", () => {
  const ending = (variables: Record<string, string>) => ({ locale: "en", businessName: "Maple Dental", planName: "Salons half off", tier: "Pro", ending: "tier", date: "2026-11-01T03:30:00.000Z", timeZone: "America/Toronto", interval: "monthly", priceCents: "4900", currency: "cad", url: `${base}/settings/plan`, ...variables });

  it("say when the plan ends, in the business's time zone, and what the subscription becomes at what price", () => {
    const { text } = render({ template: "promo_ending", variables: ending({}) });
    expect(text).toBe([
      "Maple Dental\nYour Salons half off plan ends on October 31, 2026",
      "On October 31, 2026, Maple Dental moves from Salons half off to Pro. Your subscription continues on Pro at CA$49 a month, charged to your saved payment method.",
      "You don't need to do anything. To choose another plan or cancel, go to Settings > Plan before then.",
      `Open Settings > Plan:\n${base}/settings/plan`,
      "You're receiving this email because you own Maple Dental on AlloPlace.",
    ].join("\n\n"));
    expect(promoEndingSubject(ending({}))).toBe("Your Salons half off plan ends on October 31, 2026");
  });

  it("say the subscription ends with a plan that cancels, and a yearly price per year", () => {
    expect(render({ template: "promo_ending", variables: ending({ ending: "cancel" }) }).text).toContain("On October 31, 2026, Salons half off ends for Maple Dental, and so does your subscription. Maple Dental then moves to the free plan.");
    expect(render({ template: "promo_ending", variables: ending({ interval: "annual", priceCents: "47040" }) }).text).toContain("at CA$470.40 a year");
    expect(render({ template: "promo_ending", variables: ending({ priceCents: "" }) }).text).toContain("continues on Pro at its standard price,");
  });

  it.each(locales)("read as the owner's language, with why it was sent, in %s", (locale) => {
    const { text, html } = render({ template: "promo_ending", variables: ending({ locale }) });
    expect(text.split("\n\n").at(-1)?.startsWith(reasonOpeners[locale])).toBe(true);
    expect(text.split("\n")).toContain(`${base}/settings/plan`);
    expect(html).toContain(`<html lang="${htmlLang[locale]}">`);
    if (locale === "sr") expect(text).toContain("31. 10. 2026.");
  });

  it("fall back to UTC for a time zone the runtime doesn't know", () => {
    expect(promoEndingSubject(ending({ timeZone: "Mars/Olympus" }))).toBe("Your Salons half off plan ends on November 1, 2026");
  });
});

it("writes dashboard feedback as plain text with who sent it and from where", () => {
  const email = render({ template: "feedback_submission", to: "feedback@example.test", variables: { body: "Slow calendar.\nOn my phone.", userName: "Yuri", userEmail: "yuri@example.test", businessName: "Maple Dental", pagePath: "/appointments" } });
  expect(email.html).toBeUndefined();
  expect(email.text).toBe([
    "New feedback from the AlloPlace dashboard.",
    "From: Yuri (yuri@example.test)\nBusiness: Maple Dental\nPage: /appointments",
    "Message:\nSlow calendar.\nOn my phone.",
    "You're receiving this email because this address is the feedback inbox (FEEDBACK_TO_EMAIL) of AlloPlace. To answer, write to yuri@example.test.",
  ].join("\n\n"));
});

it("escapes names people chose before putting them in HTML", () => {
  const { html } = render({ template: "invitation", variables: { url: `${base}/accept-invite?token=t`, businessName: "<script>x</script>", inviterName: "A \"B\" <c>", inviterEmail: "a@example.test", role: "viewer" } });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(html).toContain("A &quot;B&quot; &lt;c&gt;");
});
