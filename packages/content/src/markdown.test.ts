import { describe, expect, it } from "vitest";

import { canonicalMarkdown, parseMarkdown } from "./markdown.js";
import { applyStructuralPatch, compareMarkdown } from "./patches.js";

const directives = [
  { name: "callout", kind: "containerDirective", allowedAttributes: ["tone"] },
  { name: "cta", kind: "leafDirective", allowedAttributes: ["label", "href"], requiredAttributes: ["label", "href"] }
] as const;

describe("canonical Markdown and structural patches", () => {
  it("accepts GFM and declared directives but rejects HTML and unknown directives", () => {
    const source = "# Hello\n\n:::callout{tone=note}\nA safe note.\n:::\n\n::cta{label=Read href=/read}\n";
    expect(canonicalMarkdown(source, directives)).toContain(":::callout{tone=\"note\"}");
    expect(() => canonicalMarkdown("<script>alert(1)</script>\n", directives)).toThrow(/Raw HTML/);
    expect(() => canonicalMarkdown("::unknown{x=y}\n", directives)).toThrow(/is not allowed/);
    expect(() => canonicalMarkdown("[bad](javascript:alert(1))\n", directives)).toThrow(/Unsafe URL/);
    expect(() => canonicalMarkdown("::cta{label=Bad href=javascript:alert(1)}\n", directives)).toThrow(/Unsafe URL/);
  });

  it("keeps IDs stable for unchanged unique nodes across unrelated insertions", () => {
    const first = parseMarkdown("# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n");
    const second = parseMarkdown("# Title\n\nNew paragraph.\n\nAlpha paragraph.\n\nBeta paragraph.\n");
    const betaOne = first.nodes.find((node) => node.type === "paragraph" && node.text === "Beta paragraph.");
    const betaTwo = second.nodes.find((node) => node.type === "paragraph" && node.text === "Beta paragraph.");
    expect(betaOne?.id).toBe(betaTwo?.id);
  });

  it("patches an AST node and rejects a stale source hash", () => {
    const source = canonicalMarkdown("# Hello\n\nWelcome, world.\n");
    const ast = parseMarkdown(source);
    const target = ast.nodes.find((node) => node.type === "text" && node.text === "Welcome, world.");
    expect(target).toBeDefined();
    const patched = applyStructuralPatch({
      source,
      baseSourceHash: ast.sourceHash,
      operations: [{ op: "replaceText", nodeId: target!.id, value: "Welcome, agents." }]
    });
    expect(patched.source).toContain("Welcome, agents.");
    expect(patched.diff.lines).toContainEqual({ kind: "remove", line: "Welcome, world." });
    expect(() =>
      applyStructuralPatch({
        source,
        baseSourceHash: "0".repeat(64),
        operations: [{ op: "replaceText", nodeId: target!.id, value: "Stale" }]
      })
    ).toThrow(/changed after the patch/);
  });

  it("bounds adversarial large-document comparisons without a quadratic matrix", () => {
    const from = Array.from({ length: 30_000 }, (_, index) => `before ${index}`).join("\n");
    const to = Array.from({ length: 30_000 }, (_, index) => `after ${index}`).join("\n");
    const started = performance.now();
    const diff = compareMarkdown(from, to);
    expect(diff.lines).toHaveLength(60_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
