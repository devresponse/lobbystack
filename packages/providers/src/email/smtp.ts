import { createHash } from "node:crypto";

import nodemailer, { type Transporter } from "nodemailer";
import { assertCertificationRecipient } from "@lobbystack/shared";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  replyTo?: string;
};

type TemplateName = "existing_account" | "account_setup" | "verify_email" | "password_reset" | "invitation" | "operator_alert" | "feedback_submission" | "onboarding_followup";

export class SmtpEmailProvider {
  private readonly transporter: Transporter;
  private readonly config: SmtpConfig;

  constructor(config: SmtpConfig, transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
  })) {
    this.config = config;
    this.transporter = transporter;
  }

  /** `appName` is the deployment's name, which the email calls the app by (see docs/branding.md). */
  async sendTemplate(input: { template: TemplateName; to: string; subject: string; variables: Record<string, string>; appName: string; idempotencyKey?: string; from?: string; replyTo?: string }): Promise<{ messageId: string }> {
    assertCertificationRecipient("email", input.to);
    const email = renderTemplate(input.template, input.subject, input.variables, input.appName);
    // A per-message sender (the founder check-in) replaces the default reply-to
    // too, so replies reach that sender rather than the shared inbox.
    const replyTo = input.from ? input.replyTo : input.replyTo ?? this.config.replyTo;
    const result = await this.transporter.sendMail({
      from: input.from ?? this.config.from,
      ...(replyTo ? { replyTo } : {}),
      to: input.to,
      subject: input.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
      ...(input.idempotencyKey ? { messageId: `<${createHash("sha256").update(input.idempotencyKey).digest("hex")}@mail.lobbystack.internal>` } : {}),
    });
    return { messageId: result.messageId };
  }
}

function renderTemplate(template: TemplateName, subject: string, variables: Record<string, string>, appName: string): { text: string; html?: string } {
  const text = templateBody(template, variables, appName);

  if (template !== "verify_email" || !variables.code) {
    return { text };
  }

  const code = escapeHtml(variables.code);
  return {
    text,
    html: renderEmailLayout({
      appName,
      previewText: subject,
      content: [
        '<h1 style="margin:0 0 24px;font-size:28px;font-weight:600;line-height:1.25;color:#0B0B0D;text-align:center;">Verify your email address</h1>',
        `<p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#3D3D3D;text-align:center;">Enter this verification code to finish setting up your ${escapeHtml(appName)} account.</p>`,
        `<p style="margin:0 0 24px;padding:16px 24px;background-color:#F3F4F6;border-radius:16px;font-size:32px;font-weight:600;line-height:1.25;letter-spacing:8px;color:#0B0B0D;text-align:center;">${code}</p>`,
        '<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#6B7280;text-align:center;">This code expires in 10 minutes.</p>',
        '<p style="margin:0;font-size:14px;line-height:1.5;color:#6B7280;text-align:center;">If you did not request this code, you can safely ignore this email.</p>',
      ].join(""),
    }),
  };
}

function templateBody(template: TemplateName, variables: Record<string, string>, appName: string): string {
  switch (template) {
    case "existing_account":
      return existingAccountBody(variables, appName);
    case "account_setup":
      return accountSetupBody(variables, appName);
    case "verify_email":
      return variables.code
        ? `Your ${appName} email verification code is: ${variables.code}. It expires in 10 minutes.`
        : `Verify your ${appName} email address using this link: ${variables.url ?? ""}`;
    case "password_reset":
      return variables.code
        ? `Your ${appName} password reset code is: ${variables.code}. It expires in 10 minutes.`
        : `Reset your ${appName} password using this link: ${variables.url ?? ""}`;
    case "invitation":
      return `You have been invited to join ${appName}. Accept the invitation here: ${variables.url ?? ""}`;
    case "operator_alert":
      return variables.message ?? `${appName} operator notification`;
    case "feedback_submission":
      return variables.body ?? `${appName} dashboard feedback`;
    case "onboarding_followup":
      return onboardingFollowupBody(variables, appName);
  }
}

/** For an account a platform key made: the forgot-password page's code sets its first password and verifies the email. */
function accountSetupBody(variables: Record<string, string>, appName: string): string {
  const url = variables.url;
  const email = variables.email;
  switch (variables.locale) {
    case "fr":
      return `Un compte ${appName} a été créé pour vous avec l’adresse ${email}. Pour choisir votre mot de passe, ouvrez ${url}, saisissez cette adresse et entrez le code que nous vous enverrons. Si vous ne l’attendiez pas, ignorez cet e-mail.`;
    case "es":
      return `Se creó una cuenta de ${appName} para usted con la dirección ${email}. Para elegir su contraseña, abra ${url}, escriba esta dirección e introduzca el código que le enviaremos. Si no lo esperaba, ignore este correo.`;
    case "sr":
      return `Za Vas je napravljen ${appName} nalog sa adresom ${email}. Da biste izabrali lozinku, otvorite ${url}, upišite ovu adresu i unesite kod koji ćemo Vam poslati. Ako ovo niste očekivali, zanemarite ovaj imejl.`;
    default:
      return `An account on ${appName} was made for you with ${email}. To choose your password, open ${url}, enter this address, and type in the code we send you. If you weren't expecting this, ignore this email.`;
  }
}

