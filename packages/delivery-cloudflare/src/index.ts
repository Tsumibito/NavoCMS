import {
  DomainEventFactory,
  sha256,
  type EventFactoryContext,
  type EventStore,
  type ReleaseArtifact,
  type ReleaseProvider,
  type ReleaseProviderPublication,
  type ReleaseProviderPublishInput
} from "@navocms/kernel";
import {
  verifyAstroArtifact,
  verifyBuiltAstroOutput,
  type AstroArtifact
} from "@navocms/design-astro";

export * from "./cloudflare-pages-http.js";
export * from "./coolify-http.js";

/** Bounds remote provider input and operational telemetry; no credential is ever accepted here. */
export const CLOUDFLARE_DELIVERY_LIMITS = Object.freeze({
  attempts: 3,
  // A maximum v1 manifest serializes to 419,838 bytes in its provider envelope
  // (512 distinct 512-byte paths, hashes and byte sizes). 448 KiB leaves a
  // measured safety margin while preserving the independently verifiable file
  // manifest; see the maximum-shape adversarial test.
  providerReferenceBytes: 448 * 1024,
  identifierBytes: 160,
  outputFiles: 512,
  outputBytes: 8 * 1024 * 1024
});

export const CLOUDFLARE_CACHE_CONTROL = Object.freeze({
  preview: "private, no-store",
  production: "public, max-age=300, must-revalidate"
});

const PROVIDER_KEY = "navocms.cloudflare-pages.v1";
const REFERENCE_SCHEMA = "io.navocms.cloudflare-artifact-reference.v1" as const;
const REFERENCE_FORMAT = "navocms-cloudflare-pages/v1" as const;

export class CloudflareDeliveryError extends Error {
  public readonly code: string;
  public readonly httpStatus?: number;

