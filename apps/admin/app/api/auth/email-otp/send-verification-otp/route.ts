import { z } from "zod";

import { EmailVerificationRateLimitError } from "@/lib/email-verification-policy";
import { issueEmailVerificationCode } from "@/lib/auth";
import { logAuthEvent, logRateLimited } from "@/lib/auth-events";
import { reportServerError } from "@/lib/error-reporting";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import { verifyTurnstile } from "@/lib/turnstile";
import { attachVerificationFlow, hasVerificationFlow } from "@/lib/verification-flow";

export const runtime = "nodejs";

const requestSchema = z.object({
  email: z.email(),
  type: z.literal("email-verification"),
  turnstileToken: z.string().trim().min(1).optional(),
});

const path = "/email-otp/send-verification-otp";

const successResponse = () => Response.json({ success: true });

function refused(request: Request, code: "INVALID_REQUEST" | "CHALLENGE_FAILED", message: string): Response {
  logAuthEvent("warn", "auth.verification_code_request_failed", { path, status: 400, code }, request.headers);
  return Response.json({ code, message }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refused(request, "INVALID_REQUEST", "Invalid request.");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return refused(request, "INVALID_REQUEST", "Invalid request.");

  const email = parsed.data.email.trim().toLowerCase();
  // Shared trusted-IP derivation: only an explicitly configured, ingress-
  // controlled header is trusted, and an unset opt-in yields no remote IP.
  const remoteIp = trustedClientIp(request);
  const hasProof = hasVerificationFlow(request, email);
  try {
    if (!hasProof) await verifyTurnstile({ token: parsed.data.turnstileToken, ...(remoteIp ? { remoteIp } : {}) });
  } catch {
    return refused(request, "CHALLENGE_FAILED", "Verification challenge failed.");
  }

  try {
    await issueEmailVerificationCode(email, remoteIp);
    const response = successResponse();
    if (!hasProof) attachVerificationFlow(response, email);
    return response;
  } catch (error) {
    if (error instanceof EmailVerificationRateLimitError) {
      logRateLimited({ path, limit: "recipient", ...(remoteIp ? { ip: remoteIp } : {}) });
      return Response.json(
        { code: "RATE_LIMITED", message: "Please wait before requesting another verification code." },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    const errorId = crypto.randomUUID();
    void reportServerError(error, { operation: "auth.verification_code", errorId, route: `/api/auth${path}` });
    return Response.json({ code: "SERVICE_UNAVAILABLE", message: "Verification service unavailable.", errorId }, { status: 503, headers: { "x-error-id": errorId } });
  }
}
