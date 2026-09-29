/**
 * BC4 Computer Use service.
 *
 * Owns the machine/desktop catalog (kernel `computer.machine` /
 * `computer.desktop` records), the per-desktop resident driver session, the
 * serialized action queue, and cancellation. Observations carry ids that pin
 * element indexes to the read that produced them; actions citing a stale
 * observation are rejected rather than replayed onto a changed UI.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerAppDescriptor,
  ComputerCapabilities,
  ComputerControlState,
  ComputerDesktop,
  ComputerDesktopFrame,
  ComputerElement,
  ComputerHumanInput,
  ComputerInputResult,
  ComputerListResult,
  ComputerMachine,
  ComputerObservation,
  ComputerPlatform,
} from "@varin/protocol";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import { HarnessServiceError } from "../harness/service-error.js";
import {
  computerDriverDir,
  createDriverSession,
  localDriverSpawnSpec,
  type ComputerDriverSession,
  type DriverRequest,
  type DriverResponse,
  type DriverSpawnSpec,
} from "./driver-host.js";

/** Kernel workspace under which computer catalog records live. */
export const COMPUTER_CATALOG_WORKSPACE_ID = "__varin_computers__";

/** Stable ids for the machine this Host runs on and its console desktop. */
export const LOCAL_MACHINE_ID = "local";
export const LOCAL_DESKTOP_ID = "local-console";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const localPlatform = (): ComputerPlatform => (
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
);

// ---------------------------------------------------------------------------
// Catalog record <-> DTO
// ---------------------------------------------------------------------------

const recordIdSuffix = (record: KernelRecordResult): string | undefined =>
  record.recordId.startsWith("computer.machine:")
    ? record.recordId.slice("computer.machine:".length)
    : record.recordId.startsWith("computer.desktop:")
      ? record.recordId.slice("computer.desktop:".length)
      : undefined;

const parseMachine = (record: KernelRecordResult): ComputerMachine | null => {
  try {
    const raw = JSON.parse(record.payloadJson) as unknown;
    if (!isObject(raw)) return null;
    const id = recordIdSuffix(record);
    if (!id || raw.id !== id) return null;
    if (!asString(raw.name) || !asString(raw.coordinatorHostId)) return null;
    return {
      id,
      name: raw.name as string,
      provider: (asString(raw.provider) ?? "local") as ComputerMachine["provider"],
      platform: (asString(raw.platform) ?? "windows") as ComputerPlatform,
      coordinatorHostId: raw.coordinatorHostId as string,
      status: (record.state === "active" || record.state === "archived" ? record.state : "unavailable") as ComputerMachine["status"],
      ...(asString(raw.statusDetail) ? { statusDetail: raw.statusDetail as string } : {}),
      createdAt: asString(raw.createdAt) ?? new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    };
  } catch {
    return null;
  }
};

