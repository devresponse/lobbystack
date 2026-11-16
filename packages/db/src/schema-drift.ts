import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

/**
 * The Drizzle schema types every query; the SQL migrations build the database.
 * Nothing generates one from the other, so they can drift apart in silence
 * until a query touches a column that isn't there (AUDIT-015). These shapes let
 * CI compare the two after migrating.
 */
export type ColumnShape = { name: string; type: string; notNull: boolean };
/** Indexes are compared by what they cover, not by name: the same unique index is spelled as a named index in Drizzle and as an inline UNIQUE constraint in SQL, under a name PostgreSQL generates. */
export type IndexShape = { columns: string; unique: boolean };
export type TableShape = { name: string; columns: ColumnShape[]; indexes: IndexShape[] };

/**
 * PostgreSQL's own spelling of a type, as `format_type` returns it, so both
 * sides of the comparison can be strings. Drizzle writes `varchar(64)` where
 * PostgreSQL writes `character varying(64)`, and a serial column is an integer
 * with a default once the table exists.
 */
const TYPE_NAMES = new Map([
  ["varchar", "character varying"],
  ["char", "character"],
  ["bpchar", "character"],
  ["int", "integer"],
  ["int4", "integer"],
  ["serial", "integer"],
  ["int2", "smallint"],
  ["smallserial", "smallint"],
  ["int8", "bigint"],
  ["bigserial", "bigint"],
  ["bool", "boolean"],
  ["float4", "real"],
  ["float8", "double precision"],
  ["decimal", "numeric"],
  ["timestamptz", "timestamp with time zone"],
  ["timetz", "time with time zone"],
]);

export function normalizeType(type: string): string {
  const lower = type.trim().toLowerCase();
  const arraySuffix = lower.endsWith("[]") ? "[]" : "";
  const withoutArray = arraySuffix ? lower.slice(0, -2) : lower;
  // PostgreSQL writes a precision in the middle of a name: `timestamp(3) with
  // time zone`. Keep the three parts apart so only the name is translated.
  const open = withoutArray.indexOf("(");
  const close = withoutArray.lastIndexOf(")");
  const name = (open === -1 ? withoutArray : withoutArray.slice(0, open)).trim();
  const parameters = open === -1 ? "" : `(${withoutArray.slice(open + 1, close).replaceAll(" ", "")})`;
  const after = open === -1 ? "" : withoutArray.slice(close + 1).trim();
  const mapped = TYPE_NAMES.get(name) ?? name;
  return `${mapped}${parameters}${after ? ` ${after}` : ""}${arraySuffix}`;
}

function indexKey(columns: readonly string[]): string {
  return columns.join(", ");
}

/** What the code believes each table looks like. */
export function describeCodeTables(tables: Record<string, unknown>): TableShape[] {
  const shapes: TableShape[] = [];
  for (const table of Object.values(tables)) {
    const config = getTableConfig(table as PgTable);
    const columns = config.columns.map((column) => ({
      name: column.name,
      type: normalizeType(column.getSQLType()),
      notNull: column.notNull || column.primary,
    }));
    const indexes: IndexShape[] = [];
    for (const index of config.indexes) {
      // An index over an expression, such as the GIN index on
      // `to_tsvector(title)`, has no column names on either side. It lives in
      // SQL and is compared by nothing here.
      if (index.config.columns.some((column) => !("name" in column))) continue;
      const names = index.config.columns.map((column) => String((column as { name: unknown }).name));
      indexes.push({ columns: indexKey(names), unique: index.config.unique === true });
    }
    for (const unique of config.uniqueConstraints) {
      indexes.push({ columns: indexKey(unique.columns.map((column) => column.name)), unique: true });
    }
    const primaryColumns = config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name));
    const singlePrimary = config.columns.filter((column) => column.primary).map((column) => column.name);
    const primary = primaryColumns.length ? primaryColumns : singlePrimary;
    if (primary.length) indexes.push({ columns: indexKey(primary), unique: true });
    shapes.push({ name: config.name, columns: columns.sort(byName), indexes });
  }
  return shapes.sort(byName);
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function sameIndex(left: IndexShape, right: IndexShape): boolean {
  return left.columns === right.columns && left.unique === right.unique;
}

