// Local maintainer helper: fresh database per run on the dedicated agent-tests branch.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const require = createRequire(new URL('../packages/persistence-postgres/package.json', import.meta.url));
const { Client } = require('pg');
const root = new URL('../', import.meta.url);
const isolationOnly = process.argv[2] === '--isolation-only';
if (process.argv.length > (isolationOnly ? 3 : 2)) throw new Error('Supported option: --isolation-only');
const adminUrl = new URL(process.env.NAVOCMS_NEON_TEST_ADMIN_DATABASE_URL ?? 'https://missing.invalid');
const allowedHost = 'ep-round-darkness-b1wmk3ea.c-5.eu-central-1.aws.neon.tech';
if (adminUrl.protocol !== 'postgresql:' || adminUrl.hostname !== allowedHost || adminUrl.pathname !== '/navocms_agent_test') {
  throw new Error('Refusing non-agent-tests endpoint or anchor database. Load the local encrypted .env.test.');
}
if ((process.env.NAVOCMS_RUNTIME_DATABASE_PASSWORD ?? '').length < 32) throw new Error('Test runtime password missing');
adminUrl.searchParams.set('sslmode', 'verify-full');
const database = `navocms_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
const admin = new Client({ connectionString: adminUrl.toString(), application_name: 'navocms-agent-tests', connectionTimeoutMillis: 30000 });
const runUrl = new URL(adminUrl); runUrl.pathname = `/${database}`;
const runtimeUrl = new URL(runUrl); runtimeUrl.username = 'navocms_runtime'; runtimeUrl.password = process.env.NAVOCMS_RUNTIME_DATABASE_PASSWORD;
const env = { ...process.env, NODE_ENV: 'test', NAVOCMS_NEON_TEST_RUN: 'true', NAVOCMS_MIGRATION_DATABASE_URL: runUrl.toString(), NAVOCMS_INTEGRATION_ADMIN_DATABASE_URL: runUrl.toString(), NAVOCMS_INTEGRATION_DATABASE_URL: runtimeUrl.toString() };
delete env.NAVOCMS_ALLOW_INSECURE_TEST_DATABASE;
function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`pnpm ${args.join(' ')} failed (${code ?? signal})`)));
  });
}
let created = false;
try {
  await admin.connect();
  const lock = await admin.query('SELECT pg_try_advisory_lock(861081) AS acquired');
  if (!lock.rows[0].acquired) throw new Error('Another Neon test run is active; retry after it finishes.');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  console.log(`Fresh Neon test database: ${database}`);
  await command(['build']);
  const { runMigrations } = await import('../packages/persistence-postgres/dist/migrate.js');
  const { provisionRuntimeRole } = await import('../packages/persistence-postgres/dist/provision-runtime-role.js');
  const { bootstrapSite } = await import('../packages/persistence-postgres/dist/bootstrap-site.js');
  await runMigrations(runUrl.toString());
  await provisionRuntimeRole(runUrl.toString(), process.env.NAVOCMS_RUNTIME_DATABASE_PASSWORD);
  // Neon owners are not PostgreSQL superusers. SQL isolation fixtures explicitly SET ROLE.
  // Grant that test-owner capability only on the allowlisted branch; runtime remains NOBYPASSRLS.
  await admin.query('GRANT navocms_app TO neondb_owner WITH INHERIT FALSE, SET TRUE');
  await bootstrapSite(runUrl.toString(), {
    tenantId: 'a2af348f-58b8-4efe-b873-8bd032ecbc5c', tenantSlug: 'sprint-seven', tenantName: 'Sprint Seven Integration',
    siteId: '2e0bcd4f-6780-470c-844b-d72abb6737ca', siteSlug: 'persistence-suite', siteName: 'Persistence suite', primaryLocale: 'en', locales: ['en'],
    environmentId: '7b0c4135-7015-4afd-9d6c-1ee4b2d974f1', environmentKind: 'staging', environmentKey: 'default',
    principal: { id: '016ef382-bf28-406b-9321-1fc580b6ea00', issuer: 'urn:navocms:integration', subject: 'sprint-6', kind: 'human', siteRole: 'owner' }
  });
  if (!isolationOnly) await command(['check']);
  for (const name of ['rls', 'content', 'runtime', 'release-workflow', 'media']) {
    const sql = await readFile(new URL(`../packages/persistence-postgres/tests/${name}-isolation.sql`, import.meta.url), 'utf8');
    if (sql.split('\n').some(line => line.startsWith('\\') && line.trim() !== '\\set ON_ERROR_STOP on')) throw new Error('Unsupported isolation script directive');
    const client = new Client({ connectionString: runUrl.toString(), application_name: 'navocms-isolation-test', connectionTimeoutMillis: 30000 });
    try { await client.connect(); await client.query(sql.replace(/^\\set ON_ERROR_STOP on\r?$/gm, '')); }
    catch (error) { throw new Error(`Isolation ${name}: ${error.message}`); }
    finally { await client.end(); }
    console.log(`Isolation passed: ${name}`);
  }
} catch (error) {
  // Never dump database connection objects or SQL errors containing role credentials.
  console.error(`Neon test run failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (created) { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); console.log(`Removed this run's database: ${database}`); }
  } catch { console.error(`Cleanup failed; remove only ${database} from the agent-tests branch.`); process.exitCode = 1; }
  await admin.end();
}
