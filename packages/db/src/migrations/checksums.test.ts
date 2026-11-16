import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compareMigrationChecksums,
  describeDifference,
  readMigrationChecksums,
  type MigrationChecksums,
} from "./checksums";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const manifestPath = `${migrationsDirectory}/checksums.json`;

describe("frozen migration checksums", () => {
  it("matches every migration file on disk", () => {
    const frozen = JSON.parse(readFileSync(manifestPath, "utf8")) as MigrationChecksums;
    const differences = compareMigrationChecksums(frozen, readMigrationChecksums(migrationsDirectory));

    expect(differences.map(describeDifference)).toEqual([]);
  });

  it("names an edited migration, a deleted one and a new one", () => {
    const frozen = { "0002_rls.sql": "aaa", "0003_resolvers.sql": "bbb" };
    const onDisk = { "0002_rls.sql": "ccc", "0004_vector.sql": "ddd" };

    expect(compareMigrationChecksums(frozen, onDisk)).toEqual([
      { file: "0002_rls.sql", reason: "edited" },
      { file: "0003_resolvers.sql", reason: "deleted" },
      { file: "0004_vector.sql", reason: "unfrozen" },
    ]);
    expect(describeDifference({ file: "0002_rls.sql", reason: "edited" })).toContain("add a new migration");
    expect(describeDifference({ file: "0004_vector.sql", reason: "unfrozen" })).toContain("db:freeze-migrations");
  });
});