/**
 * Every difference between what the code believes and what the database holds,
 * as lines a person can act on. A table the code doesn't model is ignored:
 * migration journals and anything maintained in SQL alone are not the schema's
 * business. An index the database has and the code doesn't is reported as a
 * note, since SQL is where partial and concurrent indexes are written.
 */
export function compareSchemas(code: readonly TableShape[], database: readonly TableShape[]): string[] {
  const differences: string[] = [];
  const byTable = new Map(database.map((table) => [table.name, table]));

  for (const table of code) {
    const live = byTable.get(table.name);
    if (!live) {
      differences.push(`table ${table.name}: the schema declares it, the database doesn't have it`);
      continue;
    }
    const liveColumns = new Map(live.columns.map((column) => [column.name, column]));
    for (const column of table.columns) {
      const liveColumn = liveColumns.get(column.name);
      if (!liveColumn) {
        differences.push(`${table.name}.${column.name}: the schema declares it, the database doesn't have it`);
        continue;
      }
      if (liveColumn.type !== column.type) {
        differences.push(`${table.name}.${column.name}: the schema says ${column.type}, the database has ${liveColumn.type}`);
      }
      if (liveColumn.notNull !== column.notNull) {
        differences.push(
          `${table.name}.${column.name}: the schema says ${column.notNull ? "not null" : "nullable"}, the database has ${liveColumn.notNull ? "not null" : "nullable"}`,
        );
      }
    }
    for (const column of live.columns) {
      if (!table.columns.some((candidate) => candidate.name === column.name)) {
        differences.push(`${table.name}.${column.name}: the database has it, the schema doesn't declare it, so no query can read it`);
      }
    }
    for (const index of table.indexes) {
      if (!live.indexes.some((candidate) => sameIndex(candidate, index))) {
        differences.push(`${table.name}: the schema declares ${index.unique ? "a unique index" : "an index"} on (${index.columns}), the database has none covering those columns`);
      }
    }
  }
  return differences;
}

export type ColumnRow = { table_name: string; column_name: string; column_type: string; not_null: boolean };
export type IndexRow = { table_name: string; index_columns: string; is_unique: boolean };

/** The two `pg_catalog` reads the comparison needs, kept here so the CLI holds no SQL of its own. */
export const DATABASE_COLUMNS_QUERY = `
  select c.relname as table_name,
         a.attname as column_name,
         format_type(a.atttypid, a.atttypmod) as column_type,
         a.attnotnull as not_null
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attname
`;

export const DATABASE_INDEXES_QUERY = `
  select c.relname as table_name,
         (select string_agg(att.attname, ', ' order by key.ordinality)
          from unnest(i.indkey[0:i.indnkeyatts - 1]) with ordinality as key(attnum, ordinality)
          join pg_attribute att on att.attrelid = c.oid and att.attnum = key.attnum) as index_columns,
         i.indisunique as is_unique
  from pg_index i
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname
`;

/** What the database actually holds, from the two queries above. */
export function describeDatabaseTables(columns: readonly ColumnRow[], indexes: readonly IndexRow[]): TableShape[] {
  const tables = new Map<string, TableShape>();
  const table = (name: string): TableShape => {
    let shape = tables.get(name);
    if (!shape) { shape = { name, columns: [], indexes: [] }; tables.set(name, shape); }
    return shape;
  };
  for (const row of columns) {
    table(row.table_name).columns.push({ name: row.column_name, type: normalizeType(row.column_type), notNull: row.not_null });
  }
  for (const row of indexes) {
    // An index over an expression has no column names; it can't match a
    // Drizzle column index, and SQL is the only place it is written.
    if (!row.index_columns) continue;
    table(row.table_name).indexes.push({ columns: row.index_columns, unique: row.is_unique });
  }
  return [...tables.values()].map((shape) => ({ ...shape, columns: shape.columns.sort(byName) })).sort(byName);
}
