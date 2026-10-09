/** Native conversation plans reuse the KnowledgeStore owner, not Pi session identity. */
export type NativePlanRef = string;
export interface NativePlanSnapshot {
  ref: NativePlanRef;
  threadId: string;
  branchId: string;
  sourceHeadId: string | null;
  previousRef: NativePlanRef | null;
  content: string;
  updatedBy: 'user' | 'agent';
  updatedAt: number;
}
export interface NativePlanForkBasis {
  sourceBranchId: string;
  headId: string | null;
  sourceInheritedRef: NativePlanRef | null;
}
export interface NativePlanView {
  threadId: string;
  branchId: string;
  headId: string | null;
  inheritedRef: NativePlanRef | null;
  /** Immutable Catalog creation evidence; null identifies a root or legacy branch. */
  forkBasis: NativePlanForkBasis | null;
}
export type NativePlanOrigin =
  | { kind: 'user'; key: string }
  | { kind: 'tool'; operationId: string; runId: string; requestId: string; callId: string; epoch: number };
export interface NativePlanSelection { latestRef: NativePlanRef | null; selectedRef: NativePlanRef | null }
export interface NativePlanCandidate {
  latestRef: NativePlanRef | null;
  candidate: Pick<NativePlanSnapshot, 'ref' | 'sourceHeadId' | 'previousRef' | 'updatedAt'> | null;
}
export interface NativePlanMutationInput {
  view: NativePlanView;
  origin: NativePlanOrigin;
  expectedRef: NativePlanRef | null;
  content: string;
  /** Temporary visibility evidence; excluded from semantic mutation intent. */
  selection?: NativePlanSelection;
}
export interface NativePlanMutationReceipt {
  threadId: string;
  branchId: string;
  origin: NativePlanOrigin;
  intentHash: string;
  status: 'applied' | 'conflict';
  /** Original committed result, or the current version observed by the original conflict. */
  ref: NativePlanRef | null;
}
export interface NativePlanMutationResult {
  receipt: NativePlanMutationReceipt;
  plan: NativePlanSnapshot | null;
}
export interface NativePlanForkInput {
  source: NativePlanView;
  targetBranchId: string;
  selection?: NativePlanSelection;
}
export interface NativePlanForkCapture {
  sourceThreadId: string;
  sourceBranchId: string;
  targetBranchId: string;
  headId: string | null;
  inheritedRef: NativePlanRef | null;
  capturedRef: NativePlanRef | null;
}
export interface NativePlanChanged { threadId: string; branchId: string; ref: NativePlanRef }