  public constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "CloudflareDeliveryError";
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

/**
 * The immutable binding passed between the renderer, release workflow, Pages, and Coolify.
 * Hashes are carried, never credentials, API tokens, transport headers, or provider URLs.
 */
export interface ImmutableArtifactReference {
  readonly schema: typeof REFERENCE_SCHEMA;
  readonly releaseHash: string;
  readonly releaseArtifactHash: string;
  readonly astroArtifactHash: string;
  readonly outputHash: string;
  readonly routeDigest: string;
  readonly sourceCommitSha: string;
  readonly fileCount: number;
  readonly byteSize: number;
  /** Sorted immutable file manifest used to prove the bytes served by Pages. */
  readonly files: readonly ImmutableArtifactFile[];
}

export interface ImmutableArtifactFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface DeployableArtifact {
  readonly reference: ImmutableArtifactReference;
  readonly files: Readonly<Record<string, string>>;
}

/** A resolver is the explicit bridge from the existing release record to a verified Astro bundle. */
export interface ImmutableArtifactResolver {
  resolve(input: Readonly<{
    releaseId: string;
    releaseHash: string;
    releaseArtifact: ReleaseArtifact;
  }>): Promise<DeployableArtifact>;
}

export interface CloudflareDeployment {
  readonly id: string;
  readonly projectKey: string;
  readonly referenceHash: string;
  readonly environment: "preview" | "production";
  readonly status: "queued" | "building" | "success" | "failure" | "canceled";
}

export interface CloudflareLiveProbe {
  readonly status: number;
  readonly referenceHash?: string;
  readonly releaseHash?: string;
  readonly outputHash?: string;
  readonly cacheControl?: string;
  readonly files?: readonly ImmutableArtifactFile[];
}

/**
 * Direct-upload transport boundary. A concrete client owns API credentials outside this package;
 * all calls are bound to an immutable reference and are idempotently discoverable before creation.
 */
export interface CloudflarePagesTransport {
  findDeployment(input: Readonly<{ projectKey: string; referenceHash: string; environment: "preview" | "production" }>): Promise<CloudflareDeployment | undefined>;
  createPreview(input: Readonly<{
    projectKey: string;
    previewBranch: string;
    reference: ImmutableArtifactReference;
    referenceHash: string;
    files: Readonly<Record<string, string>>;
  }>): Promise<CloudflareDeployment>;
  deployProduction(input: Readonly<{
    projectKey: string;
    productionBranch: string;
    reference: ImmutableArtifactReference;
    referenceHash: string;
    files: Readonly<Record<string, string>>;
  }>): Promise<CloudflareDeployment>;
  retryDeployment(input: Readonly<{ projectKey: string; deploymentId: string; referenceHash: string; environment: "preview" | "production" }>): Promise<CloudflareDeployment>;
  inspectDeployment(input: Readonly<{ projectKey: string; deploymentId: string }>): Promise<CloudflareDeployment | undefined>;
  verifyLive(input: Readonly<{
    projectKey: string;
    deploymentId: string;
    referenceHash: string;
    environment: "preview" | "production";
    reference: ImmutableArtifactReference;
  }>): Promise<CloudflareLiveProbe>;
  rollback(input: Readonly<{
    projectKey: string;
    currentDeploymentId: string;
    targetDeploymentId: string;
    currentEnvironment: "production";
    targetEnvironment: "production";
    operationKey: string;
  }>): Promise<void>;
}

export interface CoolifyPromotion {
  readonly id: string;
  readonly applicationKey: string;
  readonly sourceCommitSha: string;
  readonly referenceHash: string;
  readonly status: "queued" | "running" | "finished" | "failed";
}

/**
 * Coolify does not become a source of truth: it is asked to promote the commit already pinned by
 * the immutable artifact reference, and can be queried by that same operation identity on retry.
 */
export interface CoolifyCommitTransport {
  findPromotion(input: Readonly<{
    applicationKey: string;
    sourceCommitSha: string;
    referenceHash: string;
  }>): Promise<CoolifyPromotion | undefined>;
  promoteCommit(input: Readonly<{
    applicationKey: string;
    sourceCommitSha: string;
    referenceHash: string;
    operationKey: string;
  }>): Promise<CoolifyPromotion>;
  retryPromotion(input: Readonly<{
    applicationKey: string;
    sourceCommitSha: string;
    referenceHash: string;
    operationKey: string;
  }>): Promise<CoolifyPromotion>;
  inspectPromotion(input: Readonly<{ applicationKey: string; promotionId: string; referenceHash: string }>): Promise<CoolifyPromotion | undefined>;
  rollback(input: Readonly<{
    applicationKey: string;
    currentPromotionId: string;
    targetPromotionId: string;
    targetCommitSha: string;
    referenceHash: string;
    operationKey: string;
  }>): Promise<CoolifyPromotion>;
}

export interface DeliveryTelemetryRecord {
  readonly provider: "cloudflare-pages" | "coolify";
  readonly operation: "discover" | "preview" | "verify" | "promote" | "rollback";
  readonly outcome: "attempt" | "retry" | "success" | "failure";
  readonly attempt: number;
  readonly releaseHash: string;
  readonly artifactHash: string;
  readonly referenceHash: string;
  readonly httpStatus?: number;
  readonly errorCode?: string;
}

export interface DeliveryTelemetry {
  record(record: DeliveryTelemetryRecord): Promise<void>;
}

/**
 * Durable phase journal supplied by the existing release-workflow persistence.
 * Reserving precedes an external effect; an unresolved reservation is fail-closed
 * rather than replaying a potentially successful provider request.
 */
export interface DeliveryPhaseStore {
  reserve(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<"new" | "reserved" | "completed">;
  complete(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; externalId: string }>): Promise<void>;
  externalId(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<string | undefined>;
  /**
   * A human operator may record a bounded, auditable candidate after an
   * uncertain provider call. It is not completion: the provider must inspect
   * the candidate against the immutable binding before it completes the phase.
   */
  resolve(input: Readonly<{
    releaseId: string;
    referenceHash: string;
    phase: string;
    externalId: string;
    evidenceHash: string;
    observedAt: string;
  }>): Promise<void>;
  /**
   * Records independently collected proof that the numbered reservation did
   * not reach the provider.  A store may permit exactly one second attempt;
   * it must never erase the original reservation.
   */
  notApplied(input: Readonly<{
    releaseId: string;
    referenceHash: string;
    phase: string;
    evidenceHash: string;
    observedAt: string;
  }>): Promise<void>;
  attempt(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<1 | 2>;
  resolution(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<DeliveryPhaseResolution | undefined>;
}

export interface DeliveryPhaseResolution {
  readonly externalId: string;
  readonly actor: Readonly<{ kind: "human"; id: string }>;
  readonly evidenceHash: string;
  readonly observedAt: string;
}

export class InMemoryDeliveryPhaseStore implements DeliveryPhaseStore {
  readonly #entries = new Map<string, { readonly attempt: 1 | 2; readonly externalId?: string; readonly resolutions: readonly DeliveryPhaseResolution[]; readonly notApplied?: Readonly<{ evidenceHash: string; observedAt: string }> }>();
  public async reserve(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<"new" | "reserved" | "completed"> {
    const key = phaseKey(input);
    const current = this.#entries.get(key);
    if (current?.externalId) return "completed";
    if (current?.notApplied && current.attempt === 1) {
      this.#entries.set(key, Object.freeze({ attempt: 2, resolutions: current.resolutions }));
      return "new";
    }
    if (current) return "reserved";
    this.#entries.set(key, Object.freeze({ attempt: 1, resolutions: Object.freeze([]) }));
    return "new";
  }
  public async complete(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; externalId: string }>): Promise<void> {
    const key = phaseKey(input); const current = this.#entries.get(key);
    if (current?.externalId && current.externalId !== input.externalId) throw new CloudflareDeliveryError("DELIVERY_PHASE_CONFLICT", "Provider phase already has another external identifier");
    this.#entries.set(key, Object.freeze({ attempt: current?.attempt ?? 1, externalId: input.externalId, resolutions: current?.resolutions ?? Object.freeze([]), ...(current?.notApplied ? { notApplied: current.notApplied } : {}) }));
  }
  public async externalId(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<string | undefined> { return this.#entries.get(phaseKey(input))?.externalId; }
  public async resolve(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; externalId: string; evidenceHash: string; observedAt: string }>): Promise<void> {
    const resolution = assertHumanResolution({ ...input, actor: { kind: "human", id: "in-memory-operator" } });
    const key = phaseKey(input); const current = this.#entries.get(key);
    if (!current) throw new CloudflareDeliveryError("DELIVERY_PHASE_MISSING", "Cannot resolve a phase that was not reserved");
    if (current.externalId) return;
    this.#entries.set(key, Object.freeze({ ...current, resolutions: Object.freeze([...current.resolutions, resolution]) }));
  }
  public async resolution(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<DeliveryPhaseResolution | undefined> {
    return this.#entries.get(phaseKey(input))?.resolutions.at(-1);
  }
  public async notApplied(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; evidenceHash: string; observedAt: string }>): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.evidenceHash) || !Number.isFinite(Date.parse(input.observedAt))) throw new CloudflareDeliveryError("DELIVERY_PHASE_RESOLUTION_INVALID", "Not-applied evidence is invalid");
    const key = phaseKey(input); const current = this.#entries.get(key);
    if (!current || current.externalId || current.attempt !== 1) throw new CloudflareDeliveryError("DELIVERY_PHASE_NOT_APPLIED_INVALID", "Only the first unresolved reservation may be retried");
    if (current.notApplied && (current.notApplied.evidenceHash !== input.evidenceHash || current.notApplied.observedAt !== input.observedAt)) throw new CloudflareDeliveryError("DELIVERY_PHASE_CONFLICT", "Not-applied evidence conflicts with the existing record");
    this.#entries.set(key, Object.freeze({ ...current, notApplied: Object.freeze({ evidenceHash: input.evidenceHash, observedAt: input.observedAt }) }));
  }
  public async attempt(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<1 | 2> { return this.#entries.get(phaseKey(input))?.attempt ?? 1; }
}

export class InMemoryDeliveryTelemetry implements DeliveryTelemetry {
  readonly records: DeliveryTelemetryRecord[] = [];

  public async record(record: DeliveryTelemetryRecord): Promise<void> {
    this.records.push(Object.freeze({ ...record }));
  }
}

/** Optional bridge to the existing Event Ledger; it does not introduce a telemetry database. */
export class EventLedgerDeliveryTelemetry implements DeliveryTelemetry {
  readonly #events: EventStore;
  readonly #factory: DomainEventFactory;

  public constructor(events: EventStore, context: Readonly<{
    source: string;
    tenantId: string;
    siteId: string;
    correlationId: string;
    actor: EventFactoryContext["actor"];
  }>) {
    this.#events = events;
    this.#factory = new DomainEventFactory(context);
  }

  public async record(record: DeliveryTelemetryRecord): Promise<void> {
    await this.#events.append(this.#factory.create({
      type: "io.navocms.delivery.provider.attempt.v1",
      subject: record.referenceHash,
      consequence: "G0",
      data: Object.freeze({
        provider: record.provider,
        operation: record.operation,
        outcome: record.outcome,
        attempt: record.attempt,
        releaseHash: record.releaseHash,
        artifactHash: record.artifactHash,
        referenceHash: record.referenceHash,
        ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
        ...(record.errorCode ? { errorCode: record.errorCode } : {})
      })
    }));
  }
}

export interface CloudflarePagesReleaseProviderOptions {
  readonly projectKey: string;
  readonly previewBranch: string;
  readonly productionBranch: string;
  readonly coolifyApplicationKey: string;
  readonly resolver: ImmutableArtifactResolver;
  readonly cloudflare: CloudflarePagesTransport;
  readonly coolify: CoolifyCommitTransport;
  readonly phases: DeliveryPhaseStore;
  readonly telemetry?: DeliveryTelemetry;
  readonly attempts?: number;
}

interface ProviderReferenceV1 {
  readonly schema: typeof REFERENCE_SCHEMA;
  readonly format: typeof REFERENCE_FORMAT;
  readonly projectKey: string;
  readonly releaseId: string;
  readonly previewDeploymentId: string;
  readonly productionDeploymentId: string;
  readonly coolifyApplicationKey: string;
  readonly coolifyPromotionId: string;
  readonly reference: ImmutableArtifactReference;
  readonly referenceHash: string;
}

/**
 * Provider implementation for the existing ReleaseProvider workflow. It is deliberately dormant
 * until a host injects both real transports and an immutable Astro artifact resolver.
 */
export class CloudflarePagesReleaseProvider implements ReleaseProvider {
  public readonly key = PROVIDER_KEY;
  readonly #options: Required<Pick<CloudflarePagesReleaseProviderOptions, "projectKey" | "previewBranch" | "productionBranch" | "coolifyApplicationKey">> & CloudflarePagesReleaseProviderOptions;
  readonly #telemetry: DeliveryTelemetry;
  readonly #attempts: number;

