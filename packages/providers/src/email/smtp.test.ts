import { afterEach, describe, expect, it, vi } from "vitest";

import { SmtpEmailProvider } from "./smtp";

afterEach(() => vi.unstubAllEnvs());

describe("SMTP delivery", () => {
  it("blocks unapproved certification recipients before SMTP delivery", async () => {
    vi.stubEnv("LOBBYSTACK_CERTIFICATION_MODE", "true");
    vi.stubEnv("LOBBYSTACK_CERTIFICATION_EMAILS", "approved@example.invalid");
    const sendMail = vi.fn().mockResolvedValue({ messageId: "fixture" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    await expect(provider.sendTemplate({ template: "operator_alert", appName: "AlloPlace", to: "other@example.invalid", subject: "Test", variables: {} })).rejects.toThrow("CERTIFICATION_RECIPIENT_BLOCKED");
    expect(sendMail).not.toHaveBeenCalled();
    await provider.sendTemplate({ template: "operator_alert", appName: "AlloPlace", to: "approved@example.invalid", subject: "Test", variables: {} });
    expect(sendMail).toHaveBeenCalledOnce();
  });
  it("sends the onboarding follow-up as plain text from the founder, with replies going to the founder", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test", replyTo: "support@example.test" }, { sendMail } as never);
    await provider.sendTemplate({ template: "onboarding_followup", appName: "AlloPlace", to: "owner@example.test", from: "Raphael <raphael@example.test>", subject: "How'd you like AlloPlace?", variables: { locale: "en", firstName: "Sam", businessName: "Acme Dental", senderName: "Raphael" } });
    const sent = sendMail.mock.calls[0]?.[0];
    expect(sent.from).toBe("Raphael <raphael@example.test>");
    expect(sent.replyTo).toBeUndefined();
    expect(sent.html).toBeUndefined();
    expect(sent.text).toMatch(/^Hi Sam,\n/);
    expect(sent.text).toContain("I'm Raphael, the founder of AlloPlace. You set up a receptionist for Acme Dental yesterday.");
    expect(sent.text).toContain("3. Do you plan to use it for real, with your own phone number?");
    expect(sent.text).toContain("You can reply to this email, and two lines would be plenty!\n\nThanks again,\nRaphael\nFounder, AlloPlace");
    await provider.sendTemplate({ template: "onboarding_followup", appName: "AlloPlace", to: "owner@example.test", subject: "Votre avis sur AlloPlace ?", variables: { locale: "fr", firstName: "", businessName: "Clinique", senderName: "Raphael" } });
    const french = sendMail.mock.calls[1]?.[0];
    expect(french.from).toBe("no-reply@example.test");
    expect(french.replyTo).toBe("support@example.test");
    expect(french.text).toMatch(/^Bonjour,\n/);
    expect(french.text).toContain("une réceptionniste pour Clinique hier");
    expect(french.text).toContain("Je suis Raphael, fondateur du service AlloPlace.");
    expect(french.text).toContain("Raphael\nFondateur, AlloPlace");
  });
  it("tells someone a platform key made an account for how to set its password", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    await provider.sendTemplate({ template: "account_setup", appName: "AlloPlace", to: "owner@example.test", subject: "Set up your AlloPlace account", variables: { locale: "en", email: "owner@example.test", url: "https://app.example.test/en/forgot-password" } });
    await provider.sendTemplate({ template: "account_setup", appName: "AlloPlace", to: "owner@example.test", subject: "Configurez votre compte AlloPlace", variables: { locale: "fr", email: "owner@example.test", url: "https://app.example.test/fr/forgot-password" } });
    const [english, french] = sendMail.mock.calls.map((call) => call[0].text as string);
    expect(english).toBe("An account on AlloPlace was made for you with owner@example.test. To choose your password, open https://app.example.test/en/forgot-password, enter this address, and type in the code we send you. If you weren't expecting this, ignore this email.");
    expect(french).toContain("ouvrez https://app.example.test/fr/forgot-password");
  });

  it("localizes the onboarding follow-up and existing-account emails in Spanish and Serbian", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    await provider.sendTemplate({ template: "onboarding_followup", appName: "AlloPlace", to: "owner@example.test", subject: "¿Qué le pareció AlloPlace?", variables: { locale: "es", firstName: "Ana", businessName: "Clínica Sol", senderName: "Raphael" } });
    await provider.sendTemplate({ template: "onboarding_followup", appName: "AlloPlace", to: "owner@example.test", subject: "Kako Vam se dopao servis AlloPlace?", variables: { locale: "sr", firstName: "", businessName: "Ordinacija Javor", senderName: "Raphael" } });
    await provider.sendTemplate({ template: "existing_account", appName: "AlloPlace", to: "owner@example.test", subject: "Ya tiene una cuenta de AlloPlace", variables: { locale: "es", signInUrl: "https://app.example.test/es/login", resetUrl: "https://app.example.test/es/forgot-password" } });
    await provider.sendTemplate({ template: "existing_account", appName: "AlloPlace", to: "owner@example.test", subject: "Već imate AlloPlace nalog", variables: { locale: "sr", signInUrl: "https://app.example.test/sr/login", resetUrl: "https://app.example.test/sr/forgot-password" } });
    const [spanish, serbian, spanishAccount, serbianAccount] = sendMail.mock.calls.map((call) => call[0].text as string);
    expect(spanish).toMatch(/^Hola, Ana:\n/);
    expect(spanish).toContain("una recepcionista para Clínica Sol");
    expect(serbian).toMatch(/^Zdravo,\n/);
    expect(serbian).toContain("recepcionera za Ordinacija Javor");
    expect(serbian).toContain("Ja sam Raphael, osnivač servisa AlloPlace.");
    expect(serbian).not.toMatch(/[Ѐ-ӿ]/);
    expect(spanishAccount).toContain("Inicie sesión para continuar: https://app.example.test/es/login");
    expect(serbianAccount).toContain("Prijavite se da biste nastavili: https://app.example.test/sr/login");
  });
  it("sends reset codes as codes while preserving previously issued reset links", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    await provider.sendTemplate({ template: "password_reset", appName: "AlloPlace", to: "recipient@example.test", subject: "Reset", variables: { code: "123456" } });
    expect(sendMail.mock.calls[0]?.[0].text).toBe("Your AlloPlace password reset code is: 123456. It expires in 10 minutes.");
    await provider.sendTemplate({ template: "password_reset", appName: "AlloPlace", to: "recipient@example.test", subject: "Reset", variables: { url: "https://example.test/reset" } });
    expect(sendMail.mock.calls[1]?.[0].text).toContain("using this link: https://example.test/reset");
  });
  it("sends email verification codes while preserving email-change links", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    await provider.sendTemplate({ template: "verify_email", appName: "AlloPlace", to: "recipient@example.test", subject: "Verify", variables: { code: "123456" } });
    expect(sendMail.mock.calls[0]?.[0].text).toBe("Your AlloPlace email verification code is: 123456. It expires in 10 minutes.");
    expect(sendMail.mock.calls[0]?.[0].html).toContain(">AlloPlace</p>");
    expect(sendMail.mock.calls[0]?.[0].html).toContain("finish setting up your AlloPlace account.");
    expect(sendMail.mock.calls[0]?.[0].html).not.toContain("<svg");
    expect(sendMail.mock.calls[0]?.[0].html).toContain("Verify your email address");
    expect(sendMail.mock.calls[0]?.[0].html).toContain(">123456</p>");
    await provider.sendTemplate({ template: "verify_email", appName: "AlloPlace", to: "recipient@example.test", subject: "Verify", variables: { url: "https://example.test/verify" } });
    expect(sendMail.mock.calls[1]?.[0].text).toContain("using this link: https://example.test/verify");
    expect(sendMail.mock.calls[1]?.[0].html).toBeUndefined();
  });
  it("escapes verification email content before rendering branded HTML", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    await provider.sendTemplate({ template: "verify_email", appName: "AlloPlace", to: "recipient@example.test", subject: "Verify <email>", variables: { code: "12<345" } });
    const html = sendMail.mock.calls[0]?.[0].html;
    expect(html).toContain("<title>Verify &lt;email&gt;</title>");
    expect(html).toContain(">12&lt;345</p>");
    expect(html).not.toContain(">12<345</p>");
  });
  it("uses a stable privacy-safe Message-ID for retries", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    const input = { template: "verify_email" as const, appName: "AlloPlace", to: "recipient@example.test", subject: "Verify", variables: { url: "https://example.test/verify" }, idempotencyKey: "auth-email:stable" };
    await provider.sendTemplate(input);
    await provider.sendTemplate(input);
    const first = sendMail.mock.calls[0]?.[0].messageId;
    expect(first).toBe(sendMail.mock.calls[1]?.[0].messageId);
    expect(first).not.toContain("recipient");
  });
  it("calls the app by the deployment's name in every email and escapes it in HTML", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const provider = new SmtpEmailProvider({ host: "localhost", port: 1025, secure: false, username: "", password: "", from: "no-reply@example.test" }, { sendMail } as never);
    const variablesFor = (locale: string) => ({ locale, code: "123456", email: "owner@example.test", url: "https://app.example.test/x", signInUrl: "https://app.example.test/login", resetUrl: "https://app.example.test/reset", firstName: "Sam", businessName: "Acme", senderName: "Miki" });
    for (const template of ["existing_account", "account_setup", "verify_email", "password_reset", "invitation", "onboarding_followup"] as const) {
      for (const locale of ["en", "fr", "es", "sr"]) {
        await provider.sendTemplate({ template, appName: "RealInfoBot", to: "owner@example.test", subject: "Subject", variables: variablesFor(locale) });
      }
    }
    for (const template of ["operator_alert", "feedback_submission"] as const) {
      await provider.sendTemplate({ template, appName: "RealInfoBot", to: "owner@example.test", subject: "Subject", variables: {} });
    }
    for (const [message] of sendMail.mock.calls) {
      expect(`${message.text}${message.html ?? ""}`).not.toContain("LobbyStack");
      expect(message.text).toContain("RealInfoBot");
    }
    await provider.sendTemplate({ template: "verify_email", appName: "A&B <Realty>", to: "owner@example.test", subject: "Verify", variables: { code: "123456" } });
    const html = sendMail.mock.calls.at(-1)?.[0].html as string;
    expect(html).toContain(">A&amp;B &lt;Realty&gt;</p>");
    expect(html).not.toContain("<Realty>");
  });
});
