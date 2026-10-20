import { randomUUID } from 'node:crypto';
import { DomainEventFactory } from '@navocms/kernel';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase, bootstrapSite, provisionRuntimeRole, runMigrations, inspectInstallation, createRecovery, restoreRecovery, encryptRecovery, decryptRecovery, type SiteBootstrapInput, type RecoveryStore } from '@navocms/persistence-postgres';
import { createFetchS3Transport, S3NamespaceStorage, NAVOCMS_MEDIA_NAMESPACE, NAVOCMS_ARTIFACTS_NAMESPACE } from '@navocms/s3-core';
import { r2RuntimeBindingDigest, selectR2Runtime, r2RuntimeBindingFromEnvironment, r2RuntimeExpectationFromEnvironment } from './r2-runtime.js';
import { parseR2RuntimeBinding, parseCloudflareStagingBinding } from '@navocms/contracts';
import { stagingBindingDigest } from './staging-profile.js';
import { evaluatePilot } from './pilot-evaluation.js';
import { createDotenvxSecretBroker } from './secret-broker.js';
import { initializeR2Namespaces, createR2StorageRuntime } from './r2-storage-runtime.js';
const required = (name: string) => { const value = process.env[name]; if (!value)
    throw Error('MISSING_' + name); return value; };
export function createRecoveryStorage() { const selected = selectR2Runtime({ requested: 'r2', runtimeMode: 'production', environment: 'staging', binding: r2RuntimeBindingFromEnvironment(), expected: r2RuntimeExpectationFromEnvironment(), secrets: createDotenvxSecretBroker() })!; const transport = createFetchS3Transport({ endpoint: () => selected.binding.endpoint, bucket: () => selected.binding.bucket, credentials: () => selected.secrets.use(selected.binding.accessKeySecretRef, accessKeyId => selected.secrets.use(selected.binding.secretKeySecretRef, async (secretAccessKey) => ({ accessKeyId, secretAccessKey }))) }); const media = new S3NamespaceStorage({ bucket: selected.binding.bucket, namespace: NAVOCMS_MEDIA_NAMESPACE, transport }), artifacts = new S3NamespaceStorage({ bucket: selected.binding.bucket, namespace: NAVOCMS_ARTIFACTS_NAMESPACE, transport }); const select = (key: string) => { const ns = key.startsWith(NAVOCMS_MEDIA_NAMESPACE) ? NAVOCMS_MEDIA_NAMESPACE : key.startsWith(NAVOCMS_ARTIFACTS_NAMESPACE) ? NAVOCMS_ARTIFACTS_NAMESPACE : undefined; if (!ns)
    throw Error('RECOVERY_NAMESPACE_INVALID'); return { adapter: ns === NAVOCMS_MEDIA_NAMESPACE ? media : artifacts, key: key.slice(ns.length) }; }; const store: RecoveryStore = { read: async (key, max) => { const s = select(key); return s.adapter.read(s.key, max); }, put: async (key, bytes, mediaType) => { const s = select(key); await s.adapter.putImmutable({ key: s.key, bytes, mediaType }); } }; return { store, transport, selected }; }
