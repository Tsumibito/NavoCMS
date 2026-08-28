import {
  CloudflarePagesReleaseProvider,
  FetchCloudflarePagesTransport,
  type DeliveryPhaseStore
} from "@navocms/delivery-cloudflare";
import type { CloudflareStagingBinding } from "@navocms/contracts";

import type { ReviewedAstroArtifactStore } from "./reviewed-astro-resolver.js";
import { ReviewedAstroArtifactResolver } from "./reviewed-astro-resolver.js";
import type { DotenvxSecretBroker } from "./staging-runtime.js";

/**
 * The only composition point for the activated staging provider. Resolver
 * failure happens inside CloudflarePagesReleaseProvider before the transport
 * asks the secret broker for a credential or performs network I/O.
 */
export function composeCloudflareStagingReleaseProvider(input: Readonly<{
  binding: CloudflareStagingBinding;
  environmentKey: string;
  store: ReviewedAstroArtifactStore;
  phases: DeliveryPhaseStore;
  secrets: DotenvxSecretBroker;
  fetcher?: typeof fetch;
}>): Readonly<{ provider: CloudflarePagesReleaseProvider; resolver: ReviewedAstroArtifactResolver }> {
  const resolver = new ReviewedAstroArtifactResolver(input.store, {
    tenantId: input.binding.tenantId,
    siteId: input.binding.siteId,
    environment: "staging",
    environmentKey: input.environmentKey
  });
  const fetcher = input.fetcher ? { fetcher: input.fetcher } : {};
  const provider = new CloudflarePagesReleaseProvider({
    projectKey: input.binding.cloudflare.projectId,
    previewBranch: input.binding.cloudflare.previewBranch,
    productionBranch: input.binding.cloudflare.productionBranch,
    resolver,
    cloudflare: new FetchCloudflarePagesTransport({
      accountId: input.binding.cloudflare.accountId,
      projectKey: input.binding.cloudflare.projectId,
      productionBranch: input.binding.cloudflare.productionBranch,
      previewHostnameSuffix: input.binding.cloudflare.previewHostnameSuffix,
      productionHostname: input.binding.cloudflare.allowedHostname,
      apiToken: () => input.secrets.use(input.binding.cloudflare.tokenSecretRef, async (value) => value),
      ...fetcher
    }),
    phases: input.phases
  });
  return Object.freeze({ provider, resolver });
}
