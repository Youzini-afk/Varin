export class VarinExtensionContractError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "VarinExtensionContractError";
    this.issues = issues;
  }
}
