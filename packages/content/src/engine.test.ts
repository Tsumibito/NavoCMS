import { describe, expect, it } from "vitest";

import { ContentEngine } from "./engine.js";
import { editorialPack } from "./packs.js";

const scope = { tenantId: "tenant-one", siteId: "site-one" };
const foreignScope = { tenantId: "tenant-two", siteId: "site-two" };

function deterministicEngine(): ContentEngine {
  let id = 0;
  return new ContentEngine({
    id: () => `id-${++id}`,
    now: () => new Date("2026-08-21T12:00:00.000Z")
  });
}

describe("content revisions, relations, variants, and portability", () => {
  it("creates immutable revisions and rejects cross-site lookup", () => {
    const engine = deterministicEngine();
    engine.registerPack(scope, editorialPack);
    const created = engine.createDocument({
      ...scope,
      typeName: "article",
      slug: "agent-native-content",
      locale: "en",
      source: "# Agent-native content\n\nEdit me in Markdown.\n",
      metadata: { title: "Agent-native content" },
      provenance: { kind: "human", actorId: "editor-1" }
    });
    expect(Object.isFrozen(created.revision)).toBe(true);
    expect(() => engine.getRevision(foreignScope, created.revision.id)).toThrow(/does not exist in this site/);

    const target = created.revision.ast.nodes.find((node) => node.type === "text" && node.text === "Edit me in Markdown.");
    const changed = engine.patchRevision({
      ...scope,
      revisionId: created.revision.id,
      baseSourceHash: created.revision.sourceHash,
      operations: [{ op: "replaceText", nodeId: target!.id, value: "Edit me from any agent." }],
      provenance: { kind: "agent", actorId: "agent-1" }
    });
    expect(changed.revision.number).toBe(2);
    expect(changed.revision.parentRevisionId).toBe(created.revision.id);
    expect(engine.listRevisions(scope, created.variant.id)).toHaveLength(2);
  });

  it("fails closed when a patch is based on a revision that is no longer the variant head", () => {
    const engine = deterministicEngine();
    engine.registerPack(scope, editorialPack);
    const created = engine.createDocument({
      ...scope,
      typeName: "article",
      slug: "concurrent-edits",
      locale: "en",
      source: "# Concurrent edits\n\nFirst paragraph.\n\nSecond paragraph.\n",
      metadata: { title: "Concurrent edits" },
      provenance: { kind: "human", actorId: "editor-1" }
    });
    const textNodes = created.revision.ast.nodes.filter((node) => node.type === "text");
    const firstEdit = engine.patchRevision({
      ...scope,
      revisionId: created.revision.id,
      baseSourceHash: created.revision.sourceHash,
      operations: [{ op: "replaceText", nodeId: textNodes[0]!.id, value: "First edit." }],
      provenance: { kind: "agent", actorId: "agent-1" }
    });
    expect(firstEdit.revision.number).toBe(2);

    // A second edit that still targets the stale r1 base must not silently make
    // a r1-based revision the current head; it fails with the actual head.
    const staleError = (() => {
      try {
        engine.patchRevision({
          ...scope,
          revisionId: created.revision.id,
          baseSourceHash: created.revision.sourceHash,
          operations: [{ op: "replaceText", nodeId: textNodes[1]!.id, value: "Second edit." }],
          provenance: { kind: "agent", actorId: "agent-2" }
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect((staleError as { code?: string }).code).toBe("REVISION_NOT_CURRENT");
    expect((staleError as { details?: Record<string, unknown> }).details).toMatchObject({
      currentRevisionId: firstEdit.revision.id,
      currentRevisionNumber: 2,
      currentSourceHash: firstEdit.revision.sourceHash
    });
    expect(engine.listRevisions(scope, created.variant.id)).toHaveLength(2);

    // A rebased patch carries both edits forward in one head lineage.
    const rebased = engine.patchRevision({
      ...scope,
      revisionId: firstEdit.revision.id,
      baseSourceHash: firstEdit.revision.sourceHash,
      operations: [{ op: "replaceText", nodeId: textNodes[1]!.id, value: "Second edit." }],
      provenance: { kind: "agent", actorId: "agent-2" }
    });
    expect(rebased.revision.number).toBe(3);
    expect(rebased.revision.source).toContain("First edit.");
    expect(rebased.revision.source).toContain("Second edit.");
    expect(engine.listRevisions(scope, created.variant.id)).toHaveLength(3);
  });

  it("validates relations and round-trips a redacted portable bundle", () => {
    const engine = deterministicEngine();
    engine.registerPack(scope, editorialPack);
    const first = engine.createDocument({
      ...scope,
      typeName: "article",
      slug: "first-article",
      locale: "en",
      source: "# First\n",
      metadata: { title: "First" },
      provenance: { kind: "import", actorId: "importer" }
    });
    const second = engine.createDocument({
      ...scope,
      typeName: "article",
      slug: "second-article",
      locale: "en",
      source: "# Second\n",
      metadata: { title: "Second" },
      provenance: { kind: "human", actorId: "editor" }
    });
    engine.createVariant({
      ...scope,
      documentId: first.document.id,
      locale: "fr",
      source: "# Premier\n",
      metadata: { title: "Premier" },
      provenance: { kind: "human", actorId: "translator" }
    });
    engine.addRelation({
      ...scope,
      fromDocumentId: first.document.id,
      toDocumentId: second.document.id,
      kind: "related"
    });
    expect(() =>
      engine.addRelation({
        ...scope,
        fromDocumentId: first.document.id,
        toDocumentId: second.document.id,
        kind: "related",
        metadata: { access_token: "forbidden" }
      })
    ).toThrow(/Sensitive field rejected/);

    const bundle = engine.exportBundle(scope);
    expect(Object.keys(bundle.files)).toHaveLength(3);
    expect(JSON.stringify(bundle)).not.toContain("access_token");
    const restored = deterministicEngine();
    const firstPath = Object.keys(bundle.files)[0]!;
    const tampered = {
      ...bundle,
      files: { ...bundle.files, [firstPath]: `${bundle.files[firstPath]}tampered` }
    };
    expect(() => restored.importBundle(tampered, foreignScope)).toThrow(/integrity validation/);
    expect(restored.listDocuments(foreignScope)).toHaveLength(0);
    restored.importBundle(bundle, foreignScope);
    expect(restored.listDocuments(foreignScope)).toHaveLength(2);
    expect(restored.getRevision(foreignScope, first.revision.id).sourceHash).toBe(first.revision.sourceHash);
  });
});
