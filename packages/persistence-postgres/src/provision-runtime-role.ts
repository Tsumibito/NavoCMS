import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { requireDatabaseUrl } from "./database.js";

const { Client } = pg;

export async function provisionRuntimeRole(connectionString: string, password: string): Promise<void> {
  if (password.length < 32) throw new Error("NAVOCMS_RUNTIME_DATABASE_PASSWORD must contain at least 32 characters");
  const client = new Client({
    connectionString: requireDatabaseUrl(connectionString, "NAVOCMS_MIGRATION_DATABASE_URL"),
    application_name: "navocms-role-provisioner"
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DO $runtime_role$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navocms_runtime') THEN
           CREATE ROLE navocms_runtime LOGIN INHERIT NOBYPASSRLS;
         END IF;
       END
       $runtime_role$`
    );
    const quoted = await client.query<{ value: string }>("SELECT quote_literal($1) AS value", [password]);
    await client.query(`ALTER ROLE navocms_runtime PASSWORD ${quoted.rows[0]!.value}`);
    await client.query("GRANT navocms_app TO navocms_runtime");
    const verified = await client.query<{ valid: boolean }>(
      `SELECT rolcanlogin AND NOT rolbypassrls AND pg_has_role('navocms_runtime', 'navocms_app', 'MEMBER') AS valid
         FROM pg_roles WHERE rolname = 'navocms_runtime'`
    );
    if (verified.rows[0]?.valid !== true) throw new Error("Runtime role verification failed");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await provisionRuntimeRole(
    process.env.NAVOCMS_MIGRATION_DATABASE_URL ?? "",
    process.env.NAVOCMS_RUNTIME_DATABASE_PASSWORD ?? ""
  );
  process.stdout.write("NavoCMS runtime database role is ready.\n");
}
