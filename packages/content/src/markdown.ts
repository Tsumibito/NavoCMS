import { createHash } from "node:crypto";

import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { ContentError } from "./errors.js";
import type { AstNodeDescriptor, ContentAst, DirectiveDefinition } from "./model.js";

interface PositionPoint {
  readonly offset?: number;
}

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly name?: string;
  readonly url?: string;
  readonly depth?: number;
  readonly lang?: string | null;
  readonly attributes?: Record<string, string | null> | null;
  readonly children?: readonly MarkdownNode[];
  readonly position?: { readonly start: PositionPoint; readonly end: PositionPoint };
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).use(remarkStringify, {
  bullet: "-",
  fences: true,
  listItemIndent: "one",
  emphasis: "*",
  strong: "*"
});

export function contentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function canonicalMarkdown(source: string, directives: readonly DirectiveDefinition[] = []): string {
  const root = processor.parse(normalizeInput(source)) as MarkdownNode;
  validateTree(root, directives);
  return processor.stringify(root as never).replace(/\n*$/, "\n");
}

export function parseMarkdown(source: string, directives: readonly DirectiveDefinition[] = []): ContentAst {
  const canonical = canonicalMarkdown(source, directives);
  const root = processor.parse(canonical) as MarkdownNode;
  validateTree(root, directives);
  const nodes: AstNodeDescriptor[] = [];
  const occurrences = new Map<string, number>();

  const walk = (node: MarkdownNode, parentId?: string): void => {
    if (node.type !== "root") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) {
        throw new ContentError("MARKDOWN_POSITION_MISSING", `Parser omitted offsets for ${node.type}`);
      }
      const text = textContent(node);
      const attributes = stringAttributes(node.attributes);
      const fingerprint = JSON.stringify({
        type: node.type,
        text,
        name: node.name,
        url: node.url,
        depth: node.depth,
        lang: node.lang,
        attributes
      });
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      const id = `n_${createHash("sha256").update(`${fingerprint}\0${occurrence}`).digest("hex").slice(0, 20)}`;
      nodes.push(
        Object.freeze({
          id,
          type: node.type,
          ...(parentId ? { parentId } : {}),
          start,
          end,
          text,
          ...(Object.keys(attributes).length > 0 ? { attributes: Object.freeze(attributes) } : {})
        })
      );
      for (const child of node.children ?? []) walk(child, id);
      return;
    }
    for (const child of node.children ?? []) walk(child, parentId);
  };
  walk(root);
  return Object.freeze({
    format: "navocms-markdown-ast/v1",
    parser: "remark-gfm-directive",
    sourceHash: contentHash(canonical),
    nodes: Object.freeze(nodes)
  });
}

function normalizeInput(source: string): string {
  if (source.includes("\0")) throw new ContentError("MARKDOWN_NUL_REJECTED", "Markdown cannot contain NUL bytes");
  return source.replace(/\r\n?/g, "\n");
}

function validateTree(root: MarkdownNode, definitions: readonly DirectiveDefinition[]): void {
  const directives = new Map(definitions.map((definition) => [definition.name, definition]));
  const walk = (node: MarkdownNode): void => {
    if (node.type === "html") {
      throw new ContentError("MARKDOWN_HTML_REJECTED", "Raw HTML is not allowed in canonical content");
    }
    if (typeof node.url === "string" && !safeContentUrl(node.url)) {
      throw new ContentError("MARKDOWN_URL_UNSAFE", `Unsafe URL rejected in ${node.type}`);
    }
    if (node.type.endsWith("Directive")) {
      const definition = node.name ? directives.get(node.name) : undefined;
      if (!definition || definition.kind !== node.type) {
        throw new ContentError("MARKDOWN_DIRECTIVE_UNKNOWN", `Directive ${node.name ?? "<unnamed>"} is not allowed`);
      }
      const attributes = stringAttributes(node.attributes);
      for (const [name, value] of Object.entries(attributes)) {
        if (/^(href|src|url)$/i.test(name) && !safeContentUrl(value)) {
          throw new ContentError("MARKDOWN_URL_UNSAFE", `Unsafe URL rejected in ${definition.name}.${name}`);
        }
      }
      const allowed = new Set(definition.allowedAttributes ?? []);
      const unexpected = Object.keys(attributes).find((attribute) => !allowed.has(attribute));
      if (unexpected) {
        throw new ContentError(
          "MARKDOWN_DIRECTIVE_ATTRIBUTE_UNKNOWN",
          `Attribute ${unexpected} is not allowed on ${definition.name}`
        );
      }
      const missing = (definition.requiredAttributes ?? []).find((attribute) => !(attribute in attributes));
      if (missing) {
        throw new ContentError(
          "MARKDOWN_DIRECTIVE_ATTRIBUTE_REQUIRED",
          `Attribute ${missing} is required on ${definition.name}`
        );
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
}

function textContent(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textContent).join("");
}

function stringAttributes(attributes: MarkdownNode["attributes"]): Record<string, string> {
  if (!attributes) return {};
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, value === null ? "" : String(value)])
  );
}

function safeContentUrl(value: string): boolean {
  if (value.startsWith("#")) return true;
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "mailto:" || parsed.protocol === "tel:";
  } catch {
    return false;
  }
}
