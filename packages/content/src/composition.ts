import { ContentError } from "./errors.js";

export interface PageSection {
  readonly id: string;
  readonly slot: "body" | "media";
  readonly componentId: "section-shell" | "story-card";
  readonly variant: "regular" | "compact";
  readonly tone: "plain" | "muted";
  readonly contentRef: { readonly revision: "self"; readonly field: "body" | "media" };
}
export interface PageComposition {
  readonly schema: "io.navocms.page-composition.v1";
  readonly recipe: "editorial" | "image-led";
  readonly gap: "regular" | "tight";
  readonly sections: readonly PageSection[];
}
export type PageDesignOperation = { readonly op: "variant" | "component" | "tone" | "move" | "remove"; readonly elementId: string; readonly value?: string | undefined } | { readonly op: "recipe" | "gap"; readonly value: string };
export const PAGE_DESIGN_POLICY = Object.freeze({ id: "navocms.editorial-page.v1", recipes: ["editorial", "image-led"], components: ["section-shell", "story-card"], variants: ["regular", "compact"], tones: ["plain", "muted"], gaps: ["regular", "tight"], slots: ["body", "media"], runtimeCode: false });
export function defaultPageComposition(variantId: string): PageComposition {
  return { schema: "io.navocms.page-composition.v1", recipe: "editorial", gap: "regular", sections: (["body", "media"] as const).map(slot => ({ id: `${variantId}:${slot}`, slot, componentId: "section-shell", variant: "regular", tone: "plain", contentRef: { revision: "self", field: slot } })) };
}
export function validatePageComposition(value: PageComposition, variantId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(variantId)) throw new ContentError("PAGE_COMPOSITION_INVALID", "Invalid variant ID");
  const valid = value?.schema === "io.navocms.page-composition.v1" && ["editorial", "image-led"].includes(value.recipe) && ["regular", "tight"].includes(value.gap) && Array.isArray(value.sections) && value.sections.length >= 1 && value.sections.length <= 2 && value.sections.filter(s => s.slot === "body").length === 1 && new Set(value.sections.map(s => s.id)).size === value.sections.length && value.sections.every(s => ["body", "media"].includes(s.slot) && s.id === `${variantId}:${s.slot}` && ["section-shell", "story-card"].includes(s.componentId) && ["regular", "compact"].includes(s.variant) && ["plain", "muted"].includes(s.tone) && s.contentRef?.revision === "self" && s.contentRef.field === s.slot && Object.keys(s).sort().join() === "componentId,contentRef,id,slot,tone,variant" && Object.keys(s.contentRef).sort().join() === "field,revision");
  if (!valid || Object.keys(value).sort().join() !== "gap,recipe,schema,sections") throw new ContentError("PAGE_COMPOSITION_INVALID", "Use the reviewed page design policy and stable section IDs");
}
export function applyPageDesign(current: PageComposition, variantId: string, operations: readonly PageDesignOperation[]): { composition: PageComposition; missingCapabilities: readonly string[] } {
  validatePageComposition(current, variantId);
  if (operations.length > 20) throw new ContentError("PAGE_DESIGN_BOUNDS", "At most 20 design operations are allowed");
  let composition = structuredClone(current); const missing: string[] = [];
  for (const operation of operations) {
    if (operation.op === "recipe") {
      if (!["editorial", "image-led"].includes(operation.value)) { missing.push(`recipe:${operation.value}`); continue; }
      composition = { ...composition, recipe: operation.value as PageComposition["recipe"], sections: [...composition.sections].sort((a, b) => (a.slot === "media" ? 1 : 0) - (b.slot === "media" ? 1 : 0)) };
      if (operation.value === "image-led") composition = { ...composition, sections: [...composition.sections].reverse() };
    } else if (operation.op === "gap") {
      if (!["regular", "tight"].includes(operation.value)) { missing.push(`gap:${operation.value}`); continue; }
      composition = { ...composition, gap: operation.value as PageComposition["gap"] };
    } else {
      if (!("elementId" in operation)) throw new ContentError("PAGE_DESIGN_INVALID", "Unsupported operation");
      const index = composition.sections.findIndex(s => s.id === operation.elementId);
      if (index < 0) throw new ContentError("PAGE_ELEMENT_NOT_FOUND", "The selected element no longer exists; reload this revision");
      const sections = [...composition.sections]; const section = sections[index]!;
      if (operation.op === "remove") { if (section.slot === "body") throw new ContentError("PAGE_BODY_REQUIRED", "The prose section cannot be removed"); sections.splice(index, 1); }
      else if (operation.op === "move") { if (operation.value === operation.elementId) continue; const target = operation.value ? sections.findIndex(s => s.id === operation.value) : sections.length; if (target < 0) throw new ContentError("PAGE_ELEMENT_NOT_FOUND", "The destination no longer exists"); sections.splice(index, 1); const at = operation.value ? sections.findIndex(s => s.id === operation.value) : sections.length; sections.splice(Math.max(0, at), 0, section); }
      else {
        const allowed = operation.op === "variant" ? ["regular", "compact"] : operation.op === "component" ? ["section-shell", "story-card"] : ["plain", "muted"];
        if (!allowed.includes(operation.value ?? "")) { missing.push(`${operation.op}:${operation.value ?? "missing"}`); continue; }
        sections[index] = { ...section, [operation.op === "component" ? "componentId" : operation.op]: operation.value } as PageSection;
      }
      composition = { ...composition, sections };
    }
  }
  validatePageComposition(composition, variantId);
  return { composition, missingCapabilities: missing };
}
