/** Trusted delivery metadata, never inferred from editorial prose or comments. */
export interface SiteDeliveryContext {
  readonly environmentKey: string;
  readonly releaseId: string | null;
  readonly policyDigest: string;
  readonly routes: readonly {
    readonly path: string; readonly locale: string; readonly documentId: string; readonly variantId: string;
    readonly revisionId: string; readonly typeName: string; readonly sectionId: string;
    readonly componentId: string; readonly dataSource: string; readonly fields: readonly string[];
  }[];
  readonly redirects: readonly { readonly from: string; readonly to: string; readonly status: 301 }[];
  readonly integrations: Readonly<Record<string, string>>;
  readonly components: readonly SiteComponent[];
}
export interface SiteComponent {
  readonly id: string;
  readonly version: string;
  readonly slots: readonly string[];
  readonly fields: readonly string[];
  readonly sourceOfTruth: string;
  readonly example: Readonly<Record<string, unknown>>;
}
