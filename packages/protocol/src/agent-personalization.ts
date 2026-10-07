/** Ordinary assistants have scoped persistent notes; Bot memory has its own owner. */
export type AgentMemoryScope = { kind: "global" } | { kind: "project" | "session"; id: string };
export interface AgentMemoryNote {
  id: number;
  scope: AgentMemoryScope;
  content: string;
  source?: { sessionId?: string; label: string };
  updatedAt: string;
}
export interface AgentPromptProfile {
  /** Only edited sections are stored. Unedited native sections continue to update. */
  sections: Record<string, string | null>;
}
export interface AgentPersonalizationCatalog {
  revision: number;
  memories: AgentMemoryNote[];
  prompts: Record<string, AgentPromptProfile>;
}
export interface AgentPersonalizationContext {
  mode: "agent" | "bot";
  revision: number;
  threadRole: "main" | "worker" | "read-only";
  projectId?: string;
  sessionId: string;
  profiles: Array<{ scope: AgentMemoryScope; profile: AgentPromptProfile }>;
  memories: AgentMemoryNote[];
}
/** A conversation checkpoint, not another writable memory authority. */
export interface AgentMemorySnapshot {
  revision: number;
  sessionId: string;
  projectId?: string;
  memories: AgentMemoryNote[];
}
export interface AgentMemoryChange {
  id: number;
  note: AgentMemoryNote | null;
}
export interface AgentMemoryMutation {
  revision: number;
  changes: AgentMemoryChange[];
}
export function renderAgentMemoryMutation(receipt: AgentMemoryMutation): string {
  return `Persistent memory receipt at revision ${receipt.revision}:\n${receipt.changes.map(change => change.note
    ? `- [${change.id}] [${change.note.scope.kind}] ${change.note.content}`
    : `- [${change.id}] deleted; this entry is no longer active.`).join('\n')}`;
}
export interface AgentSystemPromptSnapshot {
  sessionId: string;
  mode: "agent" | "bot";
  /** Native current prompt, including tools, files and extensions. */
  original: Record<string, string>;
  sections: Record<string, string>;
  content: string;
  personalization: AgentPersonalizationContext;
  memorySnapshot?: AgentMemorySnapshot;
  pendingMemoryChanges?: AgentMemoryChange[];
  lastRequest?: { content: string; timestamp: number };
}
export const agentScopeKey = (scope: AgentMemoryScope): string => scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;

export function splitAgentSystemPrompt(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const pattern = /^<([a-z][a-z0-9_-]*)>\n([\s\S]*?)\n<\/\1>(?=\s*$|\n\n)/gm;
  let end = 0;
  for (const match of content.matchAll(pattern)) {
    const before = content.slice(end, match.index).trim();
    if (before) sections.preamble = [sections.preamble, before].filter(Boolean).join("\n\n");
    sections[match[1]!] = match[2]!;
    end = match.index! + match[0].length;
  }
  const tail = content.slice(end).trim();
  if (tail) sections.preamble = [sections.preamble, tail].filter(Boolean).join("\n\n");
  return { preamble: sections.preamble ?? "", ...sections };
}

/** Pi uses an untagged preamble followed by named XML sections. */
export function renderAgentSystemPrompt(sections: Record<string, string>): string {
  return Object.entries(sections).filter(([, value]) => value.length > 0)
    .map(([key, value]) => key === "preamble" ? value : `<${key}>\n${value}\n</${key}>`).join("\n\n");
}

export function personalizeAgentSystemPrompt(original: Record<string, string>, context: AgentPersonalizationContext): Record<string, string> {
  const sections = { ...original };
  if (context.mode === "bot") return sections;
  for (const { profile } of context.profiles) for (const [key, value] of Object.entries(profile.sections)) {
    if (value === null) delete sections[key];
    else sections[key] = value;
  }
  return applyAgentMemorySnapshot(sections, context);
}

export function applyAgentMemorySnapshot(original: Record<string, string>, snapshot: Pick<AgentMemorySnapshot, "revision" | "memories">): Record<string, string> {
  const sections = { ...original };
  for (const key of Object.keys(sections)) if (key.startsWith("agent_memory_")) delete sections[key];
  if (snapshot.memories.length) sections.agent_memory_snapshot = `Persistent memory snapshot at revision ${snapshot.revision}. It contains the active entries at that revision. Higher-revision receipts replace or remove entries by ID; older receipts are historical.`;
  for (const kind of ["global", "project", "session"] as const) {
    const notes = snapshot.memories.filter(note => note.scope.kind === kind);
    if (notes.length) sections[`agent_memory_${kind}`] = notes.map(note => `- [${note.id}] ${note.content}`).join("\n");
  }
  return sections;
}
