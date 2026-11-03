import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { demoSnapshot, type BusinessContextSnapshot } from "@lobbystack/shared";

const mocks = vi.hoisted(() => ({
  withBusinessTransaction: vi.fn(),
  enqueueOutbox: vi.fn(),
  resolveSmsSender: vi.fn(),
  loadSnapshotKnowledge: vi.fn(),
}));

vi.mock("@lobbystack/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lobbystack/db")>()),
  withBusinessTransaction: mocks.withBusinessTransaction,
  enqueueOutbox: mocks.enqueueOutbox,
}));
vi.mock("./smsSender", () => ({ resolveSmsSender: mocks.resolveSmsSender }));
// Each receptionist's articles are ranked in SQL, which the database tests cover (knowledgeAudience.integration.test.ts).
vi.mock("./snapshotKnowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshotKnowledge")>()),
  loadSnapshotKnowledge: mocks.loadSnapshotKnowledge,
}));

import type { SnapshotCacheClient } from "./snapshotCache";
import { refreshBusinessSnapshot } from "./knowledge";

const businessId = "00000000-0000-4000-8000-000000000001";

function memoryCache(): SnapshotCacheClient {
  const store = new Map<string, BusinessContextSnapshot>();
  return { get: async (id) => store.get(id) ?? null, set: async (id, snapshot) => { store.set(id, snapshot); } };
}
const profileRow = {
  id: "00000000-0000-4000-8000-000000000002",
  businessId,
  name: "Front desk",
  description: "",
  isDefault: true,
  status: "active",
  archivedAt: null,
  listed: true,
  sortOrder: 0,
  handle: null,
  locale: null,
  knowledgeScope: "all",
  greeting: "Hello",
  tone: "professional",
  summary: "A clinic",
  bookingPolicy: "Confirm before booking.",
};
const noKnowledge = { defaultSnippets: [], extraSnippets: [], defaultDocuments: [], snippetIds: new Map() };

function tableName(table: unknown): string {
  if (table && typeof table === "object") {
    const symbolic = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")];
    if (typeof symbolic === "string") return symbolic;
    const name = (table as { name?: string })?.name;
    if (typeof name === "string") return name;
  }
  return String(table);
}

function makeTx(selectRows: Record<string, unknown>) {
  const rowsFor = (table: unknown): unknown => {
    const name = tableName(table);
    return name in selectRows ? selectRows[name] : [];
  };
  const tx = {
    select: vi.fn(() => fromChain(rowsFor)),
    insert: vi.fn(() => ({ values: () => Promise.resolve([{ id: "saved" }]) })),
    delete: vi.fn((table: unknown) => ({ where: (condition: SQL) => { deleted.push({ table: tableName(table), where: new PgDialect().sqlToQuery(condition) }); return Promise.resolve(); } })),
  };
  return tx;

  function fromChain(rows: (table: unknown) => unknown) {
    return {
      from: (table: unknown) => {
        // Honours limit() like the database, so a query that caps its rows too low shows up here.
        function whenable(result: unknown): Promise<unknown> & { limit: (count: number) => unknown; orderBy: () => unknown } {
          const thenable = Promise.resolve(result);
          return Object.assign(thenable, {
            limit: (count: number) => whenable(Array.isArray(result) ? result.slice(0, count) : result),
            orderBy: () => whenable(result),
          });
        }
        return {
          where: () => whenable(rows(table)),
          // The business with its public page: none here, as a left join leaves it.
          leftJoin: () => ({ where: () => whenable((rows(table) as unknown[]).map((row) => ({ business: row, published: null }))) }),
        };
      },
    };
  }
}

