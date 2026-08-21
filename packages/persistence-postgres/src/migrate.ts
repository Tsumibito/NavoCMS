import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { requireDatabaseUrl } from "./database.js";

const { Client } = pg;
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function runMigrations(connectionString: string): Promise<readonly string[]> {
  const client = new Client({
    connectionString: requireDatabaseUrl(connectionString, "NAVOCMS_MIGRATION_DATABASE_URL"),
    application_name: "navocms-migrator"
  });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('navocms-schema-migrations'))");
    const files = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const tableExists = await client.query<{ present: boolean }>(
        "SELECT to_regclass('navocms.schema_migrations') IS NOT NULL AS present"
      );
      if (tableExists.rows[0]?.present) {
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM navocms.schema_migrations WHERE name = $1", [file]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} has changed`);
          continue;
        }
      }
      await client.query(sql);
      await client.query(
        `CREATE TABLE IF NOT EXISTS navocms.schema_migrations (
           name text PRIMARY KEY,
           checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
           applied_at timestamptz NOT NULL DEFAULT now()
         )`
      );
      await client.query("INSERT INTO navocms.schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applied = await runMigrations(process.env.NAVOCMS_MIGRATION_DATABASE_URL ?? "");
  process.stdout.write(applied.length === 0 ? "NavoCMS schema is current.\n" : `Applied ${applied.length} migration(s).\n`);
}
