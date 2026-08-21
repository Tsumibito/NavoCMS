export class McpEditingError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "McpEditingError";
    this.code = code;
  }
}
