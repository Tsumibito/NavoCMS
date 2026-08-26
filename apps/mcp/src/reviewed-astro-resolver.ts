import { createDeployableArtifact, type DeployableArtifact, type ImmutableArtifactResolver } from "@navocms/delivery-cloudflare";
import { verifyAstroArtifact, verifyBuiltAstroOutput, type AstroArtifact } from "@navocms/design-astro";
import type { ReleaseArtifact } from "@navocms/kernel";

import { StagingRuntimeError } from "./staging-runtime.js";

export interface ReviewedAstroArtifactRecord {
  readonly tenantId: string;
  readonly siteId: string;
  readonly environment: "staging";
  readonly environmentKey: string;
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly releaseArtifactHash: string;
  readonly expectedAstroArtifactHash: string;
  readonly sourceCommitSha: string;
  readonly artifact: AstroArtifact;
  readonly output: Readonly<Record<string, string>>;
}

/** Read-only boundary: an implementation must return a reviewed immutable record, never render content. */
export interface ReviewedAstroArtifactStore {
  ready(): Promise<boolean>;
  get(scope: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string; releaseId: string }>): Promise<ReviewedAstroArtifactRecord | undefined>;
}

export class ReviewedAstroArtifactResolver implements ImmutableArtifactResolver {
  readonly #store: ReviewedAstroArtifactStore;
  readonly #scope: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string }>;

  public constructor(store: ReviewedAstroArtifactStore, scope: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string }>) {
    this.#store = store;
    this.#scope = Object.freeze({ ...scope });
  }

  /** Capability readiness is schema/scope based; a particular release is checked by resolve(). */
  public async ready(): Promise<boolean> {
    try {
      return await this.#store.ready();
    } catch {
      return false;
    }
  }

  public async resolve(input: Readonly<{ releaseId: string; releaseHash: string; releaseArtifact: ReleaseArtifact }>): Promise<DeployableArtifact> {
    if (!await this.ready()) {
      throw new StagingRuntimeError("REVIEWED_ASTRO_RESOLVER_UNAVAILABLE", "Reviewed Astro artifact resolver is not ready");
    }
    const record = await this.#store.get({ ...this.#scope, releaseId: input.releaseId });
    if (!record || record.tenantId !== this.#scope.tenantId || record.siteId !== this.#scope.siteId || record.environment !== this.#scope.environment || record.environmentKey !== this.#scope.environmentKey || record.releaseId !== input.releaseId || record.releaseHash !== input.releaseHash || record.releaseArtifactHash !== input.releaseArtifact.hash) {
      throw new StagingRuntimeError("REVIEWED_ASTRO_ARTIFACT_MISMATCH", "Reviewed Astro artifact does not match the staging release");
    }
    try {
      if (record.artifact.manifest.tenantId !== this.#scope.tenantId || record.artifact.manifest.siteId !== this.#scope.siteId) {
        throw new Error("artifact manifest scope mismatch");
      }
      verifyAstroArtifact(record.artifact, record.expectedAstroArtifactHash);
      verifyBuiltAstroOutput(record.output, record.artifact, record.expectedAstroArtifactHash);
      return createDeployableArtifact({
        releaseHash: input.releaseHash,
        releaseArtifact: input.releaseArtifact,
        sourceCommitSha: record.sourceCommitSha,
        astroArtifact: record.artifact,
        expectedAstroArtifactHash: record.expectedAstroArtifactHash,
        output: record.output
      });
    } catch {
      throw new StagingRuntimeError("REVIEWED_ASTRO_ARTIFACT_INVALID", "Reviewed Astro artifact verification failed");
    }
  }
}
