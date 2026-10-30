import { describe, expect, it } from "vitest";

import { callTranscriptSubject, cancellationSubject, invitationSubject, promoEndingSubject, renderEmail, type CallTranscriptEmail, type RenderEmailInput, type TemplateName } from "./templates";

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
    { name: "cancellation", template: "cancellation_confirm", variables: { locale, url: `${base}/cancel-account?token=t`, businessName: "Maple Dental" }, links: [`${base}/cancel-account?token=t`] },
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

describe("emails about canceling a business", () => {
  const details = { businessName: "Maple Dental", businessId: "b1", businessSlug: "maple-dental", businessType: "dental", timeZone: "America/Toronto", websiteUrl: "https://maple.example.test", createdAt: "2026-01-05 14:00 UTC", owners: "Sam Lee <sam@example.test>, Ana Ruiz <ana@example.test>", teamSize: "3", plan: "pro plan (monthly), paid through Polar (active)", phoneNumbers: "+14165550134, +14165550135", appUrl: base, requesterName: "Sam Lee", requesterEmail: "sam@example.test" };
  const toInbox = (template: "cancellation_request" | "cancellation_completed", variables: Record<string, string>) => render({ template, to: "cancel@example.test", subject: cancellationSubject(template, variables), variables });
  const inboxReason = "You're receiving this email because cancel@example.test is where AlloPlace sends account cancellations: the brand's contact address, else FEEDBACK_TO_EMAIL.";

  it("ask the owner to confirm through a link that works for 24 hours, and say what canceling does", () => {
    const { text, html } = render({ template: "cancellation_confirm", variables: { locale: "en", businessName: "Maple Dental", url: `${base}/cancel-account?token=t` } });
    expect(text).toBe([
      "Maple Dental\nConfirm canceling Maple Dental",
      "You asked to cancel Maple Dental on AlloPlace. Nothing has changed yet. To cancel it, open the link below, sign in with sam@example.test and confirm with your password.",
      "Once you confirm, nobody on the team can open Maple Dental, its receptionist stops answering calls and texts, its phone numbers go back to the provider after 30 days, and a paid plan is canceled. Nothing is deleted. You can then start again with a new business.",
      `Confirm the cancellation:\n${base}/cancel-account?token=t`,
      "The link works for 24 hours. After that, you can ask again in Settings > Team.",
      "You're receiving this email because someone signed in with sam@example.test asked to cancel Maple Dental on AlloPlace. If it wasn't you, change your password. Nothing changes unless the cancellation is confirmed with this link.",
    ].join("\n\n"));
    expect(html).toContain(`<a href="${base}/cancel-account?token=t"`);
  });

  it("name the business in each subject, and ask the owner in their language", () => {
    const named = { businessName: " Maple Dental " };
    expect(cancellationSubject("cancellation_confirm", named)).toBe("Confirm canceling Maple Dental");
    expect(cancellationSubject("cancellation_confirm", { ...named, locale: "fr" })).toBe("Confirmez l'annulation de Maple Dental");
    expect(cancellationSubject("cancellation_confirm", { ...named, locale: "es" })).toBe("Confirme la cancelación de Maple Dental");
    expect(cancellationSubject("cancellation_confirm", { ...named, locale: "sr" })).toBe("Potvrdite otkazivanje firme Maple Dental");
    // The inbox reads English, whoever asked.
    expect(cancellationSubject("cancellation_request", { ...named, locale: "fr" })).toBe("Cancellation request: Maple Dental");
    expect(cancellationSubject("cancellation_completed", { ...named, locale: "fr" })).toBe("Canceled: Maple Dental");
  });

  it("tell the inbox who asked to cancel which business, with its details, and that nothing changes until they confirm", () => {
    const { text, html } = toInbox("cancellation_request", { ...details, requestedAt: "2026-10-30 15:11 UTC", expiresAt: "2026-10-31 15:11 UTC" });
    expect(text).toBe([
      "Cancellation request: Maple Dental",
      "Sam Lee (sam@example.test) asked to cancel Maple Dental on AlloPlace. They were emailed a link to confirm, which works until 2026-10-31 15:11 UTC. Nothing changes unless they confirm, and this inbox gets another email if they do.",
      [
        "Business: Maple Dental",
        "Business ID: b1",
        "Slug: maple-dental",
        "Type: dental",
        "Time zone: America/Toronto",
        "Website: https://maple.example.test",
        "Created: 2026-01-05 14:00 UTC",
        "Owners: Sam Lee <sam@example.test>, Ana Ruiz <ana@example.test>",
        "Team members: 3",
        "Plan: pro plan (monthly), paid through Polar (active)",
        "Phone numbers: +14165550134, +14165550135",
        "Requested by: Sam Lee (sam@example.test)",
        "Requested at: 2026-10-30 15:11 UTC",
        "Link works until: 2026-10-31 15:11 UTC",
        `Dashboard: ${base}`,
      ].join("\n"),
      "Once confirmed, nobody on the team can open the business, its numbers stop answering and go back to Twilio 30 days later, and a plan paid through Polar is canceled. Nothing is deleted.",
      inboxReason,
    ].join("\n\n"));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Sam Lee &lt;sam@example.test&gt;");
  });

  it("leave out details the business doesn't have, and say when it has no numbers", () => {
    const { text } = toInbox("cancellation_request", { businessName: "Maple Dental", businessId: "b1", requesterEmail: "sam@example.test", phoneNumbers: "", websiteUrl: "" });
    expect(text).toContain("\n\nsam@example.test asked to cancel Maple Dental on AlloPlace. They were emailed a link to confirm, which works until 24 hours from now.");
    expect(text).toContain("\n\nBusiness: Maple Dental\nBusiness ID: b1\nPhone numbers: None\nRequested by: sam@example.test\n\n");
    expect(text).not.toContain("Website:");
  });

  it("tell the inbox once the owner confirms, with what happens to the plan and the numbers, and how to bring the business back", () => {
    const { text } = toInbox("cancellation_completed", { ...details, canceledAt: "2026-10-30 16:02 UTC", planOutcome: "polar", numbersReleasedOn: "2026-11-29" });
    expect(text).toBe([
      "Canceled: Maple Dental",
      "Sam Lee (sam@example.test) confirmed the cancellation of Maple Dental on AlloPlace at 2026-10-30 16:02 UTC. Nothing was deleted: the business is now inactive, nobody on its team can open it, and its receptionist no longer answers calls or texts.",
      "Its paid plan is being canceled in Polar now. If Polar still shows the subscription as active in an hour, cancel it there by hand.",
      "Its phone numbers (+14165550134, +14165550135) go back to Twilio on 2026-11-29 unless the business is reactivated before then.",
      [
        "Business: Maple Dental",
        "Business ID: b1",
        "Slug: maple-dental",
        "Type: dental",
        "Time zone: America/Toronto",
        "Website: https://maple.example.test",
        "Created: 2026-01-05 14:00 UTC",
        "Owners: Sam Lee <sam@example.test>, Ana Ruiz <ana@example.test>",
        "Team members: 3",
        "Plan: pro plan (monthly), paid through Polar (active)",
        "Phone numbers: +14165550134, +14165550135",
        "Canceled by: Sam Lee (sam@example.test)",
        "Canceled at: 2026-10-30 16:02 UTC",
        `Dashboard: ${base}`,
      ].join("\n"),
      "To reactivate it, see 7.27, \"Reactivate a canceled business\", in the deployment guide. Its plan stays canceled.",
      inboxReason,
    ].join("\n\n"));
  });

  it("say a plan billed outside the app ends by hand, a free one has nothing to end, and a business without numbers has none to release", () => {
    const managed = toInbox("cancellation_completed", { ...details, plan: "pro plan, billed outside the app", planOutcome: "managed", phoneNumbers: "" }).text;
    expect(managed).toContain("\n\nIts plan is billed outside the app, so end it by hand.\n\nIt has no phone numbers waiting to go back to Twilio.\n\n");
    expect(managed).toContain("\nPhone numbers: None\n");
    const free = toInbox("cancellation_completed", { ...details, plan: "Free plan", planOutcome: "free" }).text;
    expect(free).toContain("\n\nIt was on the free plan, so there's no plan to cancel.\n\n");
    // Queued without who confirmed or what the plan was, it asks to check the plan.
    const bare = toInbox("cancellation_completed", { businessName: "Maple Dental" }).text;
    expect(bare).toContain("\n\nAn owner confirmed the cancellation of Maple Dental on AlloPlace. Nothing was deleted:");
    expect(bare).toContain("\n\nCheck its plan in Polar, and cancel it there by hand if it's still active.\n\n");
  });
});

