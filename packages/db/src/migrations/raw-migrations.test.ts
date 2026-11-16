import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  concurrentIndexName,
  CONTRACT_MIGRATIONS,
  contractsWithoutTheirExpand,
  LEGACY_BASELINE_MIGRATIONS,
  narrowsTheSchema,
  RAW_MIGRATIONS,
  ROLE_MIGRATION,
  SCHEMA_MIGRATIONS,
} from "./raw-migrations";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

describe("raw migration manifest", () => {
  const filesOnDisk = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  it("lists every hand-written migration file exactly once", () => {
    expect([...RAW_MIGRATIONS].sort()).toEqual(filesOnDisk);
  });

  it("keeps the role migration first and schema migrations ordered without duplicates", () => {
    expect(RAW_MIGRATIONS[0]).toBe(ROLE_MIGRATION);
    expect([...SCHEMA_MIGRATIONS]).toEqual([...SCHEMA_MIGRATIONS].sort());
    expect(new Set(RAW_MIGRATIONS).size).toBe(RAW_MIGRATIONS.length);
  });

  it("keeps the pre-journal baseline fixed at migration 0052", () => {
    expect(LEGACY_BASELINE_MIGRATIONS.at(-1)).toBe(
      "0052_calendar_sync_freshness.sql",
    );
    expect(LEGACY_BASELINE_MIGRATIONS).not.toContain(
      "0053_legacy_email_verified_backfill.sql",
    );
  });

  it("clears expired call summaries only for calls without transcripts, and a conversation's only while it holds that text", () => {
    const backfill = readFileSync(`${migrationsDirectory}/0126_clear_expired_call_summaries.sql`, "utf8");
    expect(backfill).toContain("NOT EXISTS (SELECT 1 FROM public.transcripts t WHERE t.call_id = s.call_id)");
    expect(backfill).toContain("AND conv.summary = e.summary_text");
  });

  it("recognizes only validated concurrent-index migration directives", () => {
    expect(concurrentIndexName("-- lobbystack:concurrent-index product_events_business_sent_idx\nCREATE INDEX CONCURRENTLY ..."))
      .toBe("product_events_business_sent_idx");
    expect(concurrentIndexName("-- lobbystack:concurrent-index product-events;drop table users"))
      .toBeUndefined();
  });
});

// AUDIT-024: a migration that takes something away breaks the release still
// serving while the deploy finishes, and nothing recorded which release had to
// run in between.
describe("expand and contract", () => {
  const sqlFiles = readdirSync(migrationsDirectory).filter((file) => file.endsWith(".sql")).sort();

  it("declares every migration that drops a column or a table, or sets one not null", () => {
    const narrowing = sqlFiles.filter((file) => narrowsTheSchema(readFileSync(`${migrationsDirectory}/${file}`, "utf8")));

    expect(narrowing.filter((file) => !(file in CONTRACT_MIGRATIONS))).toEqual([]);
  });

  it("declares nothing that takes nothing away", () => {
    const declared = Object.keys(CONTRACT_MIGRATIONS);

    expect(declared.filter((file) => !narrowsTheSchema(readFileSync(`${migrationsDirectory}/${file}`, "utf8")))).toEqual([]);
  });

  it("names an expand migration that exists and runs first, and says why when there is none", () => {
    for (const [file, { expand, why }] of Object.entries(CONTRACT_MIGRATIONS)) {
      expect(RAW_MIGRATIONS, file).toContain(file);
      expect(why.length, file).toBeGreaterThan(40);
      if (expand === null) continue;
      expect(RAW_MIGRATIONS, file).toContain(expand);
      const order: readonly string[] = RAW_MIGRATIONS;
      expect(order.indexOf(expand), file).toBeLessThan(order.indexOf(file));
    }
  });

  it("catches a contract migration pending in the same run as its expand half", () => {
    expect(contractsWithoutTheirExpand(["0146_billing_provider.sql", "0147_billing_provider_contract.sql"])).toEqual([
      { contract: "0147_billing_provider_contract.sql", expand: "0146_billing_provider.sql" },
    ]);
  });

  it("lets the contract migration through once its expand half has already run", () => {
    expect(contractsWithoutTheirExpand(["0147_billing_provider_contract.sql"])).toEqual([]);
    expect(contractsWithoutTheirExpand(["0040_embedding_fingerprints.sql"])).toEqual([]);
  });
});
