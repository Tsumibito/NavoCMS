export class DesignContractError extends Error {
  public readonly code:
    | "TOKEN_CYCLE"
    | "TOKEN_REFERENCE_MISSING"
    | "OVERRIDE_DENIED"
    | "OVERRIDE_EXPIRED"
    | "OVERRIDE_TARGET_MISMATCH";

  public constructor(code: DesignContractError["code"], message: string) {
    super(message);
    this.name = "DesignContractError";
    this.code = code;
  }
}
