import type { HostEvent, HostEventData } from "./events.js";
import type { HostMethodMap } from "./methods.js";
import {
  createErrorResponse,
  type ErrorResponseEnvelope,
} from "./envelopes.js";
import {
  VARIN_PROTOCOL_VERSION,
  type ExtensionUiResponse,
  type HostHandshakeParams,
  type HostHandshakeResult,
  type ProtocolErrorData,
  type ProtocolVersion,
} from "./types.js";
import type { ProviderAuthResponse } from "./auth.js";
import type { SessionWorkspaceBinding } from "./types.js";
import type { WorkFocusId } from "./work-focus.js";
import type {
  FoundationalPiPackageId,
  FoundationalPiPackageStatusSnapshot,
} from "./foundational-pi-packages.js";

type DirectRuntimeMethod =
  | "agent.compact"
  | "agent.followUp"
  | "agent.prompt"
  | "agent.queue.clear"
  | "agent.steer"
  | "command.execute"
  | "config.unwatch"
  | "fleet.action"
  | "fleet.status"
  | "recovery.checkpoint.create"
  | "recovery.navigate"
  | "recovery.repair"
  | "recovery.redo"
  | "recovery.status"
  | "recovery.undo"
  | "session.close"
  | "session.entry"
  | "session.entries"
  | "session.features.get"
  | "session.features.mutate"
  | "session.fork"
  | "session.header"
  | "session.list"
  | "session.navigate"
  | "session.open"
  | "session.rename"
  | "session.snapshot"
  | "session.reconcile"
  | "session.stats"
  | "session.summary"
  | "session.tree"
  | "thinking.select";

type SessionScopedRuntimeMethod =
  | "agentProvider.action"
  | "agentProvider.list"
  | "config.document.get"
  | "config.document.update"
  | "config.text.authority.get"
  | "config.text.authority.update"
  | "config.text.get"
  | "config.text.update"
  | "config.watch"
  | "model.list"
  | "mcp.config.snapshot"
  | "package.install"
  | "package.list"
  | "package.remove"
  | "package.setEnabled"
  | "package.update"
  | "provider.list"
  | "provider.config.delete"
  | "provider.config.get"
  | "provider.config.upsert"
  | "provider.models.discover"
  | "provider.auth.cancel"
  | "provider.login"
  | "provider.logout"
  | "resource.copy"
  | "resource.create"
  | "resource.delete"
  | "resource.get"
  | "resource.list"
  | "resource.update"
  | "settings.get"
  | "settings.update";

export type RuntimeContextTarget =
  | { cwd: string; sessionId?: never }
  | { cwd?: never; sessionId: string };

type SessionScopedMethodMap = {
  [M in SessionScopedRuntimeMethod]: {
    params: M extends
      | "model.list"
      | "mcp.config.snapshot"
      | "agentProvider.list"
      | "package.list"
      | "provider.list"
      | "settings.get"
      ? RuntimeContextTarget
      : HostMethodMap[M]["params"] & RuntimeContextTarget;
    result: HostMethodMap[M]["result"];
  };
};

/**
 * Public Varin runtime contract used by renderer, web, mobile, and editor
 * surfaces. Worker-only lifecycle and trust-response methods are deliberately
 * absent. Catalog operations target either a live session or a broker-owned in-memory workspace
 * context because Pi resources and provider registrations can vary by workspace.
 */
