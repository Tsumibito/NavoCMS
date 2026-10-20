import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { bootstrapSite, runMigrations, provisionRuntimeRole, PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore, createRecovery, restoreRecovery, encryptRecovery, decryptRecovery, inspectInstallation, type RecoveryStore } from '@navocms/persistence-postgres';
import { LocalDeterministicMediaStorage, PostgresMediaRepository } from '@navocms/media';
import { NAVOCMS_PERMISSIONS } from '@navocms/security';
import { PostgresEditingRepository } from './postgres-repository.js';
import { PostgresReleaseWorkflowRepository } from './postgres-release-repository.js';
import { McpEditingService, type IdempotencyStore } from './service.js';
import { MediaUploadGateway } from './media-upload-gateway.js';
import { McpMediaService } from './media-service.js';
import { pageChangeSchema } from './page-editing.js';
const require = createRequire(new URL('../../../packages/persistence-postgres/package.json', import.meta.url));
const { Client } = require('pg');
const sharp = createRequire(new URL('../../../packages/media/package.json', import.meta.url))('sharp');
const adminUrl = process.env.NAVOCMS_INTEGRATION_ADMIN_DATABASE_URL;
describe.skipIf(!adminUrl || !process.env.NAVOCMS_PG_DUMP)('clean installation and recovery', () => {
    it('restores real revisions, contracts, release, responsive files and comment history into an independent empty database', async () => {
        const admin = new Client({ connectionString: adminUrl });
        const names: string[] = [];
        const tenantId = randomUUID(), siteId = randomUUID(), principalId = randomUUID();
        const scope = { tenantId, siteId, principalId };
        const context = { authorization: { tenantId, siteId, principal: { id: principalId, kind: 'human' as const, issuer: 'urn:navocms:recovery', subject: 'owner' }, layers: [{ name: 'principal' as const, permissions: NAVOCMS_PERMISSIONS }] } };
        const site = { tenantId, siteId, name: 'Recovery pilot', primaryLocale: 'en', locales: ['en'] };
        let source: PostgresDatabase | undefined, target: PostgresDatabase | undefined;
        try {
            await admin.connect();
            async function fresh() { const name = 'navocms_recovery_' + randomUUID().replaceAll('-', ''); await admin.query(`CREATE DATABASE "${name}"`); names.push(name); const url = new URL(adminUrl!); url.pathname = '/' + name; return url.toString(); }
            const sourceUrl = await fresh(), targetUrl = await fresh();
            await runMigrations(sourceUrl);
            expect(await runMigrations(sourceUrl)).toEqual([]);
            const input = { tenantId, tenantSlug: 'recovery-pilot', tenantName: 'Recovery', siteId, siteSlug: 'recovery-site', siteName: 'Recovery pilot', primaryLocale: 'en', locales: ['en'], environmentId: randomUUID(), environmentKind: 'staging' as const, environmentKey: 'default', principal: { id: principalId, issuer: 'urn:navocms:recovery', subject: 'owner', kind: 'human' as const, siteRole: 'owner' as const } };
            await bootstrapSite(sourceUrl, input);
            await bootstrapSite(sourceUrl, input);
            await provisionRuntimeRole(sourceUrl, process.env.NAVOCMS_RUNTIME_DATABASE_PASSWORD ?? 'navocms_ci_runtime_password_0123456789');
            const runtime = (url: string) => { const value = new URL(url); value.username = 'navocms_runtime'; value.password = process.env.NAVOCMS_RUNTIME_DATABASE_PASSWORD ?? 'navocms_ci_runtime_password_0123456789'; return new PostgresDatabase({ connectionString: value.toString(), maxConnections: 2 }); };
            source = runtime(sourceUrl);
            const editing = new PostgresEditingRepository(source);
            const service = new McpEditingService(editing, new PostgresEventStore(source), new PostgresIdempotencyStore(source) as IdempotencyStore, new PostgresReleaseWorkflowRepository(source), undefined, { environmentKey: "staging" });
            const created = await service.createDraft(context, { typeName: 'landing-page', slug: 'recovery-proof', locale: 'en', title: 'Recovery proof', markdown: '# Restore me\n\nKeep the [link](https://example.com).\n', idempotencyKey: 'recovery-draft-create-001' }) as any;
            const revision = await editing.getRevision({ site, principalId }, created.draft.revisionId);
            const saved = await service.applyPageChange(context, pageChangeSchema.parse({ revisionId: revision.id, baseSourceHash: revision.sourceHash, designOperations: [{ op: 'variant', elementId: `${revision.variantId}:body`, value: 'compact' }], idempotencyKey: 'recovery-design-save-001' })) as any;
            await service.addPageComment(context, { revisionId: saved.draft.revisionId, elementId: `${revision.variantId}:body`, field: 'body', text: 'Preserve this comment', idempotencyKey: 'recovery-comment-save-001' });
            const preview = await service.preparePreview(context, saved.draft.revisionId, 'recovery-preview-create-001');
            const mediaStorage = new LocalDeterministicMediaStorage();
            const mediaRepository = new PostgresMediaRepository(source, mediaStorage);
            const gateway = new MediaUploadGateway(source, mediaStorage, mediaRepository, { ...scope, principalKind: 'service' }, 'https://recovery.example.test');
            const media = new McpMediaService(mediaRepository, { storageInjected: true, uploadGateway: gateway });
            const bytes = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#123456' } }).png().toBuffer());
            const prepared = await media.prepare(context, { idempotencyKey: 'recovery-photo-upload-001', expectedSha256: createHash('sha256').update(bytes).digest('hex'), expectedSize: bytes.length, expectedMediaType: 'image/png', expiresAt: new Date(Date.now() + 60000).toISOString(), provenance: { kind: 'upload', receivedAt: new Date().toISOString() }, rights: { license: 'test', restricted: false } }) as any;
            const uploaded = await gateway.receive(prepared.uploadUrl.split('/').at(-1)!, bytes) as any;
            await mediaRepository.createReference({ ...scope, principalKind: 'human' }, { assetId: uploaded.assetId, ownerType: 'content.revision', ownerId: saved.draft.revisionId, purpose: 'hero', alt: 'Recovery photo', idempotencyKey: 'recovery-photo-reference-001' });
            const sourceStore: RecoveryStore = { read: (key, max) => mediaStorage.read(key.slice('navocms/v1/media/'.length), max), put: async () => { throw Error('Source store is read-only'); } };
            const started = Date.now();
            const bundle = await createRecovery({ url: sourceUrl, siteId, sourceCommit: 'a'.repeat(40), store: sourceStore });
            expect(bundle.objects.length).toBeGreaterThanOrEqual(4);
            await service.patchRevision(context,{revisionId:saved.draft.revisionId,baseSourceHash:saved.draft.sourceHash,operations:[],metadataPatch:{title:'Post-snapshot change'},idempotencyKey:'recovery-after-snapshot-001'});
            const simulatedFailureAt=Date.now();
            const encoded = encryptRecovery(bundle, 'b'.repeat(64));
            const decoded = decryptRecovery(encoded, 'b'.repeat(64));
            const restoredObjects = new Map<string, {
                bytes: Uint8Array;
                mediaType: string;
            }>();
            const targetStore: RecoveryStore = { read: async (key) => restoredObjects.get(key), put: async (key, bytes, mediaType) => { restoredObjects.set(key, { bytes, mediaType }); } };
            const result = await restoreRecovery({ url: targetUrl, bundle: decoded, siteId, store: targetStore });
            expect(result.status).toBe('restored-not-activated');
            expect(result.objects).toBe(bundle.objects.length);
            await expect(restoreRecovery({ url: targetUrl, bundle: decoded, siteId, store: targetStore })).rejects.toThrow('RESTORE_TARGET_NOT_EMPTY');
            await expect(restoreRecovery({ url: targetUrl, bundle: decoded, siteId: randomUUID(), store: targetStore })).rejects.toThrow('RESTORE_SCOPE');
            expect(await inspectInstallation(targetUrl, siteId)).toMatchObject({ status: 'ready' });
            target = runtime(targetUrl);
            expect(await target.ready()).toBe(true);
            const recovered = new McpEditingService(new PostgresEditingRepository(target), new PostgresEventStore(target), new PostgresIdempotencyStore(target) as IdempotencyStore, new PostgresReleaseWorkflowRepository(target), undefined, { environmentKey: "staging" });
            expect(await recovered.pageChangeStatus(context, saved.changeSet.id)).toMatchObject({ changeSet: { resultRevisionId: saved.draft.revisionId, status: 'saved' } });
            expect(await recovered.pageComments(context, saved.draft.revisionId)).toMatchObject({ comments: [{ text: 'Preserve this comment' }] });
            expect(await recovered.releaseConfirmationStatus(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash })).toMatchObject({ status: 'pending' });
            const evidence={recoveryRehearsal:true,objects:result.objects,tables:result.tables,rtoMs:result.elapsedMs,rehearsalMs:Date.now()-started,rpoMsAtSimulatedFailure:simulatedFailureAt-Date.parse(bundle.createdAt),snapshotAt:bundle.createdAt,source:'synthetic',activated:false,tableHashesMatched:true,objectHashesMatched:true};
            if(process.env.NAVOCMS_RECOVERY_EVIDENCE_PATH)await writeFile(process.env.NAVOCMS_RECOVERY_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(evidence));
            const check=new Client({connectionString:targetUrl});try{await check.connect();await check.query("UPDATE navocms.schema_migrations SET checksum=repeat('0',64) WHERE name='0019_page_design_editor.sql'");await expect(inspectInstallation(targetUrl,siteId)).rejects.toThrow('MIGRATION_INCOMPATIBLE');await expect(runMigrations(targetUrl)).rejects.toThrow('has changed');expect(await target.ready()).toBe(false);}finally{await check.end();}

        }
        finally {
            await source?.close();
            await target?.close();
            for (const name of names)
                await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
            await admin.end();
        }
    }, 180000);
});
