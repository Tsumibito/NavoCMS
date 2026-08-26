import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, lstat, open, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { ASTRO_BUILT_OUTPUT_LIMITS, materializeAstroArtifact, renderAstroArtifact, verifyAstroArtifact, verifyBuiltAstroOutput, type AstroArtifact, type AstroRenderInput } from "@navocms/design-astro";
import { createReleaseManifest, sha256, type ReleaseManifestV1 } from "@navocms/kernel";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";
import { reviewedAstroArtifactAuthority, type RegisterReviewedAstroArtifactInput, type ReviewedAstroArtifactAuthority } from "./postgres-reviewed-astro-artifact-store.js";
import type { RepositoryContext } from "./repository.js";
import type { ReviewedAstroArtifactRecord } from "./reviewed-astro-resolver.js";

const exec = promisify(execFile);
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const IDENTITY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_IDEMPOTENCY_KEY_BYTES = 128;
const MAX_OUTPUT_DEPTH = 16;
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
const DEFAULT_PREPARATION_TIMEOUT_MS = 120_000;
const REVIEWED_TOOLCHAIN_DIRECTORY = "apps/design-catalogue/node_modules";
const TOOLCHAIN = Object.freeze({ astro: "7.2.4", "@astrojs/check": "0.9.10", typescript: "5.9.3" });

/** Exact reviewed inputs are internal durable evidence, never an MCP request envelope. */
export interface ReviewedAstroBuildInputs {
  readonly tenantId: string;
  readonly siteId: string;
  readonly environment: "staging";
  readonly environmentKey: string;
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly releaseArtifactHash: string;
  /** Loaded from the durable release candidate, including its immutable anchors. */
  readonly releaseManifest: ReleaseManifestV1;
  /** Durable reviewed-evidence digest; the builder recomputes this before it builds. */
  readonly bindingDigest: `sha256:${string}`;
  /** Includes pinned content, design, media, delivery, and governance inputs. */
  readonly render: AstroRenderInput;
}

/** The implementation must read releaseManifest and bindingDigest from durable reviewed evidence. */
export interface ReviewedAstroBuildInputStore {
  get(scope: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string; releaseId: string }>): Promise<ReviewedAstroBuildInputs | undefined>;
}

/** Deliberately bounded and hash-only: preview body/source/output/commit are never caller fields. */
export interface TrustedAstroBuildRequest {
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly releaseArtifactHash: string;
  readonly idempotencyKey: string;
}

export interface ReviewedCheckoutAttestation {
  /** Canonical full object ID obtained with `git rev-parse --verify HEAD^{commit}`. */
  readonly sourceCommitSha: string;
  /** Lockfile and real toolchain fingerprint rechecked around both builds. */
  readonly toolchainFingerprint: `sha256:${string}`;
}

export interface CheckedOutAstroBuild {
  readonly sourceCommitSha: string;
  readonly output: Readonly<Record<string, string>>;
}

/** The runner is trusted infrastructure; build output must attest to this exact checkout identity. */
export interface TrustedAstroBuildRunner {
  attest(): Promise<ReviewedCheckoutAttestation>;
  build(attestation: ReviewedCheckoutAttestation, artifact: AstroArtifact): Promise<CheckedOutAstroBuild>;
}

export interface ReviewedAstroArtifactRegistrar {
  register(input: RegisterReviewedAstroArtifactInput, authority: ReviewedAstroArtifactAuthority): Promise<ReviewedAstroArtifactRecord>;
}

/** Trusted producer; durable registration stays in the existing append-only store. */
export class TrustedAstroBuilder {
  readonly #inputs: ReviewedAstroBuildInputStore;
  readonly #registrations: ReviewedAstroArtifactRegistrar;
  readonly #context: RepositoryContext;
  readonly #environmentKey: string;
  readonly #runner: TrustedAstroBuildRunner;

  public constructor(input: Readonly<{ inputs: ReviewedAstroBuildInputStore; registrations: ReviewedAstroArtifactRegistrar; context: RepositoryContext; environmentKey: string; runner: TrustedAstroBuildRunner }>) {
    this.#inputs = input.inputs; this.#registrations = input.registrations; this.#context = input.context;
    this.#environmentKey = input.environmentKey; this.#runner = input.runner;
  }

