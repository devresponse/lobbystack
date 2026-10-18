import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { enqueueOutbox, users, withBusinessTransaction, type Database } from "@lobbystack/db";
import { normalizeAuthEmail, type ApiUser, type ApiUserCreate, type InterfaceLocale } from "@lobbystack/shared";

import { deploymentAppName } from "../branding";
import { isSingleEmailAddress } from "../tenancy";
import { conflict, invalidRequest, PublicApiError } from "./errors";
import type { ResolvedPlatformKey } from "./platformKeys";

// Accounts made by platform keys (D4). Only the auth role may write users, so
// callers pass that database. The account has no password and an unverified
// email: the person sets a password through the forgot-password page, whose
// emailed code also proves the address is theirs.

/**
 * The id POST /users gives the account made for one platform key and
 * Idempotency-Key, so a retry finds that account instead of making another.
 * A UUIDv8 from SHA-256: other keys can't produce it.
 */
export function platformUserId(platformKeyId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256").update(`lobbystack:platform-user:v1:${platformKeyId}:${idempotencyKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type UserRow = { id: string; email: string; name: string | null; preferredLocale: string; emailVerified: boolean; createdAt: Date };

const toApiUser = (row: UserRow): ApiUser => ({ id: row.id, email: row.email, name: row.name, locale: row.preferredLocale, email_verified: row.emailVerified, created_at: row.createdAt.toISOString() });

const userColumns = { id: users.id, email: users.email, name: users.name, preferredLocale: users.preferredLocale, emailVerified: users.emailVerified, createdAt: users.createdAt };

function isUniqueViolation(error: unknown): boolean {
  const cause = typeof error === "object" && error !== null && "cause" in error ? (error as { cause: unknown }).cause : undefined;
  return [error, cause].some((value) => typeof value === "object" && value !== null && "code" in value && (value as { code: unknown }).code === "23505");
}

/**
 * Creates an account for a platform key, recording the key and its partner on
 * it. The Idempotency-Key decides the account's id, so a retry returns the
 * account it made, and a different email with the same key is
 * idempotency_key_reused. An email that already has an account is a 409.
 * beforeCreate runs only when an account is about to be made, so a retry
 * isn't counted against the key's limit.
 */
export async function createUserForApi(authDb: Database, input: { key: ResolvedPlatformKey; idempotencyKey: string; body: ApiUserCreate; beforeCreate?: (() => Promise<void>) | undefined }): Promise<{ user: ApiUser; replayed: boolean }> {
  // Stored lowercased, as Better Auth stores and looks up addresses, so the forgot-password page finds the account.
  const normalizedEmail = normalizeAuthEmail(input.body.email);
  if (!isSingleEmailAddress(normalizedEmail)) throw invalidRequest("email must be one email address.", [{ path: "email", message: "Use one address, such as owner@example.com." }]);
  const id = platformUserId(input.key.platformKeyId, input.idempotencyKey);
  const made = async (): Promise<ApiUser | null> => {
    const [row] = await authDb.select(userColumns).from(users).where(eq(users.id, id)).limit(1);
    if (!row) return null;
    if (normalizeAuthEmail(row.email) !== normalizedEmail) throw new PublicApiError(422, "idempotency_key_reused", "This Idempotency-Key was used with a different request body.");
    return toApiUser(row);
  };
  const existing = await made();
  if (existing) return { user: existing, replayed: true };
  await input.beforeCreate?.();
  try {
    // The database sets normalized_email from email.
    const [row] = await authDb.insert(users).values({ id, email: normalizedEmail, normalizedEmail: "", name: input.body.name ?? null, preferredLocale: input.body.locale ?? "en", emailVerified: false, createdByPlatformKeyId: input.key.platformKeyId, createdByPartnerId: input.key.partnerId }).returning(userColumns);
    if (!row) throw new Error("The new account could not be read back.");
    return { user: toApiUser(row), replayed: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A retry that ran at the same time made it first.
    const raced = await made();
    if (raced) return { user: raced, replayed: true };
    throw conflict("An account already uses this email. Send its owner a claim link instead.");
  }
}

const SETUP_SUBJECTS: Record<InterfaceLocale, (appName: string) => string> = {
  en: (appName) => `Set up your ${appName} account`,
  fr: (appName) => `Configurez votre compte ${appName}`,
  es: (appName) => `Configure su cuenta de ${appName}`,
  sr: (appName) => `Podesite svoj ${appName} nalog`,
};

/**
 * Emails the person a link to set a password. Its dedupe key is the account,
 * so a retry of POST /users that already queued it doesn't send it twice.
 */
export async function enqueueAccountSetupEmail(appDb: Database, input: { user: ApiUser; appBaseUrl: string }): Promise<void> {
  const locale = (input.user.locale in SETUP_SUBJECTS ? input.user.locale : "en") as InterfaceLocale;
  const appName = await deploymentAppName(appDb);
  await withBusinessTransaction(appDb, { actorType: "system" }, async (tx) => {
    await enqueueOutbox(tx, {
      topic: "email.send",
      aggregateType: "auth_email",
      aggregateId: input.user.id,
      dedupeKey: `auth-email:account-setup:${input.user.id}`,
      payload: { template: "account_setup", to: input.user.email, subject: SETUP_SUBJECTS[locale](appName), variables: { locale, email: input.user.email, url: new URL(`/${locale}/forgot-password`, input.appBaseUrl).href } },
    });
  });
}
