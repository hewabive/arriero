import assert from "node:assert/strict";
import { test } from "node:test";

import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";

import { sqlite } from "./index.js";
import * as schema from "./schema.js";

type PragmaColumn = {
  name: string;
  notnull: number;
  pk: number;
};

function declaredTables() {
  return (Object.values(schema) as unknown[])
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => getTableConfig(table));
}

function columnsInDatabase(tableName: string): PragmaColumn[] {
  return sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as PragmaColumn[];
}

function tablesInDatabase(): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

test("migrate() creates every table declared in schema.ts, and no others", () => {
  const declared = declaredTables()
    .map((table) => table.name)
    .sort();
  assert.deepEqual(tablesInDatabase().sort(), declared);
});

test("every schema.ts column exists in the migrated table", () => {
  for (const table of declaredTables()) {
    const declared = table.columns.map((column) => column.name).sort();
    const created = columnsInDatabase(table.name)
      .map((column) => column.name)
      .sort();
    assert.deepEqual(
      created,
      declared,
      `${table.name} differs between db/schema.ts and db/index.ts:migrate()`,
    );
  }
});

test("nullability agrees between schema.ts and migrate()", () => {
  for (const table of declaredTables()) {
    const createdByName = new Map(
      columnsInDatabase(table.name).map((column) => [column.name, column]),
    );
    for (const column of table.columns) {
      const created = createdByName.get(column.name);
      assert.ok(created, `${table.name}.${column.name} was not created`);
      if (created.pk === 1) {
        continue;
      }
      assert.equal(
        created.notnull === 1,
        column.notNull,
        `${table.name}.${column.name} nullability differs between db/schema.ts and db/index.ts:migrate()`,
      );
    }
  }
});
