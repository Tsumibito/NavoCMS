import { z } from "zod";
const label = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const element = z.string().regex(/^[A-Za-z0-9_-]{1,128}:(body|media)$/);
export const pageDesignOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["variant", "component", "tone"]), elementId: element, value: label }).strict(),
  z.object({ op: z.literal("move"), elementId: element, value: element.optional() }).strict(),
  z.object({ op: z.literal("remove"), elementId: element }).strict(),
  z.object({ op: z.enum(["recipe", "gap"]), value: label }).strict()
]);
export const pageChangeShape = {
  revisionId: z.string().uuid(), baseSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("replaceText"), nodeId: z.string().min(1).max(180), value: z.string().max(20000) }).strict(),
    z.object({ op: z.literal("replaceNode"), nodeId: z.string().min(1).max(180), markdown: z.string().max(20000) }).strict(),
    z.object({ op: z.literal("insertAfter"), nodeId: z.string().min(1).max(180), markdown: z.string().max(20000) }).strict(),
    z.object({ op: z.literal("remove"), nodeId: z.string().min(1).max(180) }).strict()
  ])).max(20).default([]),
  metadataPatch: z.record(z.string(), z.unknown()).optional(), designOperations: z.array(pageDesignOperationSchema).max(20).default([]),
  idempotencyKey: z.string().min(16).max(160)
};
export const pageChangeSchema = z.object(pageChangeShape).strict();
export type PageChangeInput = z.infer<typeof pageChangeSchema>;
export const pageCommentShape = { revisionId: z.string().uuid(), elementId: element, field: z.enum(["title", "body", "media"]), text: z.string().trim().min(1).max(2000), viewport: z.object({ width: z.number().int().min(240).max(7680), height: z.number().int().min(240).max(7680) }).strict().optional(), idempotencyKey: z.string().min(16).max(160) };
export const pageCommentSchema = z.object(pageCommentShape).strict();
