import { createHash } from "node:crypto";
import type { KernelClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type { ExperimentCaller, ExperimentContext } from "./experiments.js";
import type {
  BackendObservation,
  BackendRemoteObject,
  ExperimentBackend,
  ResolvedExperimentBackend,
} from "./experiment-backend.js";
import { openExperimentInputTransfer } from "./experiment-workspace.js";
import type { ExternalResourceAuthority, ResourceMachineRegistration, ResourceService } from "./resources.js";
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
} from "./managed-remote-types.js";

const BASE_PATH = "/api/harness/managed-execution/v1";
const TARGET_REFRESH_WORKSPACE = "__varin_managed_remote__";
const digest = (...values: string[]): string => createHash("sha256").update(values.join("\0")).digest("hex");
const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const payload = JSON.parse(record.payloadJson) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch { return {}; }
};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

interface ConfiguredHost {
  id: string;
  label: string;
  apiUrl: string;
  clientToken?: string;
  requestHeaders: Record<string, string>;
  source: "desktop-host" | "ssh-instance" | "configured-host";
}

interface ManagedTarget {
  machineId: string;
  hostId: string;
  connection: ConfiguredHost;
  identity: ManagedRemoteIdentity;
}

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
  onError?: (error: Error) => void;
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

  async request<Result>(relativePath: string, init: Omit<RequestInit, "body"> & { body?: RequestInit["body"] | AsyncIterable<Uint8Array> } = {}): Promise<Result> {
    const url = new URL(`${BASE_PATH}${relativePath}`, `${this.target.connection.apiUrl.replace(/\/$/, "")}/`).toString();
    const { body, ...rest } = init;
    const asyncBody = body !== undefined && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
    const response = await this.fetchImpl(url, {
      ...rest,
      headers: this.headers(Object.fromEntries(new Headers(init.headers).entries())),
      ...(body === undefined ? {} : { body: body as never }),
      ...(asyncBody ? { duplex: "half" as never } : {}),
    });
    const actualHost = response.headers.get("x-varin-managed-host");
    if (actualHost !== this.target.hostId) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Managed target identity changed for ${this.target.machineId}`);
    }
    const responseBody = await response.json().catch(() => null) as Result | { error?: unknown } | null;
    if (!response.ok) {
      const message = responseBody && typeof responseBody === "object" && "error" in responseBody && typeof responseBody.error === "string"
        ? responseBody.error : `Managed target request failed (${response.status})`;
      throw new Error(message);
    }
    return responseBody as Result;
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

const configuredHosts = (settings: Record<string, unknown>): ConfiguredHost[] => {
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
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  const probe = async (connection: ConfiguredHost): Promise<ManagedTarget> => {
    const headers = new Headers(connection.requestHeaders);
    headers.set("Accept", "application/json");
    if (connection.clientToken) headers.set("Authorization", `Bearer ${connection.clientToken}`);
    const response = await fetchImpl(new URL(`${BASE_PATH}/identity`, `${connection.apiUrl.replace(/\/$/, "")}/`), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const identity = await response.json().catch(() => null) as ManagedRemoteIdentity | { error?: string } | null;
    if (!response.ok || !identity || !("hostId" in identity) || typeof identity.hostId !== "string") {
      throw new Error(identity && "error" in identity && typeof identity.error === "string" ? identity.error : `Target probe failed (${response.status})`);
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
      const probed = await Promise.allSettled(configured.map(probe));
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

  const shellExec = async (workspaceId: string, machineId: string, input: { toolCallId: string; command: string; cwd?: string; waitMs: number }, signal?: AbortSignal) => {
    const target = await targetFor(workspaceId, machineId);
    if (!target) throw new Error(`Managed target ${machineId} is unavailable`);
    const client = new ManagedTargetClient(target, fetchImpl);
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
      prepare: async ({ attemptId, input }) => {
        const transfer = await openExperimentInputTransfer(options.kernel, caller, input);
        const manifest: ManagedRemoteMaterialManifest = {
          coordinatorHostId: options.coordinatorHostId,
          materialId: transfer.materialId,
          entries: transfer.entries,
          ...(transfer.cwd ? { cwd: transfer.cwd } : {}),
        };
        const probeReceipt = await client.json<ManagedRemoteMaterialProbe>("/materials/probe", manifest);
        for (const object of probeReceipt.missingObjects) {
          await client.request(`/objects/${encodeURIComponent(object.objectHash)}`, {
            method: "PUT",
            headers: {
              "X-Varin-Coordinator-Host": options.coordinatorHostId,
              "X-Varin-Object-Length": String(object.byteLength),
              "Content-Type": "application/octet-stream",
            },
            body: transfer.readObject(object.objectHash, object.byteLength),
          });
        }
        const receipt = probeReceipt.ready && probeReceipt.rootId && probeReceipt.canonicalRoot
          ? { materialId: transfer.materialId, root: transfer.materialId, rootId: probeReceipt.rootId, canonicalRoot: probeReceipt.canonicalRoot, cwd: probeReceipt.cwd ?? "", reused: true }
          : await client.json<ManagedRemoteMaterialReceipt>("/materials/commit", manifest);
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
      },
    };
  };

  return { refresh, resolveBackend, externalAuthority, targetFor, shellExec, shellRead, shellWrite, shellKill };
}

export type ManagedRemoteTargetRegistry = ReturnType<typeof createManagedRemoteTargetRegistry>;