  public constructor(options: CloudflarePagesReleaseProviderOptions) {
    if (!safeIdentifier(options.projectKey) || !safeIdentifier(options.previewBranch) || !safeIdentifier(options.productionBranch) || !safeIdentifier(options.coolifyApplicationKey) || options.previewBranch === options.productionBranch) {
      throw new CloudflareDeliveryError("DELIVERY_CONFIG_INVALID", "Cloudflare delivery identifiers are invalid");
    }
    this.#options = Object.freeze({ ...options });
    this.#telemetry = options.telemetry ?? { record: async () => undefined };
    this.#attempts = boundedAttempts(options.attempts);
  }

  public async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
    assertReleaseInput(input);
    const deployable = await this.#options.resolver.resolve({
      releaseId: input.releaseId,
      releaseHash: input.releaseHash,
      releaseArtifact: input.artifact
    });
    assertDeployable(deployable, input);
    const referenceHash = immutableReferenceHash(deployable.reference);
    const found = await this.#call("cloudflare-pages", "discover", input, referenceHash, () => (
      this.#options.cloudflare.findDeployment({ projectKey: this.#options.projectKey, referenceHash, environment: "preview" })
    ));
    const preview = found ? await this.#resumeDeployment(found, "preview", input, referenceHash) : await this.#call("cloudflare-pages", "preview", input, referenceHash, () => (
      this.#options.cloudflare.createPreview({
        projectKey: this.#options.projectKey,
        previewBranch: this.#options.previewBranch,
        reference: deployable.reference,
        referenceHash,
        files: deployable.files
      })
    ));
    assertCloudflareDeployment(preview, this.#options.projectKey, referenceHash, "preview");
    const existingProduction = await this.#call("cloudflare-pages", "discover", input, referenceHash, () => (
      this.#options.cloudflare.findDeployment({ projectKey: this.#options.projectKey, referenceHash, environment: "production" })
    ));
    const production = existingProduction ? await this.#resumeDeployment(existingProduction, "production", input, referenceHash) : await this.#call("cloudflare-pages", "preview", input, referenceHash, () => (
      this.#options.cloudflare.deployProduction({
        projectKey: this.#options.projectKey,
        productionBranch: this.#options.productionBranch,
        reference: deployable.reference,
        referenceHash,
        files: deployable.files
      })
    ));
    assertCloudflareDeployment(production, this.#options.projectKey, referenceHash, "production");

    const coolifyPhase = "publish.coolify";
    const promotionState = await this.#options.phases.reserve({ releaseId: input.releaseId, referenceHash, phase: coolifyPhase });
    let promotion: CoolifyPromotion;
    if (promotionState === "completed") {
      const promotionId = await this.#options.phases.externalId({ releaseId: input.releaseId, referenceHash, phase: coolifyPhase });
      if (!promotionId) throw new CloudflareDeliveryError("DELIVERY_PHASE_INVALID", "Completed Coolify phase has no durable deployment identifier");
      const found = await this.#call("coolify", "discover", input, referenceHash, () => this.#options.coolify.inspectPromotion({ applicationKey: this.#options.coolifyApplicationKey, promotionId, referenceHash }));
      if (!found) throw new CloudflareDeliveryError("DELIVERY_PHASE_EFFECT_MISSING", "Recorded Coolify deployment no longer exists");
      promotion = found;
    } else {
      if (promotionState === "reserved") {
        promotion = await this.#recoverCoolifyPhase({ releaseId: input.releaseId, referenceHash, phase: coolifyPhase }, input, deployable.reference.sourceCommitSha);
      } else {
        const attempt = await this.#options.phases.attempt({ releaseId: input.releaseId, referenceHash, phase: coolifyPhase });
        promotion = await this.#call("coolify", "promote", input, referenceHash, () => this.#options.coolify.promoteCommit({
          applicationKey: this.#options.coolifyApplicationKey,
          sourceCommitSha: deployable.reference.sourceCommitSha,
          referenceHash,
          operationKey: operationKey("promote", input.releaseHash, referenceHash, attempt)
        }));
        await this.#options.phases.complete({ releaseId: input.releaseId, referenceHash, phase: coolifyPhase, externalId: promotion.id });
      }
    }
    assertCoolifyPromotion(promotion, this.#options.coolifyApplicationKey, deployable.reference.sourceCommitSha, referenceHash);
    const reference = Object.freeze({
      schema: REFERENCE_SCHEMA,
      format: REFERENCE_FORMAT,
      projectKey: this.#options.projectKey,
      releaseId: input.releaseId,
      previewDeploymentId: preview.id,
      productionDeploymentId: production.id,
      coolifyApplicationKey: this.#options.coolifyApplicationKey,
      coolifyPromotionId: promotion.id,
      reference: deployable.reference,
      referenceHash
    });
    return Object.freeze({ providerKey: this.key, providerReference: encodeProviderReference(reference), artifactHash: input.artifact.hash });
  }

  public async verify(publication: ReleaseProviderPublication): Promise<boolean> {
    let reference: ProviderReferenceV1;
    try { reference = decodeProviderReference(publication, this.key); } catch { return false; }
    const releaseInput = { releaseHash: reference.reference.releaseHash, artifact: { hash: publication.artifactHash } };
    try {
      const deployment = await this.#call("cloudflare-pages", "verify", releaseInput, reference.referenceHash, () => (
        this.#options.cloudflare.inspectDeployment({ projectKey: reference.projectKey, deploymentId: reference.productionDeploymentId })
      ));
      if (!deployment || deployment.status !== "success") return false;
      assertCloudflareDeployment(deployment, reference.projectKey, reference.referenceHash, "production");
      const probe = await this.#call("cloudflare-pages", "verify", releaseInput, reference.referenceHash, () => (
        this.#options.cloudflare.verifyLive({ projectKey: reference.projectKey, deploymentId: reference.productionDeploymentId, referenceHash: reference.referenceHash, environment: "production", reference: reference.reference }).then((value) => {
          if (value.status === 502) throw new CloudflareDeliveryError("CLOUDFLARE_HTTP_502", "Cloudflare verification received a transient response", 502);
          return value;
        })
      ));
      if (probe.status !== 200 || probe.referenceHash !== reference.referenceHash || probe.releaseHash !== reference.reference.releaseHash || probe.outputHash !== reference.reference.outputHash || probe.cacheControl !== CLOUDFLARE_CACHE_CONTROL.production || !sameFileManifest(probe.files, reference.reference.files)) return false;
      const promotion = await this.#call("coolify", "verify", releaseInput, reference.referenceHash, () => (
        this.#options.coolify.inspectPromotion({ applicationKey: reference.coolifyApplicationKey, promotionId: reference.coolifyPromotionId, referenceHash: reference.referenceHash })
      ));
      return Boolean(promotion && promotion.status === "finished" && promotion.applicationKey === reference.coolifyApplicationKey && promotion.sourceCommitSha === reference.reference.sourceCommitSha && promotion.referenceHash === reference.referenceHash);
    } catch (error) {
      if (error instanceof CloudflareDeliveryError && error.httpStatus === 502) return false;
      throw error;
    }
  }

  public async rollback(current: ReleaseProviderPublication, target: ReleaseProviderPublication): Promise<void> {
    const currentReference = decodeProviderReference(current, this.key);
    const targetReference = decodeProviderReference(target, this.key);
    if (currentReference.projectKey !== targetReference.projectKey || currentReference.coolifyApplicationKey !== targetReference.coolifyApplicationKey) {
      throw new CloudflareDeliveryError("ROLLBACK_PROVIDER_MISMATCH", "Rollback target belongs to another delivery binding");
    }
    const input = { releaseHash: currentReference.reference.releaseHash, artifact: { hash: current.artifactHash } };
    const rollbackScope = currentReference.releaseId;
    const cloudflarePhase = "rollback.cloudflare";
    const cloudflareState = await this.#options.phases.reserve({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: cloudflarePhase });
    if (cloudflareState === "new") {
      const attempt = await this.#options.phases.attempt({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: cloudflarePhase });
      await this.#call("cloudflare-pages", "rollback", input, currentReference.referenceHash, () => (
        this.#options.cloudflare.rollback({
        projectKey: currentReference.projectKey,
        currentDeploymentId: currentReference.productionDeploymentId,
        targetDeploymentId: targetReference.productionDeploymentId,
        currentEnvironment: "production",
        targetEnvironment: "production",
        operationKey: operationKey("rollback", currentReference.referenceHash, targetReference.referenceHash, attempt)
        })
      ));
      await this.#options.phases.complete({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: cloudflarePhase, externalId: targetReference.productionDeploymentId });
    } else if (cloudflareState === "reserved") {
      // verifyLive uses the authoritative Pages canonical_deployment and its
      // immutable marker-bound bytes; success proves the uncertain rollback.
      await this.#verifyRollbackTarget(targetReference, input);
      await this.#options.phases.complete({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: cloudflarePhase, externalId: targetReference.productionDeploymentId });
    }
    const coolifyPhase = "rollback.coolify";
    const coolifyState = await this.#options.phases.reserve({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: coolifyPhase });
    let rollbackPromotion: CoolifyPromotion;
    if (coolifyState === "completed") {
      const promotionId = await this.#options.phases.externalId({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: coolifyPhase });
      if (!promotionId) throw new CloudflareDeliveryError("DELIVERY_PHASE_INVALID", "Completed Coolify rollback phase has no durable deployment identifier");
      const found = await this.#call("coolify", "discover", input, targetReference.referenceHash, () => this.#options.coolify.inspectPromotion({ applicationKey: targetReference.coolifyApplicationKey, promotionId, referenceHash: targetReference.referenceHash }));
      if (!found) throw new CloudflareDeliveryError("DELIVERY_PHASE_EFFECT_MISSING", "Recorded Coolify rollback deployment no longer exists");
      rollbackPromotion = found;
    } else {
      if (coolifyState === "reserved") {
        rollbackPromotion = await this.#recoverCoolifyPhase({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: coolifyPhase }, input, targetReference.reference.sourceCommitSha);
      } else {
        const attempt = await this.#options.phases.attempt({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: coolifyPhase });
        rollbackPromotion = await this.#call("coolify", "rollback", input, currentReference.referenceHash, () => (
          this.#options.coolify.rollback({
          applicationKey: currentReference.coolifyApplicationKey,
          currentPromotionId: currentReference.coolifyPromotionId,
          targetPromotionId: targetReference.coolifyPromotionId,
          targetCommitSha: targetReference.reference.sourceCommitSha,
          referenceHash: targetReference.referenceHash,
          operationKey: operationKey("rollback", currentReference.referenceHash, targetReference.referenceHash, attempt)
          })
        ));
        await this.#options.phases.complete({ releaseId: rollbackScope, referenceHash: targetReference.referenceHash, phase: coolifyPhase, externalId: rollbackPromotion.id });
      }
    }
    await this.#verifyRollbackTarget(targetReference, input);
    assertCoolifyPromotion(rollbackPromotion, targetReference.coolifyApplicationKey, targetReference.reference.sourceCommitSha, targetReference.referenceHash);
    const targetPromotion = await this.#call("coolify", "verify", input, targetReference.referenceHash, () => this.#options.coolify.inspectPromotion({ applicationKey: targetReference.coolifyApplicationKey, promotionId: rollbackPromotion.id, referenceHash: targetReference.referenceHash }));
    if (!targetPromotion || targetPromotion.status !== "finished" || targetPromotion.sourceCommitSha !== targetReference.reference.sourceCommitSha || targetPromotion.referenceHash !== targetReference.referenceHash) throw new CloudflareDeliveryError("ROLLBACK_TARGET_VERIFICATION_FAILED", "Rollback target Coolify promotion has not finished");
  }

  async #recoverCoolifyPhase(phase: Readonly<{ releaseId: string; referenceHash: string; phase: string }>, input: Readonly<{ releaseHash: string; artifact: Readonly<{ hash: string }> }>, sourceCommitSha: string): Promise<CoolifyPromotion> {
    const candidate = await this.#options.phases.resolution(phase);
    if (!candidate) {
      throw new CloudflareDeliveryError("DELIVERY_PHASE_HUMAN_RESOLUTION_REQUIRED", "Coolify has no immutable operation lookup; a human operator must record the exact deployment UUID and evidence before reconciliation can continue");
    }
    const promotion = await this.#call("coolify", "discover", input, phase.referenceHash, () => this.#options.coolify.inspectPromotion({
      applicationKey: this.#options.coolifyApplicationKey,
      promotionId: candidate.externalId,
      referenceHash: phase.referenceHash
    }));
    if (!promotion) throw new CloudflareDeliveryError("DELIVERY_PHASE_RESOLUTION_INVALID", "The human-recorded Coolify deployment UUID no longer exists");
    assertCoolifyPromotion(promotion, this.#options.coolifyApplicationKey, sourceCommitSha, phase.referenceHash);
    await this.#options.phases.complete({ ...phase, externalId: promotion.id });
    return promotion;
  }

  async #verifyRollbackTarget(targetReference: ProviderReferenceV1, input: Readonly<{ releaseHash: string; artifact: Readonly<{ hash: string }> }>): Promise<void> {
    const targetDeployment = await this.#call("cloudflare-pages", "verify", input, targetReference.referenceHash, () => this.#options.cloudflare.inspectDeployment({ projectKey: targetReference.projectKey, deploymentId: targetReference.productionDeploymentId }));
    if (!targetDeployment || targetDeployment.status !== "success") throw new CloudflareDeliveryError("ROLLBACK_TARGET_VERIFICATION_FAILED", "Rollback target deployment is not successful");
    assertCloudflareDeployment(targetDeployment, targetReference.projectKey, targetReference.referenceHash, "production");
    const targetLive = await this.#call("cloudflare-pages", "verify", input, targetReference.referenceHash, () => this.#options.cloudflare.verifyLive({ projectKey: targetReference.projectKey, deploymentId: targetReference.productionDeploymentId, referenceHash: targetReference.referenceHash, environment: "production", reference: targetReference.reference }));
    if (targetLive.status !== 200 || targetLive.referenceHash !== targetReference.referenceHash || targetLive.releaseHash !== targetReference.reference.releaseHash || targetLive.outputHash !== targetReference.reference.outputHash || targetLive.cacheControl !== CLOUDFLARE_CACHE_CONTROL.production || !sameFileManifest(targetLive.files, targetReference.reference.files)) throw new CloudflareDeliveryError("ROLLBACK_TARGET_VERIFICATION_FAILED", "Rollback target bytes or cache contract do not match the immutable reference");
  }

  async #resumeDeployment(deployment: CloudflareDeployment, environment: "preview" | "production", input: ReleaseProviderPublishInput, referenceHash: string): Promise<CloudflareDeployment> {
    assertCloudflareDeployment(deployment, this.#options.projectKey, referenceHash, environment);
    if (!terminalDeployment(deployment)) return deployment;
    return this.#call("cloudflare-pages", "preview", input, referenceHash, () => this.#options.cloudflare.retryDeployment({
      projectKey: this.#options.projectKey, deploymentId: deployment.id, referenceHash, environment
    }));
  }

  async #call<T>(provider: DeliveryTelemetryRecord["provider"], operation: DeliveryTelemetryRecord["operation"], input: Readonly<{ releaseHash: string; artifact: Readonly<{ hash: string }> }>, referenceHash: string, action: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      await this.#telemetry.record({ provider, operation, outcome: "attempt", attempt, releaseHash: input.releaseHash, artifactHash: input.artifact.hash, referenceHash });
      try {
        const value = await action();
        await this.#telemetry.record({ provider, operation, outcome: "success", attempt, releaseHash: input.releaseHash, artifactHash: input.artifact.hash, referenceHash });
        return value;
      } catch (error) {
        lastError = error;
        const status = error instanceof CloudflareDeliveryError ? error.httpStatus : undefined;
        const errorCode = error instanceof CloudflareDeliveryError ? error.code : "DELIVERY_REQUEST_FAILED";
        // A mutation can succeed before an upstream proxy returns 5xx.  Do
        // not replay it inside this call: the durable phase stays reserved
        // and reconciliation must establish the provider outcome first.
        const retryable = (operation === "discover" || operation === "verify") && (status === 502 || status === 503 || status === 504);
        await this.#telemetry.record({ provider, operation, outcome: retryable && attempt < this.#attempts ? "retry" : "failure", attempt, releaseHash: input.releaseHash, artifactHash: input.artifact.hash, referenceHash, ...(status ? { httpStatus: status } : {}), errorCode });
        if (!retryable || attempt === this.#attempts) throw error;
      }
    }
    throw lastError;
  }
}

