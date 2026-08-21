import { createHash } from "node:crypto";

import { ContentError } from "./errors.js";
import { canonicalMarkdown } from "./markdown.js";

interface LegacyNode {
  readonly type: string;
  readonly children?: readonly LegacyNode[];
  readonly text?: string;
  readonly format?: number | string;
  readonly tag?: string;
  readonly listType?: string;
  readonly url?: string;
  readonly src?: string;
  readonly altText?: string;
}

export interface LegacyConversionResult {
  readonly markdown: string;
  readonly sourceArtifactHash: string;
  readonly sourceFormat: "lexical-json";
  readonly warnings: readonly string[];
}

export function convertLexicalToMarkdown(value: unknown): LegacyConversionResult {
  if (!isRecord(value) || !isRecord(value.root)) {
    throw new ContentError("LEGACY_DOCUMENT_INVALID", "Lexical artifact must contain a root node");
  }
  const artifact = stableJson(value);
  const warnings: string[] = [];
  const markdown = renderNode(value.root as unknown as LegacyNode, warnings, 0).trim();
  return Object.freeze({
    markdown: canonicalMarkdown(markdown),
    sourceArtifactHash: createHash("sha256").update(artifact).digest("hex"),
    sourceFormat: "lexical-json",
    warnings: Object.freeze(warnings)
  });
}

function renderNode(node: LegacyNode, warnings: string[], depth: number): string {
  const children = () => (node.children ?? []).map((child) => renderNode(child, warnings, depth + 1)).join("");
  switch (node.type) {
    case "root":
      return (node.children ?? []).map((child) => renderNode(child, warnings, depth)).join("\n\n");
    case "paragraph":
      return children();
    case "heading": {
      const level = /^h[1-6]$/.test(node.tag ?? "") ? Number(node.tag!.slice(1)) : 2;
      return `${"#".repeat(level)} ${children()}`;
    }
    case "quote":
      return children().split("\n").map((line) => `> ${line}`).join("\n");
    case "text":
      return formattedText(node.text ?? "", typeof node.format === "number" ? node.format : 0);
    case "linebreak":
      return "  \n";
    case "link": {
      if (!safeUrl(node.url)) throw new ContentError("LEGACY_LINK_UNSAFE", "Legacy link URL is unsafe");
      return `[${children()}](${node.url})`;
    }
    case "list": {
      const ordered = node.listType === "number";
      return (node.children ?? [])
        .map((child, index) => `${ordered ? `${index + 1}.` : "-"} ${renderNode(child, warnings, depth + 1).trim()}`)
        .join("\n");
    }
    case "listitem":
      return children();
    case "image":
    case "upload":
      if (!safeUrl(node.src)) throw new ContentError("LEGACY_ASSET_UNSAFE", "Legacy asset URL is unsafe");
      return `![${escapeLabel(node.altText ?? "")}](${node.src})`;
    case "horizontalrule":
      return "---";
    default:
      warnings.push(`Unsupported Lexical node rejected: ${node.type}`);
      throw new ContentError("LEGACY_NODE_UNSUPPORTED", `Lexical node ${node.type} is not supported`, {
        nodeType: node.type,
        depth
      });
  }
}

function formattedText(value: string, format: number): string {
  let result = value.replace(/([\\`*_[\]<>])/g, "\\$1");
  if ((format & 16) !== 0) return `\`${value.replaceAll("`", "\\`")}\``;
  if ((format & 1) !== 0) result = `**${result}**`;
  if ((format & 2) !== 0) result = `*${result}*`;
  if ((format & 4) !== 0) result = `~~${result}~~`;
  return result;
}

function safeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeLabel(value: string): string {
  return value.replace(/[\[\]\\]/g, "\\$&");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
