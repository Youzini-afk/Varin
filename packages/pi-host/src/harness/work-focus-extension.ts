import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { WorkFocusId } from "@varin/protocol";

const RESEARCH_TOOLS = ["research_search", "research_decide", "materials", "experiment", "resources", "research_source"];

export const excludedWorkFocusTools = (focus: WorkFocusId): string[] => focus === "research" ? [] : [...RESEARCH_TOOLS];

export const RESEARCH_WORK_FOCUS_PROMPT = [
  "<varin-work-focus id=\"research\">",
  "Act as the principal researcher for the user's scientific work. Use the current session model for the main research line.",
  "Turn an open question or anomaly into competing explanations and actions that can distinguish them. Use the installed read, search, web, code, shell, and thread tools as the work requires; research is not a restriction on programming or execution.",
  "Delegate only independent research routes that benefit from separate context. Keep claims tied to the source text, code, command output, result, or durable artifact that supports them. Distinguish implementation, environment, data, and scientific outcomes.",
  "Synthesize discoveries when they change the direction of the work. Preserve unresolved conflicts and useful negative results, and propose the next action by how much it can change the current understanding.",
  "</varin-work-focus>",
].join("\n");

export const RESEARCH_BRANCH_WORK_FOCUS_PROMPT = [
  "<varin-work-focus id=\"research\" role=\"branch\">",
  "You are an independent research branch working on the bounded task assigned by the parent research line.",
  "Use the installed read, search, web, code, and shell tools needed for that task. Keep findings tied to actual sources, code, command output, results, or durable artifacts, and distinguish implementation, environment, data, and scientific outcomes.",
  "Return the useful result, conflicts, and unresolved questions to the parent. Do not take over the principal research line or broaden the assigned scope without a concrete dependency.",
  "</varin-work-focus>",
].join("\n");

/** A fixed Zone 0 fragment selected before a Pi run starts. */
export function createWorkFocusExtension(
  getFocus: () => WorkFocusId,
  getRole: () => "principal" | "branch",
): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      if (getFocus() !== "research") return undefined;
      const fragment = getRole() === "branch"
        ? RESEARCH_BRANCH_WORK_FOCUS_PROMPT
        : RESEARCH_WORK_FOCUS_PROMPT;
      return { systemPrompt: `${event.systemPrompt}\n\n${fragment}` };
    });
  };
}
