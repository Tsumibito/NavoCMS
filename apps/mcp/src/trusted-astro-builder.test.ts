import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { astroContentDigest, astroMediaDigest, renderAstroArtifact, type AstroRenderInput } from "@navocms/design-astro";
import { contentHash } from "@navocms/content";
import { createReleaseManifest } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS } from "@navocms/security";
import { describe, expect, it } from "vitest";

import { ImageAttestedAstroBuildRunner, TrustedAstroBuilder, readBoundedAstroOutput, reviewedAstroBuildBindingDigest, runBoundedTrustedAstroProcess, type ReviewedAstroArtifactRegistrar, type ReviewedAstroBuildInputs, type ReviewedAstroBuildInputStore, type TrustedAstroBuildRunner } from "./trusted-astro-builder.js";
import type { RegisterReviewedAstroArtifactInput, ReviewedAstroArtifactAuthority } from "./postgres-reviewed-astro-artifact-store.js";
import type { ReviewedAstroArtifactRecord } from "./reviewed-astro-resolver.js";
import type { McpRequestContext } from "./model.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const releaseArtifactHash = "b".repeat(64);
const repositoryContext = Object.freeze({ site: { tenantId, siteId, name: "Trusted Astro", primaryLocale: "en", locales: ["en"] }, principalId: "44444444-4444-4444-8444-444444444444" });

