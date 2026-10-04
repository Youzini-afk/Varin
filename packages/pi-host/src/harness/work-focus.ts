import type { WorkFocusId } from "@varin/protocol";

const RESEARCH_TOOLS = ["research_search", "research_decide", "materials", "experiment", "resources", "research_source"];

/** Work focus changes the native tool registry without adding model instructions. */
export const excludedWorkFocusTools = (focus: WorkFocusId): string[] => focus === "research" ? [] : [...RESEARCH_TOOLS];
