import { describe, expect, it } from "vitest";

import { convertLexicalToMarkdown } from "./legacy.js";

describe("legacy editor conversion", () => {
  it("converts a representative Lexical article deterministically", () => {
    const artifact = {
      root: {
        type: "root",
        children: [
          { type: "heading", tag: "h2", children: [{ type: "text", text: "Imported article", format: 1 }] },
          {
            type: "paragraph",
            children: [
              { type: "text", text: "Read the " },
              { type: "link", url: "/guide", children: [{ type: "text", text: "guide" }] },
              { type: "text", text: "." }
            ]
          },
          { type: "upload", src: "https://cdn.example/image.avif", altText: "Harbour" }
        ]
      }
    };
    const first = convertLexicalToMarkdown(artifact);
    const second = convertLexicalToMarkdown({ root: artifact.root });
    expect(first.markdown).toContain("## **Imported article**");
    expect(first.markdown).toContain("[guide](/guide)");
    expect(first.markdown).toContain("![Harbour](https://cdn.example/image.avif)");
    expect(first.sourceArtifactHash).toBe(second.sourceArtifactHash);
    expect(first.warnings).toEqual([]);
  });

  it("fails closed on unsupported or unsafe legacy nodes", () => {
    expect(() => convertLexicalToMarkdown({ root: { type: "root", children: [{ type: "embed", html: "<x>" }] } }))
      .toThrow(/is not supported/);
    expect(() => convertLexicalToMarkdown({
      root: { type: "root", children: [{ type: "image", src: "javascript:alert(1)", altText: "bad" }] }
    })).toThrow(/unsafe/);
  });
});