export async function operationsMain(args: string[]): Promise<unknown> {
    const [command, path] = args;
    if (!['evaluate', 'pins', 'install', 'doctor', 'backup', 'restore', 'monitor'].includes(command ?? ''))
        throw Error('USAGE_pins_install_doctor_backup_restore_monitor');
    if (command === 'evaluate') {
        if (!path)
            throw Error('PILOT_EVIDENCE_REQUIRED');
        const report = evaluatePilot(JSON.parse(await readFile(path, 'utf8')));
        if (report.failures.length)
            process.exitCode = 1;
        return report;
    }
    if (command === 'pins') {
        if (!path)
            throw Error('BINDING_FILE_REQUIRED');
        const data = JSON.parse(await readFile(path, 'utf8'));
        const cloudflare = parseCloudflareStagingBinding(data.cloudflare), r2 = parseR2RuntimeBinding(data.r2);
        if (cloudflare.siteId !== r2.siteId || cloudflare.tenantId !== r2.tenantId)
            throw Error('BINDING_SCOPE_MISMATCH');
        return { NAVOCMS_STAGING_BINDING: JSON.stringify(cloudflare), NAVOCMS_STAGING_BINDING_DIGEST: stagingBindingDigest(cloudflare), NAVOCMS_STAGING_HOSTNAME: cloudflare.cloudflare.allowedHostname, NAVOCMS_R2_RUNTIME_BINDING: JSON.stringify(r2), NAVOCMS_R2_RUNTIME_BINDING_DIGEST: r2RuntimeBindingDigest(r2) };
    }
    const siteId = required('NAVOCMS_SITE_ID');
    if (command === 'install') {
        if (!path)
            throw Error('INSTALL_CONFIG_REQUIRED');
        const inputs = JSON.parse(await readFile(resolve(path), 'utf8')) as SiteBootstrapInput[];
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 4 || inputs.some(input => input.siteId !== siteId || input.tenantId !== required('NAVOCMS_TENANT_ID')))
            throw Error('INSTALL_SCOPE_INVALID');
        const url = required('NAVOCMS_MIGRATION_DATABASE_URL');
        const migrations = await runMigrations(url);
        await provisionRuntimeRole(url, required('NAVOCMS_RUNTIME_DATABASE_PASSWORD'));
        for (const input of inputs)
            await bootstrapSite(url, input);
        await initializeR2Namespaces(createRecoveryStorage().transport);
        return { status: 'installed-not-activated', siteId, migrations };
    }
    if (command === 'doctor') {
        const db = new PostgresDatabase({ connectionString: required('NAVOCMS_DATABASE_URL'), readinessScope: { tenantId: required('NAVOCMS_TENANT_ID'), siteId, principalId: required('NAVOCMS_RUNTIME_PRINCIPAL_ID'), environmentKey: required('NAVOCMS_ENVIRONMENT_KEY') } });
        try {
            const registry = await inspectInstallation(required('NAVOCMS_MIGRATION_DATABASE_URL'), siteId);
            if (!await db.ready())
                throw Error('RUNTIME_READINESS_FAILED');
            const s = createRecoveryStorage();
            if (!await createR2StorageRuntime({ selection: s.selected, tenantId: required('NAVOCMS_TENANT_ID'), siteId, transport: s.transport }).ready())
                throw Error('OBJECT_STORAGE_NOT_READY');
            if (process.env.NAVOCMS_HEALTH_ORIGIN) {
                await health();
            }
            return { ...registry, runtime: process.env.NAVOCMS_HEALTH_ORIGIN ? 'ready' : 'not-probed' };
        }
        finally {
            await db.close();
        }
    }
    if (command === 'monitor') {
        await health();
        if (!path)
            throw Error('BACKUP_PATH_REQUIRED');
        const bundle = decryptRecovery(await readFile(path), required('NAVOCMS_BACKUP_KEY'));
        if (bundle.siteId !== siteId)
            throw Error('BACKUP_SCOPE_MISMATCH');
        const ageHours = (Date.now() - Date.parse(bundle.createdAt)) / 3600000;
        if (ageHours > 24 || ageHours < -0.1)
            throw Error('BACKUP_OVERDUE');
        return { status: 'healthy', siteId, backupAgeHours: ageHours };
    }
    if (!path)
        throw Error('BACKUP_PATH_REQUIRED');
    const key = required('NAVOCMS_BACKUP_KEY');
    const { store } = createRecoveryStorage();
    if (command === 'backup') {
        const start = Date.now();
        const bundle = await createRecovery({ url: required('NAVOCMS_MIGRATION_DATABASE_URL'), siteId, sourceCommit: required('NAVOCMS_REVIEWED_SOURCE_COMMIT'), store });
        const encrypted = encryptRecovery(bundle, key);
        await writeFile(path, encrypted, { flag: 'wx', mode: 0o600 });
        return { status: 'backup-created', siteId, createdAt: bundle.createdAt, objects: bundle.objects.length, bytes: encrypted.length, elapsedMs: Date.now() - start };
    }
    const bytes = await readFile(path);
    const bundle = decryptRecovery(bytes, key);
    return restoreRecovery({ url: required('NAVOCMS_RESTORE_DATABASE_URL'), bundle, siteId, store });
}
async function health() { const origin = new URL(required('NAVOCMS_HEALTH_ORIGIN')); if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/')
    throw Error('HEALTH_ORIGIN_INVALID'); for (const path of ['healthz', 'readyz']) {
    const response = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok)
        throw Error('RELEASE_READINESS_ALERT');
    const body = await response.json() as {
        status?: string;
    };
    if (!['ok', 'ready'].includes(body.status ?? ''))
        throw Error('RELEASE_READINESS_ALERT');
} }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const command = process.argv[2] ?? 'unknown', consequential = ['backup', 'restore', 'install'].includes(command);
    let events: DomainEventFactory | undefined;
    try {
        if (consequential) {
            events = new DomainEventFactory({ source: 'urn:navocms:operations', tenantId: required('NAVOCMS_TENANT_ID'), siteId: required('NAVOCMS_SITE_ID'), correlationId: randomUUID(), actor: { type: 'service', id: required('NAVOCMS_RUNTIME_PRINCIPAL_ID') } });
            console.log(JSON.stringify(events.create({ type: `io.navocms.operations.${command}-requested.v1`, consequence: 'G2', data: { operation: command, status: 'requested' } })));
        }
        const result = await operationsMain(process.argv.slice(2));
        if (events)
            console.log(JSON.stringify(events.create({ type: `io.navocms.operations.${command}-completed.v1`, consequence: 'G2', data: { operation: command, status: 'completed' } })));
        console.log(JSON.stringify(result));
    }
    catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATIONS_FAILED';
        if (events)
            console.error(JSON.stringify(events.create({ type: `io.navocms.operations.${command}-failed.v1`, consequence: 'G2', data: { operation: command, status: 'failed', code } })));
        console.error(JSON.stringify({ status: 'failed', code }));
        process.exitCode = 1;
    }
}
