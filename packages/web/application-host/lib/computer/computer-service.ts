/**
 * BC4 Computer Use service.
 *
 * Owns the machine/desktop catalog (kernel `computer.machine` /
 * `computer.desktop` records), the per-desktop resident driver session, the
 * serialized action queue, and cancellation. Observations carry ids that pin
 * element indexes to the read that produced them; actions citing a stale
 * observation are rejected rather than replayed onto a changed UI.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { actionResult, interruptedAction } from './action-receipt.js';
import type {
  ComputerAction,
  ComputerActor,
  ComputerLease,
  ComputerAccess,
  ComputerGesture,
  ComputerAutomationState,
  ComputerActivity,
  ComputerActivityEntry,
  ComputerArtifact,
  ComputerActionResult,
  ComputerAppDescriptor,
  ComputerCapabilities,
  ComputerControlState,
  ComputerDesktop,
  ComputerDesktopFrame,
  ComputerDesktopPrepareParams,
  ComputerElement,
  ComputerHumanInput,
  ComputerInputResult,
  ComputerListResult,
  ComputerMachine,
  ComputerObservation,
  ComputerOpenResult,
  ComputerBrowserParams,
  ComputerBrowserResult,
  ComputerEvidenceEntry,
  ComputerEvidenceParams,
  ComputerEvidenceResult,
  ComputerOfficeParams,
  ComputerOfficeResult,
  ComputerPlatform,
  ComputerSoftwareResult,
  ComputerVmBinding,
  ComputerVmCreateParams,
  ComputerVmDescriptor,
  ComputerVmProviderConfig,
  ComputerVmState,
  ComputerVmStep,
  ComputerWorkAssociation,
} from "@varin/protocol";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import { HarnessServiceError } from "../harness/service-error.js";
import {
  computerDriverDir,
  localDriverSpawnSpec,
  type ComputerDriverSession,
  type DriverRequest,
  type DriverResponse,
  type DriverSpawnSpec,
} from "./driver-host.js";
import { createLibvirtProvider } from "./libvirt-provider.js";
import { createDesktopDriverPool } from "./desktop-drivers.js";
import { createComputerEvidence } from "./computer-evidence.js";
import { createComputerAutomation } from './computer-automation.js';
import { createLinuxDesktop, type LinuxDesktopState, type LinuxSoftwareResult } from "./linux-desktop.js";
import { inspectDesktopFile, openDesktopFile, writeDesktopFile, type DesktopArtifactVersion } from "./desktop-artifact-files.js";
import { prepareVmGuestSeed } from "./vm-guest-seed.js";
import { resolveDebianCloudImage, downloadDebianCloudImage } from "./vm-guest-image.js";
import { forgetVmGuestPassword, probeVmGuest, vmGuestBootstrapStatus, vmGuestIpv4, vmGuestPassword } from "./vm-guest-connection.js";
import type { VmExec, VmProvider } from "./vm-provider.js";

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
      // A failed create may have no domainUuid yet — the binding still
      // carries the journal and provider identity for the retry path.
      ...(isObject(raw.vm) && asString(raw.vm.providerId)
        ? {
            vm: {
              providerId: asString(raw.vm.providerId)!,
              kind: "libvirt" as const,
              uri: asString(raw.vm.uri) ?? "",
              ...(asString(raw.vm.storagePool) ? { storagePool: raw.vm.storagePool as string } : {}),
              domainUuid: asString(raw.vm.domainUuid) ?? "",
              volumePaths: Array.isArray(raw.vm.volumePaths)
                ? raw.vm.volumePaths.filter((v): v is string => typeof v === "string")
                : [],
              steps: Array.isArray(raw.vm.steps) ? raw.vm.steps as ComputerVmStep[] : [],
              ...(isObject(raw.vm.guest) && raw.vm.guest.recipe === "debian13-xvnc"
                ? { guest: {
                  recipe: "debian13-xvnc" as const,
                  ...(isObject(raw.vm.guest.image) && asString(raw.vm.guest.image.ref)
                    && asString(raw.vm.guest.image.version) && asString(raw.vm.guest.image.sha512)
                    ? { image: { ref: raw.vm.guest.image.ref as string, version: raw.vm.guest.image.version as string,
                      sha512: raw.vm.guest.image.sha512 as string } } : {}),
                  ...(asString(raw.vm.guest.runtimeSha256) ? { runtimeSha256: raw.vm.guest.runtimeSha256 as string } : {}),
                  ...(raw.vm.guest.imageUploaded === true ? { imageUploaded: true } : {}),
                  state: (["preparing", "ready", "failed", "stopped"].includes(String(raw.vm.guest.state))
                    ? raw.vm.guest.state : "failed") as NonNullable<ComputerVmBinding["guest"]>["state"],
                  ...(asString(raw.vm.guest.detail) ? { detail: raw.vm.guest.detail as string } : {}),
                  ...(asString(raw.vm.guest.connectionId) ? { connectionId: raw.vm.guest.connectionId as string } : {}),
                  ...(asString(raw.vm.guest.hostId) ? { hostId: raw.vm.guest.hostId as string } : {}),
                  ...(asString(raw.vm.guest.apiUrl) ? { apiUrl: raw.vm.guest.apiUrl as string } : {}),
                } } : {}),
            },
          }
        : {}),
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
      ...(isObject(raw.remote) && asString(raw.remote.connectionId) && asString(raw.remote.desktopId) && asString(raw.remote.hostId)
        ? { remote: { connectionId: raw.remote.connectionId as string, desktopId: raw.remote.desktopId as string, hostId: raw.remote.hostId as string } }
        : {}),
      ...(isObject(raw.usage) && asString(raw.usage.sessionId) && asString(raw.usage.at)
        ? { usage: { sessionId: raw.usage.sessionId as string, at: raw.usage.at as string } }
        : {}),
      ...(Array.isArray(raw.work) ? { work: raw.work.flatMap((entry): ComputerWorkAssociation[] =>
        isObject(entry) && asString(entry.scopeId) && asString(entry.threadId) && asString(entry.sessionId) && asString(entry.at)
          ? [{ scopeId: entry.scopeId as string, threadId: entry.threadId as string,
            sessionId: entry.sessionId as string, at: entry.at as string }] : []) } : {}),
      ...(raw.managed === "linux-xvnc" ? { managed: "linux-xvnc" as const } : {}),
      ...(isObject(raw.media) && raw.media.kind === "vnc"
        && Number.isSafeInteger(raw.media.width) && (raw.media.width as number) > 0
        && Number.isSafeInteger(raw.media.height) && (raw.media.height as number) > 0
        ? { media: { kind: "vnc" as const, width: raw.media.width as number, height: raw.media.height as number } } : {}),
      ...(isObject(raw.software)
        ? { software: Object.fromEntries(Object.entries(raw.software).flatMap(([key, value]) =>
            isObject(value) && (value.state === "installed" || value.state === "failed") && Number.isSafeInteger(value.at)
              ? [[key, { state: value.state, at: value.at as number,
                ...(Array.isArray(value.packages) && value.packages.every((pkg) => typeof pkg === "string") ? { packages: value.packages as string[] } : {}),
                  ...(asString(value.detail) ? { detail: value.detail as string } : {}) }]]
              : [])) }
        : {}),
    };
  } catch {
    return null;
  }
};

const parseArtifact = (record: KernelRecordResult): ComputerArtifact | null => {
  if (!record.recordId.startsWith("computer.artifact:")) return null;
  try {
    const raw = JSON.parse(record.payloadJson) as unknown;
    if (!isObject(raw) || raw.id !== record.recordId.slice("computer.artifact:".length)
      || ![raw.desktopId, raw.sourceHostId, raw.scopeId, raw.threadId, raw.relativePath, raw.sha256,
        raw.modifiedAt, raw.registeredAt].every(asString)
      || !/^[0-9a-f]{64}$/u.test(raw.sha256 as string)
      || !Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) < 0) return null;
    return raw as unknown as ComputerArtifact;
  } catch { return null; }
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
    const png = Buffer.from(snapshot.screenshotPngBase64 as string, "base64");
    const dimensions = png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : {};
    observation.screenshot = {
      mime: "image/png",
      base64: snapshot.screenshotPngBase64 as string,
      ...dimensions,
      ...(snapshot.screenshotSource === "window" || snapshot.screenshotSource === "screen" ? { source: snapshot.screenshotSource } : {}),
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
   * `input` ops are human control input — their owner, connection and captured
   * control generation are checked again at dispatch.
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
  | { type: 'gesture'; gesture: ComputerGesture }
  | { type: "control"; control: ComputerControlState }
  | { type: "frame"; frame: ComputerDesktopFrame }
  | { type: "error"; error: string; terminal?: boolean };

interface DesktopViewers {
  viewers: Map<string, (event: DesktopViewEvent) => void>;
  frameViewers: Set<string>;
  timer: NodeJS.Timeout | null;
  /** A frame capture is in flight inside the lane. */
  polling: boolean;
  /** Consecutive capture failures before viewers get an error event. */
  failures: number;
}

interface DesktopLane {
  lastController?: ComputerActor;
  interrupted?: { id: string; actor: ComputerActor; holderId?: string };
  inputReleaseUnconfirmed: boolean;
  activity?: ComputerActivity;
  queue: QueuedOp[];
  running: boolean;
  /** Bumped on cancel; actions stamped with an older generation report cancelled. */
  generation: number;
  /** Input ownership — BC5 takeover/handback state machine. */
  control: DesktopControl;
  transitioning: boolean;
  needsObservation: boolean;
  externalAbort?: AbortController;
}

interface PendingHandback {
  id: string;
  scopeId: string;
  threadId: string;
  desktopId: string;
  label: string;
  at: string;
  actor: ComputerActor;
}

const handbackEvents = (value: unknown): PendingHandback[] => Array.isArray(value) ? value.flatMap((entry): PendingHandback[] =>
  isObject(entry) && asString(entry.id) && asString(entry.scopeId) && asString(entry.threadId)
    && asString(entry.desktopId) && asString(entry.label) && asString(entry.at) && isObject(entry.actor)
    ? [{ id: entry.id as string, scopeId: entry.scopeId as string, threadId: entry.threadId as string,
      desktopId: entry.desktopId as string, label: entry.label as string, at: entry.at as string, actor: entry.actor as unknown as ComputerActor }] : []) : [];

/** A configured remote Host a `remote` desktop's calls route to (BC6). */
export interface ComputerRemoteHost {
  /** Settings connection id — also the remote machine's catalog prefix. */
  id: string;
  label: string;
  apiUrl: string;
  clientToken?: string;
  requestHeaders?: Record<string, string>;
  /** Pinned when a desktop is discovered; connection edits cannot retarget it. */
  expectedHostId?: string;
}

export interface ComputerServiceOptions {
  localControlHolder?: string | undefined;
  resolveActor?: (sessionId: string) => Promise<ComputerActor | null>;
  notifyActor?: (actor: ComputerActor, text: string, wake: boolean, id: string) => Promise<void>;
  onAutomationChange?: (state: ComputerAutomationState) => void;
  revokeSession?: (actor: ComputerActor) => Promise<void>;
  bindDesktop?: (actor: ComputerActor, desktopId: string) => Promise<void>;
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
  /**
   * Configured virtualization providers (BC7) — `computerVmProviders` in the
   * Host settings file. Each entry is a libvirt connection URI; credentials
   * stay in the environment (ssh agent), never in settings.
   */
  vmProviders?: () => Promise<ComputerVmProviderConfig[]>;
  /** Test seam: scripted provider-CLI invocations. */
  vmExec?: VmExec;
  /** Test seam: substitute provider implementation entirely. */
  vmProviderFactory?: (config: ComputerVmProviderConfig, exec: VmExec) => VmProvider;
  appVersion?: string;
  vmGuestFetch?: typeof fetch;
  registerVmGuest?: (input: { connectionId: string; label: string; apiUrl: string; password: string;
    hostId: string }) => Promise<void>;
  removeVmGuest?: (connectionId: string) => Promise<void>;
  /** Resolve the real durable work owning a Pi session. */
  resolveWork?: (sessionId: string) => Promise<{ scopeId: string; threadId: string } | null>;
  /** Deliver an idempotent work continuation through the existing Thread ledger. */
  onHandback?: (event: PendingHandback) => Promise<void>;
  /** Ephemeral app-operation metadata for the existing UI event stream; never carries typed content. */
  onActivityChange?: (entry: ComputerActivityEntry) => void;
  onGesture?: (gesture: ComputerGesture, localConsole: boolean) => void;
  onControlChange?: (control: ComputerControlState) => void;
  controlWindows?: (() => number[]) | undefined;
}

