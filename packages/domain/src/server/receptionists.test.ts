import { describe, expect, it } from "vitest";

import { receptionistCapReached, receptionistPlanLimitReached } from "./receptionists";

// The Receptionists page shows these sentences as they are, so each plan sees
// what raises its number: Free and Starter can upgrade, a full Pro talks to
// sales about Enterprise, Enterprise and self-hosted deployments can't go
// higher. The integration tests reach the one-receptionist and Pro wordings
// through the database; this covers every branch.
describe("the refusal when a plan's active receptionists are all in use", () => {
  it.each([
    [1, "plan", "Your plan includes one receptionist. Upgrade to add more."],
    [1, "sales", "Your plan includes one receptionist. Contact sales about Enterprise to add more."],
    [1, null, "Your plan includes one receptionist."],
    // A promo plan between Starter and Pro, say.
    [3, "plan", "Your plan includes 3 active receptionists. Pause one or upgrade to add another."],
    [5, "sales", "Your plan includes 5 active receptionists. Pause one or contact sales about Enterprise to add another."],
    [50, null, "Your plan includes 50 active receptionists. Pause one to add another."],
  ] as const)("limit %i, upgrade %s", (limit, upgrade, message) => {
    expect(receptionistPlanLimitReached({ limit, upgrade })).toMatchObject({ message, status: 409, code: "receptionist_limit" });
  });
});

describe("the refusal when a business keeps the deployment's cap", () => {
  it("names the cap and asks to archive one", () => {
    expect(receptionistCapReached(50)).toMatchObject({ message: "A business can keep up to 50 receptionists. Archive one to add another.", status: 409, code: "receptionist_cap" });
  });
});
