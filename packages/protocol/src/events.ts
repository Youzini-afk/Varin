import type {
  ExtensionStateSnapshot,
  ExtensionUiRequest,
  JsonValue,
  ProjectTrustRequest,
  PiConfigWatchChangeReason,
  PiConfigWatchTarget,
  ProtocolErrorData,
  RecoveryStatus,
  RuntimeDescriptor,
  SessionSnapshot,
} from "./types.js";
import type {
  ProviderAuthEvent,
  ProviderAuthPromptRequest,
} from "./auth.js";
import type { PiAgentEvent } from "./session.js";
import type { ProviderConfigDeleteScope } from "./provider.js";
import type { HarnessCancelData, HarnessRequestData } from "./harness.js";
import type { Thread, ThreadReport, ThreadRun } from "./harness-threads.js";
import type { CompactionTraceUpdate } from "./harness-compaction.js";

interface WorkspaceMutationRequestBase {
  path: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: "write" | "edit" | "apply_patch";
}

export type WorkspaceMutationRequest = WorkspaceMutationRequestBase & (
  | { phase: "before"; succeeded?: never }
  | { phase: "after"; succeeded: boolean }
);

export interface HostEventMap {
  "compaction.trace": CompactionTraceUpdate;
  "agent.event": {
    event: PiAgentEvent;
    sessionId: string;
  };
  "config.changed": {
    reason: PiConfigWatchChangeReason;
    target: PiConfigWatchTarget;
    watchId: string;
  };
  "extension.ui.dismiss": {
    requestId: string;
    sessionId: string;
  };
  "extension.ui.request": ExtensionUiRequest;
  "extension.state": ExtensionStateSnapshot;
  "host.error": ProtocolErrorData;
  "host.log": {
    fields?: JsonValue;
    level: "debug" | "info" | "warn" | "error";
    message: string;
  };
  "host.ready": {
    runtime: RuntimeDescriptor;
  };
  "project.trust.request": ProjectTrustRequest;
  "provider.auth.dismiss": {
    interactionId: string;
    providerId: string;
    requestId: string;
    sessionId: string;
  };
  "provider.auth.event": {
    event: ProviderAuthEvent;
    interactionId: string;
    providerId: string;
    sessionId: string;
  };
  "provider.auth.prompt": ProviderAuthPromptRequest;
  "provider.config.changed": {
    providerId: string;
    scope: ProviderConfigDeleteScope;
    sessionId: string;
  };
  "recovery.changed": {
    sessionId: string;
  };
  "recovery.status": RecoveryStatus & {
    sessionId: string;
  };
  "package.progress": {
    message: string;
    operation: "install" | "remove" | "update";
    percent?: number;
    source?: string;
  };
  "session.closed": {
    sessionId: string;
  };
  "session.snapshot": SessionSnapshot;
  "session.worker.exited": {
    code: number | null;
    expected: boolean;
    sessionId: string;
    signal: string | null;
  };
  "workspace.mutation.request": WorkspaceMutationRequest;
  "harness.request": HarnessRequestData;
  /** Abort an in-flight harness request and/or the explore query it belongs to. */
  "harness.cancel": HarnessCancelData;
  "harness.thread.changed": {
    workspaceId: string;
    parent: import("./harness-threads.js").ThreadParent;
    thread: Thread;
    activeRun: ThreadRun | null;
  };
  "harness.thread.done": {
    workspaceId: string;
    parent: import("./harness-threads.js").ThreadParent;
    threadId: string;
    report: ThreadReport;
  };
}

export const HOST_EVENTS = [
  "agent.event",
  "compaction.trace",
  "config.changed",
  "extension.ui.dismiss",
  "extension.ui.request",
  "extension.state",
  "harness.request",
  "harness.cancel",
  "harness.thread.changed",
  "harness.thread.done",
  "host.error",
  "host.log",
  "host.ready",
  "package.progress",
  "project.trust.request",
  "provider.auth.dismiss",
  "provider.auth.event",
  "provider.auth.prompt",
  "provider.config.changed",
  "recovery.changed",
  "recovery.status",
  "session.closed",
  "session.snapshot",
  "session.worker.exited",
  "workspace.mutation.request",
] as const satisfies readonly (keyof HostEventMap)[];

const HOST_EVENT_SET = new Set<string>(HOST_EVENTS);

export type HostEvent = keyof HostEventMap;

export type HostEventData<E extends HostEvent> = HostEventMap[E];

export function isHostEvent(value: unknown): value is HostEvent {
  return typeof value === "string" && HOST_EVENT_SET.has(value);
}