/** Creates a deployable immutable reference only after the complete Astro output passed its checks. */
export function createDeployableArtifact(input: Readonly<{
  releaseHash: string;
  releaseArtifact: ReleaseArtifact;
  sourceCommitSha: string;
  astroArtifact: AstroArtifact;
  expectedAstroArtifactHash: string;
  output: Readonly<Record<string, string>>;
}>): DeployableArtifact {
  assertReleaseHash(input.releaseHash, "releaseHash");
  assertArtifactHash(input.releaseArtifact.hash, "releaseArtifact.hash");
  if (!commitSha(input.sourceCommitSha)) throw new CloudflareDeliveryError("ARTIFACT_COMMIT_INVALID", "Artifact source commit must be a full immutable SHA");
  verifyAstroArtifact(input.astroArtifact, input.expectedAstroArtifactHash);
  verifyBuiltAstroOutput(input.output, input.astroArtifact, input.expectedAstroArtifactHash);
  const files = sortedFiles(input.output);
  const fileCount = Object.keys(files).length;
  const byteSize = Object.values(files).reduce((total, body) => total + bytes(body), 0);
  if (fileCount < 1 || fileCount > CLOUDFLARE_DELIVERY_LIMITS.outputFiles || byteSize > CLOUDFLARE_DELIVERY_LIMITS.outputBytes) throw new CloudflareDeliveryError("ARTIFACT_OUTPUT_BOUNDS", "Built output exceeds delivery bounds");
  const reference = Object.freeze({
    schema: REFERENCE_SCHEMA,
    releaseHash: input.releaseHash,
    releaseArtifactHash: input.releaseArtifact.hash,
    astroArtifactHash: input.expectedAstroArtifactHash,
    outputHash: sha256(canonical(files)),
    routeDigest: sha256(canonical(Object.keys(files).filter((path) => path.endsWith(".html")).sort())),
    sourceCommitSha: input.sourceCommitSha,
    fileCount,
    byteSize,
    files: Object.freeze(Object.entries(files).map(([path, body]) => Object.freeze({ path, sha256: sha256(body), byteSize: bytes(body) })))
  });
  assertReference(reference);
  return Object.freeze({ reference, files: Object.freeze(files) });
}

