import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AuthorizationContext } from "./authorization.js";
import { InMemoryQuotaMeter, KillSwitchRegistry } from "./limits.js";
import { assertSafeProjection } from "./redaction.js";
import { InMemoryEncryptedSecretStore, SecretBroker, type SecretReference } from "./secrets.js";
import { assertObjectKeyScope, scopedObjectKey } from "./storage.js";

const context: AuthorizationContext = {
  tenantId: "tenant-1",
  siteId: "site-1",
  principal: { id: "service-1", kind: "service", issuer: "https://id.example", subject: "service-1" },
  layers: [{ name: "principal", permissions: ["secrets:use"] }]
};

describe("security controls", () => {
  it("brokers an encrypted secret only to the declared plugin without serializing it", async () => {
    const store = new InMemoryEncryptedSecretStore(randomBytes(32));
    const broker = new SecretBroker(store, () => new Date("2026-08-21T00:00:00Z"));
    const reference: SecretReference = {
      id: "secret-1",
      tenantId: "tenant-1",
      siteId: "site-1",
      provider: "test",
      label: "Publishing credential",
      createdAt: "2026-08-21T00:00:00Z"
    };
    await store.put(reference, Buffer.from("highly-sensitive"));
    const result = await broker.use(
      context,
      { reference, pluginId: "renderer", allowedPluginIds: ["renderer"] },
      async (plaintext, receipt) => ({ value: Buffer.from(plaintext).toString("utf8"), receipt })
    );
    expect(result.value).toBe("highly-sensitive");
    expect(JSON.stringify(reference)).not.toContain("highly-sensitive");
    await expect(
      broker.use(context, { reference, pluginId: "seo", allowedPluginIds: ["renderer"] }, async () => undefined)
    ).rejects.toMatchObject({ code: "SECRET_PLUGIN_DENIED" });
  });

  it("constructs canonical site-scoped object keys and rejects traversal", () => {
    const scope = { tenantId: "tenant-1", siteId: "site-1", environmentId: "production" };
    const key = scopedObjectKey(scope, "media/hero.avif");
    expect(key).toBe("tenants/tenant-1/sites/site-1/environments/production/media/hero.avif");
    expect(() => scopedObjectKey(scope, "../site-2/secret.jpg")).toThrow(/unsafe path segment/);
    expect(() => assertObjectKeyScope({ ...scope, siteId: "site-2" }, key)).toThrow(/another scope/);
  });

  it("meters quota atomically in the reference implementation and honors kill switches", () => {
    const scope = { tenantId: "tenant-1", siteId: "site-1", pluginId: "seo" };
    const meter = new InMemoryQuotaMeter();
    meter.setLimit(scope, "model.tokens", 100);
    meter.consume(scope, "model.tokens", 80);
    expect(() => meter.consume(scope, "model.tokens", 21)).toThrow(/Quota exceeded/);

    const switches = new KillSwitchRegistry();
    switches.enable({ level: "plugin", ...scope, reason: "Provider incident" });
    expect(() => switches.assertEnabled(scope)).toThrow(/Provider incident/);
  });

  it("rejects sensitive fields from projections", () => {
    expect(() => assertSafeProjection({ articleId: "one", nested: { access_token: "nope" } })).toThrow(
      /Sensitive field rejected/
    );
    expect(() => assertSafeProjection({ referenceId: "secret-1", pluginId: "renderer" })).not.toThrow();
  });
});
