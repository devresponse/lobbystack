import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ invite: vi.fn(async () => ({ invitationId: "invitation_1" })), updateRole: vi.fn(), remove: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@/lib/fixed-window-limit", () => ({ enforceFixedWindow: async () => ({ allowed: true }), fixedWindowLimit: () => ({}) }));
vi.mock("@/lib/auth", () => ({
  getAuthDatabase: () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ locale: "en" }] }) }) }) } }),
}));
vi.mock("@lobbystack/domain", () => ({ inviteMember: fixture.invite, removeMember: fixture.remove, revokeInvitation: fixture.revoke, updateMemberRole: fixture.updateRole }));

import { DELETE, PATCH, POST } from "./route";

const send = (method: "POST" | "PATCH" | "DELETE", body: unknown) =>
  ({ POST, PATCH, DELETE })[method](new Request("http://localhost:3000/api/team?businessId=business_1", { method, body: JSON.stringify(body) }));

beforeEach(() => { vi.clearAllMocks(); });

describe("team API", () => {
  it("invites a member with a permitted role", async () => {
    const response = await send("POST", { email: "sam@example.com", role: "scheduler" });

    expect(response.status).toBe(201);
    expect(fixture.invite).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", email: "sam@example.com", role: "scheduler", locale: "en" });
  });

  // AUDIT-007: an invitation with a wrong field answered 500 "Request failed." before.
  it("answers a wrong field with 400 and says which one it is", async () => {
    for (const [body, field, message] of [
      [{ email: "sam@example.com", role: "owner" }, "role", "role is business_admin, scheduler or viewer."],
      [{ email: "sam", role: "viewer" }, "email", "Give the person's email address."],
      [{ role: "viewer" }, "email", "Give the person's email address."],
    ] as const) {
      const response = await send("POST", body);
      expect(response.status, field).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: `${field}: ${message}`, code: "invalid_request", details: [{ path: field, message }] });
    }
    expect(fixture.invite).not.toHaveBeenCalled();
  });

  it("changes a member's role, and refuses one that isn't a role", async () => {
    await expect(send("PATCH", { membershipId: "membership_1", role: "viewer" })).resolves.toHaveProperty("status", 200);
    expect(fixture.updateRole).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", membershipId: "membership_1", role: "viewer" });

    const response = await send("PATCH", { membershipId: "membership_1", role: "business_owner" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "role: role is business_admin, scheduler or viewer." });
  });

  it("needs a membership or an invitation to remove", async () => {
    const response = await send("DELETE", {});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "membershipId: Name the membershipId to remove, or the invitationId to revoke." });
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.revoke).not.toHaveBeenCalled();
  });

  it("revokes an invitation", async () => {
    await expect(send("DELETE", { invitationId: "invitation_1" })).resolves.toHaveProperty("status", 200);
    expect(fixture.revoke).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", invitationId: "invitation_1" });
  });
});
