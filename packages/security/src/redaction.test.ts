import { describe, expect, it } from "vitest";

import { assertSafeProjection } from "./redaction.js";

describe("safe projections", () => {
  it("rejects sensitive fields without rejecting opaque references", () => {
    expect(() => assertSafeProjection({ articleId: "one", nested: { access_token: "nope" } })).toThrow(
      /Sensitive field rejected/
    );
    expect(() => assertSafeProjection({ referenceId: "secret-1", pluginId: "renderer" })).not.toThrow();
  });
});
