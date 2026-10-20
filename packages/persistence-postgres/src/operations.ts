import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { expectedMigrations, runMigrations } from './migrate.js';
import { requireDatabaseUrl } from './database.js';
const LIMIT = 128 * 1024 * 1024;
const MAGIC = Buffer.from('NAVOCMS-BACKUP-1\n');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export interface RecoveryObject {
    key: string;
    sha256: string;
    mediaType: string;
    bytes: string;
}
export interface RecoveryStore {
    read(key: string, maxBytes: number): Promise<{
        bytes: Uint8Array;
        mediaType: string;
    } | undefined>;
    put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
}
export interface RecoveryBundle {
    schema: 'io.navocms.recovery.v1';
    siteId: string;
    tenantId: string;
    createdAt: string;
    sourceCommit: string;
    postgresMajor: number;
    databaseOwner: string;
    migrations: readonly {
        name: string;
        checksum: string;
    }[];
    tables: Record<string, {
        rows: number;
        sha256: string;
    }>;
    dump: string;
    objects: RecoveryObject[];
}
export function encryptRecovery(bundle: RecoveryBundle, key: string): Buffer { validateBundle(bundle); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', backupKey(key), iv); cipher.setAAD(MAGIC); const bytes = Buffer.from(JSON.stringify(bundle)); if (bytes.length > LIMIT)
    throw Error('BACKUP_LIMIT'); const encrypted = Buffer.concat([cipher.update(gzipSync(bytes)), cipher.final()]); return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]); }
export function decryptRecovery(bytes: Uint8Array, key: string): RecoveryBundle { try {
    const data = Buffer.from(bytes);
    if (data.length > LIMIT || !data.subarray(0, MAGIC.length).equals(MAGIC))
        throw Error();
    const iv = data.subarray(MAGIC.length, MAGIC.length + 12), tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const cipher = createDecipheriv('aes-256-gcm', backupKey(key), iv);
    cipher.setAAD(MAGIC);
    cipher.setAuthTag(tag);
    const json = gunzipSync(Buffer.concat([cipher.update(data.subarray(MAGIC.length + 28)), cipher.final()]), { maxOutputLength: LIMIT });
    const bundle = JSON.parse(json.toString()) as RecoveryBundle;
    validateBundle(bundle);
    return bundle;
}
catch {
    throw Error('BACKUP_AUTHENTICATION_OR_FORMAT_FAILED');
} }
function backupKey(key: string): Buffer { if (!/^[a-f0-9]{64}$/.test(key))
    throw Error('BACKUP_KEY_REQUIRED'); return Buffer.from(key, 'hex'); }
