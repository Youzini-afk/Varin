import { createHash, randomUUID } from "node:crypto";
import { threadSourceFailureMessage } from '@varin/application-client';
import type { StorageCleanupPreview, StorageCleanupReceipt, StorageDevice, StorageInventory, StorageScope } from '@varin/application-client';
import { SourceAdmissionError } from '../kernel/source-admission-error.js';
import type { KernelClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult, SourceFailureCode } from "../kernel/protocol.generated.js";
import type { ExperimentCaller, ExperimentContext } from "./experiments.js";
import {
  ExperimentPreparationError,
  type BackendObservation,
  type BackendRemoteObject,
  type ExperimentBackend,
  type ResolvedExperimentBackend,
} from "./experiment-backend.js";
import { openExperimentInputTransfer } from "./experiment-workspace.js";
import type { ExternalResourceAuthority, ResourceAdmissionReconciliation, ResourceMachineRegistration, ResourceService } from "./resources.js";
import {
  MANAGED_REMOTE_PROTOCOL_VERSION,
  type ManagedRemoteAdmissionReceipt,
  type ManagedRemoteIdentity,
  type ManagedRemoteJobReceipt,
  type ManagedRemoteMaterialManifest,
  type ManagedRemoteMaterialProbe,
  type ManagedRemoteMaterialReceipt,
  type ManagedRemoteOutputReceipt,
  type ManagedRemoteReadReceipt,
  type ManagedHostSourceOwner,
  type ManagedSourceService,
  type ManagedSourceServiceRequest,
  type SourceServiceOperation,
  type SourceServiceResponse,
} from "./managed-remote-types.js";
import { decodeManagedSourceCancellation, decodeManagedSourceReceiptRelease, decodeManagedSourceResponse } from './managed-source-response.js';
import { consumeManagedProcessStream } from './managed-process-stream.js';

