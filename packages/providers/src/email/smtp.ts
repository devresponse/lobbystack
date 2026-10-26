import { createHash } from "node:crypto";

import nodemailer, { type Transporter } from "nodemailer";
import { assertCertificationRecipient, type BrandImage } from "@lobbystack/shared";

import { renderEmail, type CallTranscriptEmail, type TemplateName } from "./templates";

export { callTranscriptSubject, invitationSubject, promoEndingSubject, type CallTranscriptEmail, type TemplateName } from "./templates";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  replyTo?: string;
  /** The brand's email logo, at an absolute URL, shown above the deployment's name. */
  logo?: BrandImage;
};

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
  async sendTemplate(input: { template: TemplateName; to: string; subject: string; variables: Record<string, string>; appName: string; idempotencyKey?: string; from?: string; replyTo?: string; callTranscript?: CallTranscriptEmail }): Promise<{ messageId: string }> {
    assertCertificationRecipient("email", input.to);
    const email = renderEmail({ template: input.template, subject: input.subject, to: input.to, variables: input.variables, appName: input.appName, logo: this.config.logo, callTranscript: input.callTranscript });
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
      ...(email.attachments ? { attachments: email.attachments } : {}),
      ...(input.idempotencyKey ? { messageId: `<${createHash("sha256").update(input.idempotencyKey).digest("hex")}@mail.lobbystack.internal>` } : {}),
    });
    return { messageId: result.messageId };
  }
}

/**
 * The mail server's reply code when it refused this recipient or this message
 * for good: a 5xx answer to the envelope or to the message, which every retry
 * would get again. A refused sign-in or a dropped connection isn't one, since
 * those clear up, so that send is tried again.
 */
export function permanentSmtpRefusal(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  return (code === "EENVELOPE" || code === "EMESSAGE") && typeof responseCode === "number" && responseCode >= 500 && responseCode < 600 ? responseCode : undefined;
}