describe("emails after a call", () => {
  const call = (change: Partial<CallTranscriptEmail> = {}): CallTranscriptEmail => ({
    locale: "en",
    businessName: "Maple Dental",
    timeZone: "America/Toronto",
    channel: "phone",
    callerName: "Jane Doe",
    callerPhone: "+14165550134",
    startedAt: "2026-10-26T19:42:10.000Z",
    durationSeconds: 252,
    outcome: { kind: "booked", serviceName: "Cleaning", startsAt: "2026-10-30T14:00:00.000Z" },
    callUrl: `${base}/calls/c1`,
    settingsUrl: `${base}/settings/notifications`,
    turns: [
      { speaker: "assistant", text: "Thanks for calling Maple Dental, how can I help?", atSeconds: 0 },
      { speaker: "caller", text: "Hi, I'd like a cleaning on Friday.", atSeconds: 4.6 },
      { speaker: "assistant", text: "Friday at 10 works. Booked!", atSeconds: 69 },
    ],
    ...change,
  });
  const send = (email: CallTranscriptEmail) => render({ template: "call_transcript", subject: callTranscriptSubject(email), to: "owner@example.test", variables: {}, callTranscript: email });
  const line = (text: string, start: string) => text.split("\n").find((row) => row.startsWith(start));

  it("say who called, when, for how long and how it went, then give every turn", () => {
    const { text, html, attachments } = send(call());
    expect(text).toBe([
      "Maple Dental\nCall with Jane Doe",
      "When: Mon, Oct 26, 2026, 3:42 PM EDT\nLength: 4 min 12 sec\nCaller: Jane Doe, +14165550134\nCall: Phone call\nSummary: Caller booked Cleaning for Oct 30, 2026, 10:00 AM.",
      `Open the call:\n${base}/calls/c1`,
      "Transcript",
      "0:00 Assistant: Thanks for calling Maple Dental, how can I help?",
      "0:04 Caller: Hi, I'd like a cleaning on Friday.",
      "1:09 Assistant: Friday at 10 works. Booked!",
      `You're receiving this email because your AlloPlace account gets an email after each call at Maple Dental. This copy stays in your mailbox after the dashboard deletes the transcript. To stop these emails, go to Settings > Notifications:\n${base}/settings/notifications`,
    ].join("\n\n"));
    expect(html).toContain(`<a href="${base}/calls/c1"`);
    expect(html).toContain('<p class="t"><i>0:04</i> <b>Caller:</b> <span dir="auto">Hi, I&#39;d like a cleaning on Friday.</span></p>');
    expect(attachments).toBeUndefined();
  });

  it("hold the summary and a link when the business doesn't send the whole conversation", () => {
    const { text, html } = send(call({ turns: null }));
    expect(text).toContain([
      "Summary: Caller booked Cleaning for Oct 30, 2026, 10:00 AM.",
      "Open the call to read the whole conversation.",
      `Open the call:\n${base}/calls/c1`,
      `You're receiving this email because your AlloPlace account gets an email after each call at Maple Dental. To stop these emails, go to Settings > Notifications:\n${base}/settings/notifications`,
    ].join("\n\n"));
    expect(text).not.toContain("Thanks for calling");
    expect(html).not.toContain('class="t"');
  });

  it("have a subject with who called and for how long, but never their number", () => {
    expect(callTranscriptSubject(call())).toBe("Call transcript: Jane Doe, 4 min");
    expect(callTranscriptSubject(call({ turns: null }))).toBe("Call summary: Jane Doe, 4 min");
    expect(callTranscriptSubject(call({ callerName: null }))).toBe("Call transcript: unknown caller, 4 min");
    expect(callTranscriptSubject(call({ channel: "website", callerName: "  ", durationSeconds: 45 }))).toBe("Call transcript: website visitor, 45 sec");
    expect(callTranscriptSubject(call({ callerName: "Jane\n  Doe", durationSeconds: null }))).toBe("Call transcript: Jane Doe");
    expect(callTranscriptSubject(call({ channel: "test", durationSeconds: 45 }))).toBe("Test call transcript: 45 sec");
    expect(callTranscriptSubject(call({ channel: "test", turns: null, durationSeconds: null }))).toBe("Test call summary");
    // French keeps a number with its unit.
    expect(callTranscriptSubject(call({ locale: "fr" }))).toBe("Transcription d'appel : Jane Doe, 4\u00a0min");
    expect(callTranscriptSubject(call({ locale: "es", turns: null }))).toBe("Resumen de llamada: Jane Doe, 4 min");
    expect(callTranscriptSubject(call({ locale: "sr", channel: "test", durationSeconds: 45 }))).toBe("Transkript probnog poziva: 45 sek");
  });

  it.each(locales)("read in the reader's language, with why it was sent and where to stop it, in %s", (locale) => {
    const { text, html } = send(call({ locale }));
    const reason = text.split("\n\n").at(-1);
    expect(reason?.startsWith(reasonOpeners[locale])).toBe(true);
    expect(reason?.endsWith(`\n${base}/settings/notifications`)).toBe(true);
    expect(html).toContain(`<html lang="${htmlLang[locale]}">`);
    expect(html).toContain(`<a href="${base}/settings/notifications"`);
    if (locale === "sr") expect(`${text}${html}`).not.toMatch(/[Ѐ-ӿ]/);
  });

  it("put a space before each colon in French", () => {
    const { text, html } = send(call({ locale: "fr" }));
    expect(text).toContain("\nAppelant : Jane Doe, +14165550134\n");
    expect(text).toContain("\n\n0:04 Appelant : Hi, I'd like a cleaning on Friday.\n\n");
    expect(html).toContain("<b>Appelant&nbsp;:</b>");
  });

  it("escape what was said and let each turn keep its own direction", () => {
    const { text, html } = send(call({
      callerName: "<b>Jane</b>",
      outcome: { kind: "summary", summary: "<script>alert(1)</script>" },
      turns: [
        { speaker: "caller", text: 'Call me <a href="https://example.test/x">here</a>\nor at noon', atSeconds: 3 },
        { speaker: "assistant", text: "   ", atSeconds: 4 },
        { speaker: "caller", text: "مرحبا", atSeconds: 5 },
      ],
    }));
    expect(html).not.toContain("<b>Jane</b>");
    expect(html).toContain("Call with &lt;b&gt;Jane&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<a href="https://example.test/x">');
    expect(html).toContain('<span dir="auto">Call me &lt;a href=&quot;https://example.test/x&quot;&gt;here&lt;/a&gt;<br />or at noon</span>');
    expect(html).toContain('<span dir="auto">مرحبا</span>');
    expect(html).toContain('<td dir="auto"');
    // A turn with no words isn't one.
    expect(text).not.toContain("0:04 Assistant:");
  });

  it("take card and ID numbers out of the turns and the summary, in the reader's language", () => {
    const said = call({
      outcome: { kind: "summary", summary: "Paid with 4111 1111 1111 1111." },
      turns: [
        { speaker: "caller", text: "My card is 4111 1111 1111 1111 and my SIN is 046 454 286.", atSeconds: 3 },
        { speaker: "assistant", text: "Thanks. Call us back at 416 555 0134.", atSeconds: 9 },
      ],
    });
    const { text, html } = send(said);
    expect(text).toContain("Summary: Paid with [card number removed].");
    expect(text).toContain("0:03 Caller: My card is [card number removed] and my SIN is [ID number removed].");
    expect(text).toContain("0:09 Assistant: Thanks. Call us back at 416 555 0134.");
    expect(`${text}${html}`).not.toMatch(/4111|046 454/);
    expect(send({ ...said, locale: "fr" }).text).toContain("Appelant : My card is [numéro de carte retiré] and my SIN is [numéro d'identité retiré].");
    // A long call's attached file leaves them out too.
    const turns = Array.from({ length: 900 }, (_, index) => ({ speaker: "caller" as const, text: `Turn ${index}: 5555 5555 5555 4444`, atSeconds: index }));
    const { attachments } = send(call({ turns }));
    expect(attachments?.[0]?.content).toContain("Turn 899: [card number removed]");
    expect(attachments?.[0]?.content).not.toContain("4444");
  });

  it("stop a long call's turns before Gmail clips the email, and attach the whole conversation", () => {
    const turns = Array.from({ length: 900 }, (_, index) => ({ speaker: index % 2 ? "caller" as const : "assistant" as const, text: `Turn ${index}, about as long as what a person says in one go.`, atSeconds: index * 4 }));
    // 10:30 PM in Toronto, the day before UTC's.
    const { text, html = "", attachments } = send(call({ turns, startedAt: "2026-10-27T02:30:00.000Z" }));
    expect(new TextEncoder().encode(html).length).toBeLessThan(102_000);
    expect(text).toContain("\n\nThe transcript stops here because it's long. The whole conversation is in the attached file and on the call's page.\n\n");
    expect(text).not.toContain("Turn 899,");
    expect(attachments).toEqual([{ filename: "call-2026-10-26.txt", content: expect.stringContaining("\n\n59:56 Caller: Turn 899, about as long as what a person says in one go.\n"), contentType: "text/plain; charset=utf-8" }]);
    expect(attachments?.[0]?.content).toMatch(/^Maple Dental\nCall with Jane Doe\n\nWhen: Mon, Oct 26, 2026, 10:30 PM EDT\n/);
  });

  it("leave out who called on a test call, and a length the call didn't record", () => {
    expect(send(call({ channel: "test", durationSeconds: null })).text).toMatch(/^Maple Dental\nTest call from the dashboard\n\nWhen: [^\n]+\nCall: Dashboard test call\nSummary: [^\n]+\n\n/);
    expect(line(send(call({ channel: "website", callerName: null, callerPhone: null })).text, "Caller: ")).toBe("Caller: Not given");
  });

  it("say how the call went as its page does", () => {
    const summary = (outcome: CallTranscriptEmail["outcome"]) => line(send(call({ outcome, turns: null })).text, "Summary: ");
    expect(summary({ kind: "summary", summary: "Asked about Saturday hours." })).toBe("Summary: Asked about Saturday hours.");
    expect(summary({ kind: "message_taking" })).toBe("Summary: Caller left a message for follow-up.");
    expect(summary({ kind: "booking_in_progress", serviceName: "Cleaning", startsAt: null })).toBe("Summary: Caller discussed scheduling Cleaning, but no appointment was confirmed.");
    expect(summary({ kind: "booking_in_progress", serviceName: null, startsAt: null })).toBe("Summary: Caller started scheduling, but no appointment was confirmed.");
    expect(summary({ kind: "disposition", disposition: "transfer_busy" })).toBe("Summary: Transfer was attempted, but the destination line was busy.");
    expect(summary({ kind: "disposition", disposition: "blocked_contact" })).toBe("Summary: Call was blocked before the assistant answered.");
    expect(summary({ kind: "none" })).toBe("Summary: Caller asked questions, but no final outcome was captured yet.");
  });

  it("write the call's start in the business's time zone, or in UTC for one the runtime doesn't know", () => {
    expect(line(send(call({ timeZone: "Europe/Belgrade" })).text, "When: ")).toBe("When: Mon, Oct 26, 2026, 8:42 PM GMT+1");
    expect(line(send(call({ timeZone: "Mars/Olympus" })).text, "When: ")).toBe("When: Mon, Oct 26, 2026, 7:42 PM UTC");
    expect(line(send(call({ locale: "sr", timeZone: "Europe/Belgrade" })).text, "Vreme: ")).toBe("Vreme: 26. 10. 2026. 20:42 CET");
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
