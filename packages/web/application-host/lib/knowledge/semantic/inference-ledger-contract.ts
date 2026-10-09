/** Durable execution facts for paid semantic inference, separate from index data. */
import { createHash } from "node:crypto";
import type { HarnessEmbedResult } from "@varin/protocol";
import type { SemanticInferenceReceipt } from "./runtime-inference.js";

export type SemanticInferenceOperation = {
  kind: "retrieval-query";
  hostId: string;
  threadId: string;
  runId: string;
  invocation: { kind: "model_step"; requestId: string; toolCallId: string }
    | { kind: "policy_action"; actionId: string; nodeId: string; toolCallId: string };
  stage: "code-retrieval.semantic.query-embedding";
} | {
  kind: "index-build";
  hostId: string;
  workspaceId: string;
  recipeId: string;
  stage: "document-embedding";
};

export type SemanticInferenceLedgerIdentity = {
  providerId: string;
  modelId: string;
  protocol: "openai-compatible";
  configurationId: string;
  endpointHash: string;
  credentialScopeHash: string;
  dimensions?: number;
  maxTokens: number;
  operation: SemanticInferenceOperation;
  inputHashes: string[];
};
export type SemanticInferenceAdmission = {
  key: string;
  identity: SemanticInferenceLedgerIdentity;
  receipt: SemanticInferenceReceipt;
};
export type SemanticInferenceAdmissionResult =
  | { status: "admitted"; token: string }
  | { status: "completed"; result: HarnessEmbedResult; receipt: SemanticInferenceReceipt }
  | { status: "terminal"; receipt: SemanticInferenceReceipt }
  | { status: "indeterminate"; receipt: SemanticInferenceReceipt };
export type SemanticInferenceSettlement = {
  receipt: SemanticInferenceReceipt;
  result?: HarnessEmbedResult;
  /** The transport was never created, or its complete pre-dispatch chain has
   * settled with cancellation latched. No late dispatch remains possible. */
  noDispatchFinalized?: true;
};
export type SemanticInferenceFact = {
  key: string;
  identity: SemanticInferenceLedgerIdentity;
  receipt: SemanticInferenceReceipt;
  state: "unknown" | "terminal";
  hasResult: boolean;
  admissionNumber: number;
  noDispatchFinalized: boolean;
  createdAt: string;
  updatedAt: string;
};
export type SemanticInferenceFactFilter = { runId?: string; scopeId?: string; state?: "unknown" | "terminal" };
export interface SemanticInferenceLedger {
  admit(input: SemanticInferenceAdmission): Promise<SemanticInferenceAdmissionResult>;
  settle(token: string, settlement: SemanticInferenceSettlement): Promise<void>;
  read(key: string): Promise<Exclude<SemanticInferenceAdmissionResult, { status: "admitted" }> | null>;
  list(filter?: SemanticInferenceFactFilter): Promise<SemanticInferenceFact[]>;
  close(): Promise<void>;
}
export type SemanticInferenceLedgerOpenOptions = { dataDir: string; hostId: string };

/** Transport batch IDs never grant permission to repeat a durable operation. */
export function semanticInferenceOperationKey(identity: SemanticInferenceLedgerIdentity,
  purpose: SemanticInferenceReceipt["purpose"]): string {
  const operation = identity.operation;
  const owner = operation.kind === "retrieval-query"
    ? [operation.kind, operation.hostId, operation.threadId, operation.runId,
      operation.invocation.kind === "model_step"
        ? [operation.invocation.kind, operation.invocation.requestId, operation.invocation.toolCallId]
        : [operation.invocation.kind, operation.invocation.actionId, operation.invocation.nodeId, operation.invocation.toolCallId],
      operation.stage]
    : [operation.kind, operation.hostId, operation.workspaceId, operation.recipeId, operation.stage];
  const binding = operation.kind === "retrieval-query" ? [] : [identity.providerId, identity.modelId,
    identity.protocol, identity.configurationId, identity.endpointHash, identity.dimensions ?? null, identity.maxTokens];
  return createHash("sha256").update(JSON.stringify(operation.kind === "retrieval-query"
    ? [purpose, owner] : [purpose, owner, binding, identity.inputHashes])).digest("hex");
}