function validateBundle(b: RecoveryBundle): void { if (b?.schema !== 'io.navocms.recovery.v1' || !uuid(b.siteId) || !uuid(b.tenantId) || (!Number.isInteger(b.postgresMajor) || !b.databaseOwner || typeof b.databaseOwner !== 'string') || !Array.isArray(b.migrations) || !Array.isArray(b.objects) || b.objects.length > 10000 || typeof b.dump !== 'string' || !b.dump.length || !b.tables || typeof b.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(b.sourceCommit) || !Number.isFinite(Date.parse(b.createdAt)))
    throw Error('BACKUP_FORMAT_INVALID'); const prefix = `tenants/${b.tenantId}/sites/${b.siteId}/`; const seen = new Set<string>(); let total = 0; for (const o of b.objects) {
    if (!['navocms/v1/media/', 'navocms/v1/artifacts/'].some(ns => o.key.startsWith(ns + prefix)) || o.key.includes('..') || seen.has(o.key) || !/^[a-zA-Z0-9/_.-]+$/.test(o.key) || !/^[a-f0-9]{64}$/.test(o.sha256) || typeof o.mediaType !== 'string' || !o.mediaType.length || typeof o.bytes !== 'string')
        throw Error('BACKUP_OBJECT_INVALID');
    seen.add(o.key);
    const bytes = Buffer.from(o.bytes, 'base64');
    total += bytes.length;
    if (total > LIMIT || hash(bytes) !== o.sha256)
        throw Error('BACKUP_OBJECT_INTEGRITY');
} }
const uuid = (v: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
function quote(name: string) { if (!/^[a-z][a-z0-9_]*$/.test(name))
    throw Error('DATABASE_IDENTIFIER_INVALID'); return '"' + name + '"'; }
async function inventory(client: pg.Client): Promise<RecoveryBundle['tables']> { await client.query("SET TIME ZONE 'UTC'"); const names = await client.query<{
    tablename: string;
}>("SELECT tablename FROM pg_tables WHERE schemaname='navocms' ORDER BY tablename"); const result: RecoveryBundle['tables'] = {}; let size = 0; for (const { tablename } of names.rows) {
    const rows = await client.query<{
        row: unknown;
    }>(`SELECT to_jsonb(t) AS row FROM navocms.${quote(tablename)} t`);
    const text = rows.rows.map(r => JSON.stringify(r.row)).sort().join('\n');
    size += Buffer.byteLength(text);
    if (size > LIMIT)
        throw Error('BACKUP_LIMIT');
    result[tablename] = { rows: rows.rowCount ?? 0, sha256: hash(text) };
} return result; }
async function registry(client: pg.Client) { const rows = (await client.query<{
    name: string;
    checksum: string;
}>('SELECT name,checksum FROM navocms.schema_migrations ORDER BY name')).rows; if (JSON.stringify(rows) !== JSON.stringify(await expectedMigrations()))
    throw Error('RUNTIME_MIGRATION_INCOMPATIBLE'); return rows; }
async function assertIsolation(client:pg.Client):Promise<void>{
 const unsafe=await client.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='navocms' AND c.relkind='r' AND c.relname<>'schema_migrations' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)");
 if(unsafe.rows.length)throw Error('DATABASE_ISOLATION_FAILED');
 const rewritable=(await client.query<{unsafe:boolean}>("SELECT has_table_privilege('navocms_app','navocms.page_editor_records','UPDATE') OR has_table_privilege('navocms_app','navocms.page_editor_records','DELETE') AS unsafe")).rows[0];if(rewritable?.unsafe)throw Error('APPEND_ONLY_GRANTS_INVALID');
}
export async function inspectInstallation(url: string, siteId: string) { const client = new pg.Client({ connectionString: requireDatabaseUrl(url), connectionTimeoutMillis: 30000 }); try {
    await client.connect();
    const migrations = await registry(client);
        await assertIsolation(client);
    const scope = await client.query('SELECT id FROM navocms.sites WHERE id=$1', [siteId]);
    if (scope.rows.length !== 1)
        throw Error('INSTALLATION_SITE_MISSING');
    const role = (await client.query<{
        safe: boolean;
    }>("SELECT NOT rolsuper AND NOT rolbypassrls AS safe FROM pg_roles WHERE rolname='navocms_runtime'")).rows[0];
    if (!role?.safe)
        throw Error('UNSAFE_RUNTIME_ROLE');
    return { status: 'ready', migrations: migrations.length, siteId };
}
finally {
    await client.end();
} }
export async function createRecovery(input: {
    url: string;
    siteId: string;
    sourceCommit: string;
    store: RecoveryStore;
    dump?: (snapshot: string, major: number) => Promise<Buffer>;
}): Promise<RecoveryBundle> {
    const client = new pg.Client({ connectionString: requireDatabaseUrl(input.url), connectionTimeoutMillis: 30000 });
    try {
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const createdAt = (await client.query<{
            at: Date;
        }>("SELECT transaction_timestamp() AS at")).rows[0]!.at.toISOString();
        const sites = (await client.query<{
            id: string;
            tenant_id: string;
        }>('SELECT id,tenant_id FROM navocms.sites')).rows;
        if (sites.length !== 1 || sites[0]!.id !== input.siteId)
            throw Error('BACKUP_REQUIRES_DEDICATED_SITE_DATABASE');
        const site = sites[0]!;
        const migrations = await registry(client);
        await assertIsolation(client);
        const major = Number((await client.query<{
            version: string;
        }>("SELECT current_setting('server_version_num') AS version")).rows[0]!.version.slice(0, -4));
        const snapshot = (await client.query<{
            id: string;
        }>('SELECT pg_export_snapshot() AS id')).rows[0]!.id;
        const databaseOwner = (await client.query<{
            name: string;
        }>("SELECT current_user AS name")).rows[0]!.name;
        const tables = await inventory(client);
        const objects: RecoveryObject[] = [];
        const rows = await client.query<{
            key: string;
            sha256: string;
            media_type: string;
        }>(`SELECT 'navocms/v1/media/'||o.storage_key AS key,o.sha256,o.media_type FROM navocms.media_originals o JOIN navocms.media_assets a ON a.tenant_id=o.tenant_id AND a.site_id=o.site_id AND a.id=o.asset_id WHERE a.state<>'deleted'
 UNION SELECT 'navocms/v1/media/'||o.storage_key,o.sha256,o.media_type FROM navocms.media_variants o JOIN navocms.media_assets a ON a.tenant_id=o.tenant_id AND a.site_id=o.site_id AND a.id=o.asset_id WHERE a.state<>'deleted'
 UNION SELECT 'navocms/v1/media/'||o.storage_key,o.output_sha256,o.media_type FROM navocms.media_variant_checkpoints o JOIN navocms.media_assets a ON a.tenant_id=o.tenant_id AND a.site_id=o.site_id AND a.id=o.asset_id WHERE a.state<>'deleted' AND o.status='completed'
 UNION SELECT 'navocms/v1/artifacts/'||source_object_key,source_object_sha256,'application/vnd.navocms.astro-source-bundle+json' FROM navocms.reviewed_astro_artifact_object_bindings
 UNION SELECT 'navocms/v1/artifacts/'||output_object_key,output_object_sha256,'application/vnd.navocms.astro-output-bundle+json' FROM navocms.reviewed_astro_artifact_object_bindings ORDER BY key`);
        let size = 0;
        for (const row of rows.rows) {
            const object = await input.store.read(row.key, 32 * 1024 * 1024);
            if (!object || hash(object.bytes) !== row.sha256 || object.mediaType !== row.media_type)
                throw Error('BACKUP_OBJECT_MISSING_OR_CHANGED');
            size += object.bytes.length;
            if (size > LIMIT / 2)
                throw Error('BACKUP_LIMIT');
            objects.push({ key: row.key, sha256: row.sha256, mediaType: row.media_type, bytes: Buffer.from(object.bytes).toString('base64') });
        }
        const dump = await (input.dump?.(snapshot, major) ?? postgresCommand('dump', input.url, ['--format=custom', '--schema=navocms', '--no-owner', `--snapshot=${snapshot}`], undefined, major));
        const bundle: RecoveryBundle = { schema: 'io.navocms.recovery.v1', siteId: site.id, tenantId: site.tenant_id, createdAt, sourceCommit: input.sourceCommit, postgresMajor: major, databaseOwner, migrations, tables, dump: dump.toString('base64'), objects };
        validateBundle(bundle);
        await client.query('COMMIT');
        return bundle;
    }
    finally {
        await client.end();
    }
}
export async function restoreRecovery(input: {
    url: string;
    bundle: RecoveryBundle;
    siteId: string;
    store: RecoveryStore;
    restore?: (dump: Buffer, major: number) => Promise<void>;
}): Promise<{
    status: string;
    objects: number;
    tables: number;
    elapsedMs: number;
}> {
    const started = Date.now();
    validateBundle(input.bundle);
    if (input.bundle.siteId !== input.siteId || JSON.stringify(input.bundle.migrations) !== JSON.stringify(await expectedMigrations()))
        throw Error('RESTORE_SCOPE_OR_RUNTIME_INCOMPATIBLE');
    const client = new pg.Client({ connectionString: requireDatabaseUrl(input.url), connectionTimeoutMillis: 30000 });
    try {
        await client.connect();
        const locked = await client.query<{
            locked: boolean;
        }>("SELECT pg_try_advisory_lock(hashtext('navocms-recovery-activation')) AS locked");
        if (!locked.rows[0]?.locked)
            throw Error('RESTORE_ALREADY_RUNNING');
        const existing = await client.query("SELECT 1 FROM pg_namespace WHERE nspname='navocms'");
        if (existing.rows.length)
            throw Error('RESTORE_TARGET_NOT_EMPTY');
        const version = Number((await client.query<{
            n: string;
        }>("SELECT current_setting('server_version_num') AS n")).rows[0]!.n.slice(0, -4));
        if (version !== input.bundle.postgresMajor)
            throw Error('RESTORE_POSTGRES_MAJOR_MISMATCH');
        if ((await client.query<{
            name: string;
        }>("SELECT current_user AS name")).rows[0]!.name !== input.bundle.databaseOwner)
            throw Error('RESTORE_OWNER_ROLE_MISMATCH');
        await runMigrations(input.url);
        // Activation is a separate step: partial object transfer must never start a server.
        for (const object of input.bundle.objects) {
            const bytes = Buffer.from(object.bytes, 'base64');
            await input.store.put(object.key, bytes, object.mediaType);
            const restored = await input.store.read(object.key, 32 * 1024 * 1024);
            if (!restored || hash(restored.bytes) !== object.sha256)
                throw Error('RESTORE_OBJECT_VERIFICATION_FAILED');
        }
        const dump = Buffer.from(input.bundle.dump, 'base64');
        if (input.restore)
            await input.restore(dump, input.bundle.postgresMajor);
        else
            await postgresCommand('restore', input.url, ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--single-transaction'], dump, input.bundle.postgresMajor);
        await registry(client);
        await assertIsolation(client);
        const restored = await inventory(client);
        if (JSON.stringify(restored) !== JSON.stringify(input.bundle.tables))
            throw Error('RESTORE_DATABASE_INTEGRITY_FAILED');
        return { status: 'restored-not-activated', objects: input.bundle.objects.length, tables: Object.keys(restored).length, elapsedMs: Date.now() - started };
    }
    finally {
        await client.end();
    }
}
export async function postgresCommand(kind: 'dump' | 'restore', url: string, args: string[], input?: Buffer, major?: number): Promise<Buffer> { const u = new URL(requireDatabaseUrl(url)); if (u.hostname.includes('-pooler.'))
    throw Error('DIRECT_DATABASE_ENDPOINT_REQUIRED'); const executable = process.env[kind === 'dump' ? 'NAVOCMS_PG_DUMP' : 'NAVOCMS_PG_RESTORE'] ?? `pg_${kind}`; const env = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGSSLMODE: u.searchParams.get('sslmode') === 'disable' ? 'disable' : 'verify-full', PGCONNECT_TIMEOUT: '30' }; if (env.PGSSLMODE !== 'disable')
    Object.assign(env, { PGSSLROOTCERT: u.searchParams.get('sslrootcert') ?? process.env.PGSSLROOTCERT ?? 'system' }); const run = (a: string[], body?: Buffer) => new Promise<Buffer>((resolve, reject) => { const child = spawn(executable, a, { env, stdio: ['pipe', 'pipe', 'pipe'] }); const timer = setTimeout(() => { child.kill(); reject(Error('POSTGRES_RECOVERY_TIMEOUT')); }, 120000); const chunks: Buffer[] = []; let size = 0; child.on('close', () => clearTimeout(timer)); child.on('error', () => clearTimeout(timer)); child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) {
    child.kill();
    reject(Error('BACKUP_LIMIT'));
}
else
    chunks.push(chunk); }); let detail = ''; child.stderr.on('data', (chunk: Buffer) => { if (detail.length < 4096)
    detail += chunk.toString(); }); child.on('error', () => reject(Error('POSTGRES_CLIENT_UNAVAILABLE'))); child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error('POSTGRES_RECOVERY_' + kind.toUpperCase() + '_FAILED' + (process.env.NAVOCMS_NEON_TEST_RUN === 'true' ? ': ' + detail.split('\n').filter(line => line.includes('error:')).map(line => line.replaceAll(env.PGPASSWORD, '[REDACTED]').replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[DATABASE_URL]')).slice(0, 2).join(' ') : '')))); child.stdin.on('error', () => { }); child.stdin.end(body); }); const version = (await run(['--version'])).toString(); if (major && !version.match(new RegExp(`\\b${major}\\.`)))
    throw Error('POSTGRES_CLIENT_MAJOR_MISMATCH'); return run(kind === 'restore' ? ['--dbname', env.PGDATABASE, ...args] : args, input); }