function existingAccountBody(variables: Record<string, string>, appName: string): string {
  const signIn = variables.signInUrl;
  const reset = variables.resetUrl;
  switch (variables.locale) {
    case "fr":
      return `Vous avez déjà un compte ${appName}. Connectez-vous pour continuer : ${signIn}. Mot de passe oublié ? ${reset}. Si vous n’avez pas demandé la création d’un compte, ignorez cet e-mail.`;
    case "es":
      return `Ya tiene una cuenta de ${appName}. Inicie sesión para continuar: ${signIn}. ¿Olvidó su contraseña? ${reset}. Si no solicitó una cuenta, ignore este correo.`;
    case "sr":
      return `Već imate ${appName} nalog. Prijavite se da biste nastavili: ${signIn}. Zaboravili ste lozinku? ${reset}. Ako niste zatražili nalog, zanemarite ovaj imejl.`;
    default:
      return `You already have an account on ${appName}. Sign in to continue: ${signIn}. Forgot your password? ${reset}. If you did not request an account, ignore this email.`;
  }
}

// Serbian never declines the name and French puts no "de" before it, because
// a configured name can't change its form (see docs/branding.md).
function onboardingFollowupBody(variables: Record<string, string>, appName: string): string {
  const sender = variables.senderName ?? "";
  const business = variables.businessName ?? "";
  if (variables.locale === "es") {
    return [
      variables.firstName ? `Hola, ${variables.firstName}:` : "Hola:",
      "",
      `Soy ${sender}, fundador de ${appName}. Ayer configuró una recepcionista para ${business}. Gracias por probarla.`,
      "",
      "Me encantaría saber qué le pareció:",
      "",
      "1. ¿Le gustó? ¿Qué funcionó bien y qué no le convenció?",
      "2. ¿Qué deberíamos mejorar?",
      "3. ¿Piensa usarla de verdad, con su propio número de teléfono? Si no, ¿qué se lo impide?",
      "",
      "Puede responder a este correo. ¡Con dos líneas basta!",
      "",
      "Gracias de nuevo,",
      sender,
      `Fundador, ${appName}`,
    ].join("\n");
  }
  if (variables.locale === "sr") {
    return [
      variables.firstName ? `Zdravo, ${variables.firstName},` : "Zdravo,",
      "",
      `Ja sam ${sender}, osnivač servisa ${appName}. Juče ste podesili recepcionera za ${business}. Hvala što ste ga isprobali.`,
      "",
      "Voleo bih da čujem Vaše utiske:",
      "",
      "1. Da li Vam se dopao? Šta je dobro radilo, a šta Vam nije delovalo kako treba?",
      "2. Šta bi trebalo da poboljšamo?",
      "3. Da li planirate da ga zaista koristite, sa svojim brojem telefona? Ako ne, šta Vas sprečava?",
      "",
      "Možete da odgovorite na ovaj imejl, i dva reda su sasvim dovoljna!",
      "",
      "Hvala još jednom,",
      sender,
      `Osnivač, ${appName}`,
    ].join("\n");
  }
  if (variables.locale === "fr") {
    return [
      variables.firstName ? `Bonjour ${variables.firstName},` : "Bonjour,",
      "",
      `Je suis ${sender}, fondateur du service ${appName}. Vous avez configuré une réceptionniste pour ${business} hier. Merci de l'avoir essayée.`,
      "",
      "J'aimerais savoir ce que vous en avez pensé :",
      "",
      "1. Avez-vous aimé l'expérience ? Qu'est-ce qui a bien fonctionné, et qu'est-ce qui clochait ?",
      "2. Que devrions-nous améliorer ?",
      "3. Comptez-vous l'utiliser pour vrai, avec votre propre numéro de téléphone ? Sinon, qu'est-ce qui vous en empêche ?",
      "",
      "Vous pouvez répondre à ce courriel, et deux lignes suffiraient !",
      "",
      "Merci encore,",
      sender,
      `Fondateur, ${appName}`,
    ].join("\n");
  }
  return [
    variables.firstName ? `Hi ${variables.firstName},` : "Hi,",
    "",
    `I'm ${sender}, the founder of ${appName}. You set up a receptionist for ${business} yesterday. Thanks for giving it a try.`,
    "",
    "I'd love to hear what you thought:",
    "",
    "1. Did you like it? What worked, and what felt off?",
    "2. What should we improve?",
    "3. Do you plan to use it for real, with your own phone number? If not, what's stopping you?",
    "",
    "You can reply to this email, and two lines would be plenty!",
    "",
    "Thanks again,",
    sender,
    `Founder, ${appName}`,
  ].join("\n");
}

function renderEmailLayout({ appName, previewText, content }: { appName: string; previewText: string; content: string }): string {
  const escapedPreviewText = escapeHtml(previewText);
  // The deployment's name as a wordmark: mail clients such as Gmail and
  // Outlook don't show inline or remote SVG logos, so no logo stands in for it.
  const wordmark = `<p style="margin:0;font-size:22px;font-weight:700;line-height:1.2;color:#0B0B0D;text-align:center;">${escapeHtml(appName)}</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapedPreviewText}</title>
    <style>
      :root { color-scheme: light; }
      @media only screen and (max-width: 620px) {
        .email-container { width: 100% !important; padding: 24px 16px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%">
      <tr>
        <td align="center" style="padding:48px 16px;">
          <table role="presentation" class="email-container" border="0" cellspacing="0" cellpadding="0" width="600" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:24px;padding:48px;">
            <tr>
              <td align="center" style="padding-bottom:32px;">
                ${wordmark}
              </td>
            </tr>
            <tr>
              <td>
                ${content}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