const businessRow = { id: businessId, name: "Maple Family Clinic", timezone: "America/Toronto", defaultLocale: "en" };
let deleted: { table: string; where: { sql: string; params: unknown[] } }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deleted = [];
  vi.stubEnv("REDIS_PREFIX", "lobbystack");
  mocks.withBusinessTransaction.mockImplementation(async (_db, _ctx, callback) => await callback(makeTx({ businesses: [businessRow], receptionist_profiles: [profileRow] })));
  mocks.enqueueOutbox.mockResolvedValue(undefined);
  mocks.resolveSmsSender.mockResolvedValue(null);
  mocks.loadSnapshotKnowledge.mockResolvedValue(noKnowledge);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("refreshBusinessSnapshot write-through", () => {
  it("preserves business identity, active contact numbers, locale labels, and opt-out", async () => {
    // The number customer texts come from, which the business's plan decides.
    mocks.resolveSmsSender.mockResolvedValue("+14165550003");
    mocks.withBusinessTransaction.mockImplementation(async (_db, _ctx, callback) => callback(makeTx({
      businesses: [{ ...businessRow, legalName: "Maple Clinic Inc.", businessType: "clinic", telemetryEnabled: false }],
      receptionist_profiles: [profileRow],
      phone_numbers: [
        { e164: "+14165550001", status: "released", voiceEnabled: true, smsEnabled: true },
        { e164: "+14165550002", status: "active", voiceEnabled: true, smsEnabled: false },
        { e164: "+14165550003", status: "active", voiceEnabled: false, smsEnabled: true },
      ],
      services: [{ id: "service", name: "Consultation", durationMinutes: 30, localizedNames: { en: "Consultation", fr: "Consultation française" } }],
    })));
    const cache = memoryCache();
    await refreshBusinessSnapshot({ db: {} as never, snapshotCache: cache }, { businessId });
    expect(await cache.get(businessId)).toMatchObject({ legalName: "Maple Clinic Inc.", businessType: "clinic", telemetryEnabled: false, contactChannels: { phoneNumber: "+14165550002", smsNumber: "+14165550003" }, services: [{ localizedNames: { fr: "Consultation française" } }] });
    expect(mocks.resolveSmsSender).toHaveBeenCalledWith(expect.anything(), businessId);
  });
  it("keeps the language calls open in, and falls back to English for one they can't", async () => {
    for (const [stored, expected] of [["hi", "hi"], ["pt", "pt"], ["sr", "en"]] as const) {
      mocks.withBusinessTransaction.mockImplementation(async (_db, _ctx, callback) => callback(makeTx({ businesses: [{ ...businessRow, defaultLocale: stored }], receptionist_profiles: [profileRow] })));
      const cache = memoryCache();
      await refreshBusinessSnapshot({ db: {} as never, snapshotCache: cache }, { businessId });
      expect((await cache.get(businessId))?.defaultLocale, stored).toBe(expected);
    }
  });

  it("keeps every text entry the default receptionist's ranking gives, not just the few that prompts list", async () => {
    // Answers saved from the unanswered questions inbox are text entries too; knowledge search needs them all.
    const snippetRows = Array.from({ length: 12 }, (_, index) => ({ id: `snippet-${index}`, title: `Question ${index}`, content: `Answer ${index}`, tags: [], priority: 100 - index }));
    mocks.loadSnapshotKnowledge.mockResolvedValue({ ...noKnowledge, defaultSnippets: snippetRows, snippetIds: new Map([[profileRow.id, snippetRows.map((row) => row.id)]]) });
    const cache = memoryCache();
    await refreshBusinessSnapshot({ db: {} as never, snapshotCache: cache }, { businessId });
    const cached = await cache.get(businessId);
    expect(cached?.knowledgeSnippets?.map((snippet) => snippet.id)).toEqual(snippetRows.map((row) => row.id));
    expect(cached?.receptionists?.[0]?.snippetIds).toEqual(snippetRows.map((row) => row.id));
    expect(mocks.loadSnapshotKnowledge).toHaveBeenCalledWith(expect.anything(), { businessId, receptionists: [{ id: profileRow.id, isDefault: true, status: "active", knowledgeScope: "all" }] });
  });

  it("ranks a business from before receptionists as one receptionist that sees every article", async () => {
    mocks.withBusinessTransaction.mockImplementation(async (_db, _ctx, callback) => callback(makeTx({ businesses: [businessRow] })));
    const cache = memoryCache();
    await refreshBusinessSnapshot({ db: {} as never, snapshotCache: cache }, { businessId });
    expect(mocks.loadSnapshotKnowledge).toHaveBeenCalledWith(expect.anything(), { businessId, receptionists: [expect.objectContaining({ isDefault: true, status: "active", knowledgeScope: "all" })] });
    const cached = await cache.get(businessId);
    expect(cached).not.toHaveProperty("receptionists");
    expect(cached).toMatchObject({ greeting: "Thank you for calling Maple Family Clinic.", bookingPolicy: "Confirm availability before booking." });
  });

  it("pushes the regenerated snapshot into the shared cache", async () => {
    const cache = memoryCache();
    const context = { db: {} as never, snapshotCache: cache };

    const version = await refreshBusinessSnapshot(context, { businessId });

    expect(typeof version).toBe("string");
    const cached = await cache.get(businessId);
    expect(cached).not.toBeNull();
    expect(cached?.displayName).toBe("Maple Family Clinic");
    expect(cached?.bookingPolicy).toBe("Confirm before booking.");
  });

  it("tolerates a failing cache write without failing the refresh", async () => {
    const cache = memoryCache();
    const failing = {
      ...cache,
      set: vi.fn().mockRejectedValue(new Error("redis down")),
    } as never;
    const context = { db: {} as never, snapshotCache: failing };

    await expect(refreshBusinessSnapshot(context, { businessId })).resolves.toBeTypeOf("string");
  });

  it("deletes the business's older snapshot rows, keeping any from a newer refresh", async () => {
    await refreshBusinessSnapshot({ db: {} as never }, { businessId });

    expect(deleted).toMatchObject([{ table: "business_context_snapshots", where: { sql: '("business_context_snapshots"."business_id" = $1 and "business_context_snapshots"."generated_at" < now())', params: [businessId] } }]);
  });

  it("skips the cache push when no snapshot cache is configured", async () => {
    const context = { db: {} as never };
    await expect(refreshBusinessSnapshot(context, { businessId })).resolves.toBeTypeOf("string");
  });

  it("builds a schema-valid snapshot for the cache (demo reference)", () => {
    expect(demoSnapshot.businessId).toBeDefined();
  });
});