export function immutableReferenceHash(reference: ImmutableArtifactReference): string {
  assertReference(reference);
  return sha256(canonical(reference));
}

function assertReleaseInput(input: ReleaseProviderPublishInput): void {
  if (!safeIdentifier(input.releaseId) || !/^[a-f0-9]{64}$/.test(input.releaseHash) || !input.artifact || !/^[a-f0-9]{64}$/.test(input.artifact.hash)) {
    throw new CloudflareDeliveryError("RELEASE_INPUT_INVALID", "Cloudflare provider requires an exact immutable release artifact");
  }
}

function assertDeployable(deployable: DeployableArtifact, input: ReleaseProviderPublishInput): void {
  assertReference(deployable.reference);
  if (deployable.reference.releaseHash !== input.releaseHash || deployable.reference.releaseArtifactHash !== input.artifact.hash) {
    throw new CloudflareDeliveryError("ARTIFACT_REFERENCE_MISMATCH", "Resolved artifact does not match the approved release");
  }
  const files = sortedFiles(deployable.files);
  const manifest = Object.entries(files).map(([path, body]) => ({ path, sha256: sha256(body), byteSize: bytes(body) }));
  if (sha256(canonical(files)) !== deployable.reference.outputHash || Object.keys(files).length !== deployable.reference.fileCount || Object.values(files).reduce((total, body) => total + bytes(body), 0) !== deployable.reference.byteSize || !sameFileManifest(manifest, deployable.reference.files)) {
    throw new CloudflareDeliveryError("ARTIFACT_REFERENCE_MISMATCH", "Resolved output no longer matches its immutable reference");
  }
}