export interface ComputerService {
  automation: ReturnType<typeof createComputerAutomation>;
  resolveDesktop(desktopId?: string): Promise<string>;
  finishExecution(runId: string): Promise<void>;
  claimDesktop(origin: string, assignmentId: string, actor: ComputerActor, desktopId: string, access: ComputerAccess): Promise<string>;
  dropDesktopClaim(origin: string, assignmentId: string, actor: ComputerActor, desktopId: string, access: ComputerAccess): Promise<void>;
  activities(sessionId?: string): ComputerActivityEntry[];
  prepareDesktop(params: ComputerDesktopPrepareParams, automation?: boolean): Promise<ComputerDesktop>;
  desktopLifecycle(desktopId: string, action: "start" | "stop", automation?: boolean): Promise<ComputerDesktop>;
  mediaTarget(desktopId: string): Promise<{ socketPath: string } | { url: string; headers: Record<string, string> }>;
  list(options?: { localOnly?: boolean }): Promise<ComputerListResult>;
  workDesktops(scopeId: string): Promise<ComputerDesktop[]>;
  reconcileHandbacks(): Promise<void>;
  inspectArtifact(desktopId: string, relativePath: string): Promise<DesktopArtifactVersion>;
  registerArtifact(sessionId: string, desktopId: string | undefined, relativePath: string): Promise<ComputerArtifact>;
  listArtifacts(scopeId: string): Promise<ComputerArtifact[]>;
  openDesktopArtifact(desktopId: string, relativePath: string, sha256: string): Promise<{ stream: Readable; cancel(): void }>;
  openArtifact(id: string): Promise<{ artifact: ComputerArtifact; stream: Readable; cancel(): void }>;
  /** Ensure the local machine/console desktop records exist. */
  ensureLocal(): Promise<{ machine: ComputerMachine; desktop: ComputerDesktop }>;
  /** Re-probe driver capabilities into the desktop record. */
  probe(desktopId?: string): Promise<ComputerDesktop>;
  /** The user's persisted default target; null = pick the sole desktop. */
  defaultDesktop(): Promise<string | null>;
  setDefaultDesktop(desktopId: string | null): Promise<void>;
  prewarm(desktopId?: string): Promise<void>;
  /** App inventory on a desktop. */
  listApps(desktopId?: string): Promise<ComputerAppDescriptor[]>;
  observe(params: {
    desktopId?: string;
    app: string;
    /** Select one of the app's windows: hwnd number or title (BC4.B). */
    window?: number | string;
    includeScreenshot?: boolean;
    observationId?: string;
    offset?: number;
    textLimit?: number | "max";
    maxTreeNodes?: number;
    maxTreeDepth?: number;
    signal?: AbortSignal;
    /** Harness session that issued the call — recorded as work association (BC8). */
    sessionId?: string;
  }): Promise<ComputerObservation>;
  act(params: { desktopId?: string; action: ComputerAction; automationEpoch?: string; signal?: AbortSignal; sessionId?: string }): Promise<ComputerActionResult>;
  cancel(desktopId?: string): Promise<{ cancelled: number; released: boolean }>;
  release(desktopId?: string): Promise<{ released: boolean }>;
  /**
   * EE: open a URL/path/application on the desktop's own machine. The target
   * resolves where the desktop runs — `localhost` and file paths mean that
   * machine, never the caller's. Same control gate as `act`.
   */
  open(params: { desktopId?: string; url?: string; path?: string; command?: string; args?: string[]; automationEpoch?: string; signal?: AbortSignal; sessionId?: string }): Promise<ComputerOpenResult>;
  /**
   * EE: one-shot file write into a managed desktop user's home, returning the
   * stored revision. No sync relationship is created.
   */
  fileWrite(params: { desktopId?: string; relativePath: string; contentBase64: string; sessionId?: string; signal?: AbortSignal }): Promise<{ version: DesktopArtifactVersion }>;
  /**
   * EE §6.2: install recipe component groups or explicit packages into the
   * environment this desktop belongs to. `installed` means the package layer
   * succeeded; interface usability is reported only by `status`/`capabilities`.
   */
  installSoftware(params: { desktopId?: string; groups?: string[]; packages?: string[]; sessionId?: string; signal?: AbortSignal }): Promise<{ results: ComputerSoftwareResult[] }>;
  /**
   * EE §7.2: browser bridge — attach to the visible Chromium session on the
   * target machine. status/tabs/snapshot are reads through the observe lane;
   * launch/act write to the same real scene and hold the same human-control
   * gate as `open`/`act`.
   */
  browser(params: ComputerBrowserParams & { signal?: AbortSignal; sessionId?: string }): Promise<ComputerBrowserResult>;
  /**
   * EE §7.2: LibreOffice bridge — attach to the live soffice instance on the
   * same desktop scene (open documents carry their unsaved state).
   */
  office(params: ComputerOfficeParams & { signal?: AbortSignal; sessionId?: string }): Promise<ComputerOfficeResult>;
  /**
   * EE6 (§10): durable review of the steps this Host executed on a desktop —
   * who issued them, the target, and the real outcome. Remote desktops are
   * answered by their owning Host's own journal.
   */
  evidence(params: ComputerEvidenceParams & { signal?: AbortSignal }): Promise<ComputerEvidenceResult>;
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
  input(params: { desktopId?: string; holderId?: string; controlEpoch?: string; input: ComputerHumanInput }): Promise<ComputerInputResult>;
  /**
   * Subscribe a viewer to desktop frames + control changes. Closing the view
   * unsubscribes without cancelling work; when the holder's subscription
   * drops, control stays human-owned but unreachable until it reconnects.
   */
  subscribeFrames(desktopId: string, viewerId: string, listener: (event: DesktopViewEvent) => void, options?: { frames?: boolean; signal?: AbortSignal }): Promise<() => void>;
  // --- BC7: virtual machine lifecycle ----------------------------------------
  /** Virtual machines on configured providers, with live domain state. */
  listVms(): Promise<ComputerVmDescriptor[]>;
  reconcileVmGuests(): Promise<void>;
  /**
   * Create a VM with a durable, preallocated UUID. A retry resumes only that
   * identity; a coincidentally matching external domain name grants no ownership.
   */
  createVm(params: ComputerVmCreateParams): Promise<{ machine: ComputerMachine; created: boolean }>;
  /** Lifecycle on a VM machine's real domain UUID. */
  vmAction(params: { machineId: string; action: "start" | "shutdown" | "reboot" | "upgrade" }): Promise<ComputerVmDescriptor>;
  /** Undefine the domain. `deleteDisks` also removes the recorded volumes. */
  deleteVm(machineId: string, deleteDisks?: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export function createComputerService(options: ComputerServiceOptions): ComputerService {
  const automation = createComputerAutomation({
    resolveActor: options.resolveActor ?? (async () => null),
    notify: options.notifyActor ?? (async () => { throw new HarnessServiceError('unavailable', 'Computer Use message delivery is unavailable'); }),
    revokeSession: options.revokeSession ?? (async () => {}),
    bindDesktop: options.bindDesktop ?? (async () => {}),
    onChange: state => { options.onAutomationChange?.(state); queueMicrotask(() => { if (!disposed) for (const id of lanes.keys()) broadcastControl(id); }); },
    reserve: (lease, signal) => reserveDesktop(lease, signal),
    describeDesktop: async (id) => (await desktopRecord(id)).desktop.label,
    release: (lease) => releaseDesktop(lease),
    cancelWork: async (actor, desktopId) => {
      for (const [id, lane] of lanes) {
        if (desktopId && id !== desktopId) continue;
        const interrupted = lane.interrupted;
        if (interrupted?.actor.rootSessionId !== actor.rootSessionId || interrupted.actor.rootRunId !== actor.rootRunId) continue;
        delete lane.interrupted;
        try {
          if (interrupted.holderId && (await control(id)).owner === 'human') await handbackImpl({ desktopId: id, holderId: interrupted.holderId });
          await persistControl(id, false, !(await remoteTargetFor(id)));
        } catch (error) { lane.interrupted = interrupted; throw error; }
      }
    },
    controlAvailable: (id) => laneFor(id).control.owner === 'agent' && !laneFor(id).transitioning,
  });
  const platform = options.platform ?? localPlatform();
  let scopedClient: Promise<KernelScopedClient> | null = null;
  const lanes = new Map<string, DesktopLane>();
  const controlEpoch = randomUUID();
  let disposed = false;
  let localReady: Promise<{ machine: ComputerMachine; desktop: ComputerDesktop }> | null = null;
  let localProbe: Promise<ComputerDesktop> | null = null;
  /** Latest observation per desktop+app — the reference frame for element indexes. */
  const observations = new Map<string, Map<string, ComputerObservation>>();
  const observationOwners = new Map<string, { key: string; runId: string; rootRunId: string }>();
  const remoteClaims = new Map<string, { lease: ComputerLease; target: NonNullable<Awaited<ReturnType<typeof remoteTargetFor>>>; token: string | undefined; ready: Promise<void> }>();
  const assignmentStreams = new Map<string, () => void>();
  const claimKey = (lease: ComputerLease) => `${lease.actor.sessionId}:${lease.actor.runId}:${lease.desktopId}:${lease.access}`;
  const linuxDesktop = createLinuxDesktop({ dataDir: options.dataDir ?? process.cwd(),
    driverDir: options.driverDir ?? computerDriverDir(), platform,
    ...(options.vmExec ? { exec: options.vmExec } : {}) });

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
    // Catalog refresh must preserve the local control receipt. In particular a
    // Host restart must not silently hand a human-owned desktop to automation.
    if (recordType === "computer.desktop" && existing) {
      const prior = JSON.parse(existing.payloadJson) as Record<string, unknown>;
      if (payload.control === undefined && prior.control !== undefined) payload = { ...payload, control: prior.control };
      if (payload.usage === undefined && prior.usage !== undefined) payload = { ...payload, usage: prior.usage };
      if (payload.work === undefined && prior.work !== undefined) payload = { ...payload, work: prior.work };
      if (payload.handbackEvents === undefined && prior.handbackEvents !== undefined) payload = { ...payload, handbackEvents: prior.handbackEvents };
      if (payload.interrupted === undefined && prior.interrupted !== undefined) payload = { ...payload, interrupted: prior.interrupted };
      if (payload.software === undefined && prior.software !== undefined) payload = { ...payload, software: prior.software };
    }
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

  /**
   * Stamp the desktop's work association (BC8): which agent session last
   * operated it. Called at admission, before the driver request, so a late
   * completion cannot overwrite a newer scope's attribution. This is only
   * projection metadata: conflicts retry once and storage errors are dropped.
   */
  const usageOrder = new Map<string, number>();
  const recordUsage = async (desktopId: string, sessionId: string | undefined): Promise<void> => {
    if (!sessionId) return;
    const order = (usageOrder.get(desktopId) ?? 0) + 1;
    usageOrder.set(desktopId, order);
    const work = await options.resolveWork?.(sessionId);
    const client = await scoped();
    const recordId = `computer.desktop:${desktopId}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, recordId);
      if (!record) return;
      let body: unknown;
      try { body = JSON.parse(record.payloadJson); } catch { return; }
      if (!isObject(body)) return;
      const at = new Date().toISOString();
      body.usage = { sessionId, at };
      if (work) {
        const previous = Array.isArray(body.work) ? body.work.flatMap((item): ComputerWorkAssociation[] =>
          isObject(item) && asString(item.scopeId) && asString(item.threadId) && asString(item.sessionId) && asString(item.at)
            ? [{ scopeId: item.scopeId as string, threadId: item.threadId as string,
              sessionId: item.sessionId as string, at: item.at as string }] : []) : [];
        body.work = [...previous.filter((item) => item.scopeId !== work.scopeId || item.threadId !== work.threadId),
          { ...work, sessionId, at }];
      }
      try {
        if (usageOrder.get(desktopId) !== order) return;
        await client.putRecord({
          operationId: `computer.desktop:usage:${randomUUID()}`,
          workspaceId: COMPUTER_CATALOG_WORKSPACE_ID,
          recordId,
          recordType: "computer.desktop",
          state: record.state,
          payloadJson: JSON.stringify(body),
          ownerIds: [],
          references: [],
          expectedRecordRevision: record.recordRevision,
        });
        return;
      } catch {
        if (attempt === 1) return;
      }
    }
  };

  /**
   * EE6 (§10): durable per-desktop operation journal. Diagnostics ride beside
   * the op. Persisting it adds response latency, but a journal failure never
   * flips the operation result or grants it new execution authority.
   * Only locally-executed steps are recorded here; a remote Host journals its
   * own execution and answers evidence queries for its desktops.
   */
  const evidenceJournal = createComputerEvidence({ client: scoped, workspaceId: COMPUTER_CATALOG_WORKSPACE_ID,
    owns: async (desktopId) => {
      const owner = await (await scoped()).getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.desktop:${desktopId}`);
      const desktop = owner ? parseDesktop(owner) : null;
      return desktop !== null && !desktop.remote;
    } });
  const recordEvidence = evidenceJournal.record;
  const evidenceTarget = (target: string) => `sha256:${createHash('sha256').update(target).digest('hex')}`;
  const evidenceOps: Record<ComputerEvidenceEntry['tool'], readonly string[]> = {
    observe: ['observe'], act: ['click', 'type', 'key', 'scroll', 'drag', 'set_value', 'secondary'],
    open: ['open'], fileWrite: ['fileWrite'], installSoftware: ['install'],
    browser: ['status', 'launch', 'tabs', 'snapshot', 'act'],
    office: ['status', 'launch', 'docs', 'open', 'act'],
    control: ['takeover', 'handback', 'cancel', 'release'],
  };

  const journalOutcomeOf = (result: unknown): ComputerEvidenceEntry["outcome"] => {
    if (isObject(result)) {
      if (result.outcome === "unknown") return "unknown";
      if (result.cancelled === true) return "cancelled";
      if (result.ok === false || result.accepted === false) return "error";
      if (Array.isArray(result.results) && result.results.some((entry) => isObject(entry) && entry.state === "failed")) return "error";
    }
    return "ok";
  };

  const journalErrorOutcome = (error: unknown): ComputerEvidenceEntry["outcome"] => {
    if (error instanceof CancelledActionError) return "cancelled";
    if (error instanceof RemoteTransportError || error instanceof Error && error.name === "AbortError") return "unknown";
    if (error instanceof HarnessServiceError && (error.harnessCode === "forbidden" || error.harnessCode === "invalid-params")) return "rejected";
    return "error";
  };

  /**
   * Journal one executed step. `summary` carries identifiers only — typed
   * text, expressions and file bytes never enter the journal (§10). Remote
   * desktops are skipped inside recordEvidence (owner journals there). An
   * unresolvable target means the op itself never ran — nothing to journal.
   */
  const journaledOp = async <P extends { desktopId?: string | undefined }, R>(params: P, sessionId: string | undefined,
    summary: Pick<ComputerEvidenceEntry, "lane" | "tool"> & { op?: string | undefined; target?: string | undefined },
    run: (p: P) => Promise<R>): Promise<R> => {
    const id = await resolveDesktopId(params.desktopId);
    const entry = {
      lane: summary.lane, tool: summary.tool,
      ...(summary.op !== undefined ? { op: evidenceOps[summary.tool]?.includes(summary.op) ? summary.op : 'invalid' } : {}),
      ...(summary.target !== undefined ? { target: evidenceTarget(summary.target) } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    try {
      const result = await run({ ...params, desktopId: id });
      const nested = (result as { observation?: { id?: unknown } } | null)?.observation?.id;
      const top = (result as { id?: unknown } | null)?.id;
      const observationId = typeof nested === "string" ? nested : typeof top === "string" ? top : undefined;
      await recordEvidence(id, { ...entry, outcome: journalOutcomeOf(result), ...(observationId ? { observationId } : {}) }).catch(() => undefined);
      return result;
    } catch (error) {
      await recordEvidence(id, { ...entry, outcome: journalErrorOutcome(error),
        error: error instanceof HarnessServiceError ? error.harnessCode : "operation-error" }).catch(() => undefined);
      throw error;
    }
  };

  // URL targets enter the journal as origin+path only — query strings and
  // fragments can carry tokens and never belong in a durable log (§10).
  const urlEvidenceTarget = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      return url.origin === "null" ? undefined : url.origin + url.pathname;
    } catch { return undefined; }
  };

  const desktopRecord = async (desktopId: string): Promise<{ record: KernelRecordResult; desktop: ComputerDesktop }> => {
    const client = await scoped();
    const record = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.desktop:${desktopId}`);
    const desktop = record ? parseDesktop(record) : null;
    if (!record || !desktop) {
      throw new HarnessServiceError("not-found", `Unknown computer desktop "${desktopId}"`);
    }
    if (!lanes.has(desktopId)) {
      const stored = JSON.parse(record.payloadJson) as Record<string, unknown>;
      const lane = laneFor(desktopId);
      if (isObject(stored.interrupted) && asString(stored.interrupted.id) && isObject(stored.interrupted.actor)) {
        lane.interrupted = stored.interrupted as unknown as NonNullable<DesktopLane['interrupted']>;
      }
      if (!desktop.remote && isObject(stored.control) && stored.control.owner === "human") {
        lane.control = { owner: "human", reachable: false,
          since: asString(stored.control.since) ?? new Date().toISOString(),
          ...(asString(stored.control.holderId) ? { holderId: stored.control.holderId as string } : {}) };
      }
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
      inputReleaseUnconfirmed: false,
      queue: [],
      running: false,
      generation: 0,
      control: { owner: "agent", reachable: true, since: new Date().toISOString() },
      transitioning: false,
      needsObservation: false,
    };
    lanes.set(desktopId, lane);
    return lane;
  };

  const controlState = (desktopId: string): ComputerControlState => {
    const lane = laneFor(desktopId);
    const control = lane.control;
    const controller = automation.controller(desktopId);
    if (controller) lane.lastController = controller;
    const last = controller ?? lane.interrupted?.actor ?? lane.lastController;
    const cancellation = last ? automation.cancellationStatus(last, desktopId) : undefined;
    const operator = controller ?? lane.interrupted?.actor ?? (cancellation ? last : undefined);
    return {
      desktopId,
      owner: control.owner,
      ...(control.holderId ? { holderId: control.holderId } : {}),
      reachable: control.reachable,
      since: control.since,
      automationEpoch: `${controlEpoch}:${laneFor(desktopId).generation}`,
      ...(laneFor(desktopId).transitioning ? { transitioning: true } : {}),
      ...(laneFor(desktopId).activity ? { activity: laneFor(desktopId).activity } : {}),
      ...(operator ? { operator, workStatus: cancellation ?? 'active' as const } : {}),
    };
  };
  const scopedEpoch = (epoch: string) => {
    const admission = automation.context.getStore();
    return admission ? `${epoch}:${admission.key}` : epoch;
  };
  const modelEpoch = (id: string) => scopedEpoch(controlState(id).automationEpoch);
  const clearFeedback = (id: string) => {
    const gesture: ComputerGesture = { id: '*', desktopId: id, kind: 'move', phase: 'cancelled', at: new Date().toISOString() };
    for (const listener of viewers.get(id)?.viewers.values() ?? []) { try { listener({ type: 'gesture', gesture }); } catch { /* visual only */ } }
    // Only the owning Host reaches this local cancellation path.
    if (id === 'local-console') options.onGesture?.(gesture, true);
  };

  const persistControl = async (desktopId: string, handback = false, localControl = true): Promise<void> => {
    const { record, desktop } = await desktopRecord(desktopId);
    const body = JSON.parse(record.payloadJson) as Record<string, unknown>;
    const interrupted = laneFor(desktopId).interrupted;
    const event = handback && interrupted && options.onHandback
      ? { id: interrupted.id, scopeId: interrupted.actor.scopeId, threadId: interrupted.actor.threadId, actor: interrupted.actor,
        desktopId, label: desktop.label, at: new Date().toISOString() } satisfies PendingHandback : null;
    await putRecord(record.recordId, "computer.desktop", record.state, {
      ...body,
      ...(localControl ? { control: { ...laneFor(desktopId).control } } : {}),
      interrupted: handback ? null : interrupted ?? null,
      ...(event ? { handbackEvents: [...handbackEvents(body.handbackEvents), event] } : {}),
    });
  };

  const handbackDeliveries = new Map<string, Promise<void>>();
  const deliverHandbacks = (desktopId: string): Promise<void> => {
    const ongoing = handbackDeliveries.get(desktopId);
    if (ongoing) return ongoing;
    const task = (async () => {
      if (!options.onHandback) return;
      const client = await scoped();
      for (;;) {
        const recordId = `computer.desktop:${desktopId}`;
        const record = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, recordId);
        if (!record) return;
        const body = JSON.parse(record.payloadJson) as Record<string, unknown>;
        const event = handbackEvents(body.handbackEvents)[0];
        if (!event) return;
        if (await automation.isCurrent(event.actor)) await options.onHandback(event);
        // A successful Thread-ledger receipt is idempotent by event.id. If this
        // catalog write conflicts or the Host stops, replay is harmless.
        const updated = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, recordId);
        if (!updated) return;
        const next = JSON.parse(updated.payloadJson) as Record<string, unknown>;
        next.handbackEvents = handbackEvents(next.handbackEvents).filter((item) => item.id !== event.id);
        try {
          await client.putRecord({ operationId: `computer.desktop:handback:${randomUUID()}`,
            workspaceId: COMPUTER_CATALOG_WORKSPACE_ID, recordId, recordType: "computer.desktop",
            state: updated.state, payloadJson: JSON.stringify(next), ownerIds: [], references: [],
            expectedRecordRevision: updated.recordRevision });
        } catch { /* re-read and retry the idempotent delivery */ }
      }
    })();
    handbackDeliveries.set(desktopId, task);
    void task.finally(() => { if (handbackDeliveries.get(desktopId) === task) handbackDeliveries.delete(desktopId); }).catch(() => {});
    return task;
  };

  const reconcileHandbacks: ComputerService["reconcileHandbacks"] = async () => {
    if (!options.onHandback) return;
    const desktops = (await listRecords("computer.desktop")).map(parseDesktop).filter((item): item is ComputerDesktop => item !== null);
    await Promise.all(desktops.map((desktop) => deliverHandbacks(desktop.id)));
  };

  /** Broadcast the control record to every subscribed viewer (BC5.B). */
  const viewers = new Map<string, DesktopViewers>();
  const broadcastControl = (desktopId: string) => {
    if (desktopId === LOCAL_DESKTOP_ID) { try { options.onControlChange?.(controlState(desktopId)); } catch { /* presentation only */ } }
    const entry = viewers.get(desktopId);
    if (!entry) return;
    const event: DesktopViewEvent = { type: "control", control: controlState(desktopId) };
    for (const listener of entry.viewers.values()) {
      try { listener(event); } catch { /* a broken viewer must not block others */ }
    }
  };

  const beginActivity = (desktopId: string, sessionId: string | undefined, app: string, operation: ComputerActivity["operation"]) => {
    const lane = laneFor(desktopId);
    const knownApp = [...(observations.get(desktopId)?.values() ?? [])]
      .find(observation => String(observation.app.pid) === app || observation.app.name.toLowerCase() === app.toLowerCase());
    const activity: ComputerActivity = { app: knownApp?.app.name ?? app, operation, status: "running", updatedAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}) };
    const publish = () => {
      broadcastControl(desktopId);
      try { options.onActivityChange?.({ desktopId, activity: lane.activity! }); } catch { /* presentation cannot interrupt input */ }
    };
    lane.activity = activity;
    publish();
    return (ok: boolean, resolvedApp?: string) => {
      if (lane.activity !== activity) return;
      lane.activity = { ...activity, ...(resolvedApp ? { app: resolvedApp } : {}), status: ok ? "idle" : "error", updatedAt: new Date().toISOString() };
      publish();
    };
  };

  // --- BC6: remote Host routing --------------------------------------------
  // `provider:"remote"` machines are mirrors: their desktops live on another
  // Host's service. Control state, lanes, drivers, and frame polls all run
  // there; this service only carries authenticated calls across.

  const fetchImpl = options.fetch ?? fetch;

  const remoteConnections = async (): Promise<ComputerRemoteHost[]> => (
    options.remoteHosts ? await options.remoteHosts() : []
  );

  const remoteHeaders = (connection: ComputerRemoteHost, extra?: Record<string, string>): Headers => {
    const headers = new Headers(connection.requestHeaders ?? {});
    if (connection.clientToken) headers.set("Authorization", `Bearer ${connection.clientToken}`);
    if (connection.expectedHostId) headers.set("X-Varin-Computer-Host", connection.expectedHostId);
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
    const admission = automation.context.getStore();
    admission?.assert();
    if (admission) signal = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal;
    const url = `${connection.apiUrl.replace(/\/$/, "")}${path}`;
    let leaseToken: string | undefined;
    if (admission) {
      const remoteId = /^\/api\/computers\/desktops\/([^/]+)/u.exec(path)?.[1];
      const claims = [...remoteClaims.values()].filter(claim => claim.lease.actor.sessionId === admission.actor.sessionId
        && claim.lease.actor.runId === admission.actor.runId && claim.target.connection.id === connection.id
        && encodeURIComponent(claim.target.remoteId) === remoteId);
      const claim = claims.find(item => item.lease.access === 'control') ?? claims[0];
      if (claim) { await claim.ready; admission.assert(); leaseToken = claim.token; }
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: remoteHeaders(connection, { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(leaseToken ? { 'X-Varin-Computer-Lease': leaseToken } : {}) }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
        redirect: "error",
      });
    } catch (error) {
      throw new RemoteTransportError(
        `Remote Host "${connection.label}" is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (connection.expectedHostId && response.headers.get("x-varin-computer-host") !== connection.expectedHostId) {
      await response.body?.cancel();
      throw new RemoteTransportError("Remote computer Host identity changed; rediscover the actual target before operating it");
    }
    return response;
  };

  const remoteJson = async <T>(connection: ComputerRemoteHost, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await remoteFetch(connection, method, path, body, signal);
    let payload: (T & { code?: string; error?: string }) | null;
    try { payload = await response.json() as typeof payload; }
    catch { throw new RemoteTransportError("Remote Host response was lost or malformed; submitted input may have executed"); }
    if (!isObject(payload)) throw new RemoteTransportError("Remote Host returned no usable response");
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
    return { connection: { ...connection, expectedHostId: desktop.remote.hostId }, remoteId: desktop.remote.desktopId, desktop };
  };

  const origin = `${options.hostId}:${controlEpoch}`;
  const reserveDesktop = async (lease: ComputerLease, signal: AbortSignal) => {
    const target = await remoteTargetFor(lease.desktopId);
    lease.desktopLabel = target?.desktop.label ?? (await desktopRecord(lease.desktopId)).desktop.label;
    if (!target) return;
    const key = claimKey(lease);
    const entry = { lease, target, token: undefined as string | undefined, ready: Promise.resolve() };
    remoteClaims.set(key, entry);
    entry.ready = automation.context.exit(async () => {
      const result = await remoteJson<{ token: string }>(target.connection, 'POST', `/api/computers/desktops/${encodeURIComponent(target.remoteId)}/assignment`,
        { op: 'claim', origin, assignmentId: lease.id, actor: lease.actor, access: lease.access }, signal);
      if (!asString(result.token)) throw new RemoteTransportError('Remote Host returned no desktop assignment');
      entry.token = result.token;
    });
    await entry.ready;
    if (lease.access === 'control') {
      let updates = Promise.resolve();
      let closed = false, retry = 0;
      const lifetime = new AbortController();
      let close: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const reconnect = () => {
        if (closed || timer) return;
        timer = setTimeout(() => { timer = undefined; void connect().catch(reconnect); }, Math.min(30_000, 1_000 * 2 ** retry++));
        timer.unref();
      };
      const connect = async () => {
        close?.();
        const stopStream = await automation.context.exit(() => subscribeFrames(lease.desktopId, `assignment:${lease.id}`, event => {
          if (closed || remoteClaims.get(key) !== entry) return;
          if (event.type === 'error' && event.terminal) { reconnect(); return; }
          if (event.type !== 'control') return;
          retry = 0;
          updates = updates.then(async () => {
            if (closed || remoteClaims.get(key) !== entry) return;
            if (event.control.workStatus === 'cancelling' || !event.control.operator && !event.control.transitioning) {
              await automation.cancelDesktop(lease.desktopId);
              return;
            }
            await syncRemoteControl(lease.desktopId, event.control);
          }).catch(error => console.error('[Computer] Remote control delivery failed:', error instanceof Error ? error.message : String(error)));
        }, { frames: false, signal: AbortSignal.any([lifetime.signal, signal]) }));
        if (closed) stopStream(); else close = stopStream;
      };
      assignmentStreams.set(lease.id, () => { closed = true; lifetime.abort(); close?.(); clearTimeout(timer); });
      await connect();
    }
  };
  const releaseDesktop = async (lease: ComputerLease): Promise<{ released: boolean }> => {
    assignmentStreams.get(lease.id)?.(); assignmentStreams.delete(lease.id);
    const claim = remoteClaims.get(claimKey(lease));
    const target = claim?.target ?? await remoteTargetFor(lease.desktopId);
    if (!target) {
      const lane = laneFor(lease.desktopId);
      if (lane.control.owner === 'human' && !lane.transitioning && !lane.inputReleaseUnconfirmed) return { released: true };
      return lease.access === 'control' ? cancelImpl(lease.desktopId) : { released: true };
    }
    // Release by origin and execution identity too: a lost claim receipt must not orphan a remote lock.
    await claim?.ready.catch(() => undefined);
    await remoteJson(target.connection, 'POST', `/api/computers/desktops/${encodeURIComponent(target.remoteId)}/assignment`,
      { op: 'drop', origin, assignmentId: lease.id, actor: lease.actor, access: lease.access });
    remoteClaims.delete(claimKey(lease));
    return { released: true };
  };
  const clearObservations = (id: string) => {
    for (const key of observations.get(id)?.keys() ?? []) observationOwners.delete(key);
    observations.delete(id);
  };

  /**
   * Mirror remote Host catalogs into local machine/desktop records (BC6).
   * Remote truth wins status; an unreachable Host marks its mirror
   * unavailable with the real error instead of leaving a stale "available".
   */
  let remoteSyncAt = 0;
  let remoteSync: Promise<void> | null = null;
  const syncRemote = async (force = false): Promise<void> => {
    if (!options.remoteHosts) return;
    if (remoteSync) {
      await remoteSync;
      if (!force) return;
    }
    if (!force && Date.now() - remoteSyncAt < 10_000) return;
    const task = syncRemoteCatalog();
    remoteSync = task;
    try { await task; } finally { if (remoteSync === task) remoteSync = null; }
  };
  const syncRemoteCatalog = async (): Promise<void> => {
    remoteSyncAt = Date.now();
    const hosts = await remoteConnections();
    const liveIds = new Set(hosts.map((host) => `remote:${host.id}`));
    // Hosts removed from settings keep their mirrors but report unconfigured.
    const known = (await listRecords("computer.machine"))
      .map(parseMachine)
      .filter((m): m is ComputerMachine => m !== null && m.provider === "remote");
    // Mirror rewrites must not erase local work associations (BC8) — the
    // remote Host owns driver state, not which local session used the mirror.
    const usageByDesktop = new Map(
      (await listRecords("computer.desktop"))
        .map(parseDesktop)
        .filter((d): d is ComputerDesktop => d !== null && d.usage !== undefined)
        .map((d) => [d.id, d.usage!]),
    );
    const workByDesktop = new Map((await listRecords("computer.desktop"))
      .map(parseDesktop).filter((d): d is ComputerDesktop => d !== null && d.work !== undefined)
      .map((d) => [d.id, d.work!]));
    const now = new Date().toISOString();
    await Promise.allSettled([
      ...hosts.map(async (host) => {
        const machineId = `remote:${host.id}`;
        try {
          // Ask only for resources owned there. Federating already mirrored
          // entries recursively creates an expanding A→B→A catalog.
          const catalog = await remoteJson<ComputerListResult>(host, "GET", "/api/computers?local=1");
          if (!Array.isArray(catalog.machines) || !Array.isArray(catalog.desktops)) throw new Error("Remote Host returned a malformed computer catalog");
          const remoteMachines = catalog.machines.filter((machine) => machine.provider !== "remote");
          const remoteDesktops = catalog.desktops.filter((desktop) => !desktop.remote && remoteMachines.some((machine) => machine.id === desktop.machineId));
          const primary = remoteMachines[0];
          if (!primary?.coordinatorHostId) throw new Error("Remote computer catalog has no owning Host identity");
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
            const mirrorDesktopId = `remote:${host.id}:${primary.coordinatorHostId}:${remoteDesktop.id}`;
            const mirroredUsage = usageByDesktop.get(mirrorDesktopId);
            const mirroredWork = workByDesktop.get(mirrorDesktopId);
            await putRecord(`computer.desktop:${mirrorDesktopId}`, "computer.desktop", remoteDesktop.status, {
              id: mirrorDesktopId,
              machineId,
              label: `${host.label} · ${remoteDesktop.label}`,
              kind: "remote-session",
              ...(remoteDesktop.statusDetail ? { statusDetail: remoteDesktop.statusDetail } : {}),
              ...(remoteDesktop.capabilities ? { capabilities: remoteDesktop.capabilities as unknown as Record<string, unknown> } : {}),
              remote: { connectionId: host.id, desktopId: remoteDesktop.id, hostId: primary.coordinatorHostId },
              ...(mirroredUsage ? { usage: mirroredUsage } : {}),
              ...(mirroredWork ? { work: mirroredWork } : {}),
              ...(remoteDesktop.managed ? { managed: remoteDesktop.managed } : {}),
              ...(remoteDesktop.media ? { media: remoteDesktop.media } : {}),
              ...(remoteDesktop.software ? { software: remoteDesktop.software } : {}),
            });
          }
          const retained = new Set(remoteDesktops.map((desktop) => `remote:${host.id}:${primary.coordinatorHostId}:${desktop.id}`));
          await markRemoteDesktopsUnavailable(host.id, "Desktop is no longer advertised by its owning Host", retained);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await markRemoteDesktopsUnavailable(host.id, detail);
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
        await markRemoteDesktopsUnavailable(machine.id.slice("remote:".length), "Host is no longer configured");
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
  const markRemoteDesktopsUnavailable = async (connectionId: string, detail: string, keep = new Set<string>()) => {
    for (const record of await listRecords("computer.desktop")) {
      const desktop = parseDesktop(record);
      if (desktop?.remote?.connectionId !== connectionId || keep.has(desktop.id)) continue;
      if (desktop.status === "unavailable" && desktop.statusDetail === detail) continue;
      await putRecord(record.recordId, "computer.desktop", "unavailable", { ...JSON.parse(record.payloadJson) as Record<string, unknown>, statusDetail: detail });
    }
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
    const admission = automation.context.getStore();
    return new Promise<T>((resolve, reject) => {
      lane.queue.push({
        kind,
        generation: generation ?? lane.generation,
        run: async () => {
          try {
            resolve(await (admission ? automation.context.run(admission, async () => { admission.assert(); return op(); }) : op()));
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
    onGesture?: Parameters<ComputerDriverSession['request']>[1],
  ): Promise<DriverResponse> => {
    const admission = automation.context.getStore();
    admission?.assert();
    if (admission) signal = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal;
    signal?.throwIfAborted();
    const pending = driver.request(op, { ...onGesture, beforeDispatch() {
      admission?.assert(); signal?.throwIfAborted(); onGesture?.beforeDispatch?.();
    } });
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

  const resolveDriver = async (desktopId: string): Promise<{ spec: DriverSpawnSpec; desktop: ComputerDesktop }> => {
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
    const spec = desktop.managed === "linux-xvnc" ? await linuxDesktop.driverSpec()
      : localDriverSpawnSpec(machine.platform, options.driverDir ?? computerDriverDir());
    if (!spec) {
      throw new HarnessServiceError("unavailable", `No ${machine.platform} driver is packaged for desktop "${desktopId}"`);
    }
    return { spec, desktop };
  };
  const driverPool = createDesktopDriverPool({ resolve: resolveDriver, onInputReset: (id) => clearObservations(id),
    ...(options.createDriver ? { createDriver: options.createDriver } : {}) });
  const drivers = driverPool.inputs;
  const driverFor = driverPool.acquire;
  const prewarm = async (desktopId?: string): Promise<void> => {
    const id = await resolveDesktopId(desktopId);
    if (await remoteTargetFor(id)) { await probe(id); return; }
    await Promise.all([driverPool.acquire(id), driverPool.acquire(id, 'capture')]);
  };

  const list: ComputerService["list"] = async (listOptions) => {
    await ensureLocal();
    await refreshManagedDesktop();
    // Refresh remote mirrors before reading the catalog — remote truth wins
    // status, and an unreachable Host leaves an unavailable mirror (BC6).
    if (!listOptions?.localOnly) await syncRemote();
    localProbe ??= probe(LOCAL_DESKTOP_ID);
    // Probe failures are stored in the catalog and presented as unavailable.
    // Reading a catalog does not require the user to visit Settings first.
    await localProbe.catch(() => undefined);
    const [machines, desktops] = await Promise.all([
      listRecords("computer.machine"),
      listRecords("computer.desktop"),
    ]);
    if (options.onHandback) for (const record of desktops) {
      const body = JSON.parse(record.payloadJson) as Record<string, unknown>;
      if (handbackEvents(body.handbackEvents).length > 0) {
        const id = recordIdSuffix(record);
        if (id) void deliverHandbacks(id).catch(() => undefined);
      }
    }
    return {
      machines: machines.map(parseMachine).filter((m): m is ComputerMachine => m !== null && (!listOptions?.localOnly || m.provider !== "remote")),
      desktops: desktops.map(parseDesktop).filter((d): d is ComputerDesktop => d !== null && (!listOptions?.localOnly || !d.remote))
        .map(desktop => ({ ...desktop, ...(lanes.get(desktop.id)?.activity ? { activity: lanes.get(desktop.id)!.activity } : {}) })),
      defaultDesktopId: await defaultDesktop(),
    };
  };

  const workDesktops: ComputerService["workDesktops"] = async (scopeId) => {
    await ensureLocal();
    return (await listRecords("computer.desktop")).map(parseDesktop)
      .filter((desktop): desktop is ComputerDesktop => desktop !== null && desktop.work?.some((work) => work.scopeId === scopeId) === true);
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
    if (desktopId) void prewarm(desktopId).catch(error => console.error('[Computer] Desktop preparation failed:', error instanceof Error ? error.message : String(error)));
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
    const priorDesktop = await (await scoped())
      .getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.desktop:${LOCAL_DESKTOP_ID}`)
      .catch(() => null);
    const priorUsage = priorDesktop ? parseDesktop(priorDesktop)?.usage : undefined;
    if (priorDesktop) {
      const raw = JSON.parse(priorDesktop.payloadJson) as Record<string, unknown>;
      if (isObject(raw.control) && raw.control.owner === "human") {
        laneFor(LOCAL_DESKTOP_ID).control = {
          owner: "human", reachable: false,
          ...(asString(raw.control.holderId) ? { holderId: raw.control.holderId as string } : {}),
          since: asString(raw.control.since) ?? now,
        };
      }
    }
    const desktopResult = await putRecord(`computer.desktop:${LOCAL_DESKTOP_ID}`, "computer.desktop", desktopState, {
      id: LOCAL_DESKTOP_ID,
      machineId: LOCAL_MACHINE_ID,
      label: "Console session",
      kind: "console",
      ...(priorUsage ? { usage: priorUsage } : {}),
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
          remote: { connectionId: remote.connection.id, desktopId: remote.remoteId, hostId: remote.desktop.remote!.hostId },
          ...(remoteDesktop?.statusDetail ? { statusDetail: remoteDesktop.statusDetail } : {}),
          ...(remoteDesktop?.capabilities ? { capabilities: remoteDesktop.capabilities as unknown as Record<string, unknown> } : {}),
          ...(remote.desktop.usage ? { usage: remote.desktop.usage } : {}),
          ...((remoteDesktop?.managed ?? remote.desktop.managed) ? { managed: remoteDesktop?.managed ?? remote.desktop.managed } : {}),
          ...((remoteDesktop?.media ?? remote.desktop.media) ? { media: remoteDesktop?.media ?? remote.desktop.media } : {}),
        });
      return parseDesktop(record)!;
    }
    const { desktop } = await desktopRecord(id);
    try {
      const { driver } = await driverFor(id);
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
          ...(desktop.usage ? { usage: desktop.usage } : {}),
          ...(desktop.managed ? { managed: desktop.managed } : {}),
          ...(desktop.media ? { media: desktop.media } : {}),
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
        ...(desktop.usage ? { usage: desktop.usage } : {}),
        ...(desktop.managed ? { managed: desktop.managed } : {}),
        ...(desktop.media ? { media: desktop.media } : {}),
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
    const response = await enqueue(id, "observe", () => driver.request({ tool: "list_apps", ...(id === LOCAL_DESKTOP_ID ? { control_windows: options.controlWindows?.() ?? [] } : {}) }));
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
    const admission = automation.context.getStore();
    const map = observations.get(observation.desktopId) ?? new Map<string, ComputerObservation>();
    const liveWindows = observation.windows?.length ? new Set(observation.windows.map(window => window.handle)) : undefined;
    for (const [key, previous] of map) {
      if (previous.app.pid !== observation.app.pid) continue;
      if (observationOwners.get(previous.id)?.key !== admission?.key) continue;
      if (liveWindows && previous.windowHandle !== undefined && !liveWindows.has(previous.windowHandle)
        || previous.windowHandle === observation.windowHandle && (observation.screenshot || !previous.screenshot)) map.delete(key);
    }
    map.set(observation.id, observation);
    if (admission) observationOwners.set(observation.id, { key: admission.key, runId: admission.actor.runId, rootRunId: admission.actor.rootRunId });
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

  const observationPage = (observation: ComputerObservation, params: Pick<Parameters<ComputerService['observe']>[0], 'offset' | 'textLimit' | 'includeScreenshot'>): ComputerObservation => {
    const offset = params.offset ?? 0;
    const limit = params.textLimit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || (limit !== 'max' && (!Number.isSafeInteger(limit) || limit < 1))) {
      throw new HarnessServiceError('invalid-params', 'Observation offset must be non-negative; textLimit must be positive or max');
    }
    const total = observation.treeLines.length;
    if (offset > total) throw new HarnessServiceError('invalid-params', `Observation has ${total} tree lines; offset ${offset} is outside it`);
    const end = limit === 'max' ? total : Math.min(total, offset + limit);
    const treeLines = observation.treeLines.slice(offset, end);
    const indexes = new Set(treeLines.flatMap(line => { const match = /^\s*(\d+)\s/.exec(line); return match ? [Number(match[1])] : []; }));
    const { screenshot, ...rest } = observation;
    return { ...rest, treeLines, elements: observation.elements.filter(element => indexes.has(element.index)),
      treePage: { offset, total, ...(end < total ? { nextOffset: end } : {}) },
      ...(params.includeScreenshot === true && screenshot ? { screenshot } : {}) };
  };

  const observeImpl: ComputerService["observe"] = async (params) => {
    params.signal?.throwIfAborted();
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    params.signal?.throwIfAborted();
    if (params.observationId) {
      const observation = observations.get(id)?.get(params.observationId);
      if (observation && observationOwners.get(observation.id)?.key !== automation.context.getStore()?.key) {
        throw new HarnessServiceError('forbidden', 'This observation belongs to another execution');
      }
      if (observation && (!observation.treePage || observation.treePage.total === observation.treeLines.length)) {
        if (params.includeScreenshot && !observation.screenshot) throw new HarnessServiceError('invalid-params', 'This observation has no screenshot; request a fresh observation with includeScreenshot:true');
        return observationPage(observation, params);
      }
      // Remote post-action receipts can contain just the first display page;
      // its owning Host retains the full snapshot and validates the reader.
      if (!remote) throw new HarnessServiceError('not-found', 'Observation is no longer available; observe the app again');
    }
    if (remote) {
      await recordUsage(id, params.sessionId).catch(() => undefined);
      const finish = beginActivity(id, params.sessionId, params.app, "observe");
      const result = await remoteJson<{ observation?: ComputerObservation }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/observe`, {
          app: params.app,
          ...(params.window !== undefined ? { window: params.window } : {}),
          includeScreenshot: params.includeScreenshot === true,
          textLimit: 'max',
          ...(params.observationId ? { observationId: params.observationId } : {}),
          ...(params.maxTreeNodes !== undefined ? { maxTreeNodes: params.maxTreeNodes } : {}),
          ...(params.maxTreeDepth !== undefined ? { maxTreeDepth: params.maxTreeDepth } : {}),
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        }, params.signal,
      ).catch(error => { finish(false); throw error; });
      if (!result.observation) {
        finish(false);
        throw new HarnessServiceError("unavailable", "Remote Host returned no observation");
      }
      finish(true, result.observation.app.name);
      // Keep the remote observation id — a later remote act must reference
      // the remote service's own freshness record. Only the desktop/machine
      // binding is mirrored locally.
      const observation = { ...result.observation, desktopId: id, machineId: remote.desktop.machineId };
      rememberObservation(observation);
      return observationPage(observation, params);
    }
    const generation = laneGeneration(id);
    return enqueue(id, "observe", async () => {
      params.signal?.throwIfAborted();
      const { driver, desktop } = await driverFor(id);
      await recordUsage(id, params.sessionId).catch(() => undefined);
      params.signal?.throwIfAborted();
      const finish = beginActivity(id, params.sessionId, params.app, "observe");
      const response = await requestWithAbort(driver, {
        tool: "get_app_state",
        ...(id === LOCAL_DESKTOP_ID ? { control_windows: options.controlWindows?.() ?? [] } : {}),
        app: params.app,
        screenshot: params.includeScreenshot === true,
        ...(params.window !== undefined ? { window: params.window } : {}),
        // Public textLimit paginates the retained tree. Native per-field text
        // handling is independent and keeps its existing defaults.
        ...(params.maxTreeNodes !== undefined ? { max_tree_nodes: params.maxTreeNodes } : {}),
        ...(params.maxTreeDepth !== undefined ? { max_tree_depth: params.maxTreeDepth } : {}),
      }, params.signal).catch(error => { finish(false); throw error; });
      finish(response.ok && Boolean(response.snapshot), isObject(response.snapshot?.app) ? asString(response.snapshot.app.name) : undefined);
      params.signal?.throwIfAborted();
      if (!response.ok || !response.snapshot) throw new HarnessServiceError("unavailable", response.error ?? "Observe failed");
      const observation = observationOf(response.snapshot, desktop);
      if (generation === laneGeneration(id) && !laneFor(id).transitioning) {
        rememberObservation(observation);
        if (laneFor(id).control.owner === "agent") laneFor(id).needsObservation = false;
      }
      return observationPage(observation, params);
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
        "Pass a current observationId from this desktop before using element indexes or screenshot coordinates",
      );
    }
    if (observationOwners.get(observation.id)?.key !== automation.context.getStore()?.key) throw new HarnessServiceError('forbidden', 'This observation belongs to another execution; observe the assigned desktop from this thread');
    if (action.elementIndex !== undefined) {
      const newest = [...(observations.get(desktopId)?.values() ?? [])]
        .filter(item => item.app.pid === observation.app.pid && item.windowHandle === observation.windowHandle
          && observationOwners.get(item.id)?.key === observationOwners.get(observation.id)?.key).at(-1);
      if (newest?.id !== observation.id) throw new HarnessServiceError("invalid-params", "Element index belongs to an older tree; use the latest observed elements");
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
    const rasterCoordinates = action.kind === "drag" || !element && (action.x !== undefined || action.y !== undefined);
    const screenshot = latest?.screenshot;
    const pixel = (value: number | undefined, axis: "x" | "y"): number | undefined => {
      if (value === undefined || !rasterCoordinates) return value;
      const size = axis === "x" ? screenshot?.width : screenshot?.height;
      const extent = axis === "x" ? windowBounds?.width : windowBounds?.height;
      if (!size || !extent || value < 0 || value >= size) throw new HarnessServiceError("invalid-params", "Coordinate must lie inside the screenshot from observationId; take a fresh screenshot");
      return value * extent / size;
    };
    const x = pixel(action.x, "x"), y = pixel(action.y, "y");
    const base = {
      ...(desktopId === LOCAL_DESKTOP_ID ? { control_windows: options.controlWindows?.() ?? [] } : {}),
      return_state: action.returnState ?? "none",
      app: latest ? String(latest.app.pid) : action.app,
      // An observation pins the window too. Never let an explicit selector
      // redirect observed element indexes or coordinates into another window.
      ...(latest?.windowHandle !== undefined ? { window: latest.windowHandle }
        : action.window !== undefined ? { window: action.window } : {}),
      ...(element ? { element } : {}),
      ...(windowBounds ? { windowBounds } : {}),
      ...(rasterCoordinates ? { expected_bounds: windowBounds, expected_dpi: latest?.dpiScale, capture_source: screenshot?.source } : {}),
    };
    switch (action.kind) {
      case "click":
        return {
          ...base,
          tool: "click" as const,
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
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
          input: action.clickMethod === "app_post" ? "app_post" : action.clickMethod === "global" ? "global" : "auto",
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
        };
      case "drag":
        return {
          ...base,
          tool: "drag" as const,
          from_x: pixel(action.fromX, "x") ?? 0,
          from_y: pixel(action.fromY, "y") ?? 0,
          to_x: pixel(action.toX, "x") ?? 0,
          to_y: pixel(action.toY, "y") ?? 0,
          input: action.clickMethod === "app_post" ? "app_post" : action.clickMethod === "global" ? "global" : "auto",
        };
      case "type":
        return {
          ...base,
          tool: "type_text" as const,
          text: action.text ?? "",
          input: action.clickMethod === "app_post" ? "app_post" : action.clickMethod === "global" ? "global" : "auto",
        };
      case "key":
        return {
          ...base,
          tool: "press_key" as const,
          key: action.key ?? "",
          input: action.clickMethod === "app_post" ? "app_post" : action.clickMethod === "global" ? "global" : "auto",
        };
      case "set_value":
        return { ...base, tool: "set_value" as const, value: action.value ?? "" };
    }
  };

  const validateAction = (action: ComputerAction) => {
    if (!isObject(action) || !asString(action.app)) {
      throw new HarnessServiceError("invalid-params", "computer.act requires action.app");
    }
    for (const key of ["x", "y", "fromX", "fromY", "toX", "toY", "pages", "elementIndex", "clickCount"] as const) {
      if (action[key] !== undefined && asNumber(action[key]) === undefined) throw new HarnessServiceError("invalid-params", `${key} must be a finite number`);
    }
    if (action.elementIndex !== undefined && (!Number.isSafeInteger(action.elementIndex) || action.elementIndex < 0)) throw new HarnessServiceError("invalid-params", "elementIndex must be a nonnegative integer");
    if (action.clickCount !== undefined && (!Number.isSafeInteger(action.clickCount) || action.clickCount <= 0)) throw new HarnessServiceError("invalid-params", "clickCount must be a positive integer");
    if (action.pages !== undefined && action.pages <= 0) throw new HarnessServiceError("invalid-params", "pages must be positive");
    if (action.mouseButton !== undefined && !["left", "right", "middle"].includes(action.mouseButton)) throw new HarnessServiceError("invalid-params", "Unknown mouse button");
    if (action.clickMethod !== undefined && !["auto", "accessibility", "app_post", "global"].includes(action.clickMethod)) throw new HarnessServiceError("invalid-params", "Unknown input method");
    if (action.direction !== undefined && !["up", "down", "left", "right"].includes(action.direction)) throw new HarnessServiceError("invalid-params", "Unknown scroll direction");
    if (action.returnState !== undefined && !["none", "tree", "screenshot"].includes(action.returnState)) throw new HarnessServiceError("invalid-params", "Unknown post-action capture mode");
    for (const key of ["text", "key", "value", "action", "observationId"] as const) {
      if (action[key] !== undefined && typeof action[key] !== "string") throw new HarnessServiceError("invalid-params", `${key} must be a string`);
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

  const actImpl: ComputerService["act"] = async (params) => {
    params.signal?.throwIfAborted();
    const action = structuredClone(params.action);
    const id = await resolveDesktopId(params.desktopId);
    validateAction(action);
    const generation = laneGeneration(id);
    const remote = await remoteTargetFor(id);
    if (remote) {
      // The remote Host owns its lane and control state — forward the action
      // verbatim; element indexes resolve against its own observation record.
      const observed = action.observationId ? observations.get(id)?.get(action.observationId) : undefined;
      const finish = beginActivity(id, params.sessionId, observed?.app.name ?? action.app, action.kind);
      try {
        await recordUsage(id, params.sessionId).catch(() => undefined);
        const payload = await remoteJson<{ result?: ComputerActionResult }>(
          remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/act`,
          { action, automationEpoch: params.automationEpoch, sessionId: params.sessionId }, params.signal,
        );
        if (!payload.result || typeof payload.result.accepted !== "boolean") throw new RemoteTransportError("Remote Host returned no valid action receipt");
        finish(payload.result.accepted && !payload.result.cancelled && !payload.result.outcome);
        if (payload.result.observation) {
          const observation = { ...payload.result.observation, desktopId: id, machineId: remote.desktop.machineId };
          rememberObservation(observation);
          payload.result.observation = observation;
        }
        return payload.result;
      } catch (error) {
        finish(false);
        if (error instanceof RemoteTransportError) {
          // The request may have crossed the wire — never replay; report the
          // effect as unknown and let the caller re-observe (BC6 contract).
          return interruptedAction(error.message, true);
        }
        throw error;
      }
    }
    // Stamp the caller-side generation before any further await: a cancel
    // issued while this call resolves its driver still drops the action.
    const assertAdmission = () => {
      const lane = laneFor(id);
      if (generation !== lane.generation) throw new CancelledActionError();
      if (lane.control.owner !== "agent" || lane.transitioning) throw new HarnessServiceError("forbidden", "Desktop control is changing or held by a human");
      if (lane.needsObservation) throw new HarnessServiceError("invalid-params", "Observe the desktop after handback before resuming input");
      if (params.automationEpoch !== undefined && params.automationEpoch !== modelEpoch(id)) {
        throw new HarnessServiceError("forbidden", "This computer script was invalidated by a control change; start a new evaluation from the current scene");
      }
    };
    let submitted = false;
    try {
      assertAdmission();
      const { response, desktop } = await enqueue(id, "action", async () => {
        params.signal?.throwIfAborted();
        const { driver, desktop } = await driverFor(id);
        params.signal?.throwIfAborted();
        assertAdmission();
        const op = toDriverOp(id, action);
        await recordUsage(id, params.sessionId).catch(() => undefined);
        params.signal?.throwIfAborted();
        assertAdmission();
        submitted = true;
        const observed = action.observationId ? observations.get(id)?.get(action.observationId) : undefined;
        const finish = beginActivity(id, params.sessionId, observed?.app.name ?? action.app, action.kind);
        const admission = automation.context.getStore();
        const gestureId = randomUUID();
        let nativeMechanism: ComputerGesture['mechanism'];
        const sendGesture = (event: Pick<ComputerGesture, 'phase' | 'point' | 'to' | 'target' | 'mechanism'>) => {
          if (generation !== laneGeneration(id)) return;
          try { admission?.assert(); } catch { return; }
          const mechanism = action.kind === 'set_value' || action.kind === 'secondary' || action.clickMethod === 'accessibility' || action.clickMethod === 'app_post' ? 'semantic'
            : action.kind === 'type' || action.kind === 'key' ? 'keyboard' : 'pointer';
          nativeMechanism = event.mechanism ?? nativeMechanism;
          const gesture: ComputerGesture = { mechanism: nativeMechanism ?? mechanism, ...event, id: gestureId, desktopId: id, kind: action.kind, at: new Date().toISOString(),
            ...(params.sessionId ? { sessionId: params.sessionId } : {}), ...(admission ? { actorLabel: admission.actor.label } : {}),
            ...(action.kind === 'key' ? { key: action.key } : {}), ...(action.kind === 'scroll' ? { direction: action.direction } : {}) };
          for (const listener of viewers.get(id)?.viewers.values() ?? []) { try { listener({ type: 'gesture', gesture }); } catch { /* presentation only */ } }
          try { options.onGesture?.(gesture, desktop.kind === 'console' && !desktop.managed); } catch { /* presentation only */ }
        };
        const response = await requestWithAbort(driver, { ...op, visual_feedback: true }, params.signal, { onGesture: sendGesture, beforeDispatch: assertAdmission }).catch(error => { finish(false); sendGesture({ phase: 'failed' }); throw error; });
        sendGesture({ phase: response.cancelled ? 'cancelled' : response.ok ? 'completed' : 'failed' });
        finish(response.ok && !response.cancelled && generation === laneGeneration(id));
        return { response, desktop };
      }, generation);
      const result = actionResult(response);
      if (!response.ok) {
        if (laneFor(id).control.owner === 'human' && result.receipt) {
          result.receipt.reason = { code: 'control-changed', message: 'The user took control of the desktop' };
          result.receipt.recovery = 'wait-for-control'; result.detail = result.receipt.reason.message;
        }
        clearObservations(id);
        laneFor(id).needsObservation = true;
        return result;
      }
      if (laneGeneration(id) !== generation) {
        result.cancelled = true;
        if (result.receipt) {
          const human = laneFor(id).control.owner === 'human';
          result.receipt.reason = { code: human ? 'control-changed' : 'cancelled', message: human ? 'The user took control after this input was dispatched' : 'The work was cancelled after this input was dispatched' };
          result.receipt.recovery = human ? 'wait-for-control' : 'observe';
          result.detail = result.receipt.reason.message;
        }
      }
      if (response.snapshot && laneGeneration(id) === generation) {
        const observation = observationOf(response.snapshot, desktop);
        rememberObservation(observation);
        result.observation = observationPage(observation, { includeScreenshot: action.returnState === 'screenshot' });
      }
      return result;
    } catch (error) {
      if (error instanceof CancelledActionError) {
        if (laneFor(id).control.owner === 'human') return { accepted: false, cancelled: true,
          receipt: { effect: 'none', reason: { code: 'control-changed', message: 'The user took control before dispatch' }, recovery: 'wait-for-control' } };
        return interruptedAction('The queued computer operation was cancelled', false, true);
      }
      if (submitted) {
        clearObservations(id);
        if (laneFor(id).control.owner === 'human') return {
          accepted: false, cancelled: true, outcome: 'unknown', detail: 'The user took control of the desktop',
          receipt: { effect: 'unknown', reason: { code: 'control-changed', message: 'The user took control of the desktop' }, recovery: 'wait-for-control' },
        };
        return interruptedAction(error instanceof Error ? error.message : String(error), true, params.signal?.aborted);
      }
      return { accepted: false, detail: error instanceof Error ? error.message : String(error), receipt: {
        effect: 'none', reason: { code: error instanceof HarnessServiceError && error.harnessCode === 'invalid-params' ? 'target-changed'
          : error instanceof HarnessServiceError && error.harnessCode === 'forbidden' ? 'control-changed' : 'driver-error',
        message: error instanceof Error ? error.message : String(error) },
        recovery: laneFor(id).control.owner === 'human' ? 'wait-for-control' : 'observe',
      } };
    }
  };

  const cancelImpl: ComputerService["cancel"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      return remoteJson<{ cancelled: number; released: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/cancel`,
      );
    }
    const lane = laneFor(id);
    if (lane.control.owner === "human" && !lane.transitioning) return { cancelled: 0, released: false };
    lane.inputReleaseUnconfirmed = true;
    lane.generation += 1;
    lane.needsObservation = true;
    lane.externalAbort?.abort();
    clearFeedback(id);
    // Old queued actions cannot cross this generation. Windows confirms release
    // independently of the UIA worker; other drivers drain after their cancel flag.
    const dropped = lane.queue.filter((entry) => entry.kind === "action");
    lane.queue = lane.queue.filter((entry) => entry.kind !== "action");
    for (const entry of dropped) entry.cancel();
    const driver = drivers.get(id);
    let released = driver === undefined;
    if (driver?.interrupt) {
      released = (await driver.interrupt()).released;
      if (released && drivers.get(id) === driver) drivers.delete(id);
      await enqueue(id, 'observe', async () => undefined);
    } else if (driver?.alive()) {
      // Signal the in-flight native operation through the driver's cancel
      // side-channel first — a long type/drag aborts at its next checkpoint
      // instead of running to completion before the release (BC4.A).
      driver.cancel();
      const response = await enqueue(id, "observe", () => driver.request({ tool: "release_input" }));
      if (!response.ok) throw new HarnessServiceError("failed", response.error ?? "Input release failed");
      released = true;
    } else {
      // Non-driver writes/installations still have to finish stopping before
      // cancellation reports a completed transfer of control.
      await enqueue(id, "observe", async () => undefined);
    }
    clearObservations(id);
    broadcastControl(id);
    lane.inputReleaseUnconfirmed = !released;
    return { cancelled: dropped.length, released };
  };

  const releaseImpl: ComputerService["release"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      return remoteJson<{ released: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/release`,
      );
    }
    const { driver } = await driverFor(id);
    const response = await enqueue(id, "observe", () => {
      const lane = laneFor(id);
      if (lane.control.owner !== "agent" || lane.transitioning) throw new HarnessServiceError("forbidden", "Human control owns the held input");
      return driver.request({ tool: "release_input" });
    });
    return { released: response.ok };
  };

  const openImpl: ComputerService["open"] = async (params) => {
    params.signal?.throwIfAborted();
    const provided = [params.url, params.path, params.command].filter((value) => typeof value === "string" && value.trim());
    if (provided.length !== 1) {
      throw new HarnessServiceError("invalid-params", "computer.open requires exactly one of url, path or command");
    }
    if (params.url !== undefined) {
      let scheme: string;
      try { scheme = new URL(params.url).protocol.toLowerCase(); }
      catch { throw new HarnessServiceError("invalid-params", "computer.open url is not a well-formed URL"); }
      // Handler schemes that execute attacker-controlled text instead of
      // opening a resource are rejected; everything else is the target's own
      // registered handler set.
      if (["javascript:", "data:", "vbscript:"].includes(scheme)) {
        throw new HarnessServiceError("invalid-params", `computer.open does not open ${scheme} URLs`);
      }
    }
    if (params.args !== undefined && (!Array.isArray(params.args) || !params.args.every((arg) => typeof arg === 'string'))) {
      throw new HarnessServiceError("invalid-params", "computer.open args must be a list of strings");
    }
    const id = await resolveDesktopId(params.desktopId);
    const generation = laneGeneration(id);
    const remote = await remoteTargetFor(id);
    if (remote) {
      try {
        await recordUsage(id, params.sessionId).catch(() => undefined);
        const payload = await remoteJson<{ result?: ComputerOpenResult }>(
          remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/open`,
          { ...(params.url !== undefined ? { url: params.url } : {}),
            ...(params.path !== undefined ? { path: params.path } : {}),
            ...(params.command !== undefined ? { command: params.command } : {}),
            ...(params.args !== undefined ? { args: params.args } : {}), automationEpoch: params.automationEpoch, sessionId: params.sessionId }, params.signal,
        );
        if (!payload.result || typeof payload.result.accepted !== "boolean") throw new RemoteTransportError("Remote Host returned no valid open receipt");
        return payload.result;
      } catch (error) {
        if (error instanceof RemoteTransportError) {
          // The open may have crossed the wire — never replay; report the
          // effect as unknown and let the caller verify on the desktop.
          return { accepted: false, outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
        }
        throw error;
      }
    }
    // A desktop under human control rejects automated opens — same gate as
    // `act`; the human opens things through their own session.
    if (laneFor(id).control.owner === "human") {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is under human control`);
    }
    const assertAdmission = () => {
      const lane = laneFor(id);
      if (generation !== lane.generation) throw new CancelledActionError();
      if (lane.control.owner !== "agent" || lane.transitioning) throw new HarnessServiceError("forbidden", "Desktop control is changing or held by a human");
      if (params.automationEpoch !== undefined && params.automationEpoch !== modelEpoch(id)) throw new HarnessServiceError('forbidden', 'This open belongs to an earlier control generation');
    };
    assertAdmission();
    let submitted = false;
    try {
      const response = await enqueue(id, "action", async () => {
        params.signal?.throwIfAborted();
        const { driver } = await driverFor(id);
        params.signal?.throwIfAborted();
        assertAdmission();
        await recordUsage(id, params.sessionId).catch(() => undefined);
        params.signal?.throwIfAborted();
        assertAdmission();
        submitted = true;
        return requestWithAbort(driver, {
          tool: "open",
          ...(params.url !== undefined ? { url: params.url } : {}),
          ...(params.path !== undefined ? { path: params.path } : {}),
          ...(params.command !== undefined ? { command: params.command } : {}),
          ...(params.args !== undefined ? { args: params.args } : {}),
        }, params.signal);
      }, generation);
      if (!response.ok) {
        if (response.cancelled) return { accepted: false, cancelled: true };
        throw new HarnessServiceError("failed", response.error ?? "Open failed");
      }
      const result: ComputerOpenResult = { accepted: true };
      if (typeof response.pid === "number" && Number.isSafeInteger(response.pid) && response.pid > 0) result.pid = response.pid;
      if (laneGeneration(id) !== generation) result.cancelled = true;
      return result;
    } catch (error) {
      if (error instanceof CancelledActionError) return { accepted: false, cancelled: true };
      if (submitted) {
        return { accepted: false, outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    }
  };

  const fileWriteImpl: ComputerService["fileWrite"] = async (params) => {
    params.signal?.throwIfAborted();
    validateArtifactPath(params.relativePath);
    if (typeof params.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(params.contentBase64)) {
      throw new HarnessServiceError("invalid-params", "computer.fileWrite requires valid base64 bytes");
    }
    const content = Buffer.from(params.contentBase64, "base64");
    const id = await resolveDesktopId(params.desktopId);
    const generation = laneGeneration(id);
    const remote = await remoteTargetFor(id);
    if (remote) {
      try {
        const result = await remoteJson<{ version?: DesktopArtifactVersion }>(remote.connection, "POST",
          `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/artifacts/write`,
          { relativePath: params.relativePath, contentBase64: params.contentBase64, sessionId: params.sessionId }, params.signal);
        return { version: artifactVersion(result.version) };
      } catch (error) {
        if (error instanceof RemoteTransportError) {
          // The bytes may already have landed on the target — the caller must
          // re-inspect the stored revision instead of re-sending blindly.
          throw new HarnessServiceError("unavailable", `${error.message} — re-inspect the target file before retrying`);
        }
        throw error;
      }
    }
    const { desktop } = await desktopRecord(id);
    if (desktop.managed !== "linux-xvnc") throw new HarnessServiceError("unavailable", "File transfer requires a managed Linux desktop");
    assertAutomation(id, generation);
    const version = await enqueue(id, "action", async () => {
      assertAutomation(id, generation);
      await recordUsage(id, params.sessionId).catch(() => undefined);
      assertAutomation(id, generation);
      return externalOperation(id, params.signal, async (signal) =>
        writeDesktopFile(await linuxDesktop.status(), params.relativePath, content, signal));
    }, generation);
    await recordUsage(id, params.sessionId).catch(() => undefined);
    return { version };
  };

  // --- EE §6.2/6.3: component recipe + install -------------------------------

  /** Merge install results into the desktop record's `software` map. */
  const recordSoftware = async (desktopId: string, results: LinuxSoftwareResult[]): Promise<void> => {
    const client = await scoped();
    const recordId = `computer.desktop:${desktopId}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = await client.getRecord(COMPUTER_CATALOG_WORKSPACE_ID, recordId);
      if (!record) return;
      let body: unknown;
      try { body = JSON.parse(record.payloadJson); } catch { return; }
      if (!isObject(body)) return;
      const software = isObject(body.software) ? { ...body.software } : {};
      const at = Date.now();
      for (const item of results) {
        software[item.id] = { state: item.state, at,
          ...(item.packages ? { packages: item.packages } : {}),
          ...(item.detail ? { detail: item.detail } : {}) };
      }
      body.software = software;
      try {
        await client.putRecord({
          operationId: `computer.desktop:software:${randomUUID()}`,
          workspaceId: COMPUTER_CATALOG_WORKSPACE_ID,
          recordId,
          recordType: "computer.desktop",
          state: record.state,
          payloadJson: JSON.stringify(body),
          ownerIds: [],
          references: [],
          expectedRecordRevision: record.recordRevision,
        });
        return;
      } catch {
        if (attempt === 1) return;
      }
    }
  };

  const installSoftwareImpl: ComputerService["installSoftware"] = async (params) => {
    params.signal?.throwIfAborted();
    const groups = params.groups ?? [];
    const packages = params.packages ?? [];
    if (!Array.isArray(groups) || !Array.isArray(packages) || ![...groups, ...packages].every((name) =>
      typeof name === "string" && /^[a-z0-9][a-z0-9+._:-]*$/u.test(name))) {
      throw new HarnessServiceError("invalid-params", "Invalid component or package names");
    }
    if (groups.length === 0 && packages.length === 0) {
      throw new HarnessServiceError("invalid-params", "installSoftware requires at least one component group or package");
    }
    const id = await resolveDesktopId(params.desktopId);
    const generation = laneGeneration(id);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ results?: ComputerSoftwareResult[] }>(remote.connection, "POST",
        `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/software`,
        { groups, packages, sessionId: params.sessionId }, params.signal);
      if (!Array.isArray(result.results)) {
        throw new HarnessServiceError("unavailable", "Remote Host returned no install results");
      }
      return { results: result.results };
    }
    const { desktop } = await desktopRecord(id);
    if (desktop.managed !== "linux-xvnc") {
      throw new HarnessServiceError("unavailable", "Software install requires a managed Linux environment — other desktops keep their own administration");
    }
    assertAutomation(id, generation);
    const results = await enqueue(id, "action", async () => {
      assertAutomation(id, generation);
      await recordUsage(id, params.sessionId).catch(() => undefined);
      assertAutomation(id, generation);
      return externalOperation(id, params.signal, (signal) => linuxDesktop.install({ groups, packages, signal }));
    }, generation);
    // The reported state is the install's real outcome — failed entries stay
    // visible instead of collapsing into success.
    await recordSoftware(id, results).catch(() => undefined);
    return { results };
  };

  // --- EE §7.2: browser bridge (CDP attach to the visible session) -----------

  const assertAutomation = (id: string, generation: number, epoch?: string, needsScene = false) => {
    const lane = laneFor(id);
    if (generation !== lane.generation) throw new CancelledActionError();
    if (lane.control.owner !== "agent" || lane.transitioning) throw new HarnessServiceError("forbidden", "Desktop control is changing or held by a human");
    automation.context.getStore()?.assert();
    if (epoch !== undefined && epoch !== modelEpoch(id)) throw new HarnessServiceError("forbidden", "This operation belongs to an earlier control generation");
    if (needsScene && lane.needsObservation) throw new HarnessServiceError("invalid-params", "Observe the current scene after handback before resuming input");
  };

  const externalOperation = async <T>(id: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const lane = laneFor(id);
    const controller = new AbortController();
    lane.externalAbort = controller;
    try { return await run(signal ? AbortSignal.any([controller.signal, signal]) : controller.signal); }
    finally { if (lane.externalAbort === controller) delete lane.externalAbort; }
  };

  const applicationBridge = async <R extends ComputerBrowserResult | ComputerOfficeResult>(
    params: { desktopId?: string; op: string; automationEpoch?: string; signal?: AbortSignal; sessionId?: string },
    tool: "browser" | "office", writes: boolean, observesScene: boolean,
    body: Record<string, unknown>, driverBody: Record<string, unknown>,
  ): Promise<R> => {
    params.signal?.throwIfAborted();
    const id = await resolveDesktopId(params.desktopId);
    const generation = laneGeneration(id);
    const remote = await remoteTargetFor(id);
    if (remote) {
      try {
        await recordUsage(id, params.sessionId).catch(() => undefined);
        const payload = await remoteJson<R>(remote.connection, "POST",
          `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/${tool}`,
          { ...body, op: params.op, sessionId: params.sessionId, automationEpoch: params.automationEpoch }, params.signal);
        if (typeof payload?.ok !== "boolean") throw new RemoteTransportError(`Remote Host returned no valid ${tool} receipt`);
        return payload;
      } catch (error) {
        if (error instanceof RemoteTransportError) {
          return { ok: false, outcome: "unknown", error: error.message } as R;
        }
        throw error;
      }
    }
    const assertAdmission = () => {
      params.signal?.throwIfAborted();
      if (writes) assertAutomation(id, generation, params.automationEpoch, params.op === "act");
    };
    assertAdmission();
    let submitted = false;
    try {
      const response = await enqueue(id, writes ? "action" : "observe", async () => {
        const { driver } = await driverFor(id);
        assertAdmission();
        await recordUsage(id, params.sessionId).catch(() => undefined);
        assertAdmission();
        submitted = true;
        return requestWithAbort(driver, { ...driverBody, tool, op: params.op }, params.signal);
      }, generation);
      const { id: _rid, ...result } = response as DriverResponse & Record<string, unknown>;
      if (response.ok && observesScene && generation === laneGeneration(id) && !laneFor(id).transitioning) {
        laneFor(id).needsObservation = false;
      }
      if (generation !== laneGeneration(id)) result.cancelled = true;
      return { ...result, automationEpoch: scopedEpoch(`${controlEpoch}:${generation}`) } as unknown as R;
    } catch (error) {
      if (error instanceof CancelledActionError) return { ok: false, cancelled: true, error: "Cancelled before dispatch" } as unknown as R;
      if (submitted) return { ok: false, outcome: "unknown", error: error instanceof Error ? error.message : String(error) } as R;
      throw error;
    }
  };

  const browserImpl: ComputerService["browser"] = async (params) => {
    if (!["status", "launch", "tabs", "snapshot", "act"].includes(params.op)) throw new HarnessServiceError("invalid-params", "computer.browser requires a valid op");
    const writes = params.op === "launch" || (params.op === "act" && params.act?.kind !== "screenshot");
    const fields = { ...(params.binary !== undefined ? { binary: params.binary } : {}),
      ...(params.profile !== undefined ? { profile: params.profile } : {}),
      ...(params.act !== undefined ? { act: structuredClone(params.act) } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}) };
    return applicationBridge<ComputerBrowserResult>(params, "browser", writes, params.op === "snapshot", {
      ...fields, ...(params.tabId !== undefined ? { tabId: params.tabId } : {}), ...(params.port !== undefined ? { port: params.port } : {}),
    }, { ...fields, ...(params.tabId !== undefined ? { tab: params.tabId } : {}), ...(params.port !== undefined ? { cdp_port: params.port } : {}) });
  };

  const officeImpl: ComputerService["office"] = async (params) => {
    if (!["status", "launch", "docs", "open", "act"].includes(params.op)) throw new HarnessServiceError("invalid-params", "computer.office requires a valid op");
    const readsDocument = params.op === "act" && params.act?.kind === "read";
    const writes = params.op === "launch" || params.op === "open" || (params.op === "act" && !readsDocument);
    const fields = { ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.url !== undefined ? { url: params.url } : {}), ...(params.act !== undefined ? { act: structuredClone(params.act) } : {}) };
    return applicationBridge<ComputerOfficeResult>(params, "office", writes, params.op === "docs" || readsDocument, fields, fields);
  };

  // --- BC5: control ownership ---------------------------------------------

  const remoteControlUpdates = new Map<string, Promise<void>>();
  const syncRemoteControl = (id: string, control: ComputerControlState): Promise<void> => {
    const update = (remoteControlUpdates.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const lane = laneFor(id);
      const operator = automation.controller(id);
      if (!operator || control.transitioning) return;
      if (control.owner === 'human' && !lane.interrupted) {
        const work = { id: randomUUID(), actor: operator, ...(control.holderId ? { holderId: control.holderId } : {}) };
        lane.interrupted = work;
        lane.control = { owner: 'human', since: control.since, reachable: control.reachable, ...(control.holderId ? { holderId: control.holderId } : {}) };
        automation.setHumanControl(id, true);
        const interrupted = await automation.interruptDesktop(id);
        await persistControl(id, false, false);
        if (lane.interrupted === work) await automation.notifyHandoff(operator, 'The user took control of the desktop. Automatic input is paused until control is returned.', `takeover:${work.id}`, interrupted);
      } else if (control.owner === 'agent' && lane.interrupted) {
        lane.control = { owner: 'agent', since: control.since, reachable: true };
        await persistControl(id, true, false);
        delete lane.interrupted;
        automation.setHumanControl(id, false);
        void deliverHandbacks(id).catch(() => undefined);
      }
    });
    remoteControlUpdates.set(id, update);
    void update.finally(() => { if (remoteControlUpdates.get(id) === update) remoteControlUpdates.delete(id); }).catch(() => {});
    return update;
  };

  const control: ComputerService["control"] = async (desktopId) => {
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ control?: ComputerControlState }>(
        remote.connection, "GET", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/control`,
      );
      if (!result.control) throw new HarnessServiceError("unavailable", "Remote Host returned no control state");
      const actor = automation.context.getStore()?.actor;
      const operator = automation.controller(id);
      return { ...result.control, desktopId: id, ...(operator ? { operator } : {}), ...(actor ? { executionId: actor.runId } : {}) };
    }
    await desktopRecord(id); // control state exists only for real desktops
    const actor = automation.context.getStore()?.actor;
    return { ...controlState(id), automationEpoch: modelEpoch(id), ...(actor ? { executionId: actor.runId } : {}) };
  };

  const takeoverImpl: ComputerService["takeover"] = async (params) => {
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    const operator = automation.controller(id);
    if (remote) {
      const result = await remoteJson<{ control?: ComputerControlState; cancelled: number; released: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/takeover`,
        { ...(params.holderId ? { holderId: params.holderId } : {}) },
      );
      if (!result.control) throw new HarnessServiceError("unavailable", "Remote Host returned no control state");
      await syncRemoteControl(id, result.control);
      return {
        control: { ...result.control, desktopId: id, ...(operator ? { operator } : {}) },
        cancelled: result.cancelled ?? 0,
        released: result.released ?? false,
      };
    }
    await desktopRecord(id);
    const lane = laneFor(id);
    if (!params.holderId?.trim()) throw new HarnessServiceError("invalid-params", "A viewer identity is required for takeover");
    if (lane.transitioning) throw new HarnessServiceError("forbidden", "Desktop control is already changing");
    // Fence input before the first await. The previous implementation left
    // owner=agent while draining, admitting fresh automation into the handoff.
    lane.transitioning = true;
    if (operator) lane.interrupted ??= { id: randomUUID(), actor: operator };
    if (lane.interrupted) lane.interrupted.holderId = params.holderId;
    clearFeedback(id);
    lane.inputReleaseUnconfirmed = true;
    lane.generation += 1;
    lane.externalAbort?.abort();
    lane.needsObservation = true;
    const dropped = lane.queue.filter((entry) => entry.kind !== "observe");
    lane.queue = lane.queue.filter((entry) => entry.kind === "observe");
    for (const entry of dropped) entry.cancel();
    lane.control = {
      owner: "human",
      holderId: params.holderId,
      reachable: false,
      since: new Date().toISOString(),
    };
    automation.setHumanControl(id, true);
    clearObservations(id);
    broadcastControl(id);
    drivers.get(id)?.cancel();
    try {
      const interrupted = await automation.interruptDesktop(id);
      await persistControl(id);
      const interruptedDriver = drivers.get(id);
      if (interruptedDriver?.interrupt) {
        if (!(await interruptedDriver.interrupt({ restoreFocus: false })).released) throw new HarnessServiceError('unavailable', 'Input release was not confirmed');
        if (drivers.get(id) === interruptedDriver) drivers.delete(id);
      }
      await enqueue(id, "observe", async () => {
        const driver = drivers.get(id);
        if (driver && !driver.interrupt && (!driver.alive() || !(await driver.request({ tool: "release_input" })).ok)) {
          throw new HarnessServiceError("unavailable", "Input release was not confirmed; desktop remains reserved for human recovery");
        }
      });
      lane.control.reachable = params.holderId === options.localControlHolder || (viewers.get(id)?.viewers.has(params.holderId) ?? false);
      lane.inputReleaseUnconfirmed = false;
      if (operator && lane.interrupted) await automation.notifyHandoff(operator, 'The user took control of the desktop. Automatic input is paused until control is returned.', `takeover:${lane.interrupted.id}`, interrupted);
      return { control: { ...controlState(id), transitioning: false }, cancelled: dropped.filter((entry) => entry.kind === "action").length, released: true };
    } finally {
      lane.transitioning = false;
      broadcastControl(id);
    }
  };

  const handbackImpl: ComputerService["handback"] = async (params) => {
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ control?: ComputerControlState; requiresObservation?: boolean }>(
        remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/handback`,
        { ...(params.holderId ? { holderId: params.holderId } : {}) },
      );
      if (!result.control) throw new HarnessServiceError("unavailable", "Remote Host returned no control state");
      await syncRemoteControl(id, result.control);
      const operator = automation.controller(id);
      return { control: { ...result.control, desktopId: id, ...(operator ? { operator } : {}) }, requiresObservation: true };
    }
    const lane = laneFor(id);
    if (lane.control.owner !== "human") {
      throw new HarnessServiceError("invalid-params", `Desktop "${id}" is not under human control`);
    }
    if (!params.holderId || lane.control.holderId !== params.holderId) {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is held by another viewer`);
    }
    if (lane.transitioning) throw new HarnessServiceError("forbidden", "Desktop control is already changing");
    lane.transitioning = true;
    lane.generation += 1;
    lane.externalAbort?.abort();
    lane.needsObservation = true;
    const dropped = lane.queue.filter((entry) => entry.kind !== "observe");
    lane.queue = lane.queue.filter((entry) => entry.kind === "observe");
    for (const entry of dropped) entry.cancel();
    clearObservations(id);
    drivers.get(id)?.cancel();
    broadcastControl(id);
    const previous = lane.control;
    let result: Awaited<ReturnType<ComputerService["handback"]>>;
    try {
      const interruptedDriver = drivers.get(id);
      if (interruptedDriver?.interrupt) {
        if (!(await interruptedDriver.interrupt({ restoreFocus: false })).released) throw new HarnessServiceError('unavailable', 'Input release was not confirmed; control remains human-owned');
        if (drivers.get(id) === interruptedDriver) drivers.delete(id);
      }
      await enqueue(id, "observe", async () => {
        const driver = drivers.get(id);
        if (driver && (!driver.alive() || !(await driver.request({ tool: "release_input" })).ok)) {
          throw new HarnessServiceError("unavailable", "Input release was not confirmed; control remains human-owned");
        }
        lane.control = { owner: "agent", reachable: true, since: new Date().toISOString() };
        try { await persistControl(id, true); }
        catch (error) { lane.control = previous; throw error; }
      });
      result = { control: { ...controlState(id), transitioning: false }, requiresObservation: true };
      lane.inputReleaseUnconfirmed = false;
      delete lane.interrupted;
      automation.setHumanControl(id, false);
    } finally {
      lane.transitioning = false;
      broadcastControl(id);
    }
    void deliverHandbacks(id).catch(() => undefined);
    return result;
  };

  const validateHumanInput = (input: ComputerHumanInput): void => {
    if (!isObject(input)) throw new HarnessServiceError("invalid-params", "computer.input requires input");
    for (const key of ["x", "y", "count", "pages"] as const) {
      if (input[key] !== undefined && asNumber(input[key]) === undefined) throw new HarnessServiceError("invalid-params", `${key} must be a finite number`);
    }
    if (input.count !== undefined && (!Number.isSafeInteger(input.count) || input.count <= 0)) throw new HarnessServiceError("invalid-params", "count must be a positive integer");
    if (input.pages !== undefined && input.pages <= 0) throw new HarnessServiceError("invalid-params", "pages must be positive");
    if (input.button !== undefined && !["left", "right", "middle"].includes(input.button)) throw new HarnessServiceError("invalid-params", "Unknown mouse button");
    if (input.direction !== undefined && !["up", "down", "left", "right"].includes(input.direction)) throw new HarnessServiceError("invalid-params", "Unknown scroll direction");
    if (input.key !== undefined && typeof input.key !== "string") throw new HarnessServiceError("invalid-params", "key must be a string");
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
        { ...(params.holderId ? { holderId: params.holderId } : {}), controlEpoch: params.controlEpoch, input: params.input },
      );
    }
    const lane = laneFor(id);
    if (params.controlEpoch !== undefined && params.controlEpoch !== controlState(id).automationEpoch) throw new HarnessServiceError("forbidden", "Human input belongs to an earlier control generation");
    if (lane.control.owner !== "human") {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is not under human control`);
    }
    if (!params.holderId || lane.control.holderId !== params.holderId) {
      throw new HarnessServiceError("forbidden", `Desktop "${id}" is held by another viewer`);
    }
    if (lane.control.reachable === false || lane.transitioning || lane.inputReleaseUnconfirmed) {
      // The holder's view channel dropped — do not trust input attributed to
      // it until it reconnects through subscribeFrames.
      throw new HarnessServiceError("forbidden", `Desktop "${id}" control holder is disconnected`);
    }
    const generation = lane.generation;
    return enqueue(id, "input", async () => {
      // Re-check at execution: ownership may have flipped while queued.
      const control = laneFor(id).control;
      if (control.owner !== "human" || control.holderId !== params.holderId || !control.reachable || lane.transitioning || generation !== lane.generation) {
        return { accepted: false, detail: "control changed before the input ran" };
      }
      const { driver } = await driverFor(id);
      if (lane.transitioning || generation !== lane.generation || !lane.control.reachable) return { accepted: false, detail: "control changed before dispatch" };
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
    if (!entry || entry.frameViewers.size === 0 || entry.polling) return;
    entry.polling = true;
    try {
      const frame = await (async () => {
        const { driver } = await driverFor(desktopId, "capture");
        const response = await driver.request({ tool: "capture_frame" });
        if (!response.ok || !response.frame) {
          throw new Error(response.error ?? "desktop capture produced no frame");
        }
        const raw = response.frame;
        const bounds = frameOf(raw.bounds) ?? { x: 0, y: 0, width: 0, height: 0 };
        const mime = raw.mime === "image/jpeg" ? "image/jpeg" : "image/png";
        if (!raw.base64) throw new Error("desktop capture produced no frame");
        return { mime, base64: raw.base64, bounds, capturedAt: raw.capturedAt ?? new Date().toISOString() } satisfies ComputerDesktopFrame;
      })().catch((error: unknown): Error => (error instanceof Error ? error : new Error(String(error))));
      const current = viewers.get(desktopId);
      if (!current) return;
      if (frame instanceof Error) {
        entry.failures += 1;
        if (entry.failures >= 2) {
          const event: DesktopViewEvent = { type: "error", error: frame.message };
          for (const [viewerId, listener] of current.viewers) {
            if (current.frameViewers.has(viewerId)) try { listener(event); } catch { /* broken viewer */ }
          }
        }
        return;
      }
      entry.failures = 0;
      const event: DesktopViewEvent = { type: "frame", frame };
      for (const [viewerId, listener] of current.viewers) {
        if (current.frameViewers.has(viewerId)) try { listener(event); } catch { /* broken viewer */ }
      }
    } finally {
      entry.polling = false;
    }
  };

  const subscribeFrames: ComputerService["subscribeFrames"] = async (desktopId, viewerId, listener, subscription) => {
    subscription?.signal?.throwIfAborted();
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      // Frames for a remote desktop come off the remote Host's own stream —
      // the same authenticated Host-to-Host connection carries them (BC6).
      const controller = new AbortController();
      const path = `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/stream?viewer=${encodeURIComponent(viewerId)}${subscription?.frames === false ? "&frames=0" : ""}`;
      const response = await remoteFetch(remote.connection, "GET", path, undefined, subscription?.signal ? AbortSignal.any([controller.signal, subscription.signal]) : controller.signal);
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
          if (!reader) throw new Error("Remote desktop stream has no body");
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
                  const operator = automation.controller(id);
                  listener({ ...event, control: { ...event.control, desktopId: id, ...(operator && event.control.operator ? { operator } : {}) } });
                } else if (event.type === 'gesture') {
                  listener({ ...event, gesture: { ...event.gesture, desktopId: id } });
                } else {
                  listener(event);
                }
              } catch { /* malformed stream chunk is dropped */ }
            }
          }
          // The remote stream ended — tell the viewer, don't fake a frame.
          listener({ type: "error", error: "Remote desktop stream ended", terminal: true });
        } catch (error) {
          if (!controller.signal.aborted) {
            try { listener({ type: "error", error: error instanceof Error ? error.message : String(error), terminal: true }); } catch { /* */ }
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
      entry = { viewers: new Map(), frameViewers: new Set(), timer: null, polling: false, failures: 0 };
      viewers.set(id, entry);
    }
    entry.viewers.set(viewerId, listener);
    if (subscription?.frames !== false) entry.frameViewers.add(viewerId);
    else entry.frameViewers.delete(viewerId);
    try { listener({ type: "control", control: controlState(id) }); } catch { /* */ }
    if (entry.timer && entry.frameViewers.size === 0) { clearInterval(entry.timer); entry.timer = null; }
    if (!entry.timer && entry.frameViewers.size > 0) {
      entry.timer = setInterval(() => { void pollFrame(id); }, FRAME_INTERVAL_MS);
      void pollFrame(id);
    }
    broadcastControl(id);
    return () => {
      const current = viewers.get(id);
      if (!current) return;
      if (current.viewers.get(viewerId) !== listener) return;
      current.viewers.delete(viewerId);
      current.frameViewers.delete(viewerId);
      const laneControl = laneFor(id).control;
      if (laneControl.owner === "human" && laneControl.holderId === viewerId) {
        // The disconnecting viewer held control — mark it pending-recovery
        // rather than silently handing back while its input may be mid-flight.
        laneControl.reachable = false;
        const lane = laneFor(id);
        lane.generation += 1;
        const pendingInput = lane.queue.filter((op) => op.kind === "input");
        lane.queue = lane.queue.filter((op) => op.kind !== "input");
        for (const op of pendingInput) op.cancel();
        const driver = drivers.get(id);
        if (driver?.alive()) {
          driver.cancel();
          void enqueue(id, "observe", () => driver.request({ tool: "release_input" })).catch(() => undefined);
        }
      }
      if (current.frameViewers.size === 0) {
        if (current.timer) clearInterval(current.timer);
        current.timer = null;
      }
      broadcastControl(id);
    };
  };

  const refreshManagedDesktop = async (state?: LinuxDesktopState): Promise<ComputerDesktop | null> => {
    const current = state ?? await linuxDesktop.status();
    if (current.state === "unprepared") return null;
    await ensureLocal();
    const id = "managed-linux";
    const previous = await (await scoped()).getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.desktop:${id}`);
    const payload = previous ? JSON.parse(previous.payloadJson) as Record<string, unknown> : {};
    const probeFailed = current.state === "running" && previous?.state === "unavailable";
    const record = await putRecord(`computer.desktop:${id}`, "computer.desktop",
      current.state === "running" && !probeFailed ? "available" : current.state === "stopped" ? "stopped" : "unavailable", {
        ...payload, id, machineId: LOCAL_MACHINE_ID, label: "Persistent Linux desktop", kind: "virtual-display", managed: "linux-xvnc",
        ...(current.software ? { software: { ...(isObject(payload.software) ? payload.software : {}), ...current.software } } : {}),
        statusDetail: probeFailed ? payload.statusDetail : current.detail ?? current.state,
        ...(current.state === "running" ? { media: { kind: "vnc", width: current.width, height: current.height } } : {}),
      });
    return parseDesktop(record)!;
  };
  const prepareDesktop: ComputerService["prepareDesktop"] = async (params, automation = false) => {
    if (params.connectionId) {
      const connection = (await remoteConnections()).find((connection) => connection.id === params.connectionId);
      if (!connection) throw new HarnessServiceError("not-found", "Unknown Host connection");
      const result = await remoteJson<{ desktop: ComputerDesktop }>(connection, "POST", "/api/computers/desktops/prepare", {
        automation,
        ...(params.width !== undefined ? { width: params.width } : {}), ...(params.height !== undefined ? { height: params.height } : {}),
      });
      await syncRemote(true);
      const mirrored = (await listRecords("computer.desktop")).map(parseDesktop).find((desktop) =>
        desktop?.remote?.connectionId === params.connectionId && desktop?.remote?.desktopId === result.desktop.id);
      if (!mirrored) throw new HarnessServiceError("unavailable", "Prepared desktop could not be rediscovered");
      return mirrored;
    }
    const desktop = await refreshManagedDesktop(await linuxDesktop.change("prepare", params));
    if (!desktop) throw new HarnessServiceError("unavailable", "Desktop preparation did not finish");
    await replaceDesktopRuntime(desktop.id, async () => {}, automation);
    return probe(desktop.id);
  };
  const replaceDesktopRuntime = async (id: string, change: () => Promise<void>, automation = false) => {
    await desktopRecord(id);
    const lane = laneFor(id);
    if (automation && lane.control.owner === "human") throw new HarnessServiceError("forbidden", "A human currently controls this desktop");
    if (lane.transitioning) throw new HarnessServiceError("forbidden", "Desktop control is already changing");
    lane.transitioning = true; lane.generation += 1; lane.needsObservation = true;
    const pending = lane.queue.filter((op) => op.kind !== "observe");
    lane.queue = lane.queue.filter((op) => op.kind === "observe");
    for (const op of pending) op.cancel();
    clearObservations(id); broadcastControl(id);
    try {
      await cancel(id);
      await change();
      await driverPool.reset(id);
    } finally { lane.transitioning = false; broadcastControl(id); }
  };
  const desktopLifecycle: ComputerService["desktopLifecycle"] = async (id, action, automation = false) => {
    if (action !== "start" && action !== "stop") throw new HarnessServiceError("invalid-params", "Unknown desktop lifecycle action");
    const remote = await remoteTargetFor(id);
    if (remote) {
      await remoteJson(remote.connection, "POST", `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/lifecycle`, { action, automation });
      await syncRemote(true); return (await desktopRecord(id)).desktop;
    }
    const { desktop } = await desktopRecord(id);
    if (desktop.managed !== "linux-xvnc") throw new HarnessServiceError("invalid-params", "This desktop is not a managed graphical session");
    let updated: ComputerDesktop | null = null;
    await replaceDesktopRuntime(id, async () => { updated = await refreshManagedDesktop(await linuxDesktop.change(action)); }, automation);
    if (!updated) throw new HarnessServiceError("unavailable", "Desktop configuration is unavailable");
    return action === "start" ? probe(id) : updated;
  };
  const mediaTarget: ComputerService["mediaTarget"] = async (id) => {
    const remote = await remoteTargetFor(id);
    if (remote) {
      const url = new URL(`${remote.connection.apiUrl.replace(/\/$/u, "")}/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/vnc`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return { url: url.href, headers: { ...remote.connection.requestHeaders,
        ...(remote.connection.clientToken ? { Authorization: `Bearer ${remote.connection.clientToken}` } : {}),
        "X-Varin-Computer-Host": remote.desktop.remote!.hostId } };
    }
    const { desktop } = await desktopRecord(id);
    if (desktop.managed !== "linux-xvnc") throw new HarnessServiceError("unavailable", "Desktop does not provide VNC media");
    const current = await linuxDesktop.status();
    if (current.state !== "running" || !current.socket) throw new HarnessServiceError("unavailable", "Desktop media is unavailable");
    return { socketPath: current.socket };
  };

  const validateArtifactPath = (relativePath: string): void => {
    if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.startsWith("/")
      || relativePath.includes("\\") || relativePath.split("/").includes("..")) {
      throw new HarnessServiceError("invalid-params", "Artifact path must be relative to the managed desktop user's home");
    }
  };
  const artifactVersion = (value: unknown): DesktopArtifactVersion => {
    if (!isObject(value) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)
      || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0
      || typeof value.modifiedAt !== "string" || !/^[0-9]+$/u.test(value.modifiedAt)) {
      throw new RemoteTransportError("Remote desktop returned invalid artifact metadata");
    }
    return { sha256: value.sha256 as string, byteLength: value.byteLength as number, modifiedAt: value.modifiedAt };
  };
  const inspectArtifact: ComputerService["inspectArtifact"] = async (id, relativePath) => {
    validateArtifactPath(relativePath);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const result = await remoteJson<{ version?: DesktopArtifactVersion }>(remote.connection, "POST",
        `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/artifacts/inspect`, { relativePath });
      return artifactVersion(result.version);
    }
    const { desktop } = await desktopRecord(id);
    if (desktop.managed !== "linux-xvnc") throw new HarnessServiceError("unavailable", "Artifact access requires a managed Linux desktop");
    return inspectDesktopFile(await linuxDesktop.status(), relativePath);
  };
  const registerArtifact: ComputerService["registerArtifact"] = async (sessionId, desktopId, relativePath) => {
    if (!sessionId) throw new HarnessServiceError("forbidden", "Artifact registration requires an active work session");
    const work = await options.resolveWork?.(sessionId);
    if (!work) throw new HarnessServiceError("forbidden", "Artifact registration requires a durable Thread work owner");
    const id = await resolveDesktopId(desktopId);
    const remote = await remoteTargetFor(id);
    const version = await inspectArtifact(id, relativePath);
    const artifact: ComputerArtifact = { id: randomUUID(), desktopId: id,
      sourceHostId: remote?.desktop.remote?.hostId ?? options.hostId, scopeId: work.scopeId, threadId: work.threadId,
      relativePath, ...version, registeredAt: new Date().toISOString() };
    const client = await scoped();
    await client.putRecord({ operationId: `computer.artifact:${randomUUID()}`,
      workspaceId: COMPUTER_CATALOG_WORKSPACE_ID, recordId: `computer.artifact:${artifact.id}`,
      recordType: "computer.artifact", state: "active", payloadJson: JSON.stringify(artifact), ownerIds: [], references: [] });
    return artifact;
  };
  const listArtifacts: ComputerService["listArtifacts"] = async (scopeId) =>
    (await listRecords("computer.artifact")).map(parseArtifact)
      .filter((artifact): artifact is ComputerArtifact => artifact !== null && artifact.scopeId === scopeId);
  const openDesktopArtifact: ComputerService["openDesktopArtifact"] = async (id, relativePath, sha256) => {
    validateArtifactPath(relativePath);
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new HarnessServiceError("invalid-params", "Invalid artifact revision");
    const { desktop } = await desktopRecord(id);
    if (desktop.remote || desktop.managed !== "linux-xvnc") throw new HarnessServiceError("unavailable", "Artifact access requires a local managed Linux desktop");
    const current = await linuxDesktop.status();
    return openDesktopFile(current, relativePath, sha256);
  };
  const openArtifact: ComputerService["openArtifact"] = async (id) => {
    const record = await (await scoped()).getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.artifact:${id}`);
    const artifact = record ? parseArtifact(record) : null;
    if (!artifact) throw new HarnessServiceError("not-found", "Unknown computer artifact");
    const version = await inspectArtifact(artifact.desktopId, artifact.relativePath);
    if (version.sha256 !== artifact.sha256) throw new HarnessServiceError("unavailable", "Artifact version changed; register its current revision");
    const remote = await remoteTargetFor(artifact.desktopId);
    if (remote) {
      if (remote.desktop.remote?.hostId !== artifact.sourceHostId) throw new HarnessServiceError("forbidden", "Artifact Host identity changed");
      const path = `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/artifacts/read?path=${encodeURIComponent(artifact.relativePath)}&sha256=${artifact.sha256}`;
      const response = await remoteFetch(remote.connection, "GET", path);
      if (!response.ok || response.headers.get("x-varin-artifact-sha256") !== artifact.sha256 || !response.body) {
        await response.body?.cancel();
        throw new RemoteTransportError("Remote desktop did not return the recorded artifact revision");
      }
      const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      return { artifact, stream, cancel: () => stream.destroy() };
    }
    if (artifact.sourceHostId !== options.hostId) throw new HarnessServiceError("forbidden", "Artifact Host identity changed");
    return { artifact, ...await openDesktopArtifact(artifact.desktopId, artifact.relativePath, artifact.sha256) };
  };

  // --- BC7: virtual machine lifecycle ----------------------------------------

  const vmExec: VmExec = options.vmExec ?? ((command, args, execOptions) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [execOptions?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, LC_ALL: "C" } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (execOptions?.stdin !== undefined) {
      child.stdin?.end(execOptions.stdin);
    }
  }));

  const vmProviderCache = new Map<string, VmProvider>();
  const vmMutations = new Map<string, Promise<unknown>>();
  const serializeVm = <T>(machineId: string, operation: () => Promise<T>): Promise<T> => {
    const task = (vmMutations.get(machineId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    vmMutations.set(machineId, task);
    return task.finally(() => { if (vmMutations.get(machineId) === task) vmMutations.delete(machineId); });
  };
  const vmProviderFactory = options.vmProviderFactory ?? ((config: ComputerVmProviderConfig, exec: VmExec) =>
    createLibvirtProvider(config, exec));

  const vmProviderFor = async (providerId: string): Promise<{ config: ComputerVmProviderConfig; provider: VmProvider }> => {
    const configs = options.vmProviders ? await options.vmProviders() : [];
    const config = configs.find((entry) => entry.id === providerId);
    if (!config) {
      throw new HarnessServiceError("not-found", `Unknown VM provider "${providerId}"`);
    }
    let provider = vmProviderCache.get(providerId);
    if (!provider || JSON.stringify(provider.config) !== JSON.stringify(config)) {
      provider = vmProviderFactory(config, vmExec);
      vmProviderCache.set(providerId, provider);
    }
    return { config, provider };
  };

  const boundVmProvider = async (binding: ComputerVmBinding): Promise<VmProvider> => {
    const { provider } = await vmProviderFor(binding.providerId);
    if (provider.config.uri !== binding.uri || (provider.config.storagePool || "default") !== (binding.storagePool || "default")) {
      throw new HarnessServiceError("unavailable", "VM provider target or storage pool changed; restore its recorded connection before operating this machine");
    }
    return provider;
  };

  const vmMachineFor = async (machineId: string): Promise<{ record: KernelRecordResult; machine: ComputerMachine }> => {
    const record = await (await scoped()).getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.machine:${machineId}`)
      .catch(() => null);
    const machine = record ? parseMachine(record) : null;
    if (!record || !machine || machine.provider !== "virtual" || !machine.vm) {
      throw new HarnessServiceError("not-found", `Unknown virtual machine "${machineId}"`);
    }
    if (!machine.vm.domainUuid) {
      throw new HarnessServiceError(
        "invalid-params",
        `Virtual machine "${machineId}" was never defined — retry createVm`,
      );
    }
    return { record, machine };
  };

  const statusForVmState = (state: ComputerVmState): { status: ComputerMachine["status"]; detail?: string } => {
    switch (state) {
      case "running": return { status: "active" };
      case "paused": return { status: "unavailable", detail: "domain paused" };
      case "shutoff": return { status: "unavailable", detail: "domain shut off" };
      case "crashed": return { status: "unavailable", detail: "domain crashed" };
      default: return { status: "unavailable", detail: "provider state unknown" };
    }
  };

  const describeVm = async (machine: ComputerMachine): Promise<ComputerVmDescriptor> => {
    const binding = machine.vm!;
    let state: ComputerVmState = "unknown";
    let statusDetail: string | undefined;
    try {
      const provider = await boundVmProvider(binding);
      state = await provider.domainState(binding.domainUuid);
    } catch (error) {
      statusDetail = error instanceof Error ? error.message : String(error);
    }
    const mapped = statusForVmState(state);
    const detail = statusDetail ?? mapped.detail;
    return {
      machineId: machine.id,
      name: machine.name,
      binding,
      state,
      ...(detail ? { statusDetail: detail } : {}),
      createdAt: machine.createdAt,
      updatedAt: machine.updatedAt,
    };
  };

  const vmGuestReconciling = new Map<string, Promise<void>>();
  const reconcileVmGuests = async (): Promise<void> => {
    if (!options.registerVmGuest || disposed) return;
    const machines = (await listRecords("computer.machine")).map(parseMachine)
      .filter((machine): machine is ComputerMachine => machine !== null && machine.status !== "archived"
        && !!machine.vm?.guest);
    await Promise.allSettled(machines.map((machine) => {
      const pending = vmGuestReconciling.get(machine.id);
      if (pending) return pending;
      const task = serializeVm(`vm:${machine.vm!.providerId}:${machine.name}`, async () => {
        const fresh = (await vmMachineFor(machine.id)).machine;
        const binding = fresh.vm!;
        const guest = binding.guest;
        if (!guest) return;
        const provider = await boundVmProvider(binding);
        const state = await provider.domainState(binding.domainUuid).catch((): ComputerVmState => "unknown");
        if (state === "shutoff" || state === "crashed") {
          await markRemoteDesktopsUnavailable(`vm:${binding.domainUuid}`, `Guest domain is ${state}`);
          if (guest.state === "stopped") return;
          guest.state = "stopped";
          guest.detail = `Guest domain is ${state}`;
        } else if (state === "running") {
          if (guest.state === "ready" && guest.apiUrl && guest.hostId) {
            const liveHostId = await probeVmGuest(guest.apiUrl, options.appVersion!, options.vmGuestFetch).catch(() => null);
            const connection = (await remoteConnections()).find((entry) => entry.id === `vm:${binding.domainUuid}`);
            if (liveHostId === guest.hostId && connection?.apiUrl === guest.apiUrl && connection.clientToken) return;
            if (liveHostId === guest.hostId) {
              guest.state = "preparing";
              guest.detail = "Restoring the guest Host connection";
            } else {
            // A running domain does not imply its Host is still usable. In
            // particular a Host upgrade can leave an older guest runtime here.
              guest.state = "preparing";
              guest.detail = "Guest Host is unavailable or its version differs from this Host";
            }
            await putRecord(`computer.machine:${fresh.id}`, "computer.machine", "unavailable", {
              id: fresh.id, name: fresh.name, provider: "virtual", platform: "linux", coordinatorHostId: options.hostId,
              vm: binding, createdAt: fresh.createdAt, statusDetail: guest.detail,
            });
            if (liveHostId !== guest.hostId) {
              await options.removeVmGuest?.(`vm:${binding.domainUuid}`);
              await syncRemote(true);
            }
          }
          const noteBootstrapFailure = async () => {
            const status = await vmGuestBootstrapStatus(vmExec, binding.uri, binding.domainUuid);
            if (!status?.startsWith("failed:") || guest.detail === `Guest bootstrap ${status}`) return;
            guest.state = "failed";
            guest.detail = `Guest bootstrap ${status}`;
            await putRecord(`computer.machine:${fresh.id}`, "computer.machine", "unavailable", {
              id: fresh.id, name: fresh.name, provider: "virtual", platform: "linux", coordinatorHostId: options.hostId,
              vm: binding, createdAt: fresh.createdAt, statusDetail: guest.detail,
            });
          };
          const ip = await vmGuestIpv4(vmExec, binding.uri, binding.domainUuid);
          if (!ip) { await noteBootstrapFailure(); return; }
          const apiUrl = `http://${ip}:8765`;
          const hostId = await probeVmGuest(apiUrl, options.appVersion!, options.vmGuestFetch).catch(() => null);
          if (!hostId) { await noteBootstrapFailure(); return; }
          if (guest.hostId && guest.hostId !== hostId) {
            if (guest.state === "failed" && guest.detail === "Guest Host identity changed; the recorded desktop cannot be rebound to another Host") return;
            guest.state = "failed";
            guest.detail = "Guest Host identity changed; the recorded desktop cannot be rebound to another Host";
            await putRecord(`computer.machine:${fresh.id}`, "computer.machine", "unavailable", {
              id: fresh.id, name: fresh.name, provider: "virtual", platform: "linux", coordinatorHostId: options.hostId,
              vm: binding, createdAt: fresh.createdAt, statusDetail: guest.detail,
            });
            return;
          }
          const connectionId = `vm:${binding.domainUuid}`;
          const password = await vmGuestPassword(options.dataDir!, binding.domainUuid);
          await options.registerVmGuest!({ connectionId, label: fresh.name, apiUrl, password,
            hostId });
          await syncRemote(true);
          const mirror = (await listRecords("computer.desktop")).map(parseDesktop)
            .find((desktop) => desktop?.remote?.connectionId === connectionId
              && desktop.remote.hostId === hostId && desktop.remote.desktopId === "managed-linux");
          if (!mirror) return;
          try {
            const ready = await probe(mirror.id);
            if (ready.status !== "available" || ready.capabilities?.status !== "ready") return;
          } catch { return; }
          guest.connectionId = connectionId;
          guest.hostId = hostId;
          guest.apiUrl = apiUrl;
          guest.state = "ready";
          delete guest.detail;
        } else return;
        await putRecord(`computer.machine:${fresh.id}`, "computer.machine", guest.state === "ready" ? "active" : "unavailable", {
          id: fresh.id, name: fresh.name, provider: "virtual", platform: "linux", coordinatorHostId: options.hostId,
          vm: binding, createdAt: fresh.createdAt,
          statusDetail: guest.state === "ready" ? "Guest Host and desktop are ready" : guest.detail,
        });
      }).catch(async (error) => {
        const fresh = (await vmMachineFor(machine.id)).machine;
        if (fresh.status === "archived" || !fresh.vm?.guest || fresh.vm.guest.state === "ready") return;
        fresh.vm.guest.detail = error instanceof Error ? error.message : String(error);
        await putRecord(`computer.machine:${fresh.id}`, "computer.machine", "unavailable", {
          id: fresh.id, name: fresh.name, provider: "virtual", platform: "linux", coordinatorHostId: options.hostId,
          vm: fresh.vm, createdAt: fresh.createdAt, statusDetail: fresh.vm.guest.detail,
        });
      });
      vmGuestReconciling.set(machine.id, task);
      void task.finally(() => { if (vmGuestReconciling.get(machine.id) === task) vmGuestReconciling.delete(machine.id); }).catch(() => {});
      return task;
    }));
  };

  const listVms = async (): Promise<ComputerVmDescriptor[]> => {
    void reconcileVmGuests().catch(() => undefined);
    const machines = (await listRecords("computer.machine"))
      .map(parseMachine)
      .filter((m): m is ComputerMachine => m !== null && m.provider === "virtual" && !!m.vm && m.status !== "archived");
    const descriptors: ComputerVmDescriptor[] = [];
    for (const machine of machines) {
      const descriptor = await describeVm(machine);
      // Listing is a projection. A stale read must not resurrect a machine
      // archived by a concurrent delete.
      descriptors.push(descriptor);
    }
    return descriptors;
  };

  const createVm = async (params: ComputerVmCreateParams): Promise<{ machine: ComputerMachine; created: boolean }> => serializeVm(`vm:${params.providerId}:${params.name}`, async () => {
    if (disposed) throw new HarnessServiceError("unavailable", "Computer service is closed");
    const providerId = asString(params.providerId);
    const name = asString(params.name);
    if (!providerId || !name) {
      throw new HarnessServiceError("invalid-params", "providerId and name are required");
    }
    const { provider } = await vmProviderFor(providerId);
    const existing = (await listRecords("computer.machine")).map(parseMachine)
      .find((machine) => machine?.provider === "virtual" && machine.vm?.providerId === providerId && machine.name === name && machine.status !== "archived") ?? null;
    const machineId = existing?.id ?? `vm:${providerId}:${randomUUID()}`;
    if (existing?.vm) await boundVmProvider(existing.vm);
    const now = new Date().toISOString();
    const binding: ComputerVmBinding = existing?.vm ?? {
      providerId, kind: "libvirt", uri: provider.config.uri,
      storagePool: provider.config.storagePool || "default",
      domainUuid: randomUUID(), volumePaths: [], steps: [],
    };
    const managed = params.managed === true || Boolean(binding.guest);
    if (managed && existing && !binding.guest) throw new HarnessServiceError("invalid-params", "This existing VM was created without a managed guest recipe");
    if (managed && (platform !== "linux" || process.arch !== "x64" || provider.config.uri !== "qemu:///system")) {
      throw new HarnessServiceError("unavailable", "Managed VM preparation requires a Linux x64 Host on the configured local libvirt server");
    }
    if (managed && (!options.appVersion || !options.registerVmGuest || !options.dataDir)) {
      throw new HarnessServiceError("unavailable", "Managed VM guest registration is not configured on this Host");
    }
    if (managed && params.baseImage) throw new HarnessServiceError("invalid-params", "The managed Debian recipe selects its own verified cloud image");
    if (managed && !binding.guest) binding.guest = { recipe: "debian13-xvnc", state: "preparing" };
    if (managed && existing?.vm?.guest?.state === "ready") {
      const state = await provider.domainState(binding.domainUuid).catch((): ComputerVmState => "unknown");
      if (state !== "unknown") return { machine: existing, created: false };
    }
    const persist = async (status: ComputerMachine["status"], detail?: string) => putRecord(`computer.machine:${machineId}`, "computer.machine", status, {
      id: machineId, name, provider: "virtual", platform: "linux", coordinatorHostId: options.hostId,
      vm: binding, createdAt: existing?.createdAt ?? now, ...(detail ? { statusDetail: detail } : {}),
    });
    // The UUID is durable before any provider side effect. A matching name
    // alone never grants authority over an existing domain or its disks.
    await persist("unavailable", "Creation is being reconciled with the provider");
    let seed: Awaited<ReturnType<typeof prepareVmGuestSeed>> | undefined;
    let imageDownload: Awaited<ReturnType<typeof downloadDebianCloudImage>> | undefined;
    try {
      let baseImage = asString(params.baseImage);
      if (managed) {
        const guest = binding.guest!;
        guest.state = "preparing";
        const tool = await vmExec("sh", [join(options.driverDir ?? computerDriverDir(), "linux", "prepare-vm.sh")]);
        if (tool.code !== 0) throw new HarnessServiceError("unavailable", tool.stderr.trim() || "NoCloud seed tooling is unavailable");
        const password = await vmGuestPassword(options.dataDir!, binding.domainUuid);
        seed = await prepareVmGuestSeed({ driverDir: options.driverDir ?? computerDriverDir(), domainUuid: binding.domainUuid,
          password, expectedVersion: options.appVersion!, exec: vmExec });
        guest.runtimeSha256 = seed.runtimeSha256;
        await persist("unavailable", "Guest runtime and NoCloud seed verified");
        const image = guest.image ?? await resolveDebianCloudImage(options.vmGuestFetch);
        guest.image = image;
        await persist("unavailable", `Debian image ${image.version} selected`);
        imageDownload = await downloadDebianCloudImage(image, options.vmGuestFetch);
        if (!provider.stageBaseImage) throw new HarnessServiceError("unavailable", "This provider cannot stage a managed cloud image");
        baseImage = await provider.stageBaseImage({ domainUuid: binding.domainUuid, file: imageDownload.file,
          volumePaths: binding.volumePaths, uploaded: guest.imageUploaded === true,
          checkpoint: async (paths) => { binding.volumePaths = paths; await persist("unavailable", "Cloud image allocation receipt committed"); } });
        guest.imageUploaded = true;
        binding.steps.push({ step: "guest-image", status: "done", detail: `${image.ref} sha512:${image.sha512}`, at: new Date().toISOString() });
        await persist("unavailable", "Verified Debian cloud image uploaded");
      }
      const priorSteps = [...binding.steps];
      const outcome = await provider.create({
        name,
        memoryMiB: params.memoryMiB ?? 4096,
        vcpus: params.vcpus ?? 4,
        diskGiB: params.diskGiB ?? 40,
        ...(baseImage ? { baseImage } : {}),
        ...(seed ? { seedIsoFile: seed.isoFile } : {}),
        domainUuid: binding.domainUuid,
        volumePaths: binding.volumePaths,
        checkpoint: async (progress) => {
          binding.volumePaths = progress.volumePaths;
          binding.steps = [...priorSteps, ...progress.steps.map((entry) => ({ ...entry, at: new Date().toISOString() }))];
          await persist("unavailable", "Creation in progress; allocation receipt committed");
        },
      });
      if (outcome.domainUuid && outcome.domainUuid !== binding.domainUuid) throw new HarnessServiceError("failed", "Provider returned another domain's identity");
      binding.volumePaths = outcome.volumePaths;
      binding.steps = [...priorSteps, ...outcome.steps.map((entry) => ({ ...entry, at: new Date().toISOString() }))];
      if (!outcome.ok) throw new HarnessServiceError("failed", outcome.error ?? "VM create failed");
      let state = await provider.domainState(binding.domainUuid).catch((): ComputerVmState => "unknown");
      if (managed && state === "shutoff") {
        await provider.start(binding.domainUuid);
        state = await provider.domainState(binding.domainUuid).catch((): ComputerVmState => "unknown");
      }
      const mapped = statusForVmState(state);
      if (managed && state !== "running") throw new HarnessServiceError("unavailable", `Guest domain did not start: ${state}`);
      await persist(mapped.status, managed ? "Guest Host is bootstrapping" : mapped.detail);
      if (managed) void reconcileVmGuests().catch(() => undefined);
      const record = await (await scoped()).getRecord(COMPUTER_CATALOG_WORKSPACE_ID, `computer.machine:${machineId}`);
      return { machine: parseMachine(record!)!, created: outcome.adopted !== true };
    } catch (error) {
      if (binding.guest) { binding.guest.state = "failed"; binding.guest.detail = error instanceof Error ? error.message : String(error); }
      await persist("unavailable", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await Promise.allSettled([seed?.cleanup(), imageDownload?.cleanup()]);
    }
  });

  const withVmMachine = async <T>(machineId: string, operation: (machine: ComputerMachine) => Promise<T>): Promise<T> => {
    const initial = (await vmMachineFor(machineId)).machine;
    return serializeVm(`vm:${initial.vm!.providerId}:${initial.name}`, async () => operation((await vmMachineFor(machineId)).machine));
  };

  const vmAction = async (params: { machineId: string; action: "start" | "shutdown" | "reboot" | "upgrade" }): Promise<ComputerVmDescriptor> => withVmMachine(params.machineId, async (machine) => {
    if (machine.status === "archived") throw new HarnessServiceError("invalid-params", "This virtual machine was deleted");
    const provider = await boundVmProvider(machine.vm!);
    const uuid = machine.vm!.domainUuid;
    if (params.action === "upgrade") {
      if (!machine.vm?.guest || !options.dataDir || !options.appVersion || !provider.upgradeSeed) {
        throw new HarnessServiceError("unavailable", "This VM has no supported managed guest upgrade path");
      }
      if (await provider.domainState(uuid) !== "shutoff") {
        throw new HarnessServiceError("invalid-params", "Shut down the VM before upgrading its guest runtime");
      }
      const tool = await vmExec("sh", [join(options.driverDir ?? computerDriverDir(), "linux", "prepare-vm.sh")]);
      if (tool.code !== 0) throw new HarnessServiceError("unavailable", tool.stderr.trim() || "NoCloud seed tooling is unavailable");
      const password = await vmGuestPassword(options.dataDir, uuid);
      const seed = await prepareVmGuestSeed({ driverDir: options.driverDir ?? computerDriverDir(), domainUuid: uuid,
        password, expectedVersion: options.appVersion, exec: vmExec });
      try { await provider.upgradeSeed({ domainUuid: uuid, isoFile: seed.isoFile, volumePaths: machine.vm.volumePaths }); }
      finally { await seed.cleanup(); }
      machine.vm.guest.runtimeSha256 = seed.runtimeSha256;
      machine.vm.guest.state = "stopped";
      machine.vm.guest.detail = "Guest runtime staged; start the VM to install it";
      machine.vm.steps.push({ step: "guest-upgrade", status: "done", detail: `sha256:${seed.runtimeSha256}`, at: new Date().toISOString() });
      await putRecord(`computer.machine:${machine.id}`, "computer.machine", "unavailable", {
        id: machine.id, name: machine.name, provider: "virtual", platform: machine.platform,
        coordinatorHostId: machine.coordinatorHostId, statusDetail: machine.vm.guest.detail,
        vm: machine.vm, createdAt: machine.createdAt,
      });
      await markRemoteDesktopsUnavailable(`vm:${uuid}`, "Guest runtime staged; VM is shut off");
      return describeVm(machine);
    }
    if (params.action === "start") await provider.start(uuid);
    else if (params.action === "shutdown") await provider.shutdown(uuid);
    else await provider.reboot(uuid);
    const state = await provider.domainState(uuid).catch((): ComputerVmState => "unknown");
    const mapped = statusForVmState(state);
    if (machine.vm?.guest) {
      if (state === "shutoff" || state === "crashed") {
        machine.vm.guest.state = "stopped";
        machine.vm.guest.detail = `Guest domain is ${state}`;
      } else if (params.action !== "shutdown") {
        machine.vm.guest.state = "preparing";
        machine.vm.guest.detail = "Guest Host is restarting";
      }
    }
    await putRecord(`computer.machine:${machine.id}`, "computer.machine", mapped.status, {
      id: machine.id,
      name: machine.name,
      provider: "virtual",
      platform: machine.platform,
      coordinatorHostId: machine.coordinatorHostId,
      statusDetail: mapped.detail,
      vm: machine.vm,
      createdAt: machine.createdAt,
    });
    if (machine.vm?.guest?.state === "stopped") {
      await markRemoteDesktopsUnavailable(`vm:${uuid}`, `Guest domain is ${state}`);
    }
    if (machine.vm?.guest?.state === "preparing") void reconcileVmGuests().catch(() => undefined);
    return describeVm(machine);
  });

  const deleteVm = async (machineId: string, deleteDisks = false): Promise<void> => withVmMachine(machineId, async (machine) => {
    const provider = await boundVmProvider(machine.vm!);
    await provider.delete(machine.vm!.domainUuid, machine.vm!.volumePaths, deleteDisks);
    if (machine.vm?.guest) {
      await options.removeVmGuest?.(`vm:${machine.vm.domainUuid}`);
      await syncRemote(true);
    }
    // The record is archived, not erased — the create journal stays evidence
    // of what this Host once owned; archived machines leave `listVms`.
    await putRecord(`computer.machine:${machine.id}`, "computer.machine", "archived", {
      id: machine.id,
      name: machine.name,
      provider: "virtual",
      platform: machine.platform,
      coordinatorHostId: machine.coordinatorHostId,
      statusDetail: deleteDisks ? "domain and volumes removed" : "domain removed; volumes retained",
      vm: machine.vm,
      createdAt: machine.createdAt,
    });
    // Retained disks still contain the guest Host and its password. Keep the
    // coordinator's recovery credential with them; erase it only when those
    // UUID-owned disks were actually removed.
    if (deleteDisks && machine.vm?.guest && options.dataDir) {
      await forgetVmGuestPassword(options.dataDir, machine.vm.domainUuid);
    }
  });

  const guestReconcileTimer = options.registerVmGuest ? setInterval(() => {
    void reconcileVmGuests().catch(() => undefined);
  }, 10_000) : null;
  guestReconcileTimer?.unref();
  if (guestReconcileTimer) void reconcileVmGuests().catch(() => undefined);

  // EE6 (§10): best-effort durable steps beside execution, identifiers only.
  // Remote desktops are journaled by their owning Host; queries forward there.
  const observe: ComputerService["observe"] = (params) =>
    journaledOp(params, params.sessionId, { lane: "observe", tool: "observe", op: "observe", target: params.app }, observeImpl);
  const act: ComputerService["act"] = (params) =>
    journaledOp(params, params.sessionId, { lane: "action", tool: "act", op: params.action.kind, target: params.action.app }, actImpl);
  const open: ComputerService["open"] = (params) =>
    journaledOp(params, params.sessionId, { lane: "action", tool: "open", op: "open",
      target: params.path ?? urlEvidenceTarget(params.url) ?? params.command }, openImpl);
  const fileWrite: ComputerService["fileWrite"] = (params) =>
    journaledOp(params, params.sessionId, { lane: "action", tool: "fileWrite", op: "fileWrite", target: params.relativePath }, fileWriteImpl);
  const installSoftware: ComputerService["installSoftware"] = (params) =>
    journaledOp(params, params.sessionId, { lane: "action", tool: "installSoftware", op: "install",
      target: [...(params.groups ?? []), ...(params.packages ?? [])].join(",") || undefined }, installSoftwareImpl);
  const browser: ComputerService["browser"] = (params) =>
    journaledOp(params, params.sessionId, { lane: params.op === "status" || params.op === "tabs" || params.op === "snapshot" ? "observe" : "action",
      tool: "browser", op: params.op,
      target: params.tabId ?? (params.act ? [params.act.kind, urlEvidenceTarget(params.act.url)].filter(Boolean).join(" ") : undefined) }, browserImpl);
  const office: ComputerService["office"] = (params) =>
    journaledOp(params, params.sessionId, { lane: params.op === "status" || params.op === "docs" ? "observe" : "action",
      tool: "office", op: params.op,
      target: params.act?.doc ?? params.path ?? params.act?.range ?? params.url }, officeImpl);
  const takeover: ComputerService["takeover"] = (params) =>
    journaledOp(params, undefined, { lane: "action", tool: "control", op: "takeover", target: params.holderId }, takeoverImpl);
  const handback: ComputerService["handback"] = (params) =>
    journaledOp(params, undefined, { lane: "action", tool: "control", op: "handback", target: params.holderId }, handbackImpl);
  const cancel: ComputerService["cancel"] = (desktopId) =>
    journaledOp({ desktopId }, undefined, { lane: "action", tool: "control", op: "cancel" }, (params) => cancelImpl(params.desktopId));
  const release: ComputerService["release"] = (desktopId) =>
    journaledOp({ desktopId }, undefined, { lane: "action", tool: "control", op: "release" }, (params) => releaseImpl(params.desktopId));

  // EE6 (§10): reviewable evidence for the same steps — a read, never a gate.
  const evidence: ComputerService["evidence"] = async (params) => {
    params.signal?.throwIfAborted();
    const id = await resolveDesktopId(params.desktopId);
    const remote = await remoteTargetFor(id);
    if (remote) {
      const payload = await remoteJson<ComputerEvidenceResult>(remote.connection, "POST",
        `/api/computers/desktops/${encodeURIComponent(remote.remoteId)}/evidence`,
        { ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
          ...(params.since !== undefined ? { since: params.since } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}) }, params.signal);
      if (!payload || !Array.isArray(payload.entries) || !Number.isSafeInteger(payload.nextSince) || typeof payload.hasMore !== "boolean") throw new RemoteTransportError("Remote Host returned no valid evidence");
      return { ...payload, desktopId: id };
    }
    return evidenceJournal.read(id, params);
  };

  return {
    automation, resolveDesktop: resolveDesktopId,
    async finishExecution(runId) {
      await automation.finishRun(runId);
      for (const [id, lane] of lanes) {
        if (lane.interrupted?.actor.runId === runId || lane.interrupted?.actor.rootRunId === runId) {
          delete lane.interrupted;
          await persistControl(id);
        }
        if (lane.lastController?.runId === runId || lane.lastController?.rootRunId === runId) delete lane.lastController;
        broadcastControl(id);
      }
      for (const [id, owner] of observationOwners) if (owner.runId === runId || owner.rootRunId === runId) {
        for (const map of observations.values()) map.delete(id);
        observationOwners.delete(id);
      }
    },
    async claimDesktop(origin, assignmentId, actor, desktopId, access) {
      await desktopRecord(desktopId);
      if (await remoteTargetFor(desktopId)) throw new HarnessServiceError('invalid-params', 'Request the owning Host of this desktop');
      return automation.claim(origin, assignmentId, actor, desktopId, access);
    },
    async dropDesktopClaim(origin, assignmentId, actor, desktopId, access) {
      await automation.dropClaim(origin, assignmentId, actor, desktopId, access);
      if (access === 'control' && laneFor(desktopId).inputReleaseUnconfirmed) throw new HarnessServiceError('unavailable', 'Assignment is revoked, but native input release is still unconfirmed');
    },
    activities: (sessionId) => [...lanes.entries()].flatMap(([desktopId, lane]) => lane.activity && (!sessionId || lane.activity.sessionId === sessionId) ? [{ desktopId, activity: { ...lane.activity } }] : []),
    prepareDesktop, desktopLifecycle, mediaTarget,
    inspectArtifact, registerArtifact, listArtifacts, openDesktopArtifact, openArtifact,
    list, workDesktops, reconcileHandbacks,
    ensureLocal,
    probe,
    listApps,
    observe,
    act,
    cancel,
    release,
    open,
    fileWrite,
    installSoftware,
    browser,
    office,
    evidence,
    control,
    takeover,
    handback,
    input,
    subscribeFrames,
    defaultDesktop,
    setDefaultDesktop,
    prewarm,
    listVms,
    reconcileVmGuests,
    createVm,
    vmAction,
    deleteVm,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const close of assignmentStreams.values()) close();
      assignmentStreams.clear();
      if (guestReconcileTimer) clearInterval(guestReconcileTimer);
      for (const entry of viewers.values()) {
        if (entry.timer) clearInterval(entry.timer);
        entry.timer = null;
        entry.viewers.clear();
      }
      viewers.clear();
      for (const lane of lanes.values()) {
        lane.externalAbort?.abort();
        lane.generation += 1;
        for (const entry of lane.queue.splice(0)) entry.cancel();
      }
      await driverPool.dispose();
      await linuxDesktop.dispose();
      await evidenceJournal.drain();
      await Promise.allSettled([...handbackDeliveries.values()]);
      await Promise.allSettled([...vmGuestReconciling.values()]);
      lanes.clear();
      observations.clear();
    },
  };
}