const BASE_PATH = "/api/harness/managed-execution/v1";
const TARGET_REFRESH_WORKSPACE = "__varin_managed_remote__";
const digest = (...values: string[]): string => createHash("sha256").update(values.join("\0")).digest("hex");
const managedEndpointUrl = (connection: Pick<ConfiguredHost, "apiUrl">, relativePath = ''): URL => {
  const base = new URL(connection.apiUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Managed source endpoint must use a configured HTTP Host without URL credentials');
  }
  // A configured page's query/fragment never supplied managed-route authority.
  // Keep ignoring them instead of embedding them in durable Source identity.
  base.search = '';
  base.hash = '';
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/`;
  return new URL(`${BASE_PATH.slice(1)}${relativePath}`, base);
};
/** Identity of the actual managed endpoint, including its configured mount.
 * Credentials stay in the configured Host owner.
 */
export const managedEndpointIdentity = (connection: Pick<ConfiguredHost, "apiUrl">): string => (
  `sha256-${digest(managedEndpointUrl(connection).href)}`
);
const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const payload = JSON.parse(record.payloadJson) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch { return {}; }
};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export interface ConfiguredHost {
  id: string;
  label: string;
  apiUrl: string;
  clientToken?: string;
  requestHeaders: Record<string, string>;
  source: "desktop-host" | "ssh-instance" | "configured-host";
}

export interface ManagedTarget {
  machineId: string;
  hostId: string;
  connection: ConfiguredHost;
  identity: ManagedRemoteIdentity;
}

export interface ManagedStorageActions {
  inventory: { input: { scope: StorageScope }; result: StorageInventory };
  preview: { input: { scope: StorageScope }; result: StorageCleanupPreview };
  cleanup: { input: { previewId: string; candidateIds: string[] }; result: StorageCleanupReceipt };
}

type SourceClientMethod<Method> = Method extends (principal: infer _Principal, ...args: infer Args) => infer Result
  ? (...args: Args) => Result : never;
/** An authenticated connection to one frozen Host. No credential is included in source metadata. */
export type ManagedSourceClient = Omit<{ [Method in keyof ManagedSourceService]: SourceClientMethod<ManagedSourceService[Method]> }, 'service'> & {
  service<Operation extends SourceServiceOperation>(input: Omit<ManagedSourceServiceRequest, 'operation'> & { operation: Operation }, signal?: AbortSignal): Promise<SourceServiceResponse<Operation>>;
};

export interface ManagedRemoteTargetRegistryOptions {
  coordinatorHostId: string;
  kernel: KernelClient;
  resources: ResourceService;
  readSettings(): Promise<Record<string, unknown>>;
  fetch?: typeof fetch;
  /**
   * A managed target that was unreachable (or never probed) answered an
   * identity probe again. Consumers re-attach — never resubmit — durable
   * remote jobs by re-running their reconcile for the listed workspaces.
   */
  onTargetReachable?(workspaceId: string, machineId: string): void;
  /** First authenticated Source connection, or recovery after its transport failed.
   * Source-only consumers do not register an Experiment workspace/machine. */
  onSourceReachable?(owner: ManagedHostSourceOwner): void;
  onError?: (error: Error) => void;
}

export class ManagedResponseError extends Error {
  constructor(message: string, readonly code: unknown, readonly status?: number, readonly details?: unknown) { super(message); }
}

class ManagedTargetClient {
  constructor(
    readonly target: ManagedTarget,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(this.target.connection.requestHeaders);
    if (this.target.connection.clientToken) headers.set("Authorization", `Bearer ${this.target.connection.clientToken}`);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
  }

  async response(relativePath: string, init: Omit<RequestInit, "body"> & { body?: RequestInit["body"] | AsyncIterable<Uint8Array> } = {}): Promise<Response> {
    const url = managedEndpointUrl(this.target.connection, relativePath).toString();
    const { body, ...rest } = init;
    const asyncBody = body !== undefined && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
    const response = await this.fetchImpl(url, {
      ...rest,
      redirect: 'error',
      headers: this.headers(Object.fromEntries(new Headers(init.headers).entries())),
      ...(body === undefined ? {} : { body: body as never }),
      ...(asyncBody ? { duplex: "half" as never } : {}),
    });
    const actualHost = response.headers.get("x-varin-managed-host");
    if (actualHost !== this.target.hostId) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Managed target identity changed for ${this.target.machineId}`);
    }
    if (!response.ok) {
      const responseBody = await response.json().catch(() => null) as { error?: unknown; code?: unknown; details?: unknown } | null;
      const message = responseBody && typeof responseBody === "object" && "error" in responseBody && typeof responseBody.error === "string"
        ? responseBody.error : `Managed target request failed (${response.status})`;
      throw new ManagedResponseError(message, responseBody && typeof responseBody === 'object' && 'code' in responseBody ? responseBody.code : undefined, response.status, responseBody?.details);
    }
    return response;
  }

  async request<Result>(relativePath: string, init: Omit<RequestInit, "body"> & { body?: RequestInit["body"] | AsyncIterable<Uint8Array> } = {}): Promise<Result> {
    return (await this.response(relativePath, init)).json() as Promise<Result>;
  }

  json<Result>(relativePath: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<Result> {
    return this.request(relativePath, {
      method,
      ...(signal ? { signal } : {}),
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

export const configuredHosts = (settings: Record<string, unknown>): ConfiguredHost[] => {
  const sshIds = new Set((Array.isArray(settings.desktopSshInstances) ? settings.desktopSshInstances : [])
    .flatMap((entry) => entry && typeof entry === "object" && stringValue((entry as Record<string, unknown>).id)
      ? [stringValue((entry as Record<string, unknown>).id)!] : []));
  return (Array.isArray(settings.desktopHosts) ? settings.desktopHosts : []).flatMap((entry): ConfiguredHost[] => {
    if (!entry || typeof entry !== "object") return [];
    const host = entry as Record<string, unknown>;
    const id = stringValue(host.id);
    const apiUrl = stringValue(host.apiUrl);
    if (!id || id === "local" || !apiUrl || !/^https?:\/\//i.test(apiUrl)) return [];
    const headers = host.requestHeaders && typeof host.requestHeaders === "object" && !Array.isArray(host.requestHeaders)
      ? Object.fromEntries(Object.entries(host.requestHeaders as Record<string, unknown>)
          .flatMap(([name, value]) => typeof value === "string" && name.toLowerCase() !== "authorization" ? [[name, value]] : []))
      : {};
    const clientToken = stringValue(host.clientToken);
    return [{
      id,
      label: stringValue(host.label) ?? id,
      apiUrl,
      ...(clientToken ? { clientToken } : {}),
      requestHeaders: headers,
      source: sshIds.has(id) ? "ssh-instance" : "configured-host",
    }];
  });
};

export function createManagedRemoteTargetRegistry(options: ManagedRemoteTargetRegistryOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const targets = new Map<string, ManagedTarget>();
  /** machineId → workspaces whose callers resolved that machine's backend. */
  const workspaceBindings = new Map<string, Set<string>>();
  let refreshPromise: Promise<void> | null = null;
  const reachableSources = new Map<string, ManagedHostSourceOwner>();
  const sourceKey = (owner: ManagedHostSourceOwner) => JSON.stringify([owner.hostId, owner.connectionId, owner.endpointIdentity]);
  const sourceReached = (owner: ManagedHostSourceOwner) => {
    const key = sourceKey(owner);
    if (reachableSources.has(key)) return;
    // Set before notifying: recovery itself resolves the same original Source.
    reachableSources.set(key, owner);
    try { options.onSourceReachable?.(owner); } catch (error) { report(error); }
  };
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  const probe = async (connection: ConfiguredHost, signal?: AbortSignal): Promise<ManagedTarget> => {
    const headers = new Headers(connection.requestHeaders);
    headers.set("Accept", "application/json");
    if (connection.clientToken) headers.set("Authorization", `Bearer ${connection.clientToken}`);
    const response = await fetchImpl(managedEndpointUrl(connection, '/identity'), {
      headers,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    const identity = await response.json().catch(() => null) as ManagedRemoteIdentity | { error?: string } | null;
    if (!response.ok || !identity || !("hostId" in identity) || typeof identity.hostId !== "string") {
      throw new ManagedResponseError(identity && "error" in identity && typeof identity.error === "string" ? identity.error : `Target probe failed (${response.status})`, 'target-probe-failed', response.ok ? 502 : response.status);
    }
    if (identity.protocolVersion !== MANAGED_REMOTE_PROTOCOL_VERSION) throw new Error(`Unsupported managed target protocol ${String(identity.protocolVersion)}`);
    if (response.headers.get("x-varin-managed-host") !== identity.hostId) throw new Error("Managed target identity receipt is inconsistent");
    if (identity.hostId === options.coordinatorHostId) throw new Error("Configured target resolves to this coordinator Host");
    return {
      machineId: `managed:${identity.hostId}`,
      hostId: identity.hostId,
      connection,
      identity,
    };
  };

  const registrationFor = (target: ManagedTarget): ResourceMachineRegistration => ({
    machineId: target.machineId,
    kind: "managed-remote",
    label: target.connection.label,
    backend: "managed-remote",
    state: target.identity.machine.state === "available" ? "available" : "degraded",
    ...(target.identity.machine.capacity ? { capacity: target.identity.machine.capacity } : {}),
    connection: { status: "connected", detail: `authenticated ${target.connection.source} connection` },
    target: {
      hostId: target.hostId,
      connectionId: target.connection.id,
      source: target.connection.source,
      capabilities: [...target.identity.capabilities],
      coordinatorHostId: options.coordinatorHostId,
      acceptedJobsSurviveClientDisconnect: true,
      unassignedWorkRequiresCoordinator: true,
    },
  });

  const refresh = async (workspaceId: string): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const configured = configuredHosts(await options.readSettings());
      const seenConnections = new Set(configured.map((entry) => entry.id));
      const durableManaged = (await options.resources.listMachines(workspaceId))
        .filter((machine) => machine.kind === "managed-remote" && machine.target);
      const probed = await Promise.allSettled(configured.map(connection => probe(connection)));
      const next = new Map<string, ManagedTarget>();
      const probedByConnection = new Map<string, ManagedTarget>();
      const failedByConnection = new Map<string, string>();
      for (let index = 0; index < probed.length; index += 1) {
        const result = probed[index]!;
        const connection = configured[index]!;
        if (result.status === "fulfilled") {
          const target = result.value;
          probedByConnection.set(connection.id, target);
          if (!next.has(target.machineId)) next.set(target.machineId, target);
        } else {
          failedByConnection.set(connection.id, result.reason instanceof Error ? result.reason.message : "target probe failed");
          const prior = [...targets.values()].find((entry) => entry.connection.id === connection.id);
          if (prior) {
            await options.resources.registerMachine(workspaceId, {
              ...registrationFor(prior), state: "offline",
              connection: { status: "offline", detail: result.reason instanceof Error ? result.reason.message : "target probe failed" },
            }).catch(report);
          }
          report(result.reason);
        }
      }
      for (const target of next.values()) {
        await options.resources.registerMachine(workspaceId, registrationFor(target));
      }
      for (const prior of durableManaged) {
        if (next.has(prior.machineId) || !prior.target) continue;
        const currentConnection = probedByConnection.get(prior.target.connectionId);
        const identityChanged = currentConnection && currentConnection.hostId !== prior.target.hostId;
        const detail = failedByConnection.get(prior.target.connectionId)
          ?? (identityChanged ? "trusted connection now identifies a different Host" : undefined)
          ?? (!seenConnections.has(prior.target.connectionId) ? "trusted connection was removed" : "managed target is unreachable");
        await options.resources.registerMachine(workspaceId, {
          machineId: prior.machineId,
          kind: "managed-remote",
          ...(prior.label ? { label: prior.label } : {}),
          backend: "managed-remote",
          state: "offline",
          ...(prior.capacity ? { capacity: prior.capacity } : {}),
          connection: { status: "offline", detail },
          target: prior.target,
        }).catch(report);
      }
      const reachable = [...next.keys()].filter((machineId) => !targets.has(machineId));
      targets.clear();
      for (const [machineId, target] of next) targets.set(machineId, target);
      // Re-attach, never resubmit: a reconnected target resolves the same
      // backend identity, so the owning service reconciles its durable jobs.
      for (const machineId of reachable) {
        for (const workspaceId of workspaceBindings.get(machineId) ?? []) {
          try { options.onTargetReachable?.(workspaceId, machineId); } catch (error) { report(error); }
        }
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  const targetFor = async (workspaceId: string, machineId: string): Promise<ManagedTarget | null> => {
    await refresh(workspaceId);
    return targets.get(machineId) ?? null;
  };

  const sourceTargets = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const connections = configuredHosts(await options.readSettings());
    const results = await Promise.allSettled(connections.map(async connection => {
      const endpointIdentity = managedEndpointIdentity(connection);
      const target = await probe(connection, signal).catch(error => {
        if (!signal?.aborted) for (const [key, owner] of reachableSources) {
          if (owner.connectionId === connection.id && owner.endpointIdentity === endpointIdentity) reachableSources.delete(key);
        }
        throw error;
      });
      if (!target.identity.capabilities.includes('sources')) throw new Error('Managed source resources are unavailable on this Host');
      const resourceOwner = { kind: 'managed_host' as const, hostId: target.hostId, connectionId: connection.id, endpointIdentity };
      sourceReached(resourceOwner);
      return { resourceOwner, label: connection.label, capabilities: [...target.identity.capabilities] };
    }));
    signal?.throwIfAborted();
    return {
      targets: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
      unavailable: results.flatMap((result, index) => result.status === 'rejected'
        ? [{ connectionId: connections[index]!.id, label: connections[index]!.label, message: 'The configured Host source is unavailable' }] : []),
    };
  };

  const forwardTarget = async (owner: ManagedHostSourceOwner, signal?: AbortSignal): Promise<ManagedTarget> => {
    signal?.throwIfAborted();
    const connection = configuredHosts(await options.readSettings()).find(entry => entry.id === owner.connectionId);
    if (!connection || managedEndpointIdentity(connection) !== owner.endpointIdentity) {
      throw new Error('The original managed source connection is unavailable');
    }
    // A machine may have multiple configured connections. Never substitute the
    // registry's preferred machine connection for this Source's actual endpoint.
    const target = await probe(connection, signal);
    if (target.hostId !== owner.hostId) throw new Error('The original managed source Host identity changed');
    return target;
  };

  /** Select only a configured connection; forwarding does not require a file workspace. */
  const selectForwardTarget = async (targetId: string, signal?: AbortSignal): Promise<ManagedTarget> => {
    signal?.throwIfAborted();
    const configured = configuredHosts(await options.readSettings());
    const direct = configured.find(connection => connection.id === targetId);
    if (direct) { managedEndpointIdentity(direct); return probe(direct, signal); }
    const results = await Promise.allSettled(configured.map(async connection => { managedEndpointIdentity(connection); return probe(connection, signal); }));
    signal?.throwIfAborted();
    const selected = results.find((result): result is PromiseFulfilledResult<ManagedTarget> =>
      result.status === 'fulfilled' && result.value.machineId === targetId);
    if (!selected) throw new Error('The configured service target is unavailable');
    return selected.value;
  };

  /** Independent resource inspection: never registers an Experiment or changes
   * the Agent Catalog. Credentials and endpoint resolution stay with this owner. */
  const storageTargets = async (signal?: AbortSignal): Promise<StorageDevice[]> => {
    const connections = configuredHosts(await options.readSettings());
    return Promise.all(connections.map(async connection => {
      try {
        const target = await probe(connection, signal);
        return { id: `connection:${connection.id}`, name: connection.label, current: false,
          state: target.identity.capabilities.includes('storage') ? 'ready' as const : 'unsupported' as const,
          target: { id: `connection:${connection.id}`, hostId: target.hostId, endpointIdentity: managedEndpointIdentity(connection) } };
      } catch (error) {
        signal?.throwIfAborted();
        const unsupported = (error instanceof ManagedResponseError && [404, 501].includes(error.status ?? 0))
          || (error instanceof Error && error.message.startsWith('Unsupported managed target protocol'));
        return { id: `connection:${connection.id}`, name: connection.label, current: false,
          state: error instanceof ManagedResponseError && [401, 403].includes(error.status ?? 0) ? 'restricted' as const : unsupported ? 'unsupported' as const : 'offline' as const };
      }
    }));
  };
  const storage = async <Action extends keyof ManagedStorageActions>(owner: ManagedHostSourceOwner, action: Action, input: ManagedStorageActions[Action]['input'], signal?: AbortSignal): Promise<ManagedStorageActions[Action]['result']> => {
    const target = await forwardTarget(owner, signal);
    if (!target.identity.capabilities.includes('storage')) throw new ManagedResponseError('This Host does not provide storage management', 'storage-unsupported', 501);
    const client = new ManagedTargetClient(target, fetchImpl);
    return client.json<ManagedStorageActions[Action]['result']>(`/storage/${action}`, input, 'POST', action === 'cleanup' ? undefined : signal);
  };

  const sourceTarget = async (owner: ManagedHostSourceOwner, signal?: AbortSignal): Promise<ManagedTarget> => {
    try {
      const target = await forwardTarget(owner, signal);
      if (!target.identity.capabilities.includes('sources')) throw new Error('Managed source resources are unavailable on this Host');
      sourceReached(owner);
      return target;
    } catch (error) {
      if (!signal?.aborted) reachableSources.delete(sourceKey(owner));
      throw error;
    }
  };

  const source = async (owner: ManagedHostSourceOwner, signal?: AbortSignal): Promise<ManagedSourceClient> => {
    const selected = await sourceTarget(owner, signal);
    const target = { ...selected, connection: { ...selected.connection, requestHeaders: { ...selected.connection.requestHeaders } } };
    const client = new ManagedTargetClient(target, async (url, init) => {
      try { return await fetchImpl(url, { ...init, redirect: 'error' }); }
      catch (error) {
        if (!init?.signal?.aborted) reachableSources.delete(sourceKey(owner));
        throw error;
      }
    });
    const request = async <Method extends keyof ManagedSourceService>(method: Method, input: Parameters<ManagedSourceService[Method]>[1], signal?: AbortSignal): Promise<Awaited<ReturnType<ManagedSourceService[Method]>>> => {
      if (input.coordinatorHostId !== options.coordinatorHostId) throw new Error('Managed source request belongs to another coordinator');
      const result = await client.json<Awaited<ReturnType<ManagedSourceService[Method]>>>(`/sources/${method}`, input, 'POST', signal).catch(error => {
        if (error instanceof ManagedResponseError && typeof error.code === 'string' && threadSourceFailureMessage(error.code)) {
          throw new SourceAdmissionError(error.code as SourceFailureCode, { cause: error });
        }
        throw error;
      });
      if (method !== 'service' && method !== 'handoff' && method !== 'integrationReceipt' && method !== 'fileReceipt' && method !== 'authorize' && method !== 'release' && method !== 'inspectScope'
        && (!result || typeof result !== 'object' || Array.isArray(result))) throw new Error('Managed source response is unconfirmed');
      if (method === 'cancelService') decodeManagedSourceCancellation(input as Parameters<ManagedSourceService['cancelService']>[1], result);
      if (method === 'releaseReceipt') decodeManagedSourceReceiptRelease(input as Parameters<ManagedSourceService['releaseReceipt']>[1], result);
      return result;
    };
    return {
      recovery: (input, signal) => request('recovery', input, signal),
      scriptControl: (input, signal) => request('scriptControl', input, signal),
      scriptBinding: (input, signal) => request('scriptBinding', input, signal),
      scriptSpawn: (input, signal) => request('scriptSpawn', input, signal),
      processAccess: (input, signal) => request('processAccess', input, signal),
      processControl: input => request('processControl', input),
      processWrite: input => request('processWrite', input),
      processResize: input => request('processResize', input),
      processSubscribe: async (input, observer, signal) => {
        if (input.coordinatorHostId !== options.coordinatorHostId) throw new Error('Managed process belongs to another coordinator');
        const response = await client.response('/sources/processSubscribe', { method: 'POST', body: JSON.stringify(input),
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, ...(signal ? { signal } : {}) });
        return consumeManagedProcessStream(response, input, observer, input => request('processControl', input));
      },
      capabilities: (input, signal) => request('capabilities', input, signal),
      handoff: (input, signal) => request('handoff', input, signal),
      integrationReceipt: (input, signal) => request('integrationReceipt', input, signal),
      fileReceipt: (input, signal) => request('fileReceipt', input, signal),
      codeExchange: (input, signal) => request('codeExchange', input, signal),
      resolve: (input, signal) => request('resolve', input, signal),
      prepare: (input, signal) => request('prepare', input, signal),
      bind: (input, signal) => request('bind', input, signal),
      authorize: (input, signal) => request('authorize', input, signal),
      execute: (input, signal) => request('execute', input, signal),
      service: async (input, signal) => {
        signal?.throwIfAborted();
        let cancellation: Promise<Awaited<ReturnType<ManagedSourceService['cancelService']>>> | undefined;
        const cancel = () => {
          cancellation ??= request('cancelService', { coordinatorHostId: input.coordinatorHostId,
            authorityId: input.authorityId, resourceEpoch: input.resourceEpoch, requestId: input.requestId });
          // Observe rejection immediately; the original call reports it below.
          void cancellation.catch(() => undefined);
        };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
          // Explicit cancellation has an independent control request. A lost
          // HTTP response never substitutes for the target's drain evidence.
          const result = await request('service', input);
          // A completed original effect receipt wins over a late cancellation
          // response or loss of the independent control connection.
          if (cancellation) await cancellation.catch(() => undefined);
          return decodeManagedSourceResponse(input.operation, result);
        } catch (error) {
          if (cancellation) {
            const receipt = await cancellation;
            if (receipt.status !== 'unknown') throw signal?.reason ?? new DOMException('Source service cancelled', 'AbortError');
          }
          throw error;
        } finally { signal?.removeEventListener('abort', cancel); }
      },
      fileObservation: (input, signal) => request('fileObservation', input, signal),
      inspectReadScope: (input, signal) => request('inspectReadScope', input, signal),
      closeReadScope: (input, signal) => request('closeReadScope', input, signal),
      cancelService: (input, signal) => request('cancelService', input, signal),
      observe: (input, signal) => request('observe', input, signal),
      releaseReceipt: (input, signal) => request('releaseReceipt', input, signal),
      cancel: (input, signal) => request('cancel', input, signal),
      release: (input, signal) => request('release', input, signal),
      inspectScope: (input, signal) => request('inspectScope', input, signal),
      releaseScope: (input, signal) => request('releaseScope', input, signal),
    };
  };
  const routedShellId = (machineId: string, processId: string): string => (
    `mrsh:${Buffer.from(JSON.stringify({ machineId, processId })).toString("base64url")}`
  );
  const parseShellId = (id: string): { machineId: string; processId: string } | null => {
    if (!id.startsWith("mrsh:")) return null;
    try {
      const value = JSON.parse(Buffer.from(id.slice(5), "base64url").toString("utf8")) as Record<string, unknown>;
      return typeof value.machineId === "string" && typeof value.processId === "string"
        ? { machineId: value.machineId, processId: value.processId }
        : null;
    } catch { return null; }
  };

  const scopeTargets = async (scopeId: string, machineId?: string): Promise<string[]> => {
    const grant = await options.kernel.issueGrant({ grantId: `remote-scope:${randomUUID()}`, owningWorkspace: scopeId,
      executionWorkspace: scopeId, capabilities: ["storage.read", "storage.write", "storage.maintenance"], pathScopes: [""] });
    const scoped = options.kernel.scoped(grant);
    try {
      if (machineId) {
        const recordId = `managed.shell.target:${machineId}`;
        if (!await scoped.getRecord(scopeId, recordId)) {
          try {
            await scoped.putRecord({ operationId: randomUUID(), workspaceId: scopeId,
              recordId, recordType: "managed.shell.target", state: "used",
              payloadJson: JSON.stringify({ id: machineId, machineId }), ownerIds: [], references: [] });
          } catch (error) {
            const concurrent = await scoped.getRecord(scopeId, recordId);
            if (!concurrent || payloadOf(concurrent).machineId !== machineId) throw error;
          }
        }
      }
      const ids: string[] = [];
      let cursor: number | undefined;
      do {
        const page = await scoped.listRecords({ workspaceId: scopeId, recordType: "managed.shell.target", pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }) });
        for (const record of page.records) {
          const id = stringValue(payloadOf(record).machineId);
          if (!id) throw new Error("Malformed managed shell target record");
          ids.push(id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return ids;
    } finally { await options.kernel.revokeGrant(grant.grantId); }
  };

  const setScopeSleeping = async (scopeId: string, sleeping: boolean): Promise<void> => {
    const results = await Promise.allSettled((await scopeTargets(scopeId)).map(async (machineId) => {
      const target = await targetFor(scopeId, machineId);
      if (!target) throw new Error(`Managed target ${machineId} is unavailable`);
      await new ManagedTargetClient(target, fetchImpl).json("/shell/scope-state", {
        coordinatorHostId: options.coordinatorHostId, scopeId, sleeping,
      });
    }));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new Error(failed.map((result) => String(result.reason)).join("\n"));
  };

  // The caller has already stopped the scope. Release its ownership receipts, not the machines.
  const releaseScope = async (scopeId: string): Promise<void> => {
    const ids = await scopeTargets(scopeId);
    const grant = await options.kernel.issueGrant({ grantId: `remote-release:${randomUUID()}`,
      owningWorkspace: scopeId, executionWorkspace: scopeId, capabilities: ['storage.maintenance'], pathScopes: [] });
    try {
      const scoped = options.kernel.scoped(grant);
      for (const id of ids) await scoped.releaseRecord(randomUUID(), scopeId, `managed.shell.target:${id}`);
    } finally { await options.kernel.revokeGrant(grant.grantId); }
  };

  const ownersForMachine = async (machineId: string): Promise<string[]> => {
    const grantId = `remote-owners:${randomUUID()}`;
    const grant = await options.kernel.issueGrant({ grantId, owningWorkspace: null, executionWorkspace: null,
      capabilities: ["storage.read", "storage.maintenance"], pathScopes: [] });
    try {
      const owners = new Set<string>();
      for (const recordType of ["managed.shell.target", "experiment.attempt"]) {
        const { workspaceIds } = await options.kernel.recordWorkspaces({ recordType }, grant);
        for (const scopeId of workspaceIds) {
          const ownerGrantId = `remote-owner:${randomUUID()}`;
          const ownerGrant = await options.kernel.issueGrant({ grantId: ownerGrantId, owningWorkspace: scopeId, executionWorkspace: scopeId,
            capabilities: ["storage.read"], pathScopes: [] });
          try {
            let cursor: number | undefined;
            do {
              const page = await options.kernel.scoped(ownerGrant).listRecords({ workspaceId: scopeId, recordType,
                ...(cursor === undefined ? {} : { cursor }) });
              for (const record of page.records) {
                if (payloadOf(record).machineId === machineId
                  && (recordType === "managed.shell.target" || !["completed", "failed", "cancelled", "lost"].includes(record.state))) owners.add(scopeId);
              }
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
          } finally { await options.kernel.revokeGrant(ownerGrantId); }
        }
      }
      return [...owners];
    } finally { await options.kernel.revokeGrant(grantId); }
  };

  const shellExec = async (workspaceId: string, machineId: string, input: { toolCallId: string; command: string; cwd?: string; waitMs: number; ownerScopeId?: string }, signal?: AbortSignal) => {
    const target = await targetFor(workspaceId, machineId);
    if (!target) throw new Error(`Managed target ${machineId} is unavailable`);
    const client = new ManagedTargetClient(target, fetchImpl);
    if (input.ownerScopeId) await scopeTargets(input.ownerScopeId, machineId);
    const result = await client.json<import("@varin/protocol").ShellExecResult>("/shell/exec", {
      coordinatorHostId: options.coordinatorHostId,
      ...input,
    }, "POST", signal);
    if (result.kind === "spawn-failed") return result;
    const executionId = result.executionId ? routedShellId(machineId, result.executionId) : undefined;
    const id = "id" in result ? routedShellId(machineId, result.id) : undefined;
    return {
      ...result,
      ...(id ? { id } : {}),
      ...(executionId ? { executionId } : {}),
    };
  };

  const shellRead = async (workspaceId: string, id: string, offset?: number, length?: number, waitMs?: number, signal?: AbortSignal) => {
    const route = parseShellId(id);
    if (!route) return null;
    if (!targets.has(route.machineId)) await refresh(workspaceId);
    const target = targets.get(route.machineId);
    if (!target) throw new Error(`Managed target ${route.machineId} is unavailable`);
    const client = new ManagedTargetClient(target, fetchImpl);
    const query = new URLSearchParams();
    if (offset !== undefined) query.set("offset", String(offset));
    if (length !== undefined) query.set("length", String(length));
    if (waitMs !== undefined) query.set("waitMs", String(waitMs));
    const result = await client.request<import("@varin/protocol").ShellReadResult>(`/shell/${encodeURIComponent(options.coordinatorHostId)}/${encodeURIComponent(route.processId)}?${query}`, signal ? { signal } : {});
    return {
      ...result,
      ...(result.executionId ? { executionId: routedShellId(route.machineId, result.executionId) } : {}),
      ...(result.shellId ? { shellId: routedShellId(route.machineId, result.shellId) } : {}),
    };
  };

  const shellWrite = async (workspaceId: string, id: string, inputText: string) => {
    const route = parseShellId(id);
    if (!route) return null;
    if (!targets.has(route.machineId)) await refresh(workspaceId);
    const target = targets.get(route.machineId);
    if (!target) throw new Error(`Managed target ${route.machineId} is unavailable`);
    return new ManagedTargetClient(target, fetchImpl).json<{ accepted: boolean }>(`/shell/${encodeURIComponent(options.coordinatorHostId)}/${encodeURIComponent(route.processId)}/write`, { text: inputText });
  };

  const shellKill = async (workspaceId: string, id: string) => {
    const route = parseShellId(id);
    if (!route) return null;
    if (!targets.has(route.machineId)) await refresh(workspaceId);
    const target = targets.get(route.machineId);
    if (!target) throw new Error(`Managed target ${route.machineId} is unavailable`);
    return new ManagedTargetClient(target, fetchImpl).json<{ killed: boolean }>(`/shell/${encodeURIComponent(options.coordinatorHostId)}/${encodeURIComponent(route.processId)}/kill`);
  };

  const externalAuthority = async (machineId: string, machine: KernelRecordResult): Promise<ExternalResourceAuthority | null> => {
    if (payloadOf(machine).backend !== "managed-remote") return null;
    if (!targets.has(machineId)) await refresh(TARGET_REFRESH_WORKSPACE);
    const target = targets.get(machineId);
    if (!target) return null;
    const client = new ManagedTargetClient(target, fetchImpl);
    return {
      authorityId: target.hostId,
      admit: async (input) => client.json<ManagedRemoteAdmissionReceipt>("/resources/admit", {
        coordinatorHostId: options.coordinatorHostId,
        workspaceId: input.workspaceId,
        machineId: input.machineId,
        attemptId: input.attemptId,
        resources: input.resources,
      }),
      reconcileAdmission: async (input) => client.json<ResourceAdmissionReconciliation>("/resources/observe", {
        coordinatorHostId: options.coordinatorHostId,
        workspaceId: input.workspaceId,
        machineId: input.machineId,
        attemptId: input.attemptId,
        resources: input.resources,
      }),
      release: async (input) => {
        await client.json("/resources/release", {
          coordinatorHostId: options.coordinatorHostId,
          workspaceId: input.workspaceId,
          machineId: input.machineId,
          attemptId: input.attemptId ?? "unknown",
          resources: {},
          commitmentId: input.commitmentId,
          reason: input.reason,
        });
      },
    };
  };

  const resolveBackend = async (
    _ctx: ExperimentContext,
    machineId: string,
    machine: KernelRecordResult | null,
    caller: ExperimentCaller,
  ): Promise<ResolvedExperimentBackend | null> => {
    if (!machine || payloadOf(machine).backend !== "managed-remote") return null;
    // Bind before probing. If the target is offline on the first resolution,
    // a later successful refresh still knows which durable workspace to
    // reconcile. Reconnect recovery only inspects existing job identities.
    const bound = workspaceBindings.get(machineId) ?? new Set<string>();
    bound.add(caller.workspaceId);
    workspaceBindings.set(machineId, bound);
    const target = await targetFor(caller.workspaceId, machineId);
    if (!target) return null;
    const client = new ManagedTargetClient(target, fetchImpl);
    const coordinatorPath = encodeURIComponent(options.coordinatorHostId);
    const backend: ExperimentBackend = {
      backend: "managed-remote",
      controls: ["cancel", "attach", "collect"],
      async spawn(site, request) {
        const receipt = await client.json<ManagedRemoteJobReceipt>("/jobs/submit", {
          coordinatorHostId: options.coordinatorHostId,
          sourceWorkspaceId: site.workspaceId,
          attemptId: request.attemptId,
          backendJobId: request.backendJobId,
          materialId: String((site.transport as { materialId: string }).materialId),
          cwd: request.cwd,
          command: request.command,
          args: request.args,
          env: request.env,
          resources: request.resources,
          ...(request.gpuAllocation ? { gpuAllocation: request.gpuAllocation } : {}),
        });
        return {
          handle: {
            backendJobId: receipt.backendJobId,
            ...(receipt.kernelEpoch ? { kernelEpoch: receipt.kernelEpoch } : {}),
            ...(receipt.pid !== undefined ? { pid: receipt.pid } : {}),
            executionRootId: receipt.executionRootId,
            executionCanonicalRoot: receipt.executionCanonicalRoot,
            executionCwd: receipt.executionCwd,
          },
          observation: receipt.observation,
        };
      },
      inspect: async (_site, backendJobId) => client.request<BackendObservation>(`/jobs/${coordinatorPath}/${encodeURIComponent(backendJobId)}`),
      read: async (_site, backendJobId, cursor) => client.request<ManagedRemoteReadReceipt>(`/jobs/${coordinatorPath}/${encodeURIComponent(backendJobId)}/output?cursor=${cursor}`),
      async kill(_site, backendJobId) { await client.json(`/jobs/${coordinatorPath}/${encodeURIComponent(backendJobId)}/kill`); },
      async release(_site, backendJobId) { await client.json(`/jobs/${coordinatorPath}/${encodeURIComponent(backendJobId)}/release`); },
      async collectFile(_site, relativePath, backendJobId): Promise<BackendRemoteObject> {
        const receipt = await client.json<ManagedRemoteOutputReceipt>(`/jobs/${coordinatorPath}/${encodeURIComponent(backendJobId)}/outputs`, { path: relativePath });
        return receipt;
      },
      async readCollectedObject(_site, outputId, offset, length) {
        const page = await client.request<{ bytesBase64: string; nextOffset: number; eof: boolean }>(`/outputs/${encodeURIComponent(outputId)}?offset=${offset}&length=${length}`);
        return { bytes: Buffer.from(page.bytesBase64, "base64"), nextOffset: page.nextOffset, eof: page.eof };
      },
    };
    return {
      backend,
      site: {
        workspaceId: caller.workspaceId,
        rootId: "",
        canonicalRoot: "",
        machineId,
        transport: { targetHostId: target.hostId },
      },
      reconcilePreparation: async ({ input }) => {
        const transfer = await openExperimentInputTransfer(options.kernel, caller, input);
        try {
          const probe = await client.json<ManagedRemoteMaterialProbe>("/materials/probe", {
            coordinatorHostId: options.coordinatorHostId, materialId: transfer.materialId,
            entries: transfer.entries, ...(transfer.cwd ? { cwd: transfer.cwd } : {}),
          });
          // Absence of the ready record cannot rule out an in-flight remote commit.
          return probe.ready && probe.rootId && probe.canonicalRoot ? "drained" : "unknown";
        } finally { await transfer.close(); }
      },
      prepare: async ({ attemptId, input, signal }) => {
        let transfer: Awaited<ReturnType<typeof openExperimentInputTransfer>> | undefined;
        let commitDispatched = false;
        try {
          signal?.throwIfAborted();
          transfer = await openExperimentInputTransfer(options.kernel, caller, input, signal ? { signal } : {});
          const manifest: ManagedRemoteMaterialManifest = {
            coordinatorHostId: options.coordinatorHostId,
            materialId: transfer.materialId,
            entries: transfer.entries,
            ...(transfer.cwd ? { cwd: transfer.cwd } : {}),
          };
          const probeReceipt = await client.json<ManagedRemoteMaterialProbe>("/materials/probe", manifest, undefined, signal);
          for (const object of probeReceipt.missingObjects) {
            signal?.throwIfAborted();
            await client.request(`/objects/${encodeURIComponent(object.objectHash)}`, {
              method: "PUT",
              headers: {
                "X-Varin-Coordinator-Host": options.coordinatorHostId,
                "X-Varin-Object-Length": String(object.byteLength),
                "Content-Type": "application/octet-stream",
              },
              body: transfer.readObject(object.objectHash, object.byteLength, signal),
              ...(signal ? { signal } : {}),
            });
          }
          signal?.throwIfAborted();
          // A dispatched remote materialization is an owned writer. Cancelling its
          // response would not stop the target; retain the real completion for drain.
          let receipt: ManagedRemoteMaterialReceipt;
          if (probeReceipt.ready && probeReceipt.rootId && probeReceipt.canonicalRoot) {
            receipt = { materialId: transfer.materialId, root: transfer.materialId, rootId: probeReceipt.rootId,
              canonicalRoot: probeReceipt.canonicalRoot, cwd: probeReceipt.cwd ?? "", reused: true };
          } else {
            commitDispatched = true;
            receipt = await client.json<ManagedRemoteMaterialReceipt>("/materials/commit", manifest);
          }
          return {
            site: {
              workspaceId: caller.workspaceId,
              rootId: receipt.rootId,
              canonicalRoot: receipt.canonicalRoot,
              machineId,
              transport: { targetHostId: target.hostId, materialId: transfer.materialId, backendJobId: `experiment-${digest(caller.workspaceId, attemptId).slice(0, 40)}` },
            },
            cwd: receipt.cwd,
            inputRoot: receipt.root,
            reused: receipt.reused,
          };
        } catch (error) {
          // Before commit this adapter has not started an attempt/materialization
          // writer. Uploaded objects remain with the shared content owner.
          if (!commitDispatched) throw new ExperimentPreparationError(error instanceof Error ? error.message : String(error), { drained: true, cause: error });
          throw error;
        } finally { await transfer?.close(); }
      },
    };
  };

  return { refresh, resolveBackend, externalAuthority, targetFor, sourceTargets, sourceTarget, forwardTarget, selectForwardTarget, storageTargets, storage, source, shellExec, shellRead, shellWrite, shellKill, setScopeSleeping, releaseScope, ownersForMachine };
}

export type ManagedRemoteTargetRegistry = ReturnType<typeof createManagedRemoteTargetRegistry>;
