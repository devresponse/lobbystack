import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ limit: vi.fn(), search: vi.fn(), secret: vi.fn(() => "x".repeat(32)) }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@/lib/phone-number-search-limit", () => ({ assertPhoneNumberSearchAllowed: fixture.limit }));
vi.mock("@lobbystack/domain", () => ({ searchBusinessNumberInventory: fixture.search }));
vi.mock("@/lib/twilio-provider", async (original) => ({ ...await original<typeof import("@/lib/twilio-provider")>(), getNumberClaimTokenSecret: fixture.secret }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("says phone numbers aren't set up, before a search counts against the limit or needs the claim secret", async () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  const response = await GET(new Request("http://localhost:3000/api/onboarding/phone-numbers/suggestion?businessId=business_1"));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "phone_numbers_unavailable" });
  expect(fixture.limit).not.toHaveBeenCalled();
  expect(fixture.secret).not.toHaveBeenCalled();
  expect(fixture.search).not.toHaveBeenCalled();
});

it("counts the search and passes Twilio on when the deployment has it", async () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "auth-token");
  fixture.search.mockResolvedValue({ numbers: [] });
  const response = await GET(new Request("http://localhost:3000/api/onboarding/phone-numbers/suggestion?businessId=business_1"));
  expect(response.status).toBe(200);
  expect(fixture.limit).toHaveBeenCalledWith({ userId: "user_1", initial: true });
  expect(fixture.search).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", limit: 10, claimTokenSecret: "x".repeat(32) }, expect.anything());
});