  public async buildAndRegister(context: McpRequestContext, request: unknown): Promise<ReviewedAstroArtifactRecord> {
    assertRequest(request);
    const authority = reviewedAstroArtifactAuthority(context);
    if (authority.principal.kind !== "human") throw new McpEditingError("REVIEWED_ASTRO_HUMAN_REQUIRED", "A human publisher must register a reviewed Astro artifact");
    if (authority.tenantId !== this.#context.site.tenantId || authority.siteId !== this.#context.site.siteId || authority.principal.id !== this.#context.principalId) throw new McpEditingError("REVIEWED_ASTRO_AUTHORITY_DENIED", "Reviewed Astro build authority does not match its registration scope");
    const checkout = await this.#runner.attest();
    if (!COMMIT.test(checkout.sourceCommitSha)) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_INVALID", "Trusted reviewed checkout attestation is invalid");
    const loaded = await this.#inputs.get({ tenantId: authority.tenantId, siteId: authority.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId: request.releaseId });
    assertExactReviewedInputs(loaded, authority.tenantId, authority.siteId, this.#environmentKey, request);
    let artifact: AstroArtifact;
    try { artifact = renderAstroArtifact(loaded.render); verifyAstroArtifact(artifact, artifact.hash); }
    catch { throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro render inputs are invalid"); }
    const first = await this.#runner.build(checkout, artifact);
    const second = await this.#runner.build(checkout, artifact);
    assertIdenticalBuilds(checkout, first, second, artifact);
    // A second clean attestation closes the window between the two builds and
    // the durable registration.  Neither commit nor toolchain is caller input.
    const beforeRegistration = await this.#runner.attest();
    if (beforeRegistration.sourceCommitSha !== checkout.sourceCommitSha || beforeRegistration.toolchainFingerprint !== checkout.toolchainFingerprint) {
      throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_DRIFT", "Reviewed Astro checkout or toolchain changed before registration");
    }
    return this.#registrations.register({ idempotencyKey: request.idempotencyKey, releaseId: request.releaseId,
      releaseHash: request.releaseHash, releaseArtifactHash: request.releaseArtifactHash,
      expectedAstroArtifactHash: artifact.hash, sourceCommitSha: checkout.sourceCommitSha, artifact, output: first.output }, authority);
  }
}

/** The configured directory must itself be a clean detached reviewed checkout. */
export class GitPinnedAstroBuildRunner implements TrustedAstroBuildRunner {
  readonly #reviewedCheckoutDirectory: string;
  readonly #timeoutMs: number;
  readonly #preparationTimeoutMs: number;
  #preparation: Promise<void> | undefined;

  public constructor(input: Readonly<{ reviewedCheckoutDirectory: string; processTimeoutMs?: number; preparationTimeoutMs?: number }>) {
    this.#reviewedCheckoutDirectory = resolve(input.reviewedCheckoutDirectory);
    this.#timeoutMs = boundedTimeout(input.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
    this.#preparationTimeoutMs = boundedTimeout(input.preparationTimeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS, 120_000);
  }

