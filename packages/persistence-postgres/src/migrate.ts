import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { requireDatabaseUrl } from "./database.js";

const { Client } = pg;
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface ExpectedMigration {
  readonly name: string;
  readonly checksum: string;
}

export async function expectedMigrations(): Promise<readonly ExpectedMigration[]> {
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  return Object.freeze(await Promise.all(files.map(async (name) => {
    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    return Object.freeze({ name, checksum: createHash("sha256").update(sql).digest("hex") });
  })));
}

export async function runMigrations(connectionString: string): Promise<readonly string[]> {
  const client = new Client({
    connectionString: requireDatabaseUrl(connectionString, "NAVOCMS_MIGRATION_DATABASE_URL"),
    application_name: "navocms-migrator"
  });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('navocms-schema-migrations'))");
    // The registry exists before evaluating any individual migration. Each
    // migration body and its registry row are committed together below.
    await client.query("CREATE SCHEMA IF NOT EXISTS navocms");
    await client.query(
      `CREATE TABLE IF NOT EXISTS navocms.schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const definitions = await expectedMigrations();
    for (const { name: file, checksum } of definitions) {
      const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM navocms.schema_migrations WHERE name = $1", [file]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} has changed`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(withoutOuterTransaction(sql));
        await client.query("INSERT INTO navocms.schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(file);
    }
    return Object.freeze(applied);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('navocms-schema-migrations'))");
    } finally {
      await client.end();
    }
  }
}

function withoutOuterTransaction(sql: string): string {
  return sql
    .replace(/^\s*BEGIN\s*;\s*/i, "")
    .replace(/\s*COMMIT\s*;\s*$/i, "");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applied = await runMigrations(process.env.NAVOCMS_MIGRATION_DATABASE_URL ?? "");
  process.stdout.write(applied.length === 0 ? "NavoCMS schema is current.\n" : `Applied ${applied.length} migration(s).\n`);
}
