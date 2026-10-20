import {randomUUID} from "node:crypto";
import{afterAll,describe,it,expect}from"vitest";
import{bootstrapSite,PostgresDatabase,PostgresEventStore,PostgresIdempotencyStore}from"@navocms/persistence-postgres";
import{NAVOCMS_PERMISSIONS}from"@navocms/security";
import{PostgresEditingRepository}from"./postgres-repository.js";
import{McpEditingService,type IdempotencyStore}from"./service.js";
import{pageChangeSchema}from"./page-editing.js";
const url=process.env.NAVOCMS_INTEGRATION_DATABASE_URL;const database=url?new PostgresDatabase({connectionString:url,applicationName:"navocms-design-test",maxConnections:4}):undefined;
afterAll(async()=>database?.close());
describe.skipIf(!url)("durable page design",()=>{
 it("persists changes/comments after restart, rejects concurrent heads, and atomically rolls back audit failures",async()=>{
 const tenantId="a2af348f-58b8-4efe-b873-8bd032ecbc5c",siteId=randomUUID(),principalId="016ef382-bf28-406b-9321-1fc580b6ea00";
 await bootstrapSite(process.env.NAVOCMS_INTEGRATION_ADMIN_DATABASE_URL!,{tenantId,tenantSlug:"sprint-seven",tenantName:"Integration",siteId,siteSlug:`design-${siteId}`,siteName:"Design pilot",primaryLocale:"en",locales:["en"],environmentId:randomUUID(),environmentKind:"staging",environmentKey:"default",principal:{id:principalId,issuer:"urn:navocms:integration",subject:"sprint-6",kind:"human",siteRole:"owner"}});
 const scope={tenantId,siteId,principalId};const site={tenantId,siteId,name:"Design pilot",primaryLocale:"en",locales:["en"]};const context={authorization:{tenantId,siteId,principal:{id:principalId,kind:"human" as const,issuer:"urn:navocms:integration",subject:"sprint-6"},layers:[{name:"principal" as const,permissions:NAVOCMS_PERMISSIONS}]}};
 const repo=new PostgresEditingRepository(database!);const events=new PostgresEventStore(database!);const service=()=>new McpEditingService(repo,events,new PostgresIdempotencyStore(database!)as IdempotencyStore,undefined,undefined,{},database!);
 const first=service();const created=await first.createDraft(context,{typeName:"landing-page",slug:"design-durable",locale:"en",title:"Design",markdown:"# Design\n\nOriginal text.\n",idempotencyKey:"design-durable-create-001"})as any;
 const base=await repo.getRevision({site,principalId},created.draft.revisionId);const body=`${base.variantId}:body`,media=`${base.variantId}:media`;
 const input=pageChangeSchema.parse({revisionId:base.id,baseSourceHash:base.sourceHash,designOperations:[{op:"variant",elementId:body,value:"compact"},{op:"move",elementId:media,value:body}],metadataPatch:{title:"Compact page"},idempotencyKey:"design-durable-save-001"});const saved=await first.applyPageChange(context,input)as any;
 expect(await service().applyPageChange(context,input)).toEqual(saved);expect(await service().pageChangeStatus(context,saved.changeSet.id)).toMatchObject({changeSet:{status:"saved",before:{fields:{title:"Design"}},after:{fields:{title:"Compact page"}}}});
 const revision=await repo.getRevision({site,principalId},saved.draft.revisionId);expect(revision.composition?.sections.map(s=>s.id)).toEqual([media,body]);expect(revision.provenance.kind).toBe("human");expect(base.composition).toBeUndefined();
 await first.addPageComment(context,{revisionId:revision.id,elementId:media,field:"media",text:"Review image position",viewport:{width:375,height:900},idempotencyKey:"design-durable-comment-001"});
 const concurrent=(key:string)=>service().applyPageChange(context,pageChangeSchema.parse({revisionId:revision.id,baseSourceHash:revision.sourceHash,designOperations:[{op:"remove",elementId:media}],idempotencyKey:key}));const results=await Promise.allSettled([concurrent("design-concurrent-save-001"),concurrent("design-concurrent-save-002")]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"REVISION_NOT_CURRENT"}});const winning=results.find(r=>r.status==="fulfilled")as PromiseFulfilledResult<any>;
 expect(await service().pageComments(context,winning.value.draft.revisionId)).toMatchObject({comments:[{elementId:media,field:"media",status:"orphaned",revisionId:revision.id}]});
 const head=await repo.getRevision({site,principalId},winning.value.draft.revisionId);const failing=new McpEditingService(repo,{append:async event=>{const record=await events.append(event);if(event.type==="io.navocms.page.change-recorded.v1")throw Error("Injected design audit failure");return record;},query:q=>events.query(q)},new PostgresIdempotencyStore(database!)as IdempotencyStore,undefined,undefined,{},database!);
 const count=()=>database!.withScope(scope,async client=>(await client.query<{n:string}>("SELECT count(*)::text AS n FROM navocms.content_revisions WHERE tenant_id=$1 AND site_id=$2",[tenantId,siteId])).rows[0]!.n);const before=await count();await expect(failing.applyPageChange(context,pageChangeSchema.parse({revisionId:head.id,baseSourceHash:head.sourceHash,metadataPatch:{title:"Must roll back"},idempotencyKey:"design-audit-failure-001"}))).rejects.toThrow("Injected design audit failure");expect(await count()).toBe(before);expect((await repo.findDocument({site,principalId},head.documentId))?.revisionId).toBe(head.id);
 const foreign={...context,authorization:{...context.authorization,siteId:randomUUID()}};await expect(service().pageChangeStatus(foreign,saved.changeSet.id)).rejects.toThrow();
 },180_000);
});
