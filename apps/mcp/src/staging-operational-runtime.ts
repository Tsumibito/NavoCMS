import type { AstroRenderInput } from "@navocms/design-astro";
import type { ContentRevision } from "@navocms/content";
import type { PostgresDatabase } from "@navocms/persistence-postgres";

import type { McpRequestContext } from "./model.js";
import { PostgresReviewedAstroArtifactStore } from "./postgres-reviewed-astro-artifact-store.js";
import { PostgresReviewedAstroBuildInputStore } from "./postgres-reviewed-astro-build-input-store.js";
import type { RepositoryContext } from "./repository.js";
import type { StoredRelease } from "./release-repository.js";
import type { StagingAstroOperations } from "./service.js";
import { STAGING_ASTRO_POLICY_DIGEST, StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";
import { ImageAttestedAstroBuildRunner, TrustedAstroBuilder, type TrustedAstroBuildRunner } from "./trusted-astro-builder.js";

/**
 * Private runtime composition for staging. Its methods are injected into the
 * service only; mcp.ts has no corresponding tool. Stores are created with the
 * authenticated request principal for mutations, while the delivery resolver
 * remains service-scoped and read-only.
 */
export class StagingOperationalRuntime implements StagingAstroOperations {
  readonly #database: PostgresDatabase;
  readonly #environmentKey: string;
  readonly #runner: TrustedAstroBuildRunner;
  readonly #readinessContext: RepositoryContext;
  readonly #preparer = new StagingAstroPreviewPreparer();
  #runnerReadiness: Promise<boolean> | undefined;

  public constructor(input: Readonly<{ database: PostgresDatabase; environmentKey: string; reviewedSourceCommit: string; toolchainDirectory: string; readinessContext: RepositoryContext; runner?: TrustedAstroBuildRunner }>) {
    this.#database = input.database;
    this.#environmentKey = input.environmentKey;
    this.#readinessContext = input.readinessContext;
    this.#runner = input.runner ?? new ImageAttestedAstroBuildRunner({ sourceCommitSha: input.reviewedSourceCommit, toolchainDirectory: input.toolchainDirectory });
  }

  public async ready(): Promise<boolean> {
    if (!await new PostgresReviewedAstroBuildInputStore(this.#database, this.#readinessContext, this.#environmentKey).ready()) return false;
    this.#runnerReadiness ??= this.#runner.attest().then(() => true, () => false);
    return this.#runnerReadiness;
  }

  public policyDigest(): string { return STAGING_ASTRO_POLICY_DIGEST; }

  public prepare(site: RepositoryContext["site"], revision: ContentRevision): AstroRenderInput {
    return this.#preparer.prepare(site, revision);
  }

  public async persistPreviewInput(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease, render: AstroRenderInput): Promise<void> {
    await new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey).register(context, {
      idempotencyKey: `astro-input:${release.releaseHash}`,
      releaseId: release.id,
      releaseHash: release.releaseHash,
      releaseArtifactHash: release.artifactHash,
      render
    });
  }

  public async ensureArtifact(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease): Promise<void> {
    const artifacts = new PostgresReviewedAstroArtifactStore(this.#database, repository, this.#environmentKey);
    const existing = await artifacts.get({ tenantId: repository.site.tenantId, siteId: repository.site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId: release.id });
    if (existing) {
      if (existing.releaseHash !== release.releaseHash || existing.releaseArtifactHash !== release.artifactHash) throw new Error("REVIEWED_ASTRO_ARTIFACT_DRIFT");
      return;
    }
    const inputs = new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey);
    const builder = new TrustedAstroBuilder({ inputs, registrations: artifacts, context: repository, environmentKey: this.#environmentKey, runner: this.#runner });
    await builder.buildAndRegister(context, {
      releaseId: release.id,
      releaseHash: release.releaseHash,
      releaseArtifactHash: release.artifactHash,
      idempotencyKey: `astro-build:${release.releaseHash}`
    });
  }
}
