import { getAuth } from "@/lib/auth";

/**
 * Whether the password is the signed-in person's own, for a step that asks
 * for it again, such as deleting or canceling a business. One longer than
 * sign-up allows can't be.
 */
export async function passwordMatches(request: Request, password: string): Promise<boolean> {
  try {
    await getAuth().api.verifyPassword({ body: { password }, headers: request.headers });
    return true;
  } catch (error) {
    const code = (error as { body?: { code?: unknown } } | null)?.body?.code;
    if (code === "INVALID_PASSWORD" || code === "PASSWORD_TOO_LONG") return false;
    throw error;
  }
}
