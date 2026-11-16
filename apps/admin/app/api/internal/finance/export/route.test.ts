import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn();
  return {
    execute,
    getFinanceExportDatabase: vi.fn(() => ({ db: { execute } })),
  };
});

vi.mock("@/lib/api-helpers", () => ({
  getFinanceExportDatabase: mocks.getFinanceExportDatabase,
}));

import { GET } from "./route";

// AUDIT-010: the queries are Drizzle `sql` templates now, so a test reads the
// text PostgreSQL is sent and the values it is sent beside it.
const dialect = new PgDialect();
const sent = (index = 0) => dialect.sqlToQuery(mocks.execute.mock.calls[index]?.[0] as SQL);
const text = (index = 0) => sent(index).sql;

describe("finance export", () => {
  afterEach(() => {
    delete process.env.FINANCE_EXPORT_ENABLED;
    delete process.env.FINANCE_EXPORT_TOKEN;
    mocks.execute.mockReset();
    mocks.getFinanceExportDatabase.mockClear();
  });

  it("is absent unless explicitly enabled", async () => {
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=usage"));
    expect(response.status).toBe(404);
    expect(mocks.getFinanceExportDatabase).not.toHaveBeenCalled();
  });

  it("requires the dedicated finance bearer token", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=usage", {
      headers: { authorization: "Bearer some-internal-service-token" },
    }));
    expect(response.status).toBe(401);
    expect(mocks.getFinanceExportDatabase).not.toHaveBeenCalled();
  });

  it("returns cursor-safe mutable metrics with bookings", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({ rows: [{ id: "business:2026-09-09", businessId: "business", date: "2026-09-09", callCount: 2, voiceSeconds: 42, bookingCount: 1, updatedAt: "2026-09-09T12:00:00.000Z" }] });
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=metrics", {
      headers: { authorization: "Bearer finance-only-token" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: "v1", resource: "metrics", data: [expect.objectContaining({ bookingCount: 1 })], nextCursor: null });
    expect(text()).toContain("daily_bookings");
    expect(text()).toContain("booking_count");
    expect(text()).toContain("status <> 'canceled'");
    expect(text()).toContain("short_calls_waived");
    expect(text()).toContain("billed_voice_seconds");
  });

  it("rejects a syntactically valid cursor with an invalid timestamp", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    const cursor = Buffer.from(JSON.stringify({ updatedAt: "not-a-date", id: "row" })).toString("base64url");
    const response = await GET(new Request(`http://localhost/api/internal/finance/export?resource=usage&cursor=${cursor}`, {
      headers: { authorization: "Bearer finance-only-token" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.getFinanceExportDatabase).not.toHaveBeenCalled();
  });

  it("includes provider and embedding ledger events in usage exports", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=usage", {
      headers: { authorization: "Bearer finance-only-token" },
    }));
    expect(response.status).toBe(200);
    const query = text();
    expect(query).not.toContain("event_kind in");
    expect(query).toContain("knowledge.%");
    expect(query).toContain("%_provider");
    expect(query).toContain(`bu.quantity as "billedSeconds"`);
  });

  it("exports legacy business identifiers for provider attribution", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const response = await GET(
      new Request(
        "http://localhost/api/internal/finance/export?resource=businesses",
        { headers: { authorization: "Bearer finance-only-token" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(text()).toContain(
      'legacy_convex_id as "legacyConvexId"',
    );
  });

  it("exports service periods that overlap the requested window", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=service-periods&from=2026-09-01&to=2026-09-30", {
      headers: { authorization: "Bearer finance-only-token" },
    }));
    expect(response.status).toBe(200);
    const query = text();
    expect(query).toContain("current_period_end is null or current_period_end >= $1::date");
    expect(query).toContain("current_period_start < ($2::date + interval '1 day')");
    expect(sent().params).toEqual(["2026-09-01", "2026-09-30", 101]);
  });

  it("exports durable transaction-to-business attribution keys", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          id: "transaction-id",
          businessId: "business-id",
          kind: "order",
          sourceId: "polar-order-id",
          orderId: "polar-order-id",
          subscriptionId: null,
          providerCustomerId: "polar-customer-id",
          polarCustomerId: "polar-customer-id",
          occurredAt: new Date("2026-09-12T00:00:00.000Z"),
          updatedAt: "2026-09-12T00:00:01.000000Z",
        },
      ],
    });
    const response = await GET(
      new Request(
        "http://localhost/api/internal/finance/export?resource=transactions&from=2026-09-01&to=2026-09-30",
        { headers: { authorization: "Bearer finance-only-token" } },
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: "v1",
      resource: "transactions",
      data: [
        expect.objectContaining({
          businessId: "business-id",
          orderId: "polar-order-id",
          providerCustomerId: "polar-customer-id",
          polarCustomerId: "polar-customer-id",
          subscriptionId: null,
        }),
      ],
    });
    const query = text();
    expect(query).toContain("from billing_transactions");
    // The payer's customer from the provider-neutral column, also under its old name for existing readers.
    expect(query).toContain(`provider_customer_id as "providerCustomerId", provider_customer_id as "polarCustomerId"`);
    expect(query).toContain("occurred_at >= $1::date");
    expect(query).toContain("occurred_at < ($2::date + interval '1 day')");
    expect(sent().params).toEqual(["2026-09-01", "2026-09-30", 101]);
    expect(query).toContain("order by updated_at, id");
    expect(query).not.toContain("amount_cents");
  });

  // AUDIT-010: the five queries were template strings, and a value was made
  // safe by a `replaceAll("'", "''")` written beside it. Nothing made the next
  // parameter follow that. Every value is a bind parameter now.
  it("sends a cursor as a parameter, whatever is written in it", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const id = "row'); drop table calls; --";
    const cursor = Buffer.from(JSON.stringify({ updatedAt: "2026-09-09T12:00:00.000Z", id })).toString("base64url");

    const response = await GET(new Request(`http://localhost/api/internal/finance/export?resource=usage&cursor=${cursor}&limit=25`, {
      headers: { authorization: "Bearer finance-only-token" },
    }));

    expect(response.status).toBe(200);
    expect(text()).toContain("and (u.updated_at, u.id::text) > ($1::timestamptz, $2)");
    expect(text()).not.toContain("drop table");
    expect(sent().params).toEqual(["2026-09-09T12:00:00.000Z", id, 26]);
  });

  it("serializes updatedAt at microsecond precision for strict cursors", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=usage", {
      headers: { authorization: "Bearer finance-only-token" },
    }));
    expect(response.status).toBe(200);
    expect(text()).toContain("HH24:MI:SS.US");
  });
});

describe("finance export service periods", () => {
  afterEach(() => {
    delete process.env.FINANCE_EXPORT_ENABLED;
    delete process.env.FINANCE_EXPORT_TOKEN;
    mocks.execute.mockReset();
  });

  it("exports each billing account's source, so a managed plan isn't read as a Polar subscription", async () => {
    process.env.FINANCE_EXPORT_ENABLED = "true";
    process.env.FINANCE_EXPORT_TOKEN = "finance-only-token";
    const managed = { id: "acct_1", businessId: "biz_1", source: "managed", customerId: null, subscriptionId: null, plan: "enterprise", billingInterval: null, subscriptionState: "active", currentPeriodStart: "2026-10-01T00:00:00.000Z", currentPeriodEnd: null, updatedAt: "2026-10-01T00:00:00.000000Z" };
    mocks.execute.mockResolvedValue({ rows: [managed] });
    const response = await GET(new Request("http://localhost/api/internal/finance/export?resource=service-periods", { headers: { authorization: "Bearer finance-only-token" } }));
    expect(response.status).toBe(200);
    expect(text()).toMatch(/\bsource\b/);
    expect(await response.json()).toMatchObject({ data: [{ source: "managed", plan: "enterprise", subscriptionId: null }] });
  });
});
