// Generated from kernel/protocol/schema.json. Do not hand-edit.

export type Outcome = "succeeded" | "failed" | "cancelled" | "indeterminate";

export type Effect = "none" | "dispatched" | "partial" | "confirmed" | "unknown";

export type Lifetime = "call" | "run" | "thread" | "environment";

export type OperationCallCompletion =
  | { kind: 'not_dispatched'; reason: string }
  | { kind: 'result'; outcome: Outcome; effect: Effect; content: unknown }
  | { kind: 'job_accepted'; operation_id: string; phase: string; effect: Effect; lifetime: Lifetime; content?: unknown };

export interface NestedToolInput {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface NestedToolReceipt {
  operationId: string;
  completion: OperationCallCompletion;
}
