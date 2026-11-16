import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lobbystack/providers", async () => await import("../../../../../../packages/providers/src/index"));
vi.mock("@lobbystack/providers/storage/local", async () => await import("../../../../../../packages/providers/src/storage/local"));

const reported = vi.hoisted(() => vi.fn());
vi.mock("@/lib/error-reporting", () => ({ reportServerError: reported }));
vi.mock("@/lib/after-response", () => ({ runAfterResponse: (task: () => unknown) => { void task(); } }));

import { createStorageProvider } from "@lobbystack/providers";
import { GET, PUT } from "./route";

// The route keeps one provider for the process, so this file holds one storage
// directory and one test: a second would run against the first one's root.
let storagePath = "";
const previousEnvironment = {
  STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
  LOCAL_STORAGE_PATH: process.env.LOCAL_STORAGE_PATH,
  LOCAL_STORAGE_SIGNING_SECRET: process.env.LOCAL_STORAGE_SIGNING_SECRET,
  APP_BASE_URL: process.env.APP_BASE_URL,
};

beforeEach(async () => {
  storagePath = await mkdtemp(join(tmpdir(), "lobbystack-storage-fault-"));
  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_PATH = storagePath;
  process.env.LOCAL_STORAGE_SIGNING_SECRET = "fault-test-signing-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
});

afterEach(async () => {
  await rm(storagePath, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// AUDIT-009: both catch blocks used to answer with the exception's own text, so
// a file-system message and the server's paths reached whoever was probing.
it("keeps a server fault out of the answer and puts it in the logs with an error ID", async () => {
  const storage = createStorageProvider();
  const key = "business/attachment/object/broken.txt";
  const body = new TextEncoder().encode("route storage bytes");
  const upload = await storage.createUpload({ key, contentType: "text/plain", length: body.byteLength });
  await expect(PUT(new Request(upload.url, { method: "PUT", headers: { "content-type": "text/plain" }, body })))
    .resolves.toHaveProperty("status", 204);
  await writeFile(join(storagePath, "metadata", ...key.split("/")) + ".json", "{ not json");

  const response = await GET(new Request(await storage.createDownloadUrl({ key, expiresInSeconds: 60 })));
  const answer = await response.json() as { error: string; errorId: string };

  expect(response.status).toBe(500);
  expect(answer.error).toBe("Storage download failed.");
  expect(answer.errorId).toMatch(/^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/);
  expect(response.headers.get("x-error-id")).toBe(answer.errorId);
  expect(JSON.stringify(answer)).not.toContain(storagePath);
  expect(reported).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: "storage_local", errorId: answer.errorId }));
});
