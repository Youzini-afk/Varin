export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const THINKING_LEVELS = [
  "off",
  "on",
  "budget",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const MODEL_THINKING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelThinkingEffort = (typeof MODEL_THINKING_EFFORTS)[number];
export type ModelThinkingConfiguration =
  | { mode: 'levels'; levels: ModelThinkingEffort[]; allowOff: boolean }
  | { mode: 'switch' }
  | { mode: 'fixed' }
  | { mode: 'budget'; tokens: number; allowOff: boolean };
export function isModelThinkingConfiguration(value: unknown): value is ModelThinkingConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const control = value as Record<string, unknown>;
  if (control.mode === 'switch' || control.mode === 'fixed') return true;
  if (typeof control.allowOff !== 'boolean') return false;
  if (control.mode === 'budget') return Number.isSafeInteger(control.tokens) && Number(control.tokens) > 0;
  return control.mode === 'levels' && Array.isArray(control.levels) && control.levels.length > 0
    && new Set(control.levels).size === control.levels.length
    && control.levels.every(level => (MODEL_THINKING_EFFORTS as readonly unknown[]).includes(level));
}

/**
 * Immutable source selected for one user input. Surface contexts contain only
 * an opaque Host reference; document text remains on the authenticated
 * Documents channel and never enters runtime request payloads.
 */
export type AgentInputContext =
  | { source: "disk" }
  | {
      source: "surface";
      roots: Array<{ workspaceId: string; dirtyPaths: string[] }>;
      snapshot:
        | { status: "ready"; ref: string }
        | { status: "unavailable"; reason: "surface-unavailable" };
    };

/** Documents snapshots are scoped to their real consumer, independently of editor ownership. */
export interface AgentInputSnapshotConsumer {
  kind: "thread";
  threadId: string;
  branchId: string;
}

export function parseAgentInputSnapshotConsumer(value: unknown): AgentInputSnapshotConsumer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "thread" && typeof input.threadId === "string" && input.threadId
    && typeof input.branchId === "string" && input.branchId
    && Object.keys(input).every(key => key === "kind" || key === "threadId" || key === "branchId")) {
    return { kind: "thread", threadId: input.threadId, branchId: input.branchId };
  }
  return null;
}

/** Parse untrusted wire input into a content-free AgentInputContext clone. */
export function parseAgentInputContext(value: unknown): AgentInputContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.source === "disk") return { source: "disk" };
  if (input.source !== "surface"
    || !Array.isArray(input.roots)
    || !input.snapshot || typeof input.snapshot !== "object" || Array.isArray(input.snapshot)) return null;
  const roots: Array<{ workspaceId: string; dirtyPaths: string[] }> = [];
  for (const root of input.roots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    const entry = root as Record<string, unknown>;
    if (typeof entry.workspaceId !== "string" || !entry.workspaceId
      || !Array.isArray(entry.dirtyPaths) || entry.dirtyPaths.length === 0
      || entry.dirtyPaths.some((path) => typeof path !== "string")
      || new Set(entry.dirtyPaths).size !== entry.dirtyPaths.length
      || roots.some((candidate) => candidate.workspaceId === entry.workspaceId)) return null;
    roots.push({ workspaceId: entry.workspaceId, dirtyPaths: [...entry.dirtyPaths] as string[] });
  }
  const snapshot = input.snapshot as Record<string, unknown>;
  if (snapshot.status === "ready" && typeof snapshot.ref === "string" && snapshot.ref) {
    if (roots.length === 0) return null;
    return {
      source: "surface",
      roots,
      snapshot: { status: "ready", ref: snapshot.ref },
    };
  }
  if (snapshot.status === "unavailable" && snapshot.reason === "surface-unavailable") {
    return {
      source: "surface",
      roots,
      snapshot: { status: "unavailable", reason: "surface-unavailable" },
    };
  }
  return null;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export type RecoveryPreference = "conversation" | "both" | "ask";

export interface ProtocolErrorData {
  code: string;
  details?: JsonValue;
  message: string;
  retryable?: boolean;
}
