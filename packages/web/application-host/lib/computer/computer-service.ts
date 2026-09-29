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
  ComputerDesktop,
  ComputerElement,
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

const parseMachine = (record: KernelRecordResult): ComputerMachine | null => {
  try {
    const raw = JSON.parse(record.payloadJson) as unknown;
    if (!isObject(raw)) return null;
    const id = record.recordId.split(":")[1];
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
    const id = record.recordId.split(":")[1];
    if (!id || raw.id !== id || !asString(raw.machineId) || !asString(raw.label)) return null;
    return {
      id,
      machineId: raw.machineId as string,
      label: raw.label as string,
      kind: (asString(raw.kind) ?? "console") as ComputerDesktop["kind"],
      status: (["available", "unavailable", "stopped"].includes(record.state) ? record.state : "unavailable") as ComputerDesktop["status"],
      ...(asString(raw.statusDetail) ? { statusDetail: raw.statusDetail as string } : {}),
      ...(isObject(raw.capabilities) ? { capabilities: raw.capabilities as unknown as ComputerCapabilities } : {}),
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

interface QueuedOp {
  kind: "observe" | "action";
  generation: number;
  run(): Promise<void>;
  /** Called when the entry is dropped before reaching the driver. */
  cancel(): void;
}

interface DesktopLane {
  queue: QueuedOp[];
  running: boolean;
  /** Bumped on cancel; actions stamped with an older generation report cancelled. */
  generation: number;
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
    includeScreenshot?: boolean;
    textLimit?: number | "max";
    maxTreeNodes?: number;
    maxTreeDepth?: number;
  }): Promise<ComputerObservation>;
  act(params: { desktopId?: string; action: ComputerAction }): Promise<ComputerActionResult>;
  cancel(desktopId?: string): Promise<{ cancelled: number }>;
  release(desktopId?: string): Promise<{ released: boolean }>;
  dispose(): void;
}

export function createComputerService(options: ComputerServiceOptions): ComputerService {
  const platform = options.platform ?? localPlatform();
  const newDriver = options.createDriver ?? createDriverSession;
  let scopedClient: Promise<KernelScopedClient> | null = null;
  const drivers = new Map<string, ComputerDriverSession>();
  const lanes = new Map<string, DesktopLane>();
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
    const existing = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, recordId).catch(() => null);
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
    const lane: DesktopLane = { queue: [], running: false, generation: 0 };
    lanes.set(desktopId, lane);
    return lane;
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

  const driverFor = async (desktopId: string): Promise<{ driver: ComputerDriverSession; desktop: ComputerDesktop }> => {
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
    const driver = newDriver(spec);
    drivers.set(desktopId, driver);
    return { driver, desktop };
  };

  const list: ComputerService["list"] = async () => {
    const [machines, desktops] = await Promise.all([
      listRecords("computer.machine"),
      listRecords("computer.desktop"),
    ]);
    return {
      machines: machines.map(parseMachine).filter((m): m is ComputerMachine => m !== null),
      desktops: desktops.map(parseDesktop).filter((d): d is ComputerDesktop => d !== null),
    };
  };

  const targetFile = options.dataDir ? join(options.dataDir, "computer-target.json") : null;
  const defaultDesktop: ComputerService["defaultDesktop"] = async () => {
    if (!targetFile) return null;
    try {
      const raw = JSON.parse(await readFile(targetFile, "utf8")) as unknown;
      return isObject(raw) && typeof raw.desktopId === "string" && raw.desktopId ? raw.desktopId : null;
    } catch {
      return null;
    }
  };
  const setDefaultDesktop: ComputerService["setDefaultDesktop"] = async (desktopId) => {
    if (!targetFile) return;
    if (desktopId) {
      await desktopRecord(desktopId); // never persist a target that doesn't exist
    }
    await mkdir(options.dataDir as string, { recursive: true });
    const temp = `${targetFile}.${process.pid}.tmp`;
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

  const ensureLocal: ComputerService["ensureLocal"] = async () => {
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
    const desktopState = driverAvailable ? "available" : "unavailable";
    const detail = driverAvailable
      ? undefined
      : platform === "macos"
        ? "The macOS driver helper is not packaged yet; this desktop reports its real state instead of pretending to be operable."
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

  const probe: ComputerService["probe"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
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
        }))
      : [];
  };

  const rememberObservation = (observation: ComputerObservation) => {
    const key = observation.app.name.toLowerCase();
    const map = observations.get(observation.desktopId) ?? new Map<string, ComputerObservation>();
    map.set(key, observation);
    observations.set(observation.desktopId, map);
  };

  const latestObservation = (desktopId: string, app: string): ComputerObservation | null => (
    observations.get(desktopId)?.get(app.toLowerCase()) ?? null
  );

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
    const id = await resolveDesktopId(params.desktopId);
    const { driver, desktop } = await driverFor(id);
    const response = await enqueue(id, "observe", () => driver.request({
      tool: "get_app_state",
      app: params.app,
      screenshot: params.includeScreenshot !== false,
      ...(params.textLimit !== undefined ? { text_limit: params.textLimit } : {}),
      ...(params.maxTreeNodes !== undefined ? { max_tree_nodes: params.maxTreeNodes } : {}),
      ...(params.maxTreeDepth !== undefined ? { max_tree_depth: params.maxTreeDepth } : {}),
    }));
    if (!response.ok || !response.snapshot) {
      throw new HarnessServiceError("unavailable", response.error ?? "Observe failed");
    }
    const observation = observationOf(response.snapshot, desktop);
    rememberObservation(observation);
    return observation;
  };

  /**
   * Element-targeted actions must reference the desktop's newest observation
   * for that app — indexes and frames from a stale read would click blind.
   */
  const assertObservationFresh = (desktopId: string, action: ComputerAction) => {
    if (action.elementIndex === undefined) return;
    const latest = latestObservation(desktopId, action.app);
    if (!latest) {
      throw new HarnessServiceError(
        "invalid-params",
        `No observation of "${action.app}" on desktop "${desktopId}" — observe the app before element actions`,
      );
    }
    if (action.observationId && action.observationId !== latest.id) {
      throw new HarnessServiceError(
        "invalid-params",
        `Observation ${action.observationId} is stale for "${action.app}" (current: ${latest.id}); observe again`,
      );
    }
  };

  const toDriverOp = (desktopId: string, action: ComputerAction): Record<string, unknown> => {
    const latest = latestObservation(desktopId, action.app);
    const windowBounds = latest?.windowBounds;
    const element = action.elementIndex !== undefined && latest
      ? elementRecordFor(latest, action.elementIndex)
      : undefined;
    const base = {
      app: action.app,
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
          ...(action.pages !== undefined ? { pages: action.pages } : {}),
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
    const id = await resolveDesktopId(params.desktopId);
    validateAction(params.action);
    assertObservationFresh(id, params.action);
    // Stamp the caller-side generation before any further await: a cancel
    // issued while this call resolves its driver still drops the action.
    const generation = laneGeneration(id);
    const { driver, desktop } = await driverFor(id);
    const op = toDriverOp(id, params.action);
    try {
      const response = await enqueue(id, "action", () => driver.request(op as Omit<typeof op & { id: string }, "id">), generation);
      if (!response.ok) {
        throw new HarnessServiceError("failed", response.error ?? `Action ${params.action.kind} failed`);
      }
      const result: ComputerActionResult = { accepted: true };
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
      throw error;
    }
  };

  const cancel: ComputerService["cancel"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const lane = laneFor(id);
    lane.generation += 1;
    // Drop queued actions (their callers get cancelled results); a cancel can
    // never preempt a burst already inside the driver, so release_input runs
    // after it to lift anything the interrupted sequence left held.
    const dropped = lane.queue.filter((entry) => entry.kind === "action");
    lane.queue = lane.queue.filter((entry) => entry.kind !== "action");
    for (const entry of dropped) entry.cancel();
    const driver = drivers.get(id);
    if (driver?.alive()) {
      // Fire-and-forget: the driver serializes ops, so release_input lands
      // after the in-flight burst anyway — awaiting it here would make a
      // wedged action block the cancel response itself.
      void enqueue(id, "observe", () => driver.request({ tool: "release_input" })).catch(() => undefined);
    }
    return { cancelled: dropped.length };
  };

  const release: ComputerService["release"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const { driver } = await driverFor(id);
    const response = await enqueue(id, "observe", () => driver.request({ tool: "release_input" }));
    return { released: response.ok };
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
    defaultDesktop,
    setDefaultDesktop,
    dispose: () => {
      for (const driver of drivers.values()) driver.dispose();
      drivers.clear();
      lanes.clear();
      observations.clear();
    },
  };
}
