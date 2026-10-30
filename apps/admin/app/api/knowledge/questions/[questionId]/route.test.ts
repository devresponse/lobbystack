import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ answer: vi.fn(), dismiss: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ answerUnansweredQuestion: fixture.answer, dismissUnansweredQuestion: fixture.dismiss }));

import { PATCH } from "./route";

const patch = (body: unknown) => PATCH(
  new Request("http://localhost:3000/api/knowledge/questions/question_1?businessId=business_1", { method: "PATCH", body: JSON.stringify(body) }),
  { params: Promise.resolve({ questionId: "question_1" }) },
);

beforeEach(() => { vi.clearAllMocks(); });

describe("unanswered question API", () => {
  it("answers as the signed-in operator, even when the body names another user, business or question", async () => {
    fixture.answer.mockResolvedValue({ snippetId: "snippet_1" });
    const response = await patch({ action: "answer", answer: "Two hours free.", userId: "owner", businessId: "business_2", questionId: "question_2" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snippetId: "snippet_1" });
    expect(fixture.answer).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", questionId: "question_1", answer: "Two hours free." });
  });

  it("dismisses", async () => {
    const response = await patch({ action: "dismiss" });
    expect(response.status).toBe(200);
    expect(fixture.dismiss).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", questionId: "question_1" });
  });

  it("refuses an empty answer or another action, and passes on a refusal from the domain", async () => {
    expect((await patch({ action: "answer", answer: "  " })).status).toBe(400);
    expect((await patch({ action: "delete" })).status).toBe(400);
    expect(fixture.answer).not.toHaveBeenCalled();
    fixture.dismiss.mockRejectedValueOnce(Object.assign(new Error("This question was already answered or dismissed."), { status: 409, code: "question_resolved" }));
    const resolved = await patch({ action: "dismiss" });
    expect(resolved.status).toBe(409);
    expect(await resolved.json()).toMatchObject({ code: "question_resolved" });
  });
});
