import { expect, it } from "vitest";

import { createUserForApi, platformUserId } from "./users";

it("gives each platform key and Idempotency-Key its own account id", () => {
  const id = platformUserId("key-1", "owner-acme");
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(platformUserId("key-1", "owner-acme")).toBe(id);
  expect(platformUserId("key-2", "owner-acme")).not.toBe(id);
  expect(platformUserId("key-1", "owner-other")).not.toBe(id);
});

it("refuses a list of addresses before touching the database", async () => {
  const key = { kind: "platform_key", platformKeyId: "key-1" } as never;
  await expect(createUserForApi({} as never, { key, idempotencyKey: "x", body: { email: "a@example.com, b@example.com" } })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
});
