/** Native source integration observations and explicit conflict decisions. */
export interface ThreadDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export type IntegrationApplyPhase =
  | "pending"
  | "disk-applied"
  | "surface-intent"
  | "surface-dispatched"
  | "surface-applied"
  | "surface-undone"
  | "conflict"
  | "unavailable"
  | "compensated"
  | "skipped-identical";

export type IntegrationPathDecision =
  | "identical"
  | "apply-child"
  | "keep-parent"
  | "merge-clean"
  | "conflict"
  | "unavailable";

export interface ThreadConflictResolution {
  path: string;
  choice: "parent" | "child" | "base" | "text";
  text?: string;
  expectedParentRevision?: string;
  expectedLocalEditRevision?: number;
}

export interface IntegrationPathBinding {
  target: "disk" | "surface" | "unavailable";
  revision: string;
  localEditRevision?: number;
  baseRevision?: string | null;
  ownerId?: string;
  ownerGeneration?: number;
  ownerRegistrationId?: string;
  documentInstanceId?: string;
  bufferHash?: string;
  encoding?: string;
  bom?: boolean;
  lineEnding?: "lf" | "crlf" | "cr";
}

export interface IntegrationPathProjection {
  path: string;
  target: IntegrationPathBinding["target"];
  decision: IntegrationPathDecision;
  phase: IntegrationApplyPhase;
  isText: boolean;
  conflictReason?: string;
  parentText?: string;
  childText?: string;
  baselineText?: string;
}

export interface ThreadIntegrationPreview {
  operationId: string;
  threadId: string;
  resultRevision: number;
  bindingFingerprint: string;
  valid: boolean;
  mergeReady: boolean;
  binding: Record<string, IntegrationPathBinding>;
  paths: IntegrationPathProjection[];
  conflictPaths: string[];
  surfaceTargetPaths: string[];
  unavailablePaths: string[];
  appliedPaths: string[];
  invalidReason?: string;
}
