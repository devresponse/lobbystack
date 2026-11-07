import { NextResponse } from "next/server";

import { answerUnansweredQuestion, dismissUnansweredQuestion, readUnansweredAnswerAudience } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/**
 * Answers an open question, saving the answer as a text entry, or dismisses
 * it. An answer is for everyone unless `audience` says "asked" (only the
 * receptionists that heard it) or "chosen" with `receptionistIds`.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ questionId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request) as { action?: string; answer?: unknown; audience?: unknown; receptionistIds?: unknown };
    const { questionId } = await params;
    if (body.action === "answer") {
      if (typeof body.answer !== "string" || !body.answer.trim()) return jsonError("answer is required.", 400);
      const audience = readUnansweredAnswerAudience(body);
      return NextResponse.json(await answerUnansweredQuestion(createDomainContext(), { userId: session.user.id, businessId, questionId, answer: body.answer, audience }));
    }
    if (body.action === "dismiss") {
      await dismissUnansweredQuestion(createDomainContext(), { userId: session.user.id, businessId, questionId });
      return NextResponse.json({ ok: true });
    }
    return jsonError('action must be "answer" or "dismiss".', 400);
  } catch (error) { return asApiResponse(error); }
}