export type RuntimeMethodMap = Omit<Pick<HostMethodMap, DirectRuntimeMethod>, "session.rename" | "session.open"> &
  SessionScopedMethodMap & {
    /** Surface stop must name the observed run; internal Host callers can still cancel current work. */
    "agent.abort": {
      params: { expectedRunId: string; sessionId: string };
      result: HostMethodMap["agent.abort"]["result"];
    };
    "command.list": {
      params: RuntimeContextTarget;
      result: HostMethodMap["command.list"]["result"];
    };
    "extension.ui.respond": {
      params: { response: ExtensionUiResponse; sessionId: string };
      result: HostMethodMap["extension.ui.respond"]["result"];
    };
    "host.handshake": {
      params: HostHandshakeParams;
      result: HostHandshakeResult;
    };
    "model.select": HostMethodMap["model.select"];
    "package.foundation.restore": {
      params: { ids?: FoundationalPiPackageId[] };
      result: FoundationalPiPackageStatusSnapshot;
    };
    "package.foundation.setAutoInstallNew": {
      params: { enabled: boolean };
      result: FoundationalPiPackageStatusSnapshot;
    };
    "package.foundation.status": {
      params: Record<string, never>;
      result: FoundationalPiPackageStatusSnapshot;
    };
    "project.trust.respond": {
      params: {
        remember: boolean;
        requestId: string;
        trusted: boolean;
        workerId: string;
      };
      result: HostMethodMap["project.trust.respond"]["result"];
    };
    "session.archive": {
      params: { sessionId: string };
      result: HostMethodMap["session.list"]["result"][number];
    };
    "session.create": {
      params: Omit<HostMethodMap["session.create"]["params"], "workFocus" | "workFocusGeneration" | "workFocusRole"> & {
        workspace?: SessionWorkspaceBinding;
        workFocus?: WorkFocusId;
      };
      result: HostMethodMap["session.create"]["result"];
    };
    "session.delete": {
      params: { sessionId: string };
      result: { deleted: boolean; sessionId: string };
    };
    "session.workFocus.set": {
      params: { sessionId: string; workFocus: WorkFocusId };
      result: HostMethodMap["session.snapshot"]["result"];
    };
    "session.entries.preview": {
      params: { cwd?: string; scope?: "all" | "branch"; sessionId: string };
      result: HostMethodMap["session.entries.read"]["result"];
    };
    "session.open": {
      params: Omit<HostMethodMap["session.open"]["params"], "workFocus" | "workFocusGeneration" | "workFocusRole">;
      result: HostMethodMap["session.open"]["result"];
    };
    "session.rename": {
      params: { name: string; sessionId: string };
      result: HostMethodMap["session.rename"]["result"];
    };
    "session.unarchive": {
      params: { sessionId: string };
      result: HostMethodMap["session.list"]["result"][number];
    };
  "provider.auth.respond": {
      params: { response: ProviderAuthResponse; sessionId: string };
      result: HostMethodMap["provider.auth.respond"]["result"];
    };
  };

export const RUNTIME_METHODS = [
  "agent.abort",
  "agent.compact",
  "agent.followUp",
  "agent.prompt",
  "agent.queue.clear",
  "agent.steer",
  "agentProvider.action",
  "agentProvider.list",
  "command.execute",
  "command.list",
  "config.document.get",
  "config.document.update",
  "config.text.authority.get",
  "config.text.authority.update",
  "config.text.get",
  "config.text.update",
  "config.unwatch",
  "config.watch",
  "extension.ui.respond",
  "fleet.action",
  "fleet.status",
  "host.handshake",
  "model.list",
  "mcp.config.snapshot",
  "model.select",
  "thinking.select",
  "package.install",
  "package.foundation.restore",
  "package.foundation.setAutoInstallNew",
  "package.foundation.status",
  "package.list",
  "package.remove",
  "package.setEnabled",
  "package.update",
  "project.trust.respond",
  "provider.list",
  "provider.config.delete",
  "provider.config.get",
  "provider.config.upsert",
  "provider.models.discover",
  "provider.auth.respond",
  "provider.auth.cancel",
  "provider.login",
  "provider.logout",
  "resource.copy",
  "resource.create",
  "resource.delete",
  "resource.get",
  "resource.list",
  "resource.update",
  "recovery.checkpoint.create",
  "recovery.navigate",
  "recovery.repair",
  "recovery.redo",
  "recovery.status",
  "recovery.undo",
  "session.close",
  "session.create",
  "session.delete",
  "session.entry",
  "session.entries",
  "session.entries.preview",
  "session.features.get",
  "session.features.mutate",
  "session.fork",
  "session.header",
  "session.list",
  "session.navigate",
  "session.open",
  "session.rename",
  "session.snapshot",
  "session.reconcile",
  "session.stats",
  "session.summary",
  "session.tree",
  "session.archive",
  "session.unarchive",
  "session.workFocus.set",
  "settings.get",
  "settings.update",
] as const satisfies readonly (keyof RuntimeMethodMap)[];

const RUNTIME_METHOD_SET = new Set<string>(RUNTIME_METHODS);

export type RuntimeMethod = keyof RuntimeMethodMap;

