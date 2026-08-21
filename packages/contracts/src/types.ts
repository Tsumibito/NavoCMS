export const NAVOCMS_API_VERSION = "navocms.io/v0alpha1" as const;

export type NavoApiVersion = typeof NAVOCMS_API_VERSION;
export type PluginRuntimeKind = "kernel" | "module" | "service" | "ui" | "sandbox";
export type ConsequenceLevel = "G0" | "G1" | "G2" | "G3" | "G4";

export interface CapabilityRef {
  readonly name: string;
  readonly version: number;
}

export interface CapabilityRequirement extends CapabilityRef {
  readonly optional?: boolean;
}

export interface PluginEffect {
  readonly name: string;
  readonly consequence: ConsequenceLevel;
  readonly idempotent: boolean;
  readonly compensation?: string;
}

export interface PluginManifest {
  readonly apiVersion: NavoApiVersion;
  readonly kind: "PluginManifest";
  readonly metadata: {
    readonly id: string;
    readonly version: string;
    readonly displayName: string;
    readonly description: string;
  };
  readonly spec: {
    readonly runtime: PluginRuntimeKind;
    readonly provides: readonly CapabilityRef[];
    readonly requires: readonly CapabilityRequirement[];
    readonly subscribes?: readonly string[];
    readonly permissions: {
      readonly data: {
        readonly read: readonly string[];
        readonly write: readonly string[];
      };
      readonly network: readonly string[];
      readonly scopes: readonly string[];
    };
    readonly effects: readonly PluginEffect[];
    readonly configSchema?: string;
    readonly healthcheck?: string;
  };
}

export interface SiteAnchor {
  readonly ref: string;
  readonly version: string;
  readonly digest: string;
}

export interface SiteProfile {
  readonly apiVersion: NavoApiVersion;
  readonly kind: "SiteProfile";
  readonly metadata: {
    readonly name: string;
    readonly version: string;
    readonly displayName: string;
  };
  readonly spec: {
    readonly environment: "development" | "preview" | "production";
    readonly locales: {
      readonly default: string;
      readonly supported: readonly string[];
    };
    readonly anchors: {
      readonly content: SiteAnchor;
      readonly design: SiteAnchor;
      readonly delivery: SiteAnchor;
      readonly governance: SiteAnchor;
    };
    readonly plugins: readonly {
      readonly id: string;
      readonly version: string;
      readonly enabled: boolean;
      readonly configRef?: string;
    }[];
    readonly bindings: readonly {
      readonly capability: string;
      readonly version: number;
      readonly provider: string;
    }[];
    readonly urlPolicy: {
      readonly canonicalHost: string;
      readonly immutablePublicUrls: true;
    };
  };
}

export interface ContentTypeDefinition {
  readonly apiVersion: NavoApiVersion;
  readonly kind: "ContentType";
  readonly metadata: {
    readonly name: string;
    readonly version: string;
    readonly title: string;
    readonly description: string;
  };
  readonly spec: {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly relations: readonly Readonly<Record<string, unknown>>[];
    readonly localization: Readonly<Record<string, unknown>>;
    readonly indexes: readonly Readonly<Record<string, unknown>>[];
    readonly rendererCapabilities: readonly string[];
    readonly defaultWorkflow: string;
    readonly permissions: Readonly<Record<string, readonly string[]>>;
    readonly retentionClass: "permanent" | "published-history" | "operational" | "pii-restricted";
  };
}

export interface EventActor {
  readonly type: "human" | "agent" | "service" | "system";
  readonly id: string;
}

export interface EventArtifact {
  readonly uri: string;
  readonly mediaType: string;
  readonly digest: string;
}

export interface DomainEvent<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject?: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly navotenantid: string;
  readonly navositeid: string;
  readonly navocorrelationid: string;
  readonly navocausationid?: string;
  readonly navoconsequence: ConsequenceLevel;
  readonly navoidempotencykey?: string;
  readonly navoschemaversion: number;
  readonly navoactor: EventActor;
  readonly artifacts?: readonly EventArtifact[];
  readonly data: TData;
}