function assertReference(reference: ImmutableArtifactReference): void {
  if (!reference || !exactKeys(reference, ["schema", "releaseHash", "releaseArtifactHash", "astroArtifactHash", "outputHash", "routeDigest", "sourceCommitSha", "fileCount", "byteSize", "files"]) || reference.schema !== REFERENCE_SCHEMA || !hash(reference.releaseHash) || !hash(reference.releaseArtifactHash) || !prefixedHash(reference.astroArtifactHash) || !hash(reference.outputHash) || !hash(reference.routeDigest) || !commitSha(reference.sourceCommitSha) || !Number.isSafeInteger(reference.fileCount) || reference.fileCount < 1 || reference.fileCount > CLOUDFLARE_DELIVERY_LIMITS.outputFiles || !Number.isSafeInteger(reference.byteSize) || reference.byteSize < 1 || reference.byteSize > CLOUDFLARE_DELIVERY_LIMITS.outputBytes || !validFileManifest(reference.files) || reference.files.length !== reference.fileCount || reference.files.reduce((sum, file) => sum + file.byteSize, 0) !== reference.byteSize) {
    throw new CloudflareDeliveryError("ARTIFACT_REFERENCE_INVALID", "Immutable artifact reference is invalid");
  }
}

function assertCloudflareDeployment(value: CloudflareDeployment, projectKey: string, referenceHash: string, environment: "preview" | "production"): void {
  if (!value || !safeIdentifier(value.id) || value.projectKey !== projectKey || value.referenceHash !== referenceHash || value.environment !== environment) throw new CloudflareDeliveryError("CLOUDFLARE_DEPLOYMENT_INVALID", "Cloudflare deployment does not match immutable reference");
}

