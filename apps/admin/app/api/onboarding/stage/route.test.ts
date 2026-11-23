import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Which step follows which, and for which business, is the domain's
// (onboarding.test.ts and onboardingStages.integration.test.ts); this checks
// what the route hands over and that it answers with the step to open.
const mocks = vi.hoisted(() => ({ requireOperatorBusiness: vi.fn(), advance: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({ ...await original<typeof import("@/lib/api-helpers")>(), requireOperatorBusiness: mocks.requireOperatorBusiness }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app-db" }) }));
vi.mock("@lobbystack/domain", async (original) => ({ ...await original<typeof import("@lobbystack/domain")>(), advanceOnboardingStage: mocks.advance }));

import { POST } from "./route";

const url = "https://app.example.test/api/onboarding/stage?businessId=business-1";
const post = (body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  mocks.requireOperatorBusiness.mockResolvedValue({ session: { user: { id: "user-1" } }, businessId: "business-1" });
});
afterEach(() => { vi.resetAllMocks(); });

describe("moving on to the next onboarding step", () => {
  it("asks for the step and answers with the one the server says to open", async () => {
    mocks.advance.mockResolvedValue("website");
    const response = await POST(post({ to: "website" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stage: "website" });
    expect(mocks.advance).toHaveBeenCalledWith({ db: "app-db" }, { userId: "user-1", businessId: "business-1", to: "website" });
  });

  it.each([
    // After the name, the plan step where the deployment has one, whichever step was asked for.
    ["website", "plan"],
    // No plan step: the website step in its place.
    ["plan", "website"],
    // A plan without a number to pick, such as Free: the last step in place of the number step.
    ["phone_number", "attribution"],
  ])("answers a request for %s with %s when the server puts that step in its place", async (to, stage) => {
    mocks.advance.mockResolvedValue(stage);
    const response = await POST(post({ to }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stage });
    expect(mocks.advance).toHaveBeenCalledWith({ db: "app-db" }, { userId: "user-1", businessId: "business-1", to });
  });

  it.each([[undefined], [null], [""], ["not-a-stage"], ["verify_phone"], ["constructor"], [7], ["create_business"], ["complete"]])("refuses %j as the next step before reaching the domain", async (to) => {
    const response = await POST(post({ to }));
    expect(response.status).toBe(400);
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it.each([[["plan"]], ["plan"], [null]])("refuses a body of %j", async (body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("passes on the domain's refusal of a step that is no longer current", async () => {
    mocks.advance.mockRejectedValue(Object.assign(new Error("The onboarding step is no longer current."), { status: 409, code: "onboarding_stage_conflict" }));
    const response = await POST(post({ to: "knowledge" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "The onboarding step is no longer current.", code: "onboarding_stage_conflict" });
  });

  it("requires a session", async () => {
    mocks.requireOperatorBusiness.mockRejectedValue(Object.assign(new Error("Authentication required."), { status: 401, code: "unauthorized" }));
    const response = await POST(post({ to: "website" }));
    expect(response.status).toBe(401);
    expect(mocks.advance).not.toHaveBeenCalled();
  });
});
