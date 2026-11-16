import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A migration that has run somewhere can never be edited: the database keeps
 * what it applied, and the migrator can only warn that the file has changed
 * since (AUDIT-015). Freezing each file's checksum turns that warning into a
 * failed build, where it can still be fixed.
 */
export type MigrationChecksums = Record<string, string>;

export function checksumOf(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Every migration file, raw and generated, by the path the manifest names it. */
export function readMigrationChecksums(migrationsDirectory: string): MigrationChecksums {
  const checksums: MigrationChecksums = {};
  const add = (directory: string, prefix: string): void => {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      checksums[`${prefix}${file}`] = checksumOf(readFileSync(join(directory, file)));
    }
  };
  add(migrationsDirectory, "");
  add(join(migrationsDirectory, "generated"), "generated/");
  return checksums;
}

export type ChecksumDifference = { file: string; reason: "edited" | "deleted" | "unfrozen" };

/** What changed between the frozen manifest and the files on disk. */
export function compareMigrationChecksums(frozen: MigrationChecksums, onDisk: MigrationChecksums): ChecksumDifference[] {
  const differences: ChecksumDifference[] = [];
  for (const [file, checksum] of Object.entries(frozen)) {
    const current = onDisk[file];
    if (current === undefined) differences.push({ file, reason: "deleted" });
    else if (current !== checksum) differences.push({ file, reason: "edited" });
  }
  for (const file of Object.keys(onDisk)) {
    if (frozen[file] === undefined) differences.push({ file, reason: "unfrozen" });
  }
  return differences.sort((left, right) => left.file.localeCompare(right.file));
}

export function describeDifference({ file, reason }: ChecksumDifference): string {
  if (reason === "edited") {
    return `${file} was edited after it was applied. A database that already ran it keeps the old version, so the two will never agree: add a new migration instead of changing this one.`;
  }
  if (reason === "deleted") {
    return `${file} was deleted, but databases have already run it. Put it back; a migration that has run is history.`;
  }
  return `${file} is new and not frozen yet. Run \`pnpm db:freeze-migrations\` and commit the manifest with it.`;
}
