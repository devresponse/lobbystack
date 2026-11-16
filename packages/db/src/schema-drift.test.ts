import { describe, expect, it } from "vitest";

import {
  compareSchemas,
  describeCodeTables,
  describeDatabaseTables,
  normalizeType,
  type TableShape,
} from "./schema-drift";
import { schema } from "./schema";

describe("normalizeType", () => {
  it.each([
    ["varchar(64)", "character varying(64)"],
    ["character varying(64)", "character varying(64)"],
    ["timestamptz", "timestamp with time zone"],
    ["timestamp(3) with time zone", "timestamp(3) with time zone"],
    ["numeric(10, 2)", "numeric(10,2)"],
    ["serial", "integer"],
    ["bigserial", "bigint"],
    ["TEXT[]", "text[]"],
    ["vector(1536)", "vector(1536)"],
  ])("reads %s the way PostgreSQL writes it", (written, expected) => {
    expect(normalizeType(written)).toBe(expected);
  });
});

const codeTable: TableShape = {
  name: "contacts",
  columns: [
    { name: "id", type: "uuid", notNull: true },
    { name: "name", type: "character varying(120)", notNull: true },
  ],
  indexes: [{ columns: "id", unique: true }],
};

describe("compareSchemas", () => {
  it("finds nothing when the two agree", () => {
    expect(compareSchemas([codeTable], [codeTable])).toEqual([]);
  });

  it("names a missing table, column, type, nullability and index", () => {
    const live: TableShape = {
      name: "contacts",
      columns: [
        { name: "id", type: "uuid", notNull: true },
        { name: "name", type: "text", notNull: false },
        { name: "legacy_note", type: "text", notNull: false },
      ],
      indexes: [],
    };

    expect(compareSchemas([codeTable, { ...codeTable, name: "ghosts" }], [live])).toEqual([
      "contacts.name: the schema says character varying(120), the database has text",
      "contacts.name: the schema says not null, the database has nullable",
      "contacts.legacy_note: the database has it, the schema doesn't declare it, so no query can read it",
      "contacts: the schema declares a unique index on (id), the database has none covering those columns",
      "table ghosts: the schema declares it, the database doesn't have it",
    ]);
  });

  // AUDIT-015: seven of the schema's unique indexes exist in SQL as inline
  // UNIQUE constraints, under names PostgreSQL generated. Comparing names would
  // report all seven as drift; comparing what they cover reports none.
  it("matches a unique index however it was named", () => {
    const live: TableShape = { ...codeTable, indexes: [{ columns: "id", unique: true }] };

    expect(compareSchemas([codeTable], [live])).toEqual([]);
  });

  it("ignores a table the schema doesn't model, such as a migration journal", () => {
    const journal: TableShape = { name: "__lobbystack_migrations", columns: [], indexes: [] };

    expect(compareSchemas([codeTable], [codeTable, journal])).toEqual([]);
  });
});

describe("describeDatabaseTables", () => {
  it("skips an index over an expression, which has no columns to compare", () => {
    const tables = describeDatabaseTables(
      [{ table_name: "contacts", column_name: "id", column_type: "uuid", not_null: true }],
      [
        { table_name: "contacts", index_columns: "id", is_unique: true },
        { table_name: "contacts", index_columns: "", is_unique: false },
      ],
    );

    expect(tables).toEqual([{ name: "contacts", columns: [{ name: "id", type: "uuid", notNull: true }], indexes: [{ columns: "id", unique: true }] }]);
  });
});

describe("describeCodeTables", () => {
  it("reads every table the schema exports", () => {
    const tables = describeCodeTables(schema);

    expect(tables).toHaveLength(Object.keys(schema).length);
    expect(tables.every((table) => table.columns.length > 0)).toBe(true);
    expect(tables.find((table) => table.name === "businesses")?.columns.some((column) => column.name === "slug")).toBe(true);
  });
});