export type RuntimeMethodParams<M extends RuntimeMethod> = RuntimeMethodMap[M]["params"];

export type RuntimeMethodResult<M extends RuntimeMethod> = RuntimeMethodMap[M]["result"];

export function isRuntimeMethod(value: unknown): value is RuntimeMethod {
  return typeof value === "string" && RUNTIME_METHOD_SET.has(value);
}

export const RUNTIME_WORKER_ROLES = ["catalog", "workspace", "package", "session", "compaction"] as const;

export type RuntimeWorkerRole = (typeof RUNTIME_WORKER_ROLES)[number];

export interface RuntimeEventSource {
  executionId?: string;
  role: RuntimeWorkerRole;
  runtimeGeneration: number;
  sessionId?: string;
  workerId: string;
}

export type RuntimeRequestEnvelope<M extends RuntimeMethod = RuntimeMethod> =
  M extends RuntimeMethod
    ? {
        id: string;
        kind: "request";
        method: M;
        params: RuntimeMethodParams<M>;
        v: ProtocolVersion;
      }
    : never;

export type RuntimeSuccessResponseEnvelope<M extends RuntimeMethod = RuntimeMethod> =
  M extends RuntimeMethod
    ? {
        id: string;
        kind: "response";
        ok: true;
        result: RuntimeMethodResult<M>;
        v: ProtocolVersion;
      }
    : never;

export type RuntimeResponseEnvelope<M extends RuntimeMethod = RuntimeMethod> =
  | RuntimeSuccessResponseEnvelope<M>
  | ErrorResponseEnvelope;

export type RuntimeEventEnvelope<E extends HostEvent = HostEvent> = E extends HostEvent
  ? {
      data: HostEventData<E>;
      event: E;
      kind: "event";
      /** Sequence of events delivered to this surface, after subscription filtering. */
      surfaceSeq?: number;
      /** Original worker-local sequence used with SessionSnapshot.eventWatermark. */
      seq: number;
      source: RuntimeEventSource;
      v: ProtocolVersion;
    }
  : never;

export type RuntimeWireEnvelope =
  | RuntimeRequestEnvelope
  | RuntimeResponseEnvelope
  | RuntimeEventEnvelope;

export function createRuntimeRequest<M extends RuntimeMethod>(
  id: string,
  method: M,
  params: RuntimeMethodParams<M>,
): RuntimeRequestEnvelope<M> {
  return {
    id,
    kind: "request",
    method,
    params,
    v: VARIN_PROTOCOL_VERSION,
  } as RuntimeRequestEnvelope<M>;
}

export function createRuntimeSuccessResponse<M extends RuntimeMethod>(
  id: string,
  result: RuntimeMethodResult<M>,
): RuntimeSuccessResponseEnvelope<M> {
  return {
    id,
    kind: "response",
    ok: true,
    result,
    v: VARIN_PROTOCOL_VERSION,
  } as RuntimeSuccessResponseEnvelope<M>;
}

export function createRuntimeErrorResponse(
  id: string,
  error: ProtocolErrorData,
): ErrorResponseEnvelope {
  return createErrorResponse(id, error);
}

export function createRuntimeEvent<E extends HostEvent>(
  source: RuntimeEventSource,
  seq: number,
  event: E,
  data: HostEventData<E>,
): RuntimeEventEnvelope<E> {
  return {
    data,
    event,
    kind: "event",
    seq,
    source,
    v: VARIN_PROTOCOL_VERSION,
  } as RuntimeEventEnvelope<E>;
}

export function isRuntimeEventEnvelope(
  envelope: { kind: string; [key: string]: unknown },
): envelope is RuntimeEventEnvelope {
  if (envelope.kind !== "event") return false;
  const source = envelope.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const record = source as Record<string, unknown>;
  return (
    (envelope.surfaceSeq === undefined ||
      (Number.isSafeInteger(envelope.surfaceSeq) && Number(envelope.surfaceSeq) >= 0)) &&
    RUNTIME_WORKER_ROLES.includes(record.role as RuntimeWorkerRole) &&
    typeof record.workerId === "string" &&
    record.workerId.length > 0 &&
    (record.sessionId === undefined ||
      (typeof record.sessionId === "string" && record.sessionId.length > 0))
  );
}
