/** Conversation plans reuse the KnowledgeStore owner, not Pi session identity. */
export type PlanRef = string;
export interface PlanSnapshot {
  ref: PlanRef;
  threadId: string;
  branchId: string;
  sourceHeadId: string | null;
  previousRef: PlanRef | null;
  content: string;
  updatedBy: 'user' | 'agent';
  updatedAt: number;
}
export interface PlanForkBasis {
  sourceBranchId: string;
  headId: string | null;
  sourceInheritedRef: PlanRef | null;
}
export interface PlanView {
  threadId: string;
  branchId: string;
  headId: string | null;
  inheritedRef: PlanRef | null;
  /** Immutable Catalog creation evidence; null identifies a root or legacy branch. */
  forkBasis: PlanForkBasis | null;
}
export type PlanOrigin =
  | { kind: 'user'; key: string }
  | { kind: 'tool'; operationId: string; runId: string; requestId: string; callId: string; epoch: number };
export interface PlanSelection { latestRef: PlanRef | null; selectedRef: PlanRef | null }
export interface PlanCandidate {
  latestRef: PlanRef | null;
  candidate: Pick<PlanSnapshot, 'ref' | 'sourceHeadId' | 'previousRef' | 'updatedAt'> | null;
}
export interface PlanMutationInput {
  view: PlanView;
  origin: PlanOrigin;
  expectedRef: PlanRef | null;
  content: string;
  /** Temporary visibility evidence; excluded from semantic mutation intent. */
  selection?: PlanSelection;
}
export interface PlanMutationReceipt {
  threadId: string;
  branchId: string;
  origin: PlanOrigin;
  intentHash: string;
  status: 'applied' | 'conflict';
  /** Original committed result, or the current version observed by the original conflict. */
  ref: PlanRef | null;
}
export interface PlanMutationResult {
  receipt: PlanMutationReceipt;
  plan: PlanSnapshot | null;
}
export interface PlanForkInput {
  source: PlanView;
  targetBranchId: string;
  selection?: PlanSelection;
}
export interface PlanForkCapture {
  sourceThreadId: string;
  sourceBranchId: string;
  targetBranchId: string;
  headId: string | null;
  inheritedRef: PlanRef | null;
  capturedRef: PlanRef | null;
}
export interface PlanChanged { threadId: string; branchId: string; ref: PlanRef }
