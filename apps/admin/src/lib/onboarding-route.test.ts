import { beforeEach, describe, expect, it, vi } from "vitest";

// The order of the steps is the domain's (onboarding.test.ts); this checks
// which onboarding page opens for a business on each stage, and where the
// others send it.
const fixture = vi.hoisted(() => ({
  session: { user: { id: "user-1" } } as { user: { id: string } } | null,
  state: { businessId: "business-1" as string | null, stage: "plan" },
  planStep: true,
}));
class Redirect extends Error { constructor(readonly to: string) { super(`redirect ${to}`); } }
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirect(to); } }));
vi.mock("./auth", () => ({ getSession: async () => fixture.session }));
vi.mock("./api-helpers", () => ({ getAppDatabase: () => ({ db: "app-db" }) }));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  getActiveOnboardingState: async () => fixture.state,
  onboardingHasPlanStep: () => fixture.planStep,
}));

import { requireOnboardingStage } from "./onboarding-route";

/** Where the page sends the visitor, or "opens" when it lets them in. */
async function visit(pathname: string, options?: { allowCreate?: boolean }): Promise<string> {
  try {
    await requireOnboardingStage(pathname, options);
    return "opens";
  } catch (error) {
    if (error instanceof Redirect) return error.to;
    throw error;
  }
}

beforeEach(() => {
  fixture.session = { user: { id: "user-1" } };
  fixture.state = { businessId: "business-1", stage: "plan" };
  fixture.planStep = true;
});

describe("onboarding pages, with the plan step right after the name", () => {
  it("sends a visitor who isn't signed in to sign in", async () => {
    fixture.session = null;
    expect(await visit("/onboarding/plan")).toBe("/login");
  });

  it("opens the plan step, and the name step before it, for a business on the plan step", async () => {
    expect(await visit("/onboarding/plan")).toBe("opens");
    expect(await visit("/onboarding/business")).toBe("opens");
    expect(await requireOnboardingStage("/onboarding/plan")).toEqual({ userId: "user-1", businessId: "business-1", stage: "plan" });
  });

  it.each(["/onboarding/website", "/onboarding/knowledge", "/onboarding/greeting", "/onboarding/number", "/onboarding/attribution"])("sends a business on the plan step back to it from %s, which it hasn't reached", async (pathname) => {
    expect(await visit(pathname)).toBe("/onboarding/plan");
  });

  it("sends a business that only has its name step to it from the plan step", async () => {
    fixture.state = { businessId: "business-1", stage: "create_business" };
    expect(await visit("/onboarding/plan")).toBe("/onboarding/business");
  });

  it.each(["website", "knowledge", "greeting", "phone_number", "phone_number_claiming", "attribution", "complete"])("opens the plan step again for a business on the %s stage", async (stage) => {
    fixture.state = { businessId: "business-1", stage };
    expect(await visit("/onboarding/plan")).toBe("opens");
  });

  it("keeps the number step for after the greeting", async () => {
    fixture.state = { businessId: "business-1", stage: "greeting" };
    expect(await visit("/onboarding/number")).toBe("/onboarding/greeting");
    expect(await visit("/onboarding/attribution")).toBe("/onboarding/greeting");
    fixture.state = { businessId: "business-1", stage: "phone_number" };
    expect(await visit("/onboarding/number")).toBe("opens");
  });

  it("lets a person without a business, or one adding another, open the name step", async () => {
    fixture.state = { businessId: null, stage: "create_business" };
    expect(await visit("/onboarding/business", { allowCreate: true })).toBe("opens");
    expect(await visit("/onboarding/business")).toBe("opens");
    expect(await visit("/onboarding/plan")).toBe("/onboarding/business");
  });

  it("sends a path that is no onboarding step to the business's own step", async () => {
    fixture.state = { businessId: "business-1", stage: "greeting" };
    expect(await visit("/onboarding/unknown")).toBe("/onboarding/greeting");
  });
});

describe("onboarding pages on a deployment that takes no payments", () => {
  beforeEach(() => { fixture.planStep = false; });

  it.each([
    ["website", "/onboarding/website"],
    ["knowledge", "/onboarding/knowledge"],
    ["greeting", "/onboarding/greeting"],
    ["phone_number", "/onboarding/number"],
    ["attribution", "/onboarding/attribution"],
    ["complete", "/"],
  ])("sends a business on the %s stage from the plan page, which this deployment hasn't, to %s", async (stage, route) => {
    fixture.state = { businessId: "business-1", stage };
    expect(await visit("/onboarding/plan")).toBe(route);
  });

  it("sends a business that only has its name step to it from the plan page", async () => {
    fixture.state = { businessId: "business-1", stage: "create_business" };
    expect(await visit("/onboarding/plan")).toBe("/onboarding/business");
  });

  it("opens the other steps as the business reached them", async () => {
    fixture.state = { businessId: "business-1", stage: "website" };
    expect(await visit("/onboarding/website")).toBe("opens");
    expect(await visit("/onboarding/business")).toBe("opens");
    expect(await visit("/onboarding/knowledge")).toBe("/onboarding/website");
  });
});
