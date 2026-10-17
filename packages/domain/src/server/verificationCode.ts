import { randomInt } from "node:crypto";

import type { InterfaceLocale } from "@lobbystack/shared";

/** How long a code the application texts stays valid. */
export const VERIFICATION_CODE_TTL_MS = 10 * 60_000;

/**
 * The key for hashing one-time codes the application generates itself. Admin
 * and worker both receive OTP_HASH_SECRET, so a code hashed in one runtime can
 * be checked in the other.
 */
export function verificationCodeSecret(): string {
  return process.env.OTP_HASH_SECRET ?? process.env.ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET ?? "development-only-change-me";
}

/** A uniformly random six-digit code, zero-padded. */
export function newVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// The sender's name never takes an article, an elision or a declension,
// because it is configured (see docs/branding.md).
const verificationCodeMessages: Record<InterfaceLocale, (code: string, minutes: number, senderName: string) => string> = {
  en: (code, minutes, senderName) => `${senderName} verification code: ${code}. It expires in ${minutes} minutes.`,
  fr: (code, minutes, senderName) => `Code de vérification ${senderName} : ${code}. Il expire dans ${minutes} minutes.`,
  es: (code, minutes, senderName) => `Código de verificación de ${senderName}: ${code}. Caduca en ${minutes} minutos.`,
  sr: (code, minutes, senderName) => `${senderName} kod za potvrdu: ${code}. Ističe za ${minutes} minuta.`,
};

/**
 * The text that carries a verification code, in the recipient's language. It
 * opens with who sends it: the deployment's name for its own users, the
 * business's name for its callers.
 */
export function verificationCodeSmsBody(code: string, senderName: string, locale: InterfaceLocale = "en"): string {
  return verificationCodeMessages[locale](code, Math.round(VERIFICATION_CODE_TTL_MS / 60_000), senderName);
}