const parseDesktop = (record: KernelRecordResult): ComputerDesktop | null => {
  try {
    const raw = JSON.parse(record.payloadJson) as unknown;
    if (!isObject(raw)) return null;
    const id = recordIdSuffix(record);
    if (!id || raw.id !== id || !asString(raw.machineId) || !asString(raw.label)) return null;
    return {
      id,
      machineId: raw.machineId as string,
      label: raw.label as string,
      kind: (asString(raw.kind) ?? "console") as ComputerDesktop["kind"],
      status: (["available", "unavailable", "stopped"].includes(record.state) ? record.state : "unavailable") as ComputerDesktop["status"],
      ...(asString(raw.statusDetail) ? { statusDetail: raw.statusDetail as string } : {}),
      ...(isObject(raw.capabilities) ? { capabilities: raw.capabilities as unknown as ComputerCapabilities } : {}),
      // Remote mirror (BC6): calls route to the owning Host, never a local driver.
      ...(isObject(raw.remote) && asString(raw.remote.connectionId) && asString(raw.remote.desktopId)
        ? { remote: { connectionId: raw.remote.connectionId as string, desktopId: raw.remote.desktopId as string } }
        : {}),
    };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Driver snapshot -> ComputerObservation
// ---------------------------------------------------------------------------

const frameOf = (value: unknown): ComputerObservation["windowBounds"] => {
  if (!isObject(value)) return undefined;
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const width = asNumber(value.width);
  const height = asNumber(value.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
};

const elementOf = (value: unknown): ComputerElement | null => {
  if (!isObject(value)) return null;
  const index = asNumber(value.index);
  if (index === undefined) return null;
  const element: ComputerElement = { index };
  if (Array.isArray(value.path) && value.path.every((v) => Number.isSafeInteger(v) && v >= 0)) {
    element.path = value.path as number[];
  }
  if (Array.isArray(value.runtimeId)) element.runtimeId = value.runtimeId.filter((v): v is number => typeof v === "number");
  if (asString(value.automationId)) element.automationId = value.automationId as string;
  if (asString(value.name)) element.name = value.name as string;
  if (asString(value.controlType)) element.controlType = value.controlType as string;
  if (asString(value.localizedControlType)) element.localizedControlType = value.localizedControlType as string;
  if (asString(value.className)) element.className = value.className as string;
  if (typeof value.value === "string") element.value = value.value;
  const handle = asNumber(value.nativeWindowHandle);
  if (handle !== undefined && handle > 0) element.nativeWindowHandle = handle;
  const frame = frameOf(value.frame);
  if (frame) element.frame = frame;
  if (Array.isArray(value.actions)) element.actions = value.actions.filter((v): v is string => typeof v === "string");
  return element;
};

const observationOf = (
  snapshot: Record<string, unknown>,
  desktop: ComputerDesktop,
): ComputerObservation => {
  const app = isObject(snapshot.app) ? snapshot.app : {};
  const observation: ComputerObservation = {
    id: randomUUID(),
    desktopId: desktop.id,
    machineId: desktop.machineId,
    app: {
      name: asString(app.name) ?? "unknown",
      pid: asNumber(app.pid) ?? 0,
      ...(asString(app.windowTitle ?? snapshot.windowTitle)
        ? { windowTitle: (app.windowTitle ?? snapshot.windowTitle) as string }
        : {}),
    },
    treeLines: Array.isArray(snapshot.treeLines)
      ? snapshot.treeLines.filter((line): line is string => typeof line === "string")
      : [],
    elements: Array.isArray(snapshot.elements)
      ? snapshot.elements.map(elementOf).filter((e): e is ComputerElement => e !== null)
      : [],
    capturedAt: new Date().toISOString(),
  };
  if (asString(snapshot.windowTitle)) observation.windowTitle = snapshot.windowTitle as string;
  const handle = asNumber(snapshot.windowHandle);
  // Linux AT-SPI uses a zero-based child index as the window handle.
  if (handle !== undefined && handle >= 0) observation.windowHandle = handle;
  const dpi = asNumber(snapshot.dpiScale);
  if (dpi !== undefined && dpi > 0) observation.dpiScale = dpi;
  if (Array.isArray(snapshot.windows)) {
    observation.windows = snapshot.windows
      .map((window): import("@varin/protocol").ComputerWindowDescriptor | null => {
        if (!isObject(window)) return null;
        const wh = asNumber(window.handle);
        if (wh === undefined || wh < 0) return null;
        const bounds = frameOf(window.bounds);
        return {
          handle: wh,
          ...(asString(window.title) ? { title: window.title as string } : {}),
          ...(bounds ? { bounds } : {}),
          ...(typeof window.visible === "boolean" ? { visible: window.visible } : {}),
          ...(typeof window.minimized === "boolean" ? { minimized: window.minimized } : {}),
          ...(typeof window.main === "boolean" ? { main: window.main } : {}),
        };
      })
      .filter((w): w is NonNullable<typeof w> => w !== null);
  }
  const bounds = frameOf(snapshot.windowBounds);
  if (bounds) observation.windowBounds = bounds;
  if (asString(snapshot.focusedSummary)) observation.focusedSummary = snapshot.focusedSummary as string;
  if (asString(snapshot.selectedText)) observation.selectedText = snapshot.selectedText as string;
  if (asString(snapshot.screenshotPngBase64)) {
    observation.screenshot = {
      mime: "image/png",
      base64: snapshot.screenshotPngBase64 as string,
      ...(bounds ? { width: Math.round(bounds.width), height: Math.round(bounds.height) } : {}),
    };
  }
  return observation;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CancelledActionError extends Error {
  constructor() { super("Computer action cancelled before it reached the driver"); }
}

/**
 * The HTTP request to the remote Host never produced a usable response —
 * the action may or may not have reached the desktop (BC6: report, never
 * replay). Distinct from a structured remote rejection.
 */
class RemoteTransportError extends HarnessServiceError {
  constructor(message: string) { super("unavailable", message); }
}

interface QueuedOp {
  /**
   * `action` ops are automated script work — cancelled generations drop them.
   * `input` ops are human control input — validated against the live control
   * owner at execution time instead of a generation stamp, because the human
   * stream continues across agent-side cancels while they still hold control.
   */
  kind: "observe" | "action" | "input";
  generation: number;
  run(): Promise<void>;
  /** Called when the entry is dropped before reaching the driver. */
  cancel(): void;
}

/** Server-side control ownership for one desktop (BC5). */
interface DesktopControl {
  owner: "agent" | "human";
  /** Viewer id that holds human control; undefined while the agent owns it. */
  holderId?: string;
  /** False when the holder's view channel is lost — pending recovery. */
  reachable: boolean;
  since: string;
}

/** A viewer's frame/control subscription callback (BC5.B). */
export type DesktopViewEvent =
  | { type: "control"; control: ComputerControlState }
  | { type: "frame"; frame: ComputerDesktopFrame }
  | { type: "error"; error: string };

interface DesktopViewers {
  viewers: Map<string, (event: DesktopViewEvent) => void>;
  timer: NodeJS.Timeout | null;
  /** A frame capture is in flight inside the lane. */
  polling: boolean;
  /** Consecutive capture failures before viewers get an error event. */
  failures: number;
}

interface DesktopLane {
  queue: QueuedOp[];
  running: boolean;
  /** Bumped on cancel; actions stamped with an older generation report cancelled. */
  generation: number;
  /** Input ownership — BC5 takeover/handback state machine. */
  control: DesktopControl;
}

/** A configured remote Host a `remote` desktop's calls route to (BC6). */
export interface ComputerRemoteHost {
  /** Settings connection id — also the remote machine's catalog prefix. */
  id: string;
  label: string;
  apiUrl: string;
  clientToken?: string;
  requestHeaders?: Record<string, string>;
}

export interface ComputerServiceOptions {
  client: KernelClient;
  hostId: string;
  /** Host data dir — the default-target selection persists under it. */
  dataDir?: string;
  platform?: ComputerPlatform;
  driverDir?: string;
  /** Test seam: inject a fake driver factory. */
  createDriver?: (spec: DriverSpawnSpec) => ComputerDriverSession;
  /**
   * Configured remote Hosts (BC6) — the same `desktopHosts` settings surface
   * managed-remote resolves. Each entry's apiUrl+token authenticates
   * Host-to-Host computer calls; local SSH credentials are never copied.
   */
  remoteHosts?: () => Promise<ComputerRemoteHost[]>;
  /** Test seam: override fetch for remote Host calls. */
  fetch?: typeof fetch;
}

export interface ComputerService {
  list(): Promise<ComputerListResult>;
  /** Ensure the local machine/console desktop records exist. */
  ensureLocal(): Promise<{ machine: ComputerMachine; desktop: ComputerDesktop }>;
  /** Re-probe driver capabilities into the desktop record. */
  probe(desktopId?: string): Promise<ComputerDesktop>;
  /** The user's persisted default target; null = pick the sole desktop. */
  defaultDesktop(): Promise<string | null>;
  setDefaultDesktop(desktopId: string | null): Promise<void>;
  /** App inventory on a desktop. */
  listApps(desktopId?: string): Promise<ComputerAppDescriptor[]>;
  observe(params: {
    desktopId?: string;
    app: string;
    /** Select one of the app's windows: hwnd number or title (BC4.B). */
    window?: number | string;
    includeScreenshot?: boolean;
    textLimit?: number | "max";
    maxTreeNodes?: number;
    maxTreeDepth?: number;
    signal?: AbortSignal;
  }): Promise<ComputerObservation>;
  act(params: { desktopId?: string; action: ComputerAction; signal?: AbortSignal }): Promise<ComputerActionResult>;
  cancel(desktopId?: string): Promise<{ cancelled: number; released: boolean }>;
  release(desktopId?: string): Promise<{ released: boolean }>;
  // --- BC5: control ownership + desktop view --------------------------------
  /** Current control owner record for a desktop. */
  control(desktopId?: string): Promise<ComputerControlState>;
  /**
   * Take human control: drop queued automation, cancel the in-flight op at a
   * driver checkpoint, release held input, then confirm the transfer. Only
   * after this resolves may a viewer send `input`.
   */
  takeover(params: { desktopId?: string; holderId?: string }): Promise<{ control: ComputerControlState; cancelled: number; released: boolean }>;
  /**
   * Return control to the agent. Stale observations are invalidated so the
   * next automated step re-observes the desktop the human left behind.
   */
  handback(params: { desktopId?: string; holderId?: string }): Promise<{ control: ComputerControlState; requiresObservation: true }>;
  /** Human input through the same lane — only while `owner === "human"`. */
  input(params: { desktopId?: string; holderId?: string; input: ComputerHumanInput }): Promise<ComputerInputResult>;
  /**
   * Subscribe a viewer to desktop frames + control changes. Closing the view
   * unsubscribes without cancelling work; when the holder's subscription
   * drops, control stays human-owned but unreachable until it reconnects.
   */
  subscribeFrames(desktopId: string, viewerId: string, listener: (event: DesktopViewEvent) => void): Promise<() => void>;
  dispose(): Promise<void>;
}

export function createComputerService(options: ComputerServiceOptions): ComputerService {
  const platform = options.platform ?? localPlatform();
  const newDriver = options.createDriver ?? createDriverSession;
  let scopedClient: Promise<KernelScopedClient> | null = null;
  const drivers = new Map<string, ComputerDriverSession>();
  const lanes = new Map<string, DesktopLane>();
  let disposed = false;
  let localReady: Promise<{ machine: ComputerMachine; desktop: ComputerDesktop }> | null = null;
  let localProbe: Promise<ComputerDesktop> | null = null;
  /** Latest observation per desktop+app — the reference frame for element indexes. */
  const observations = new Map<string, Map<string, ComputerObservation>>();

  const scoped = (): Promise<KernelScopedClient> => {
    if (scopedClient) return scopedClient;
    const creating = (async () => {
      const grant = await options.client.issueGrant({
        grantId: `computer-catalog:${randomUUID()}`,
        owningWorkspace: COMPUTER_CATALOG_WORKSPACE_ID,
        executionWorkspace: COMPUTER_CATALOG_WORKSPACE_ID,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return options.client.scoped(grant);
    })();
    scopedClient = creating;
    void creating.catch(() => { if (scopedClient === creating) scopedClient = null; });
    return creating;
  };

  const listRecords = async (recordType: string): Promise<KernelRecordResult[]> => {
    const client = await scoped();
    const records: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await client.listRecords({
        workspaceId: COMPUTER_CATALOG_WORKSPACE_ID,
        recordType,
        ...(typeof cursor === "number" ? { cursor } : {}),
        pageSize: 100,
      });
      records.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return records;
  };

  const putRecord = async (
    recordId: string,
    recordType: "computer.machine" | "computer.desktop",
    state: string,
    payload: Record<string, unknown>,
  ): Promise<KernelRecordResult> => {
    const client = await scoped();
    const existing = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, recordId);
    return client.putRecord({
      operationId: `${recordType}:${randomUUID()}`,
      workspaceId: COMPUTER_CATALOG_WORKSPACE_ID,
      recordId,
      recordType,
      state,
      payloadJson: JSON.stringify(payload),
      ownerIds: [],
      references: [],
      ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
    });
  };

  const desktopRecord = async (desktopId: string): Promise<{ record: KernelRecordResult; desktop: ComputerDesktop }> => {
    const client = await scoped();
    const record = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.desktop:${desktopId}`);
    const desktop = record ? parseDesktop(record) : null;
    if (!record || !desktop) {
      throw new HarnessServiceError("not-found", `Unknown computer desktop "${desktopId}"`);
    }
    return { record, desktop };
  };

  const machineFor = async (desktop: ComputerDesktop): Promise<ComputerMachine | null> => {
    const client = await scoped();
    const record = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.machine:${desktop.machineId}`).catch(() => null);
    return record ? parseMachine(record) : null;
  };

  const laneFor = (desktopId: string): DesktopLane => {
    const existing = lanes.get(desktopId);
    if (existing) return existing;
    const lane: DesktopLane = {
      queue: [],
      running: false,
      generation: 0,
      control: { owner: "agent", reachable: true, since: new Date().toISOString() },
    };
    lanes.set(desktopId, lane);
    return lane;
  };

  const controlState = (desktopId: string): ComputerControlState => {
    const control = laneFor(desktopId).control;
    return {
      desktopId,
      owner: control.owner,
      ...(control.holderId ? { holderId: control.holderId } : {}),
      reachable: control.reachable,
      since: control.since,
    };
  };

  /** Broadcast the control record to every subscribed viewer (BC5.B). */
  const viewers = new Map<string, DesktopViewers>();
  const broadcastControl = (desktopId: string) => {
    const entry = viewers.get(desktopId);
    if (!entry) return;
    const event: DesktopViewEvent = { type: "control", control: controlState(desktopId) };
    for (const listener of entry.viewers.values()) {
      try { listener(event); } catch { /* a broken viewer must not block others */ }
    }
  };

  // --- BC6: remote Host routing --------------------------------------------
  // `provider:"remote"` machines are mirrors: their desktops live on another
  // Host's service. Control state, lanes, drivers, and frame polls all run
  // there; this service only carries authenticated calls across.

  const fetchImpl = options.fetch ?? fetch;

  const remoteConnections = async (): Promise<ComputerRemoteHost[]> => (
    options.remoteHosts ? (await options.remoteHosts().catch(() => [])) : []
  );

  const remoteHeaders = (connection: ComputerRemoteHost, extra?: Record<string, string>): Headers => {
    const headers = new Headers(connection.requestHeaders ?? {});
    if (connection.clientToken) headers.set("Authorization", `Bearer ${connection.clientToken}`);
    if (extra) for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
  };

  const remoteFetch = async (
    connection: ComputerRemoteHost,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const url = `${connection.apiUrl.replace(/\/$/, "")}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: remoteHeaders(connection, body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ?? AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new RemoteTransportError(
        `Remote Host "${connection.label}" is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return response;
  };

  const remoteJson = async <T>(connection: ComputerRemoteHost, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await remoteFetch(connection, method, path, body);
    const payload = await response.json().catch(() => null) as (T & { code?: string; error?: string }) | null;
    if (!response.ok) {
      const code = payload && typeof payload.code === "string" && ["invalid-params", "not-found", "forbidden", "denied", "unavailable"].includes(payload.code)
        ? payload.code as HarnessServiceError["harnessCode"]
        : "failed";
      throw new HarnessServiceError(
        code,
        payload && typeof payload.error === "string" ? payload.error : `Remote computer request failed (${response.status})`,
      );
    }
    return payload as T;
  };

  /** The connection + remote id behind a catalog desktop, or null for local. */
  const remoteTargetFor = async (desktopId: string): Promise<{ connection: ComputerRemoteHost; remoteId: string; desktop: ComputerDesktop } | null> => {
    await ensureLocal(); // catalog records may not exist until first init
    const { desktop } = await desktopRecord(desktopId);
    if (!desktop.remote) return null;
    const connection = (await remoteConnections()).find((entry) => entry.id === desktop.remote!.connectionId);
    if (!connection) {
      throw new HarnessServiceError("unavailable", `Remote Host "${desktop.remote.connectionId}" is no longer configured`);
    }
    return { connection, remoteId: desktop.remote.desktopId, desktop };
  };

  /**
   * Mirror remote Host catalogs into local machine/desktop records (BC6).
   * Remote truth wins status; an unreachable Host marks its mirror
   * unavailable with the real error instead of leaving a stale "available".
   */
  let remoteSyncAt = 0;
  const syncRemote = async (): Promise<void> => {
    if (!options.remoteHosts) return;
    if (Date.now() - remoteSyncAt < 10_000) return;
    remoteSyncAt = Date.now();
    const hosts = await remoteConnections();
    const liveIds = new Set(hosts.map((host) => `remote:${host.id}`));
    // Hosts removed from settings keep their mirrors but report unconfigured.
    const known = (await listRecords("computer.machine"))
      .map(parseMachine)
      .filter((m): m is ComputerMachine => m !== null && m.provider === "remote");
    const now = new Date().toISOString();
    await Promise.allSettled([
      ...hosts.map(async (host) => {
        const machineId = `remote:${host.id}`;
        try {
          const catalog = await remoteJson<{ machines?: ComputerMachine[]; desktops?: ComputerDesktop[] }>(host, "GET", "/api/computers");
          const remoteMachines = catalog.machines ?? [];
          const remoteDesktops = catalog.desktops ?? [];
          const primary = remoteMachines[0];
          await putRecord(`computer.machine:${machineId}`, "computer.machine", "active", {
            id: machineId,
            name: host.label,
            provider: "remote",
            platform: primary?.platform ?? "linux",
            coordinatorHostId: `remote:${host.id}`,
            remoteConnectionId: host.id,
            createdAt: now,
          });
          for (const remoteDesktop of remoteDesktops) {
            const remoteMachine = remoteMachines.find((m) => m.id === remoteDesktop.machineId);
            if (remoteMachine?.platform) {
              await putRecord(`computer.machine:${machineId}`, "computer.machine", "active", {
                id: machineId,
                name: host.label,
                provider: "remote",
                platform: remoteMachine.platform,
                coordinatorHostId: `remote:${host.id}`,
                remoteConnectionId: host.id,
                createdAt: now,
              });
            }
            await putRecord(`computer.desktop:remote:${host.id}:${remoteDesktop.id}`, "computer.desktop", remoteDesktop.status, {
              id: `remote:${host.id}:${remoteDesktop.id}`,
              machineId,
              label: `${host.label} · ${remoteDesktop.label}`,
              kind: "remote-session",
              ...(remoteDesktop.statusDetail ? { statusDetail: remoteDesktop.statusDetail } : {}),
              ...(remoteDesktop.capabilities ? { capabilities: remoteDesktop.capabilities as unknown as Record<string, unknown> } : {}),
              remote: { connectionId: host.id, desktopId: remoteDesktop.id },
            });
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await putRecord(`computer.machine:${machineId}`, "computer.machine", "unavailable", {
            id: machineId,
            name: host.label,
            provider: "remote",
            platform: "linux",
            coordinatorHostId: `remote:${host.id}`,
            remoteConnectionId: host.id,
            statusDetail: detail,
            createdAt: now,
          }).catch(() => undefined);
        }
      }),
      ...known.filter((machine) => !liveIds.has(machine.id)).map(async (machine) => {
        await putRecord(`computer.machine:${machine.id}`, "computer.machine", "unavailable", {
          id: machine.id,
          name: machine.name,
          provider: "remote",
          platform: machine.platform,
          coordinatorHostId: machine.coordinatorHostId,
          statusDetail: "Host is no longer configured.",
          createdAt: machine.createdAt,
        }).catch(() => undefined);
      }),
    ]);
  };

  const pump = (lane: DesktopLane) => {
    for (;;) {
      if (lane.running) return;
      const next = lane.queue.shift();
      if (!next) return;
      // An action stamped before the last cancel must never reach the driver —
      // it may have arrived on the queue after the cancel drained it.
      if (next.kind === "action" && next.generation !== lane.generation) {
        next.cancel();
        continue;
      }
      lane.running = true;
      void next.run().finally(() => {
        lane.running = false;
        pump(lane);
      });
      return;
    }
  };

  /** Serialize every driver-bound op per desktop so cancel() owns the queue. */
  const enqueue = <T>(desktopId: string, kind: QueuedOp["kind"], op: () => Promise<T>, generation?: number): Promise<T> => {
    const lane = laneFor(desktopId);
    return new Promise<T>((resolve, reject) => {
      lane.queue.push({
        kind,
        generation: generation ?? lane.generation,
        run: async () => {
          try {
            resolve(await op());
          } catch (error) {
            reject(error);
          }
        },
        cancel: () => reject(new CancelledActionError()),
      });
      pump(lane);
    });
  };

  /** Stamp the lane's generation; compare after await to detect a mid-flight cancel. */
  const laneGeneration = (desktopId: string) => laneFor(desktopId).generation;

  const requestWithAbort = async (
    driver: ComputerDriverSession,
    op: Omit<DriverRequest, "id">,
    signal?: AbortSignal,
  ): Promise<DriverResponse> => {
    signal?.throwIfAborted();
    const pending = driver.request(op);
    if (!signal) return pending;
    // The bridge/router aborts its wait on script timeout or client cancel.
    // Interrupt the native operation too; otherwise it could keep typing after
    // the caller has already received a cancellation result.
    const onAbort = () => { driver.cancel(); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { return await pending; }
    finally { signal.removeEventListener("abort", onAbort); }
  };

  const driverFor = async (desktopId: string): Promise<{ driver: ComputerDriverSession; desktop: ComputerDesktop }> => {
    if (disposed) throw new HarnessServiceError("unavailable", "Computer service is closed");
    await ensureLocal();
    const { desktop } = await desktopRecord(desktopId);
    if (desktop.status === "stopped") {
      throw new HarnessServiceError("unavailable", `Desktop "${desktopId}" is stopped`);
    }
    const machine = await machineFor(desktop);
    if (!machine || machine.status !== "active") {
      throw new HarnessServiceError("unavailable", `Machine for desktop "${desktopId}" is unavailable`);
    }
    if (machine.provider !== "local" || machine.coordinatorHostId !== options.hostId) {
      // Remote desktops arrive with BC6's connection management; until then
      // only drivers on this Host's own machine can be opened.
      throw new HarnessServiceError("unavailable", `Desktop "${desktopId}" is hosted by another coordinator`);
    }
    const spec = localDriverSpawnSpec(machine.platform, options.driverDir ?? computerDriverDir());
    if (!spec) {
      throw new HarnessServiceError("unavailable", `No ${machine.platform} driver is packaged for desktop "${desktopId}"`);
    }
    const existing = drivers.get(desktopId);
    if (existing?.alive()) return { driver: existing, desktop };
    existing?.dispose();
    observations.delete(desktopId);
    const driver = newDriver(spec);
    drivers.set(desktopId, driver);
    // A new helper can release only input it actually owns. A previous helper
    // killed mid-input leaves an unknown OS state; a blanket key-up sweep here
    // would also release keys/buttons the human is holding.
    await driver.request({ tool: "release_input" }).catch(() => undefined);
    return { driver, desktop };
  };

  const list: ComputerService["list"] = async () => {
    await ensureLocal();
    // Refresh remote mirrors before reading the catalog — remote truth wins
    // status, and an unreachable Host leaves an unavailable mirror (BC6).
    await syncRemote().catch(() => undefined);
    localProbe ??= probe(LOCAL_DESKTOP_ID);
    // Probe failures are stored in the catalog and presented as unavailable.
    // Reading a catalog does not require the user to visit Settings first.
    await localProbe.catch(() => undefined);
    const [machines, desktops] = await Promise.all([
      listRecords("computer.machine"),
      listRecords("computer.desktop"),
    ]);
    return {
      machines: machines.map(parseMachine).filter((m): m is ComputerMachine => m !== null),
      desktops: desktops.map(parseDesktop).filter((d): d is ComputerDesktop => d !== null),
      defaultDesktopId: await defaultDesktop(),
    };
  };

  const targetFile = options.dataDir ? join(options.dataDir, "computer-target.json") : null;
  const defaultDesktop: ComputerService["defaultDesktop"] = async () => {
    if (!targetFile) return null;
    try {
      const raw = JSON.parse(await readFile(targetFile, "utf8")) as unknown;
      return isObject(raw) && typeof raw.desktopId === "string" && raw.desktopId ? raw.desktopId : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const setDefaultDesktop: ComputerService["setDefaultDesktop"] = async (desktopId) => {
    if (!targetFile) return;
    if (desktopId) {
      await desktopRecord(desktopId); // never persist a target that doesn't exist
    }
    await mkdir(options.dataDir as string, { recursive: true });
    const temp = `${targetFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ desktopId: desktopId ?? null }), "utf8");
    await rename(temp, targetFile);
  };

  const resolveDesktopId = async (requested?: string): Promise<string> => {
    if (requested) return requested;
    const configured = await defaultDesktop();
    if (configured) return configured;
    const { desktops } = await list();
    const ready = desktops.filter((desktop) => desktop.status === "available");
    if (ready.length === 1) return ready[0]!.id;
    if (desktops.length === 1) return desktops[0]!.id;
    if (ready.length === 0) {
      throw new HarnessServiceError("unavailable", "No computer desktop is available");
    }
    throw new HarnessServiceError("invalid-params", "Multiple desktops are available; pass desktopId");
  };

  const initializeLocal = async () => {
    const now = new Date().toISOString();
    const driverAvailable = localDriverSpawnSpec(platform, options.driverDir ?? computerDriverDir()) !== null;
    await putRecord(`computer.machine:${LOCAL_MACHINE_ID}`, "computer.machine", "active", {
      id: LOCAL_MACHINE_ID,
      name: "This PC",
      coordinatorHostId: options.hostId,
      provider: "local",
      platform,
      createdAt: now,
    });
    const desktopState = "unavailable";
    const detail = driverAvailable
      ? "Desktop capabilities have not been probed in this Host process."
      : "No platform driver found for this machine.";
    const desktopResult = await putRecord(`computer.desktop:${LOCAL_DESKTOP_ID}`, "computer.desktop", desktopState, {
      id: LOCAL_DESKTOP_ID,
      machineId: LOCAL_MACHINE_ID,
      label: "Console session",
      kind: "console",
      ...(detail ? { statusDetail: detail } : {}),
    });
    const machineRecord = await (await scoped()).getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.machine:${LOCAL_MACHINE_ID}`);
    const machine = machineRecord ? parseMachine(machineRecord) : null;
    if (!machine) throw new HarnessServiceError("failed", "Local machine record could not be read back");
    return { machine, desktop: parseDesktop(desktopResult)! };
  };
  const ensureLocal: ComputerService["ensureLocal"] = () => {
    if (disposed) return Promise.reject(new HarnessServiceError("unavailable", "Computer service is closed"));
    if (!localReady) {
      const loading = initializeLocal();
      localReady = loading;
      void loading.catch(() => { if (localReady === loading) localReady = null; });
    }
    return localReady;
  };

  const probe: ComputerService["probe"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ desktop?: ComputerDesktop }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/probe`,
      );
      const remoteDesktop = result.desktop;
      const record = await putRecord(`computer.desktop:${id}`, "computer.desktop",
        remoteDesktop?.status ?? "unavailable", {
          id,
          machineId: remote.desktop.machineId,
          label: remote.desktop.label,
          kind: remote.desktop.kind,
          remote: { connectionId: remote.connection.id, desktopId: remote.remoteId },
          ...(remoteDesktop?.statusDetail ? { statusDetail: remoteDesktop.statusDetail } : {}),
          ...(remoteDesktop?.capabilities ? { capabilities: remoteDesktop.capabilities as unknown as Record<string, unknown> } : {}),
        });
      return parseDesktop(record)!;
    }
    const { driver, desktop } = await driverFor(id);
    try {
      const response = await enqueue(id, "observe", () => driver.request({ tool: "capabilities" }));
      if (!response.ok || !response.capabilities) {
        throw new HarnessServiceError("unavailable", response.error ?? "Driver did not report capabilities");
      }
      const capabilities = response.capabilities as unknown as ComputerCapabilities;
      const result = await putRecord(`computer.desktop:${id}`, "computer.desktop",
        capabilities.status === "ready" ? "available" : "unavailable", {
          id,
          machineId: desktop.machineId,
          label: desktop.label,
          kind: desktop.kind,
          capabilities: capabilities as unknown as Record<string, unknown>,
          ...(capabilities.detail ? { statusDetail: capabilities.detail } : {}),
        });
      return parseDesktop(result)!;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Persist the real failure so the catalog never shows a stale "available".
      await putRecord(`computer.desktop:${id}`, "computer.desktop", "unavailable", {
        id,
        machineId: desktop.machineId,
        label: desktop.label,
        kind: desktop.kind,
        statusDetail: message,
      }).catch(() => undefined);
      if (error instanceof HarnessServiceError) throw error;
      throw new HarnessServiceError("unavailable", message);
    }
  };

  const listApps: ComputerService["listApps"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ apps?: ComputerAppDescriptor[] }>(
        remote.connection, "GET", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/apps`,
      );
      return result.apps ?? [];
    }
    const { driver } = await driverFor(id);
    const response = await enqueue(id, "observe", () => driver.request({ tool: "list_apps" }));
    if (!response.ok) {
      throw new HarnessServiceError("unavailable", response.error ?? "list_apps failed");
    }
    return Array.isArray(response.apps)
      ? response.apps.map((app) => ({
          name: String(app.name ?? ""),
          pid: typeof app.pid === "number" ? app.pid : 0,
          ...(asString(app.windowTitle) ? { windowTitle: app.windowTitle as string } : {}),
          ...(Array.isArray(app.windows)
            ? { windows: app.windows.map((window): import("@varin/protocol").ComputerWindowDescriptor | null => {
                const handle = asNumber(window.handle);
                if (handle === undefined || handle < 0) return null;
                const bounds = frameOf(window.bounds);
                return {
                  handle,
                  ...(asString(window.title) ? { title: window.title as string } : {}),
                  ...(bounds ? { bounds } : {}),
                  ...(typeof window.visible === "boolean" ? { visible: window.visible } : {}),
                  ...(typeof window.minimized === "boolean" ? { minimized: window.minimized } : {}),
                  ...(typeof window.main === "boolean" ? { main: window.main } : {}),
                };
              }).filter((w): w is NonNullable<typeof w> => w !== null) }
            : {}),
        }))
      : [];
  };

  const rememberObservation = (observation: ComputerObservation) => {
    const map = observations.get(observation.desktopId) ?? new Map<string, ComputerObservation>();
    for (const [key, previous] of map) {
      if (previous.app.pid === observation.app.pid) map.delete(key);
    }
    map.set(observation.id, observation);
    observations.set(observation.desktopId, map);
  };

  const elementRecordFor = (observation: ComputerObservation, index: number): Record<string, unknown> => {
    const element = observation.elements.find((entry) => entry.index === index);
    if (!element) {
      throw new HarnessServiceError(
        "invalid-params",
        `Element index ${index} is not in observation ${observation.id}; observe the app again`,
      );
    }
    return element as unknown as Record<string, unknown>;
  };

  const observe: ComputerService["observe"] = async (params) => {
    params.signal?.throwIfAborted();
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ observation?: ComputerObservation }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/observe`, {
          app: params.app,
          ...(params.window !== undefined ? { window: params.window } : {}),
          ...(params.includeScreenshot !== undefined ? { includeScreenshot: params.includeScreenshot } : {}),
          ...(params.textLimit !== undefined ? { textLimit: params.textLimit } : {}),
          ...(params.maxTreeNodes !== undefined ? { maxTreeNodes: params.maxTreeNodes } : {}),
          ...(params.maxTreeDepth !== undefined ? { maxTreeDepth: params.maxTreeDepth } : {}),
        },
      );
      if (!result.observation) throw new HarnessServiceError("unavailable", "Remote Host returned no observation");
      // Keep the remote observation id — a later remote act must reference
      // the remote service's own freshness record. Only the desktop/machine
      // binding is mirrored locally.
      const observation = { ...result.observation, desktopId: id, machineId: remote.desktop.machineId };
      rememberObservation(observation);
      return observation;
    }
    return enqueue(id, "observe", async () => {
      params.signal?.throwIfAborted();
      const { driver, desktop } = await driverFor(id);
      const response = await requestWithAbort(driver, {
        tool: "get_app_state",
        app: params.app,
        screenshot: params.includeScreenshot !== false,
        ...(params.window !== undefined ? { window: params.window } : {}),
        ...(params.textLimit !== undefined ? { text_limit: params.textLimit } : {}),
        ...(params.maxTreeNodes !== undefined ? { max_tree_nodes: params.maxTreeNodes } : {}),
        ...(params.maxTreeDepth !== undefined ? { max_tree_depth: params.maxTreeDepth } : {}),
      }, params.signal);
      params.signal?.throwIfAborted();
      if (!response.ok || !response.snapshot) throw new HarnessServiceError("unavailable", response.error ?? "Observe failed");
      const observation = observationOf(response.snapshot, desktop);
      rememberObservation(observation);
      return observation;
    });
  };

  /**
   * Element-targeted actions must reference the desktop's newest observation
   * for that app — indexes and frames from a stale read would click blind.
   */
  const assertObservationFresh = (desktopId: string, action: ComputerAction) => {
    const requiresObservation = action.elementIndex !== undefined || action.x !== undefined || action.kind === "drag";
    if (!requiresObservation && !action.observationId) return undefined;
    const observation = action.observationId ? observations.get(desktopId)?.get(action.observationId) : undefined;
    if (!observation) {
      throw new HarnessServiceError(
        "invalid-params",
        "Pass a current observationId from this desktop before using element indexes or window-relative coordinates",
      );
    }
    if (![observation.app.name.toLowerCase(), String(observation.app.pid), observation.app.windowTitle?.toLowerCase(), observation.windowTitle?.toLowerCase()]
      .some((selector) => selector === action.app.toLowerCase())) {
      throw new HarnessServiceError("invalid-params", "Action app does not match its observation target; use the observed PID");
    }
    if (action.window !== undefined) {
      const selectedWindow = typeof action.window === "number"
        ? observation.windowHandle === action.window
        : observation.windowTitle?.toLowerCase() === action.window.toLowerCase();
      if (!selectedWindow) {
        throw new HarnessServiceError("invalid-params", "Action window differs from its observation; observe that window first");
      }
    }
    return observation;
  };

  const toDriverOp = (desktopId: string, action: ComputerAction): Record<string, unknown> => {
    const latest = assertObservationFresh(desktopId, action);
    const windowBounds = latest?.windowBounds;
    const element = action.elementIndex !== undefined && latest
      ? elementRecordFor(latest, action.elementIndex)
      : undefined;
    const base = {
      app: latest ? String(latest.app.pid) : action.app,
      // An observation pins the window too. Never let an explicit selector
      // redirect observed element indexes or coordinates into another window.
      ...(latest?.windowHandle !== undefined ? { window: latest.windowHandle }
        : action.window !== undefined ? { window: action.window } : {}),
      ...(element ? { element } : {}),
      ...(windowBounds ? { windowBounds } : {}),
    };
    switch (action.kind) {
      case "click":
        return {
          ...base,
          tool: "click" as const,
          ...(action.x !== undefined ? { x: action.x } : {}),
          ...(action.y !== undefined ? { y: action.y } : {}),
          ...(action.clickCount !== undefined ? { click_count: action.clickCount } : {}),
          ...(action.mouseButton ? { mouse_button: action.mouseButton } : {}),
          ...(action.clickMethod ? { click_method: action.clickMethod } : {}),
        };
      case "secondary":
        return { ...base, tool: "perform_secondary_action" as const, action: action.action ?? "" };
      case "scroll":
        return {
          ...base,
          tool: "scroll" as const,
          direction: action.direction ?? "down",
          pages: action.pages ?? 1,
          input: action.clickMethod === "global" ? "global" : "auto",
          ...(action.x !== undefined ? { x: action.x } : {}),
          ...(action.y !== undefined ? { y: action.y } : {}),
        };
      case "drag":
        return {
          ...base,
          tool: "drag" as const,
          from_x: action.fromX ?? 0,
          from_y: action.fromY ?? 0,
          to_x: action.toX ?? 0,
          to_y: action.toY ?? 0,
          input: action.clickMethod === "global" ? "global" : "auto",
        };
      case "type":
        return {
          ...base,
          tool: "type_text" as const,
          text: action.text ?? "",
          input: action.clickMethod === "global" ? "global" : "auto",
        };
      case "key":
        return {
          ...base,
          tool: "press_key" as const,
          key: action.key ?? "",
          input: action.clickMethod === "global" ? "global" : "auto",
        };
      case "set_value":
        return { ...base, tool: "set_value" as const, value: action.value ?? "" };
    }
  };

  const validateAction = (action: ComputerAction) => {
    if (!isObject(action) || !asString(action.app)) {
      throw new HarnessServiceError("invalid-params", "computer.act requires action.app");
    }
    switch (action.kind) {
      case "click":
        if (action.elementIndex === undefined && (action.x === undefined || action.y === undefined)) {
          throw new HarnessServiceError("invalid-params", "click requires elementIndex or x/y");
        }
        break;
      case "type":
        if (!action.text) throw new HarnessServiceError("invalid-params", "type requires text");
        break;
      case "key":
        if (!action.key) throw new HarnessServiceError("invalid-params", "key requires a key chord");
        break;
      case "scroll":
        if (!action.direction) throw new HarnessServiceError("invalid-params", "scroll requires direction");
        break;
      case "drag":
        if ([action.fromX, action.fromY, action.toX, action.toY].some((v) => v === undefined)) {
          throw new HarnessServiceError("invalid-params", "drag requires fromX/fromY/toX/toY");
        }
        break;
      case "set_value":
        if (action.elementIndex === undefined || action.value === undefined) {
          throw new HarnessServiceError("invalid-params", "set_value requires elementIndex and value");
        }
        break;
      case "secondary":
        if (action.elementIndex === undefined || !action.action) {
          throw new HarnessServiceError("invalid-params", "secondary requires elementIndex and action");
        }
        break;
      default:
        throw new HarnessServiceError("invalid-params", `Unknown action kind: ${String((action as { kind?: unknown }).kind)}`);
    }
  };

  const act: ComputerService["act"] = async (params) => {
    params.signal?.throwIfAborted();
    const action = structuredClone(params.action);
    const id = await resolveDesktopId(params.desktopId);
    validateAction(action);
    const remote = await remoteTargetFor(id);
    if (remote) {
      // The remote Host owns its lane and control state — forward the action
      // verbatim; element indexes resolve against its own observation record.
      try {
        const payload = await remoteJson<{ result?: ComputerActionResult }>(
          remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/act`, { action },
        );
        if (!payload.result) throw new HarnessServiceError("unavailable", "Remote Host returned no action result");
        return payload.result;
      } catch (error) {
        if (error instanceof RemoteTransportError) {
          // The request may have crossed the wire — never replay; report the
          // effect as unknown and let the caller re-observe (BC6 contract).
          return { accepted: false, outcome: "unknown", detail: error.message };
        }
        throw error;
      }
    }
    // A desktop under human control rejects automated input outright — the
    // stale script must not resume after the takeover (BC5.A).
    if (laneFor(id).control.owner === "human") {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is under human control`);
    }
    // Stamp the caller-side generation before any further await: a cancel
    // issued while this call resolves its driver still drops the action.
    const generation = laneGeneration(id);
    let submitted = false;
    try {
      const { response, desktop } = await enqueue(id, "action", async () => {
        params.signal?.throwIfAborted();
        const { driver, desktop } = await driverFor(id);
        params.signal?.throwIfAborted();
        const op = toDriverOp(id, action);
        submitted = true;
        const response = await requestWithAbort(driver, op, params.signal);
        return { response, desktop };
      }, generation);
      if (!response.ok) {
        if (response.cancelled) {
          // Mid-operation cancel: part of the input may already have reached
          // the desktop — report the driver's progress detail, not a failure.
          return { accepted: false, cancelled: true, outcome: "partial", ...(response.error ? { detail: response.error } : {}) };
        }
        throw new HarnessServiceError("failed", response.error ?? `Action ${params.action.kind} failed`);
      }
      const result: ComputerActionResult = { accepted: true, ...(response.text ? { detail: response.text } : {}) };
      if (laneGeneration(id) !== generation) result.cancelled = true;
      if (response.snapshot) {
        const observation = observationOf(response.snapshot, desktop);
        rememberObservation(observation);
        result.observation = observation;
      }
      return result;
    } catch (error) {
      if (error instanceof CancelledActionError) {
        return { accepted: false, cancelled: true };
      }
      if (submitted) {
        observations.delete(id);
        return { accepted: false, outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    }
  };

  const cancel: ComputerService["cancel"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      return remoteJson<{ cancelled: number; released: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/cancel`,
      );
    }
    const lane = laneFor(id);
    lane.generation += 1;
    // Drop queued actions (their callers get cancelled results); a cancel can
    // never preempt a burst already inside the driver, so release_input runs
    // after it to lift anything the interrupted sequence left held.
    const dropped = lane.queue.filter((entry) => entry.kind === "action");
    lane.queue = lane.queue.filter((entry) => entry.kind !== "action");
    for (const entry of dropped) entry.cancel();
    const driver = drivers.get(id);
    let released = driver === undefined;
    if (driver?.alive()) {
      // Signal the in-flight native operation through the driver's cancel
      // side-channel first — a long type/drag aborts at its next checkpoint
      // instead of running to completion before the release (BC4.A).
      driver.cancel();
      const response = await enqueue(id, "observe", () => driver.request({ tool: "release_input" }));
      if (!response.ok) throw new HarnessServiceError("failed", response.error ?? "Input release failed");
      released = true;
    }
    observations.delete(id);
    return { cancelled: dropped.length, released };
  };

  const release: ComputerService["release"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      return remoteJson<{ released: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/release`,
      );
    }
    const { driver } = await driverFor(id);
    const response = await enqueue(id, "observe", () => driver.request({ tool: "release_input" }));
    return { released: response.ok };
  };

  // --- BC5: control ownership ---------------------------------------------

  const control: ComputerService["control"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ control?: ComputerControlState }>(
        remote.connection, "GET", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/control`,
      );
      if (!result.control) throw new HarnessServiceError("unavailable", "Remote Host returned no control state");
      return { ...result.control, desktopId: id };
    }
    await desktopRecord(id); // control state exists only for real desktops
    return controlState(id);
  };

  const takeover: ComputerService["takeover"] = async (params) => {
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ control?: ComputerControlState; cancelled: number; released: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/takeover`,
        { ...(params.holderId ? { holderId: params.holderId } : {}) },
      );
      if (!result.control) throw new HarnessServiceError("unavailable", "Remote Host returned no control state");
      return {
        control: { ...result.control, desktopId: id },
        cancelled: result.cancelled ?? 0,
        released: result.released ?? false,
      };
    }
    await desktopRecord(id);
    const lane = laneFor(id);
    // Same interlock as cancel(): bump the generation so queued automation and
    // any stale script batch can never run under human control.
    lane.generation += 1;
    const dropped = lane.queue.filter((entry) => entry.kind === "action");
    lane.queue = lane.queue.filter((entry) => entry.kind !== "action");
    for (const entry of dropped) entry.cancel();
    let released = true;
    const driver = drivers.get(id);
    if (driver?.alive()) {
      // Interrupt the in-flight native op at its next checkpoint before the
      // release sweep — a held key left down would corrupt human input.
      driver.cancel();
      const response = await enqueue(id, "observe", () => driver.request({ tool: "release_input" }));
      released = response.ok;
    }
    // Stale observations must not fire after handback — the human will have
    // changed the scene, so indexes from before the takeover are dead.
    observations.delete(id);
    lane.control = {
      owner: "human",
      ...(params.holderId ? { holderId: params.holderId } : {}),
      reachable: true,
      since: new Date().toISOString(),
    };
    broadcastControl(id);
    return { control: controlState(id), cancelled: dropped.length, released };
  };

  const handback: ComputerService["handback"] = async (params) => {
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ control?: ComputerControlState; requiresObservation?: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/handback`,
        { ...(params.holderId ? { holderId: params.holderId } : {}) },
      );
      if (!result.control) throw new HarnessServiceError("unavailable", "Remote Host returned no control state");
      return { control: { ...result.control, desktopId: id }, requiresObservation: true };
    }
    const lane = laneFor(id);
    if (lane.control.owner !== "human") {
      throw new HarnessServiceError("invalid-params", `Desktop "${id}" is not under human control`);
    }
    if (lane.control.holderId && params.holderId && lane.control.holderId !== params.holderId) {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is held by another viewer`);
    }
    // Lift whatever the human left held before automation may resume.
    const driver = drivers.get(id);
    if (driver?.alive()) {
      await enqueue(id, "observe", () => driver.request({ tool: "release_input" }));
    }
    lane.control = { owner: "agent", reachable: true, since: new Date().toISOString() };
    // Drop every observation — the next automated step must re-read the
    // desktop the human left behind rather than replay pre-takeover indexes.
    observations.delete(id);
    broadcastControl(id);
    return { control: controlState(id), requiresObservation: true };
  };

  const validateHumanInput = (input: ComputerHumanInput): void => {
    if (!isObject(input)) throw new HarnessServiceError("invalid-params", "computer.input requires input");
    switch (input.kind) {
      case "click": case "down": case "up": case "move":
        if (input.x === undefined || input.y === undefined) {
          throw new HarnessServiceError("invalid-params", `${input.kind} requires x/y`);
        }
        break;
      case "scroll":
        if (input.x === undefined || input.y === undefined || !input.direction) {
          throw new HarnessServiceError("invalid-params", "scroll requires x/y and direction");
        }
        break;
      case "key":
        if (!input.key) throw new HarnessServiceError("invalid-params", "key requires a key chord");
        break;
      case "text":
        if (typeof input.text !== "string") throw new HarnessServiceError("invalid-params", "text requires text");
        break;
      default:
        throw new HarnessServiceError("invalid-params", `Unknown human input kind: ${String(input.kind)}`);
    }
  };

  const input: ComputerService["input"] = async (params) => {
    const id = await resolveDesktopId(params.desktopId);
    validateHumanInput(params.input);
    const remote = await remoteTargetFor(id);
    if (remote) {
      // The remote Host enforces ownership; the local check is only a mirror.
      return remoteJson<ComputerInputResult>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/input`,
        { ...(params.holderId ? { holderId: params.holderId } : {}), input: params.input },
      );
    }
    const lane = laneFor(id);
    if (lane.control.owner !== "human") {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is not under human control`);
    }
    if (lane.control.holderId && params.holderId && lane.control.holderId !== params.holderId) {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is held by another viewer`);
    }
    if (lane.control.reachable === false) {
      // The holder's view channel dropped — do not trust input attributed to
      // it until it reconnects through subscribeFrames.
      throw new HarnessServiceError("forbidden", `Desktop "${id}" control holder is disconnected`);
    }
    return enqueue(id, "input", async () => {
      // Re-check at execution: ownership may have flipped while queued.
      const control = laneFor(id).control;
      if (control.owner !== "human" || (control.holderId && params.holderId && control.holderId !== params.holderId)) {
        return { accepted: false, detail: "control changed before the input ran" };
      }
      const { driver } = await driverFor(id);
      const response = await driver.request({
        tool: "inject_input",
        kind: params.input.kind,
        ...(params.input.x !== undefined ? { x: params.input.x } : {}),
        ...(params.input.y !== undefined ? { y: params.input.y } : {}),
        ...(params.input.button ? { button: params.input.button } : {}),
        ...(params.input.count !== undefined ? { count: params.input.count } : {}),
        ...(params.input.direction ? { direction: params.input.direction } : {}),
        ...(params.input.pages !== undefined ? { pages: params.input.pages } : {}),
        ...(params.input.key ? { key: params.input.key } : {}),
        ...(params.input.text !== undefined ? { text: params.input.text } : {}),
      });
      if (!response.ok) {
        return { accepted: false, ...(response.error ? { detail: response.error } : {}) };
      }
      return { accepted: true };
    });
  };

  // --- BC5: frame subscription --------------------------------------------

  const FRAME_INTERVAL_MS = 250;
  const pollFrame = async (desktopId: string): Promise<void> => {
    const entry = viewers.get(desktopId);
    if (!entry || entry.viewers.size === 0 || entry.polling) return;
    entry.polling = true;
    try {
      const frame = await enqueue(desktopId, "observe", async () => {
        const { driver } = await driverFor(desktopId);
        const response = await driver.request({ tool: "capture_frame" });
        if (!response.ok || !response.frame) {
          throw new Error(response.error ?? "desktop capture produced no frame");
        }
        const raw = response.frame;
        const bounds = frameOf(raw.bounds) ?? { x: 0, y: 0, width: 0, height: 0 };
        const mime = raw.mime === "image/jpeg" ? "image/jpeg" : "image/png";
        if (!raw.base64) throw new Error("desktop capture produced no frame");
        return { mime, base64: raw.base64, bounds, capturedAt: raw.capturedAt ?? new Date().toISOString() } satisfies ComputerDesktopFrame;
      }).catch((error: unknown): Error => (error instanceof Error ? error : new Error(String(error))));
      const current = viewers.get(desktopId);
      if (!current) return;
      if (frame instanceof Error) {
        entry.failures += 1;
        if (entry.failures >= 2) {
          const event: DesktopViewEvent = { type: "error", error: frame.message };
          for (const listener of current.viewers.values()) {
            try { listener(event); } catch { /* broken viewer */ }
          }
        }
        return;
      }
      entry.failures = 0;
      const event: DesktopViewEvent = { type: "frame", frame };
      for (const listener of current.viewers.values()) {
        try { listener(event); } catch { /* broken viewer */ }
      }
    } finally {
      entry.polling = false;
    }
  };

  const subscribeFrames: ComputerService["subscribeFrames"] = async (desktopId, viewerId, listener) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      // Frames for a remote desktop come off the remote Host's own stream —
      // the same authenticated Host-to-Host connection carries them (BC6).
      const controller = new AbortController();
      const path = `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/stream?viewer=${encodeURIComponent(viewerId)}`;
      const response = await remoteFetch(remote.connection, "GET", path, undefined, controller.signal);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new HarnessServiceError(
          "unavailable",
          payload?.error ?? `Remote desktop stream failed (${response.status})`,
        );
      }
      void (async () => {
        try {
          const reader = response.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
              if (!dataLine) continue;
              try {
                const event = JSON.parse(dataLine.slice(5).trim()) as DesktopViewEvent;
                if (event.type === "control") {
                  listener({ ...event, control: { ...event.control, desktopId: id } });
                } else {
                  listener(event);
                }
              } catch { /* malformed stream chunk is dropped */ }
            }
          }
          // The remote stream ended — tell the viewer, don't fake a frame.
          listener({ type: "error", error: "Remote desktop stream ended" });
        } catch (error) {
          if (!controller.signal.aborted) {
            try { listener({ type: "error", error: error instanceof Error ? error.message : String(error) }); } catch { /* */ }
          }
        }
      })();
      return () => { controller.abort(); };
    }
    await desktopRecord(id);
    const lane = laneFor(id);
    // A reconnecting holder gets its control marked reachable again.
    if (lane.control.owner === "human" && lane.control.holderId === viewerId && !lane.control.reachable) {
      lane.control.reachable = true;
    }
    let entry = viewers.get(id);
    if (!entry) {
      entry = { viewers: new Map(), timer: null, polling: false, failures: 0 };
      viewers.set(id, entry);
    }
    entry.viewers.set(viewerId, listener);
    try { listener({ type: "control", control: controlState(id) }); } catch { /* */ }
    if (!entry.timer) {
      entry.timer = setInterval(() => { void pollFrame(id); }, FRAME_INTERVAL_MS);
      void pollFrame(id);
    }
    broadcastControl(id);
    return () => {
      const current = viewers.get(id);
      if (!current) return;
      current.viewers.delete(viewerId);
      const laneControl = laneFor(id).control;
      if (laneControl.owner === "human" && laneControl.holderId === viewerId) {
        // The disconnecting viewer held control — mark it pending-recovery
        // rather than silently handing back while its input may be mid-flight.
        laneControl.reachable = false;
      }
      if (current.viewers.size === 0) {
        if (current.timer) clearInterval(current.timer);
        current.timer = null;
      }
      broadcastControl(id);
    };
  };

  return {
    list,
    ensureLocal,
    probe,
    listApps,
    observe,
    act,
    cancel,
    release,
    control,
    takeover,
    handback,
    input,
    subscribeFrames,
    defaultDesktop,
    setDefaultDesktop,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const entry of viewers.values()) {
        if (entry.timer) clearInterval(entry.timer);
        entry.timer = null;
        entry.viewers.clear();
      }
      viewers.clear();
      for (const lane of lanes.values()) {
        lane.generation += 1;
        for (const entry of lane.queue.splice(0)) entry.cancel();
      }
      await Promise.allSettled([...drivers.values()].map(async (driver) => {
        try { if (driver.alive()) await driver.request({ tool: "release_input" }); }
        finally { driver.dispose(); }
      }));
      for (const driver of drivers.values()) driver.dispose();
      drivers.clear();
      lanes.clear();
      observations.clear();
    },
  };
}
