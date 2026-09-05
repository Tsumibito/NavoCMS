import { describe, expect, it } from "vitest";

import { workflowHandoffMarkup, workflowReady } from "./widget-view.js";

const previewed = {
  status: "previewed",
  workflow: "navocms.editorial.standard.v1",
  nextStep: "approve-exact-release",
  previewUrl: "https://preview.example.test/previews/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abc",
  expiresAt: "2026-09-05T22:00:00.000Z",
  sourceHash: "a".repeat(64)
};

describe("preview handoff widget view", () => {
  it("renders a valid previewed payload as ready with the capability link", () => {
    expect(workflowReady(previewed.status)).toBe(true);
    const markup = workflowHandoffMarkup(previewed);
    expect(markup).toContain("Revision is bound");
    expect(markup).toContain(`<a href="${previewed.previewUrl}"`);
    expect(markup).toContain(previewed.expiresAt);
    expect(markup).toContain("approve-exact-release");
    expect(markup).not.toContain("Blocked");
  });

  it("accepts the legacy ready-for-workflow status for compatibility", () => {
    expect(workflowReady("ready-for-workflow")).toBe(true);
    expect(workflowHandoffMarkup({ ...previewed, status: "ready-for-workflow" })).toContain("Revision is bound");
  });

  it("renders an honest limitation instead of claiming a real design preview", () => {
    const markup = workflowHandoffMarkup(previewed);
    expect(markup).toContain("Markdown proof artifact");
    expect(markup).toContain("not the final site design preview");
  });

  it("renders unknown statuses as blocked without a capability link", () => {
    expect(workflowReady("unknown-status")).toBe(false);
    expect(workflowReady(undefined)).toBe(false);
    const markup = workflowHandoffMarkup({ status: "unknown-status", note: "Nothing was prepared." });
    expect(markup).toContain("Preview is blocked");
    expect(markup).toContain("Not created");
    expect(markup).not.toContain("<a ");
  });

  it("escapes untrusted strings before embedding them in markup", () => {
    const markup = workflowHandoffMarkup({
      ...previewed,
      note: '<script>alert("xss")</script>'
    });
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});