  public async attest(): Promise<ReviewedCheckoutAttestation> {
    await this.#prepare();
    const checkout = await verifiedCheckoutDirectory(this.#reviewedCheckoutDirectory);
    await assertDetachedCleanCheckout(checkout, this.#timeoutMs);
    const commit = (await run("git", ["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], this.#timeoutMs)).stdout.trim().toLowerCase();
    if (!COMMIT.test(commit)) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_INVALID", "Reviewed Astro checkout did not resolve to a canonical commit");
    const toolchain = await verifyReviewedToolchain(checkout);
    return Object.freeze({ sourceCommitSha: commit, toolchainFingerprint: toolchain.fingerprint });
  }

  public async build(attestation: ReviewedCheckoutAttestation, artifact: AstroArtifact): Promise<CheckedOutAstroBuild> {
    if (!COMMIT.test(attestation.sourceCommitSha) || !/^sha256:[a-f0-9]{64}$/.test(attestation.toolchainFingerprint)) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_INVALID", "Reviewed Astro checkout attestation is invalid");
    const current = await this.attest();
    if (current.sourceCommitSha !== attestation.sourceCommitSha || current.toolchainFingerprint !== attestation.toolchainFingerprint) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_DRIFT", "Reviewed Astro checkout or toolchain changed during build");
    verifyPinnedArtifactPolicy(artifact);
    const root = await mkdtemp(join(tmpdir(), "navocms-trusted-astro-")); const buildDirectory = join(root, "build");
    let primaryFailure: unknown;
    try {
      const toolchain = await verifyReviewedToolchain(this.#reviewedCheckoutDirectory);
      if (toolchain.fingerprint !== attestation.toolchainFingerprint) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_DRIFT", "Reviewed Astro toolchain changed before materialization");
      await materializeAstroArtifact(buildDirectory, artifact, artifact.hash);
      await symlink(toolchain.directory, join(buildDirectory, "node_modules"), "dir");
      await run(process.execPath, [toolchain.astroCli, "check"], this.#timeoutMs, buildDirectory);
      await run(process.execPath, [toolchain.astroCli, "build"], this.#timeoutMs, buildDirectory);
      const output = await readBoundedAstroOutput(join(buildDirectory, "dist"));
      verifyBuiltAstroOutput(output, artifact, artifact.hash);
      return Object.freeze({ sourceCommitSha: attestation.sourceCommitSha, output: Object.freeze(output) });
    } catch (error) { primaryFailure = error; throw error; }
    finally {
      const cleanupError = await rm(root, { recursive: true, force: true }).then(() => undefined).catch((error: unknown) => error);
      if (cleanupError) {
        if (primaryFailure) process.emitWarning(`Reviewed Astro build-directory cleanup failed after primary error: ${safeError(cleanupError)}`);
        else throw new McpEditingError("REVIEWED_ASTRO_CLEANUP_FAILED", "Reviewed Astro build-directory cleanup failed");
      }
    }
  }

  async #prepare(): Promise<void> {
    this.#preparation ??= this.#prepareOnce();
    return this.#preparation;
  }

  async #prepareOnce(): Promise<void> {
    const checkout = await verifiedCheckoutDirectory(this.#reviewedCheckoutDirectory);
    await assertDetachedCleanCheckout(checkout, this.#timeoutMs);
    await run("corepack", ["pnpm@10.24.0", "install", "--offline", "--frozen-lockfile"], this.#preparationTimeoutMs, checkout);
  }
}

export function reviewedAstroBuildBindingDigest(input: Readonly<{ releaseManifest: ReleaseManifestV1; releaseHash: string; releaseArtifactHash: string; render: AstroRenderInput }>): `sha256:${string}` {
  return `sha256:${sha256(canonical({ releaseManifest: input.releaseManifest, releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, render: normalizedRenderInput(input.render) }))}`;
}

/** Bounded, symlink-denying output reader; limits apply before each body is read. */
export async function readBoundedAstroOutput(directory: string): Promise<Record<string, string>> {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_INVALID", "Built Astro output directory is invalid");
  const root = await realpath(directory); const output: Record<string, string> = {}; let files = 0; let bytes = 0;
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_OUTPUT_DEPTH) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_BOUNDS", "Built Astro output exceeds maximum depth");
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(current, entry.name); const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_INVALID", "Built Astro output contains a symbolic link");
      if (stat.isDirectory()) await walk(absolute, depth + 1);
      else if (stat.isFile()) {
        files += 1;
        if (files > ASTRO_BUILT_OUTPUT_LIMITS.files || stat.size > ASTRO_BUILT_OUTPUT_LIMITS.bytes - bytes) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_BOUNDS", "Built Astro output exceeds file or byte bounds");
        const path = relative(root, absolute).split("\\").join("/");
        if (!safeOutputPath(path)) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_INVALID", "Built Astro output path is invalid");
        const body = await readBoundedFile(absolute, ASTRO_BUILT_OUTPUT_LIMITS.bytes - bytes); bytes += body.byteLength;
        const text = body.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(body)) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_INVALID", "Built Astro output is not UTF-8");
        output[path] = text;
      } else throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_INVALID", "Built Astro output contains an unsupported entry");
    }
  }
  await walk(root, 0); return output;
}

function assertRequest(value: unknown): asserts value is TrustedAstroBuildRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["releaseId", "releaseHash", "releaseArtifactHash", "idempotencyKey"])) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro build request is invalid");
  const request = value as TrustedAstroBuildRequest;
  if (!UUID.test(request.releaseId) || !HASH.test(request.releaseHash) || !HASH.test(request.releaseArtifactHash) || !IDENTITY_KEY.test(request.idempotencyKey) || Buffer.byteLength(request.idempotencyKey, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro build request is invalid");
}

function assertExactReviewedInputs(value: ReviewedAstroBuildInputs | undefined, tenantId: string, siteId: string, environmentKey: string, request: TrustedAstroBuildRequest): asserts value is ReviewedAstroBuildInputs {
  if (!value || value.tenantId !== tenantId || value.siteId !== siteId || value.environment !== "staging" || value.environmentKey !== environmentKey || value.releaseId !== request.releaseId || value.releaseHash !== request.releaseHash || value.releaseArtifactHash !== request.releaseArtifactHash || value.render.tenantId !== tenantId || value.render.siteId !== siteId || !/^sha256:[a-f0-9]{64}$/.test(value.bindingDigest)) throw new McpEditingError("REVIEWED_ASTRO_BUILD_BINDING_MISMATCH", "Reviewed Astro build inputs do not match the exact staging release");
  try {
    const recomputed = createReleaseManifest({ tenantId: value.releaseManifest.tenantId, siteId: value.releaseManifest.siteId, environmentId: value.releaseManifest.environmentId, revisionId: value.releaseManifest.revisionId, sourceHash: value.releaseManifest.sourceHash, workflow: value.releaseManifest.workflow, anchors: value.releaseManifest.anchors }).releaseHash;
    if (recomputed !== request.releaseHash || value.releaseManifest.tenantId !== tenantId || value.releaseManifest.siteId !== siteId || value.releaseManifest.anchors.content !== unprefixed(value.render.anchors.content) || value.releaseManifest.anchors.design !== unprefixed(value.render.anchors.design) || value.releaseManifest.anchors.delivery !== unprefixed(value.render.anchors.delivery) || value.releaseManifest.anchors.governance !== unprefixed(value.render.anchors.governance) || value.bindingDigest !== reviewedAstroBuildBindingDigest({ releaseManifest: value.releaseManifest, releaseHash: value.releaseHash, releaseArtifactHash: value.releaseArtifactHash, render: value.render })) throw new Error("reviewed binding drift");
  } catch { throw new McpEditingError("REVIEWED_ASTRO_BUILD_PROVENANCE_MISMATCH", "Reviewed Astro render inputs are not bound to durable release evidence"); }
}

function assertIdenticalBuilds(attestation: ReviewedCheckoutAttestation, first: CheckedOutAstroBuild, second: CheckedOutAstroBuild, artifact: AstroArtifact): void {
  if (!COMMIT.test(first.sourceCommitSha) || first.sourceCommitSha !== attestation.sourceCommitSha || second.sourceCommitSha !== attestation.sourceCommitSha || canonical(first.output) !== canonical(second.output)) throw new McpEditingError("REVIEWED_ASTRO_BUILD_DRIFT", "Two clean Astro builds were not byte-identical or checkout-attested");
  try { verifyBuiltAstroOutput(first.output, artifact, artifact.hash); verifyBuiltAstroOutput(second.output, artifact, artifact.hash); }
  catch { throw new McpEditingError("REVIEWED_ASTRO_BUILD_INVALID", "Built Astro output failed strict verification"); }
}

function verifyPinnedArtifactPolicy(artifact: AstroArtifact): void {
  verifyAstroArtifact(artifact, artifact.hash); let packageJson: unknown;
  try { packageJson = JSON.parse(artifact.files["package.json"] ?? ""); } catch { throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Astro artifact package policy is invalid"); }
  const value = packageJson as Record<string, unknown>;
  if (!exactKeys(value, ["dependencies", "devDependencies", "packageManager", "private", "scripts", "type"]) || value.packageManager !== "pnpm@10.24.0" || !exactDependencyVersions(value)) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Astro artifact package policy is not pinned");
}

async function verifyReviewedToolchain(checkout: string): Promise<Readonly<{ directory: string; astroCli: string; fingerprint: `sha256:${string}` }>> {
  try {
  const root = await realpath(checkout); const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  for (const [name, version] of Object.entries(TOOLCHAIN)) if (!lock.includes(`${name}@${version}`)) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed lockfile does not pin required Astro toolchain");
  const directory = join(root, REVIEWED_TOOLCHAIN_DIRECTORY); const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro toolchain directory is invalid");
  const canonicalDirectory = await realpath(directory);
  if (!inside(root, canonicalDirectory)) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro toolchain escapes its checkout");
  for (const [name, version] of Object.entries(TOOLCHAIN)) {
    const packageDirectory = await realpath(join(canonicalDirectory, name));
    const packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { version?: unknown };
    if (packageJson.version !== version) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro package version differs from pinned artifact policy");
  }
  const astroCli = await realpath(join(canonicalDirectory, "astro/bin/astro.mjs"));
  if (!inside(root, astroCli)) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro CLI escapes its checkout");
  const fingerprint = await fingerprintReviewedToolchain(root, canonicalDirectory, lock);
  return Object.freeze({ directory: canonicalDirectory, astroCli, fingerprint });
  } catch (error) { if (error instanceof McpEditingError) throw error; throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro toolchain cannot be verified"); }
}

/** Hash every checkout-local file reachable from the packages executed by Astro. */
async function fingerprintReviewedToolchain(checkout: string, directory: string, lock: string): Promise<`sha256:${string}`> {
  const digest = createHash("sha256"); const visitedDirectories = new Set<string>(); const root = await realpath(checkout);
  const record = (kind: string, path: string, value?: string | Buffer) => { digest.update(`${kind}\0${relative(root, path).split("\\").join("/")}\0`); if (value !== undefined) digest.update(value); digest.update("\0"); };
  const assertInside = (path: string) => { if (!inside(root, path)) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro toolchain contains an escaping link"); };
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await realpath(path); assertInside(target); record("link", path, relative(root, target)); await walk(target); return;
    }
    const canonicalPath = await realpath(path); assertInside(canonicalPath);
    if (stat.isFile()) { record("file", canonicalPath, await readFile(canonicalPath)); return; }
    if (!stat.isDirectory()) throw new McpEditingError("REVIEWED_ASTRO_TOOLCHAIN_INVALID", "Reviewed Astro toolchain contains an unsupported entry");
    if (visitedDirectories.has(canonicalPath)) return;
    visitedDirectories.add(canonicalPath); record("directory", canonicalPath);
    const entries = await readdir(canonicalPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) await walk(join(canonicalPath, entry.name));
  };
  record("lock", join(root, "pnpm-lock.yaml"), lock); record("toolchain", directory);
  for (const name of Object.keys(TOOLCHAIN).sort()) await walk(join(directory, name));
  return `sha256:${digest.digest("hex")}` as `sha256:${string}`;
}

async function verifiedCheckoutDirectory(directory: string): Promise<string> {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_INVALID", "Reviewed Astro checkout directory is invalid");
  return realpath(directory);
}
async function assertDetachedCleanCheckout(checkout: string, timeoutMs: number): Promise<void> {
  const branch = await symbolicRef(checkout, timeoutMs);
  if (branch !== undefined) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_NOT_DETACHED", "Reviewed Astro checkout must be detached");
  const status = await run("git", ["-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"], timeoutMs);
  if (status.stdout.trim()) throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_DIRTY", "Reviewed Astro checkout must be clean");
}
async function symbolicRef(directory: string, timeoutMs: number): Promise<string | undefined> { try { return (await exec("git", ["-C", directory, "symbolic-ref", "-q", "HEAD"], { env: minimalEnvironment(), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })).stdout.trim() || undefined; } catch (error) { const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown }; if (candidate.code === 1) return undefined; if (candidate.killed === true || candidate.signal === "SIGKILL") throw new McpEditingError("REVIEWED_ASTRO_PROCESS_TIMEOUT", "Reviewed Astro process timed out: git"); throw new McpEditingError("REVIEWED_ASTRO_CHECKOUT_INVALID", "Reviewed Astro checkout branch state is invalid"); } }
/** Bounded process-group primitive shared by Git, corepack, and Astro invocations. */
export async function runBoundedTrustedAstroProcess(command: string, args: readonly string[], timeoutMs: number, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = ""; let timedOut = false; let overflowed = false;
    let settled = false;
    const child = spawn(command, [...args], { ...(cwd ? { cwd } : {}), env: minimalEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const fail = (error: McpEditingError) => { if (!settled) { settled = true; reject(error); } };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (timedOut) return fail(new McpEditingError("REVIEWED_ASTRO_PROCESS_TIMEOUT", `Reviewed Astro process timed out: ${command}`));
      if (overflowed) return fail(new McpEditingError("REVIEWED_ASTRO_PROCESS_FAILED", `Reviewed Astro process exceeded output bounds: ${command}`));
      if (code === 0) { if (!settled) { settled = true; resolve({ stdout, stderr }); } return; }
      const detail = [stderr, stdout, signal ? `signal ${signal}` : undefined].find((value) => typeof value === "string" && value.trim());
      fail(new McpEditingError("REVIEWED_ASTRO_PROCESS_FAILED", `Reviewed Astro process failed: ${command}${typeof detail === "string" ? ` (${detail.trim().slice(0, 1200)})` : ""}`));
    };
    const terminate = () => {
      if (child.pid === undefined) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const next = `${target === "stdout" ? stdout : stderr}${chunk.toString()}`;
      if (next.length > 1024 * 1024) { overflowed = true; terminate(); return; }
      if (target === "stdout") stdout = next; else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", () => { clearTimeout(timer); fail(new McpEditingError("REVIEWED_ASTRO_PROCESS_FAILED", `Reviewed Astro process failed to start: ${command}`)); });
    child.once("close", finish);
  });
}
const run = runBoundedTrustedAstroProcess;
function normalizedRenderInput(input: AstroRenderInput): unknown { return { tenantId: input.tenantId, siteId: input.siteId, locales: { default: input.locales.default, supported: [...input.locales.supported].sort() }, anchors: input.anchors, deliveryLayout: input.deliveryLayout, expectedMediaDigest: input.expectedMediaDigest, design: { digest: input.design.digest, css: input.design.css, legacyComponentIds: [...input.design.legacyComponentIds].sort(), components: [...input.design.components.values()].map(({ id, module, source, exportName }) => ({ id, module, source, exportName })).sort(compare), recipes: [...input.design.recipes].map((recipe) => ({ id: recipe.id, slots: [...recipe.slots].map((slot) => ({ ...slot })).sort(compare) })).sort(compare) }, routes: [...input.routes].map((route) => ({ ...route, directives: route.directives ? [...route.directives].map((directive) => ({ ...directive, allowedAttributes: directive.allowedAttributes ? [...directive.allowedAttributes].sort() : undefined, requiredAttributes: directive.requiredAttributes ? [...directive.requiredAttributes].sort() : undefined })).sort(compare) : undefined, media: [...route.media].map((item) => ({ ...item })).sort(compare) })).sort(compare) }; }
function exactDependencyVersions(value: Record<string, unknown>): boolean { const dependencies = value.dependencies as Record<string, unknown> | undefined; const devDependencies = value.devDependencies as Record<string, unknown> | undefined; return !!dependencies && !!devDependencies && dependencies.astro === TOOLCHAIN.astro && devDependencies["@astrojs/check"] === TOOLCHAIN["@astrojs/check"] && devDependencies.typescript === TOOLCHAIN.typescript; }
function exactKeys(value: object, expected: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function boundedTimeout(value: number, maximumMs = 60_000): number { if (!Number.isInteger(value) || value < 10 || value > maximumMs) throw new McpEditingError("REVIEWED_ASTRO_TIMEOUT_INVALID", "Reviewed Astro process timeout is invalid"); return value; }
function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}/`); }
function safeOutputPath(value: string): boolean { return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.includes("//") && !value.split("/").some((part) => !part || part === "." || part === ".."); }
function minimalEnvironment(): NodeJS.ProcessEnv { return { PATH: process.env.PATH, ASTRO_TELEMETRY_DISABLED: "1", SOURCE_DATE_EPOCH: "0", TZ: "UTC", LC_ALL: "C" }; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
function compare(left: unknown, right: unknown): number { return canonical(left).localeCompare(canonical(right)); }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "unknown cleanup error"; }
function unprefixed(value: string): string { return value.slice("sha256:".length); }
async function readBoundedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_INVALID", "Built Astro output changed to an unsupported entry");
    const chunks: Buffer[] = []; let total = 0;
    while (total <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new McpEditingError("REVIEWED_ASTRO_OUTPUT_BOUNDS", "Built Astro output changed beyond byte bounds while reading");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