function assertCoolifyPromotion(value: CoolifyPromotion, applicationKey: string, sourceCommitSha: string, referenceHash: string): void {
  if (!value || !safeIdentifier(value.id) || value.applicationKey !== applicationKey || value.sourceCommitSha !== sourceCommitSha || value.referenceHash !== referenceHash) throw new CloudflareDeliveryError("COOLIFY_PROMOTION_INVALID", "Coolify promotion does not match immutable reference");
}

function encodeProviderReference(reference: ProviderReferenceV1): string {
  const encoded = Buffer.from(canonical(reference)).toString("base64url");
  const value = `${REFERENCE_FORMAT}:${encoded}`;
  if (bytes(value) > CLOUDFLARE_DELIVERY_LIMITS.providerReferenceBytes) throw new CloudflareDeliveryError("PROVIDER_REFERENCE_BOUNDS", "Provider reference exceeds bound");
  return value;
}

function decodeProviderReference(publication: ReleaseProviderPublication, expectedKey: string): ProviderReferenceV1 {
  if (!publication || publication.providerKey !== expectedKey || !hash(publication.artifactHash) || typeof publication.providerReference !== "string" || bytes(publication.providerReference) > CLOUDFLARE_DELIVERY_LIMITS.providerReferenceBytes || !publication.providerReference.startsWith(`${REFERENCE_FORMAT}:`)) throw new CloudflareDeliveryError("PROVIDER_REFERENCE_INVALID", "Cloudflare provider reference is invalid");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(publication.providerReference.slice(REFERENCE_FORMAT.length + 1), "base64url").toString("utf8")); } catch { throw new CloudflareDeliveryError("PROVIDER_REFERENCE_INVALID", "Cloudflare provider reference is invalid"); }
  if (!value || typeof value !== "object") throw new CloudflareDeliveryError("PROVIDER_REFERENCE_INVALID", "Cloudflare provider reference is invalid");
  const reference = value as ProviderReferenceV1;
  if (!exactKeys(reference, ["schema", "format", "projectKey", "releaseId", "previewDeploymentId", "productionDeploymentId", "coolifyApplicationKey", "coolifyPromotionId", "reference", "referenceHash"]) || reference.schema !== REFERENCE_SCHEMA || reference.format !== REFERENCE_FORMAT || !safeIdentifier(reference.projectKey) || !safeIdentifier(reference.releaseId) || !safeIdentifier(reference.previewDeploymentId) || !safeIdentifier(reference.productionDeploymentId) || !safeIdentifier(reference.coolifyApplicationKey) || !safeIdentifier(reference.coolifyPromotionId) || !hash(reference.referenceHash)) throw new CloudflareDeliveryError("PROVIDER_REFERENCE_INVALID", "Cloudflare provider reference is invalid");
  assertReference(reference.reference);
  if (reference.reference.releaseArtifactHash !== publication.artifactHash || immutableReferenceHash(reference.reference) !== reference.referenceHash) throw new CloudflareDeliveryError("PROVIDER_REFERENCE_INVALID", "Cloudflare provider reference hash mismatch");
  return Object.freeze(reference);
}

