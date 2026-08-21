import { readFile } from "node:fs/promises";

import { compileDesignSystem } from "@navocms/design";
import { describe, expect, it } from "vitest";

import { AstroDesignAdapterError, createAstroDesignAdapter } from "./index.js";

async function design() {
  const input = JSON.parse(
    await readFile(
      new URL("../../../examples/design-systems/tidal-signal.design-system.json", import.meta.url),
      "utf8"
    )
  ) as unknown;
  return compileDesignSystem(input);
}

const registrations = [
  { id: "signal-button", module: "./components/SignalButton.astro" },
  { id: "story-card", module: "./components/StoryCard.astro" },
  { id: "section-shell", module: "./components/SectionShell.astro" }
] as const;

describe("Astro design adapter", () => {
  it("binds the complete design graph", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    expect(adapter.recipes[0]?.slots).toHaveLength(3);
    expect(adapter.css).toContain(":root");
  });

  it("fails closed when a component has no renderer", async () => {
    const compiled = await design();
    expect(() => createAstroDesignAdapter(compiled, registrations.slice(1))).toThrowError(
      AstroDesignAdapterError
    );
  });
});
