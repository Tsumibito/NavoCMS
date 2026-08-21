import type { CompiledDesignSystem } from "@navocms/design";

export interface AstroComponentRegistration {
  readonly id: string;
  readonly module: string;
  readonly exportName?: string;
}

export interface AstroDesignAdapter {
  readonly digest: CompiledDesignSystem["digest"];
  readonly css: string;
  readonly components: ReadonlyMap<string, AstroComponentRegistration>;
  readonly recipes: readonly {
    readonly id: string;
    readonly slots: readonly { readonly id: string; readonly componentModule: string }[];
  }[];
}

export class AstroDesignAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AstroDesignAdapterError";
  }
}

export function createAstroDesignAdapter(
  design: CompiledDesignSystem,
  registrations: readonly AstroComponentRegistration[]
): AstroDesignAdapter {
  const duplicate = registrations.find(
    (registration, index) => registrations.findIndex(({ id }) => id === registration.id) !== index
  );
  if (duplicate) throw new AstroDesignAdapterError(`Duplicate Astro component registration: ${duplicate.id}`);

  const components = new Map(registrations.map((registration) => [registration.id, registration]));
  for (const id of design.components.keys()) {
    if (!components.has(id)) throw new AstroDesignAdapterError(`Missing Astro component registration: ${id}`);
  }
  for (const id of components.keys()) {
    if (!design.components.has(id)) throw new AstroDesignAdapterError(`Unknown Astro component registration: ${id}`);
  }

  return {
    digest: design.digest,
    css: design.css,
    components,
    recipes: [...design.recipes.values()].map((recipe) => ({
      id: recipe.id,
      slots: recipe.slots.map((slot) => ({
        id: slot.id,
        componentModule: components.get(slot.component)?.module ?? ""
      }))
    }))
  };
}