function sortedFiles(files: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(files);
  if (entries.length < 1 || entries.length > CLOUDFLARE_DELIVERY_LIMITS.outputFiles) throw new CloudflareDeliveryError("ARTIFACT_OUTPUT_BOUNDS", "Built output file count invalid");
  const output: Record<string, string> = {};
  for (const [path, body] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!safeOutputPath(path) || typeof body !== "string") throw new CloudflareDeliveryError("ARTIFACT_OUTPUT_INVALID", "Built output path is invalid");
    output[path] = body;
  }
  return output;
}

function operationKey(operation: string, left: string, right: string, attempt = 1): string {
  return `${operation}:${attempt}:${sha256(`${left}:${right}:${attempt}`)}`;
}
function phaseKey(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): string { return `${input.releaseId}:${input.referenceHash}:${input.phase}`; }

function terminalDeployment(value: CloudflareDeployment): boolean { return value.status === "failure" || value.status === "canceled"; }
function terminalPromotion(value: CoolifyPromotion): boolean { return value.status === "failed"; }
function sameFileManifest(actual: readonly ImmutableArtifactFile[] | undefined, expected: readonly ImmutableArtifactFile[]): boolean {
  if (!actual || actual.length !== expected.length) return false;
  const normalized = (values: readonly ImmutableArtifactFile[]) => values.map((value) => `${value.path}:${value.sha256}:${value.byteSize}`).sort();
  const left = normalized(actual); const right = normalized(expected);
  return left.every((value, index) => value === right[index]);
}
function validFileManifest(files: unknown): files is readonly ImmutableArtifactFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > CLOUDFLARE_DELIVERY_LIMITS.outputFiles) return false;
  const seen = new Set<string>();
  return files.every((file) => Boolean(file && typeof file === "object" && !Array.isArray(file) && exactKeys(file, ["path", "sha256", "byteSize"]) && safeOutputPath((file as ImmutableArtifactFile).path) && hash((file as ImmutableArtifactFile).sha256) && Number.isSafeInteger((file as ImmutableArtifactFile).byteSize) && (file as ImmutableArtifactFile).byteSize > 0 && (file as ImmutableArtifactFile).byteSize <= CLOUDFLARE_DELIVERY_LIMITS.outputBytes && !seen.has((file as ImmutableArtifactFile).path) && (seen.add((file as ImmutableArtifactFile).path), true)));
}
function assertHumanResolution(input: Readonly<{ externalId: string; actor: Readonly<{ kind: "human"; id: string }>; evidenceHash: string; observedAt: string }>): DeliveryPhaseResolution {
  if (!safeIdentifier(input.externalId) || input.actor?.kind !== "human" || !safeIdentifier(input.actor.id) || !hash(input.evidenceHash) || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new CloudflareDeliveryError("DELIVERY_PHASE_RESOLUTION_INVALID", "Human delivery-phase resolution is invalid");
  }
  return Object.freeze({ externalId: input.externalId, actor: Object.freeze({ kind: "human", id: input.actor.id }), evidenceHash: input.evidenceHash, observedAt: input.observedAt });
}

function boundedAttempts(value: number | undefined): number {
  if (value === undefined) return CLOUDFLARE_DELIVERY_LIMITS.attempts;
  if (!Number.isInteger(value) || value < 1 || value > CLOUDFLARE_DELIVERY_LIMITS.attempts) throw new CloudflareDeliveryError("DELIVERY_ATTEMPTS_INVALID", "Delivery retry bound is invalid");
  return value;
}

function safeIdentifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value); }
function safeOutputPath(value: string): boolean { return /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && bytes(value) <= 512; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function prefixedHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function commitSha(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function assertReleaseHash(value: unknown, name: string): asserts value is string { if (!hash(value)) throw new CloudflareDeliveryError("ARTIFACT_REFERENCE_INVALID", `${name} must be a SHA-256 hash`); }
function assertArtifactHash(value: unknown, name: string): asserts value is string { if (!hash(value)) throw new CloudflareDeliveryError("ARTIFACT_REFERENCE_INVALID", `${name} must be a SHA-256 hash`); }
function exactKeys(value: object, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