describe("trusted Astro builder", () => {
  it("uses hash-only request plus checked-out attestation and registers only two matching builds", async () => {
    const input = await reviewedInput(); const registrar = new CapturingRegistrar(); const runner = new DeterministicRunner(); const source = countingStore(input);
    const record = await builder(source, registrar, runner).buildAndRegister(humanContext(), request(input));
    expect(source.calls).toBe(1); expect(runner.attestCalls).toBe(2); expect(runner.buildCalls).toBe(2);
    expect(registrar.calls).toHaveLength(1); expect(record.sourceCommitSha).toBe("c".repeat(40));
    const adversarialInput = { ...input, reviewedCommit: "d".repeat(40) } as ReviewedAstroBuildInputs;
    const ignoredSelectorRegistrar = new CapturingRegistrar(); const ignoredSelectorRunner = new DeterministicRunner();
    await expect(builder(countingStore(adversarialInput), ignoredSelectorRegistrar, ignoredSelectorRunner).buildAndRegister(humanContext(), request(input))).resolves.toMatchObject({ sourceCommitSha: "c".repeat(40) });
  });

  it("rejects malformed/extra and out-of-range requests before input, runner, or registrar", async () => {
    const input = await reviewedInput(); const registrar = new CapturingRegistrar(); const runner = new DeterministicRunner(); const source = countingStore(input); const target = builder(source, registrar, runner);
    for (const candidate of [{ ...request(input), idempotencyKey: "a".repeat(7) }, { ...request(input), idempotencyKey: "a".repeat(129) }, { ...request(input), unexpected: true }, { releaseId, releaseHash: input.releaseHash, releaseArtifactHash }, null]) {
      await expect(target.buildAndRegister(humanContext(), candidate)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_BUILD_INPUT_INVALID" });
    }
    expect(source.calls).toBe(0); expect(runner.attestCalls).toBe(0); expect(runner.buildCalls).toBe(0); expect(registrar.calls).toHaveLength(0);
  });

  it("accepts exactly 8 and 128 byte idempotency keys", async () => {
    for (const key of ["a".repeat(8), "a".repeat(128)]) {
      const input = await reviewedInput(); const registrar = new CapturingRegistrar(); const runner = new DeterministicRunner(); const source = countingStore(input);
      await expect(builder(source, registrar, runner).buildAndRegister(humanContext(), { ...request(input), idempotencyKey: key })).resolves.toMatchObject({ releaseId });
      expect(source.calls).toBe(1); expect(runner.buildCalls).toBe(2); expect(registrar.calls).toHaveLength(1);
    }
  });

  it("rejects a stable wrong build SHA and valid render provenance drift before registration", async () => {
    const input = await reviewedInput(); const wrongRegistrar = new CapturingRegistrar(); const wrong = new DeterministicRunner("d".repeat(40));
    await expect(builder(countingStore(input), wrongRegistrar, wrong).buildAndRegister(humanContext(), request(input))).rejects.toMatchObject({ code: "REVIEWED_ASTRO_BUILD_DRIFT" });
    expect(wrongRegistrar.calls).toHaveLength(0);
    const drifted = { ...input, render: { ...input.render, anchors: { ...input.render.anchors, governance: `sha256:${"f".repeat(64)}` } } };
    const provenanceRegistrar = new CapturingRegistrar(); const provenanceRunner = new DeterministicRunner();
    await expect(builder(countingStore(drifted), provenanceRegistrar, provenanceRunner).buildAndRegister(humanContext(), request(input))).rejects.toMatchObject({ code: "REVIEWED_ASTRO_BUILD_PROVENANCE_MISMATCH" });
    expect(provenanceRunner.buildCalls).toBe(0); expect(provenanceRegistrar.calls).toHaveLength(0);
  });

  it("re-attests checkout and toolchain immediately before registration", async () => {
    const input = await reviewedInput(); const registrar = new CapturingRegistrar();
    const runner = new DeterministicRunner("c".repeat(40), [`sha256:${"e".repeat(64)}`, `sha256:${"f".repeat(64)}`]);
    await expect(builder(countingStore(input), registrar, runner).buildAndRegister(humanContext(), request(input))).rejects.toMatchObject({ code: "REVIEWED_ASTRO_CHECKOUT_DRIFT" });
    expect(runner.buildCalls).toBe(2); expect(registrar.calls).toHaveLength(0);
  });

  it("kills a timed-out child process and never registers its build", async () => {
    const root = await mkdtemp(join(tmpdir(), "navocms-timeout-")); const marker = join(root, "child.pid"); const registrar = new CapturingRegistrar();
    try {
      const runner = new TimeoutRunner(marker); const input = await reviewedInput();
      await expect(builder(countingStore(input), registrar, runner).buildAndRegister(humanContext(), request(input))).rejects.toMatchObject({ code: "REVIEWED_ASTRO_PROCESS_TIMEOUT" });
      const pid = Number(await readFile(marker, "utf8")); await new Promise((resolve) => setTimeout(resolve, 10));
      let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false); expect(registrar.calls).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects oversized, excessive-depth, and symlink output before body collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "navocms-output-bounds-"));
    try {
      await writeFile(join(root, "large.txt"), "x".repeat(8 * 1024 * 1024 + 1));
      await expect(readBoundedAstroOutput(root)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_OUTPUT_BOUNDS" });
      await rm(root, { recursive: true, force: true }); await mkdir(root);
      let nested = root; for (let index = 0; index < 17; index += 1) { nested = join(nested, "nested"); await mkdir(nested); }
      await expect(readBoundedAstroOutput(root)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_OUTPUT_BOUNDS" });
      await rm(root, { recursive: true, force: true }); await mkdir(root);
      await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(join(root, `${index}.txt`), "x")));
      await expect(readBoundedAstroOutput(root)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_OUTPUT_BOUNDS" });
      await rm(root, { recursive: true, force: true }); await mkdir(root); await writeFile(join(root, "target.html"), "safe"); await symlink(join(root, "target.html"), join(root, "link.html"));
      await expect(readBoundedAstroOutput(root)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_OUTPUT_INVALID" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("attests a complete staged image toolchain and fails closed for an unbound source commit", async () => {
    const root = await stagedImageToolchain();
    try {
      const runner = new ImageAttestedAstroBuildRunner({ sourceCommitSha: "a".repeat(40), toolchainDirectory: root });
      const stable = await runner.attest(); expect((await runner.attest()).toolchainFingerprint).toBe(stable.toolchainFingerprint);
      await expect(new ImageAttestedAstroBuildRunner({ sourceCommitSha: "unbound", toolchainDirectory: root }).attest()).rejects.toMatchObject({ code: "REVIEWED_ASTRO_CHECKOUT_INVALID" });
      await expect(new ImageAttestedAstroBuildRunner({ sourceCommitSha: "a".repeat(40), toolchainDirectory: join(root, "missing") }).attest()).rejects.toMatchObject({ code: "REVIEWED_ASTRO_TOOLCHAIN_INVALID" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fingerprints executable image-toolchain files, not merely package manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "navocms-image-toolchain-"));
    try {
      await writeStagedImageToolchain(root);
      const runner = new ImageAttestedAstroBuildRunner({ sourceCommitSha: "a".repeat(40), toolchainDirectory: root });
      const first = await runner.attest();
      await writeFile(join(root, "astro", "bin", "astro.mjs"), "throw new Error('mutated');\n");
      const second = await runner.attest();
      expect(second.toolchainFingerprint).not.toBe(first.toolchainFingerprint);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function stagedImageToolchain(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "navocms-image-toolchain-"));
  await writeStagedImageToolchain(root);
  return root;
}

async function writeStagedImageToolchain(root: string): Promise<void> {
  for (const [name, version] of [["astro", "7.2.4"], ["@astrojs/check", "0.9.10"], ["typescript", "5.9.3"]] as const) {
    const directory = join(root, name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
    await writeFile(join(directory, "runtime.mjs"), `export const ${name.replace(/[^a-z]/g, "_")} = true;\n`);
  }
  await mkdir(join(root, "astro", "bin"), { recursive: true }); await writeFile(join(root, "astro", "bin", "astro.mjs"), "export {};\n");
  await symlink("./runtime.mjs", join(root, "astro", "runtime-link.mjs"));
}

class CapturingRegistrar implements ReviewedAstroArtifactRegistrar {
  readonly calls: RegisterReviewedAstroArtifactInput[] = [];
  public async register(input: RegisterReviewedAstroArtifactInput, _: ReviewedAstroArtifactAuthority): Promise<ReviewedAstroArtifactRecord> {
    this.calls.push(input);
    return Object.freeze({ tenantId, siteId, environment: "staging" as const, environmentKey: "default", releaseId: input.releaseId, releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, expectedAstroArtifactHash: input.expectedAstroArtifactHash, sourceCommitSha: input.sourceCommitSha, artifact: input.artifact, output: input.output });
  }
}
class DeterministicRunner implements TrustedAstroBuildRunner {
  attestCalls = 0; buildCalls = 0;
  public constructor(private readonly sha = "c".repeat(40), private readonly fingerprints = [`sha256:${"e".repeat(64)}`]) {}
  public async attest() { const index = this.attestCalls; this.attestCalls += 1; return Object.freeze({ sourceCommitSha: "c".repeat(40), toolchainFingerprint: this.fingerprints[Math.min(index, this.fingerprints.length - 1)] as `sha256:${string}` }); }
  public async build(_: { readonly sourceCommitSha: string }, __: RegisterReviewedAstroArtifactInput["artifact"]) { this.buildCalls += 1; return Object.freeze({ sourceCommitSha: this.sha, output: Object.freeze({ "index.html": html() }) }); }
}
class TimeoutRunner implements TrustedAstroBuildRunner {
  public constructor(private readonly marker: string) {}
  public async attest() { return Object.freeze({ sourceCommitSha: "c".repeat(40), toolchainFingerprint: `sha256:${"e".repeat(64)}` as `sha256:${string}` }); }
  public async build(_: { readonly sourceCommitSha: string }, __: RegisterReviewedAstroArtifactInput["artifact"]): Promise<never> {
    await runBoundedTrustedAstroProcess(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(this.marker)}, String(process.pid)); setInterval(() => {}, 1000);`], 500);
    throw new Error("unreachable");
  }
}

function builder(inputs: ReviewedAstroBuildInputStore, registrations: ReviewedAstroArtifactRegistrar, runner: TrustedAstroBuildRunner) { return new TrustedAstroBuilder({ inputs, registrations, context: repositoryContext, environmentKey: "default", runner }); }
function countingStore(input: ReviewedAstroBuildInputs): ReviewedAstroBuildInputStore & { calls: number } { return { calls: 0, async get() { this.calls += 1; return input; } }; }
async function reviewedInput(): Promise<ReviewedAstroBuildInputs> {
  const registrations = [{ id: "signal-button", module: "./SignalButton.astro", source: "<button><slot /></button>" }, { id: "story-card", module: "./StoryCard.astro", source: "<article><slot /></article>" }, { id: "section-shell", module: "./SectionShell.astro", source: "<section><slot /></section>" }] as const;
  const adapter = Object.freeze({ digest: `sha256:${"d".repeat(64)}` as `sha256:${string}`, css: ":root {}\n", components: new Map(registrations.map((registration) => [registration.id, registration])), recipes: [] });
  const route = Object.freeze({ id: "home", path: "/", locale: "en", revisionId: "home-revision", componentId: "section-shell", title: "Home", source: "# Home", sourceHash: contentHash("# Home"), media: [] });
  const layoutSource = "---\nimport '../styles/navocms.css';\nconst { title, locale } = Astro.props;\n---\n<!doctype html><html lang={locale}><head><meta data-navocms-consent-bridge=\"io.navocms.consent-bridge.v1\"><meta data-navocms-analytics-bootstrap=\"io.navocms.analytics-bootstrap.v1\"><title>{title}</title><script is:inline src=\"/cdn-cgi/zaraz/i.js\" data-navocms-zaraz-loader=\"v1\"></script></head><body><slot /></body></html>\n";
  const layoutDigest = `sha256:${contentHash(layoutSource)}` as `sha256:${string}`;
  const render: AstroRenderInput = Object.freeze({ tenantId, siteId, locales: { default: "en", supported: ["en"] }, anchors: { content: astroContentDigest([route]), design: adapter.digest, delivery: layoutDigest, governance: `sha256:${"e".repeat(64)}` as `sha256:${string}` }, deliveryLayout: { schema: "io.navocms.delivery-layout.v1" as const, source: layoutSource, digest: layoutDigest }, expectedMediaDigest: astroMediaDigest([route]), design: adapter, routes: [route] });
  const anchors = Object.fromEntries(Object.entries(render.anchors).map(([key, value]) => [key, value.slice("sha256:".length)])) as { content: string; design: string; delivery: string; governance: string };
  const manifest = createReleaseManifest({ tenantId, siteId, environmentId: "55555555-5555-4555-8555-555555555555", revisionId: "66666666-6666-4666-8666-666666666666", sourceHash: render.anchors.content.slice("sha256:".length), workflow: "navocms.editorial.standard.v1", anchors }).manifest;
  const releaseHash = createReleaseManifest({ tenantId, siteId, environmentId: manifest.environmentId, revisionId: manifest.revisionId, sourceHash: manifest.sourceHash, workflow: manifest.workflow, anchors: manifest.anchors }).releaseHash;
  return Object.freeze({ tenantId, siteId, environment: "staging", environmentKey: "default", releaseId, releaseHash, releaseArtifactHash, releaseManifest: manifest, bindingDigest: reviewedAstroBuildBindingDigest({ releaseManifest: manifest, releaseHash, releaseArtifactHash, render }), render });
}
function request(input: ReviewedAstroBuildInputs) { return { releaseId, releaseHash: input.releaseHash, releaseArtifactHash, idempotencyKey: "trusted-builder-0002" }; }
function humanContext(): McpRequestContext { return { authorization: { tenantId, siteId, principal: { id: repositoryContext.principalId, kind: "human", issuer: "urn:test", subject: "human" }, layers: [{ name: "operation", permissions: NAVOCMS_PERMISSIONS }] } }; }
function html() { return '<!doctype html><html><head><meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1"><script src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script></head><body>reviewed</body></html>'; }
