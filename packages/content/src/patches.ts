import { ContentError } from "./errors.js";
import { canonicalMarkdown, contentHash, parseMarkdown } from "./markdown.js";
import type {
  ContentAst,
  DirectiveDefinition,
  RevisionDiff,
  RevisionDiffLine,
  StructuralPatchOperation
} from "./model.js";

export interface PatchResult {
  readonly source: string;
  readonly sourceHash: string;
  readonly ast: ContentAst;
  readonly diff: RevisionDiff;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly nodeId: string;
}

export function applyStructuralPatch(input: {
  readonly source: string;
  readonly baseSourceHash: string;
  readonly operations: readonly StructuralPatchOperation[];
  readonly directives?: readonly DirectiveDefinition[];
}): PatchResult {
  const directives = input.directives ?? [];
  const source = canonicalMarkdown(input.source, directives);
  const actualHash = contentHash(source);
  if (actualHash !== input.baseSourceHash) {
    throw new ContentError("REVISION_CONFLICT", "The revision changed after the patch was prepared", {
      expectedHash: input.baseSourceHash,
      actualHash
    });
  }
  if (input.operations.length === 0) {
    throw new ContentError("PATCH_EMPTY", "A structural patch must contain at least one operation");
  }
  const ast = parseMarkdown(source, directives);
  const nodeIndex = new Map(ast.nodes.map((node) => [node.id, node]));
  const touched = new Set<string>();
  const edits: Edit[] = input.operations.map((operation) => {
    if (touched.has(operation.nodeId)) {
      throw new ContentError("PATCH_NODE_DUPLICATE", `Node ${operation.nodeId} is targeted more than once`);
    }
    touched.add(operation.nodeId);
    const node = nodeIndex.get(operation.nodeId);
    if (!node) throw new ContentError("PATCH_NODE_NOT_FOUND", `Node ${operation.nodeId} does not exist`);
    switch (operation.op) {
      case "replaceText":
        if (node.type !== "text" && node.type !== "inlineCode" && node.type !== "code") {
          throw new ContentError("PATCH_NODE_TYPE_INVALID", `replaceText cannot target ${node.type}`);
        }
        return { start: node.start, end: node.end, replacement: escapeText(operation.value, node.type), nodeId: node.id };
      case "replaceNode":
        return { start: node.start, end: node.end, replacement: fragment(operation.markdown, directives), nodeId: node.id };
      case "insertAfter":
        if (node.parentId) {
          throw new ContentError("PATCH_NODE_TYPE_INVALID", "insertAfter must target a top-level block node");
        }
        return {
          start: node.end,
          end: node.end,
          replacement: `\n\n${fragment(operation.markdown, directives).trim()}\n`,
          nodeId: node.id
        };
      case "remove":
        return { start: node.start, end: node.end, replacement: "", nodeId: node.id };
    }
  });

  assertNonOverlapping(edits);
  let patched = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    patched = `${patched.slice(0, edit.start)}${edit.replacement}${patched.slice(edit.end)}`;
  }
  const canonical = canonicalMarkdown(patched, directives);
  const patchedAst = parseMarkdown(canonical, directives);
  return Object.freeze({
    source: canonical,
    sourceHash: patchedAst.sourceHash,
    ast: patchedAst,
    diff: compareMarkdown(source, canonical)
  });
}

export function compareMarkdown(from: string, to: string): RevisionDiff {
  const before = from.replace(/\n$/, "").split("\n");
  const after = to.replace(/\n$/, "").split("\n");
  const matrix = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      matrix[left]![right] = before[left] === after[right]
        ? 1 + matrix[left + 1]![right + 1]!
        : Math.max(matrix[left + 1]![right]!, matrix[left]![right + 1]!);
    }
  }
  const lines: RevisionDiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      lines.push({ kind: "context", line: before[left]! });
      left += 1;
      right += 1;
    } else if (matrix[left + 1]![right]! >= matrix[left]![right + 1]!) {
      lines.push({ kind: "remove", line: before[left]! });
      left += 1;
    } else {
      lines.push({ kind: "add", line: after[right]! });
      right += 1;
    }
  }
  while (left < before.length) lines.push({ kind: "remove", line: before[left++]! });
  while (right < after.length) lines.push({ kind: "add", line: after[right++]! });
  return Object.freeze({ fromHash: contentHash(from), toHash: contentHash(to), lines: Object.freeze(lines) });
}

function fragment(markdown: string, directives: readonly DirectiveDefinition[]): string {
  return canonicalMarkdown(markdown, directives).trimEnd();
}

function escapeText(value: string, type: string): string {
  if (value.includes("\n") && type !== "code") {
    throw new ContentError("PATCH_TEXT_MULTILINE", "Inline text replacements cannot contain a newline");
  }
  if (type === "code") return value;
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function assertNonOverlapping(edits: readonly Edit[]): void {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.start < previous.end) {
      throw new ContentError("PATCH_RANGE_OVERLAP", "Patch operations target overlapping AST ranges", {
        firstNodeId: previous.nodeId,
        secondNodeId: current.nodeId
      });
    }
  }
}
