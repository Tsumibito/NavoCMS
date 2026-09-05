/**
 * Effect state of the operation an error belongs to. Clients use it to tell
 * "nothing happened" apart from "the external effect happened but the workflow
 * is incomplete" instead of a generic rejection.
 */
export type ErrorEffectState = "none" | "applied" | "unknown";

export class McpEditingError extends Error {
  public readonly code: string;
  public readonly effectState: ErrorEffectState;
  public readonly nextAction: string | undefined;

  public constructor(
    code: string,
    message: string,
    options: { readonly effectState?: ErrorEffectState; readonly nextAction?: string } = {}
  ) {
    super(message);
    this.name = "McpEditingError";
    this.code = code;
    this.effectState = options.effectState ?? "none";
    this.nextAction = options.nextAction;
  }
}
