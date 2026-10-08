import { organizeEslint } from "./eslint.js";
import { organizeGeneric } from "./generic.js";
import { organizeGit } from "./git.js";
import { identifyShellOutput, type OrganizedCommandKind } from "./identify.js";
import { organizePackageManager } from "./package-manager.js";
import { normalizeShellText, organizeBudget, SHELL_DISPLAY_BUDGET } from "./text.js";
import { organizeTsc } from "./tsc.js";
import { organizeVitest } from "./vitest.js";

export type { OrganizedCommandKind } from "./identify.js";
export { identifyFromCommand, identifyShellOutput } from "./identify.js";
export { SHELL_DISPLAY_BUDGET, utf8Bytes } from "./text.js";

export type OrganizedShellOutput = {
  kind: OrganizedCommandKind;
  text: string;
  omitted: boolean;
  partial: boolean;
  recognized: boolean;
};

export function organizeShellOutput(input: {
  command: string;
  output: string;
  complete: boolean;
  exitCode?: number | null;
  budget?: number;
}): OrganizedShellOutput {
  const normalized = normalizeShellText(input.output);
  const budget = organizeBudget(input.budget ?? SHELL_DISPLAY_BUDGET);
  const partial = !input.complete;
  const identified = identifyShellOutput(input.command, normalized);
  const pmOrganized = identified.kind === "package-manager"
    ? organizePackageManager(normalized, budget, input.exitCode)
    : undefined;
  const organized = identified.kind === "vitest"
    ? organizeVitest(normalized, budget)
    : identified.kind === "tsc"
      ? organizeTsc(normalized, budget, input.exitCode)
      : identified.kind === "eslint"
        ? organizeEslint(normalized, budget)
        : identified.kind === "git"
          ? organizeGit(normalized, identified.gitSubcommand, budget, input.exitCode)
          : pmOrganized ?? { ...organizeGeneric(normalized, budget), recognized: false };
  // A package-manager command whose echo/body resolved to a known tool reports
  // that tool's kind — the display is that tool's organization plus the PM
  // framing lines, which remain visible in the text.
  const kind = !organized.recognized
    ? "generic"
    : pmOrganized?.innerKind ?? identified.kind;
  return {
    kind,
    text: organized.text,
    omitted: organized.omitted,
    partial,
    recognized: organized.recognized,
  };
}
