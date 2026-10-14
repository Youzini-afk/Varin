/** Owner-scoped knowledge selected for a native context checkpoint. */
export interface KnowledgeRecallItem {
  id: number;
  title: string;
  trigger: string;
  scope?: "workspace" | "user" | "bot" | "session";
  nature?: string;
  sourceKind?: string;
}

export interface KnowledgeRecallInvalidation {
  id: number;
  scope: "workspace" | "user" | "bot" | "session";
}

/** A previously delivered row and the accepted successor that replaces it. */
export interface KnowledgeRecallCorrection extends KnowledgeRecallItem {
  scope: "workspace" | "user" | "bot" | "session";
  supersedes: number;
}

export interface KnowledgeRecallMaterial {
  knowledge: KnowledgeRecallItem[];
  knowledgeInvalidations?: KnowledgeRecallInvalidation[];
  knowledgeCorrections?: KnowledgeRecallCorrection[];
}
