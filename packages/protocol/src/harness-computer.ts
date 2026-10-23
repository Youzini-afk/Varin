/**
 * BC4 Computer Use: machine/desktop catalog, observation, action, and
 * cancellation contracts shared by the Host computer service, the native
 * `computer` tool, and the settings surfaces.
 *
 * Ownership: a machine is a real computer (local host, remote machine, or a
 * VM record managed elsewhere); a desktop is one graphical session on that
 * machine. Neither is a Varin session, Thread, or Run — actions reference
 * desktops and element indexes that are valid only for the observation that
 * produced them.
 */

export type ComputerPlatform = "windows" | "macos" | "linux";

/** How the machine is reached. `remote`/`virtual` arrive with BC6/BC7. */
export type ComputerProviderKind = "local" | "remote" | "virtual";

export interface ComputerMachine {
  id: string;
  name: string;
  provider: ComputerProviderKind;
  platform: ComputerPlatform;
  /** Application Host that owns this machine's driver connection. */
  coordinatorHostId: string;
  status: "active" | "unavailable" | "archived";
  statusDetail?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Virtual-machine binding (BC7): this machine IS a domain on a VM provider.
   * Lifecycle calls (start/shutdown/reboot/delete) operate on the recorded
   * domain UUID; `volumePaths` are the provider storage volumes this Host
   * created — they are what `deleteDisks` is allowed to remove.
   */
  vm?: ComputerVmBinding;
}

/** EE §6.2: per-component install outcome for an environment's software recipe. */
export interface ComputerSoftwareResult {
  id: string;
  state: "installed" | "failed";
  detail?: string;
  packages?: string[];
}

export interface ComputerDesktop {
  id: string;
  machineId: string;
  label: string;
  /** What kind of graphical session this desktop is. */
  kind: "console" | "virtual-display" | "remote-session";
  status: "available" | "unavailable" | "stopped";
  statusDetail?: string;
  /** Last probed driver capabilities; absent until the first successful probe. */
  capabilities?: ComputerCapabilities;
  /**
   * Remote binding (BC6): this catalog entry mirrors a desktop owned by
   * another Host reached through `connectionId`. Calls route to that Host —
   * control state and the driver live there, not here.
   */
  remote?: { connectionId: string; desktopId: string; hostId: string };
  /**
   * Work association (BC8): the most recent agent session that operated this
   * desktop through the shared service. Projection material only — work state
   * stays authoritative on Thread/Run records; remote mirrors keep their own
   * Host's record.
   */
  usage?: { execution: ComputerExecutionRef; at: string };
  /** Durable links to works that used this desktop; Thread/Run remain the work authority. */
  work?: ComputerWorkAssociation[];
  /** A Host-managed persistent Linux graphical session, independent of a VM. */
  managed?: "linux-xvnc";
  /** Live framebuffer transport; input still uses the same Host control lane. */
  media?: { kind: "vnc"; width: number; height: number };
  /** Ephemeral current/last application operation. Comes from the owning Host, not durable work state. */
  activity?: ComputerActivity;
  /**
   * Component recipe state (EE §6.2): what the environment's install path
   * last reported per component id or ad-hoc package set. `installed` means
   * the package layer succeeded — control-interface usability stays in
   * `status`/`capabilities`, never inferred from this map.
   */
  software?: Record<string, { state: "installed" | "failed"; at: number; detail?: string; packages?: string[] }>;
}

export interface ComputerWorkAssociation {
  work: ComputerWorkRef;
  at: string;
}

export interface ComputerActivity {
  execution?: ComputerExecutionRef;
  app: string;
  operation: "observe" | ComputerAction["kind"];
  status: "running" | "idle" | "error";
  updatedAt: string;
}

export interface ComputerActivityEntry { desktopId: string; activity: ComputerActivity }

/** Runtime identity is part of the reference; matching strings never alias work. */
export type ComputerWorkRef = { runtime: "agent"; threadId: string; branchId: string };

export interface ComputerExecutionRef {
  work: ComputerWorkRef;
  runId: string;
}

/** Host-resolved execution identity; worker parameters never supply this authority. */
export interface ComputerActor {
  execution: ComputerExecutionRef;
  rootWork: ComputerWorkRef;
  /** A recipient can exist without a live root Run. Never synthesize an idle Run. */
  rootExecution: ComputerExecutionRef | null;
  label: string;
  /** Native tools retain their original per-invocation permission checks; this is not an assignment grant. */

}

export const computerWorkKey = (work: ComputerWorkRef): string => JSON.stringify([work.runtime, work.threadId, work.branchId]);
export const computerExecutionKey = (execution: ComputerExecutionRef): string =>
  JSON.stringify([computerWorkKey(execution.work), execution.runId]);
export const sameComputerWork = (left: ComputerWorkRef, right: ComputerWorkRef): boolean =>
  computerWorkKey(left) === computerWorkKey(right);
export const sameComputerExecution = (left: ComputerExecutionRef, right: ComputerExecutionRef): boolean =>
  computerExecutionKey(left) === computerExecutionKey(right);

const computerObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const computerId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Shared wire/storage decoder. Old session-shaped actors are not compatible records. */
export function parseComputerWorkRef(value: unknown): ComputerWorkRef {
  if (computerObject(value)) {
    if (value.runtime === "agent" && computerId(value.threadId) && computerId(value.branchId)) {
      return { runtime: "agent", threadId: value.threadId, branchId: value.branchId };
    }
  }
  throw new Error("computer_work_identity_invalid");
}

export function parseComputerExecutionRef(value: unknown): ComputerExecutionRef {
  if (!computerObject(value) || !computerId(value.runId)) throw new Error("computer_execution_identity_invalid");
  return { work: parseComputerWorkRef(value.work), runId: value.runId };
}

export function parseComputerActor(value: unknown): ComputerActor {
  if (!computerObject(value) || !computerId(value.label)) throw new Error("computer_actor_invalid");
  const execution = parseComputerExecutionRef(value.execution);
  const rootWork = parseComputerWorkRef(value.rootWork);
  const rootExecution = value.rootExecution === null ? null : parseComputerExecutionRef(value.rootExecution);
  if (execution.work.runtime !== rootWork.runtime || rootExecution && !sameComputerWork(rootExecution.work, rootWork)
    || sameComputerWork(execution.work, rootWork) && (!rootExecution || !sameComputerExecution(execution, rootExecution))) {
    throw new Error("computer_actor_family_invalid");
  }
  if ('registry' in value || 'roleAccess' in value || 'readOnly' in value) throw new Error('computer_actor_identity_invalid');
  return { execution, rootWork, rootExecution, label: value.label };
}

export type ComputerAccess = "observe" | "control";
export interface ComputerLease {
  id: string;
  desktopId: string;
  desktopLabel?: string;
  actor: ComputerActor;
  access: ComputerAccess;
  grantedAt: string;
  suspended?: boolean;
}
export interface ComputerAccessRequest {
  id: string;
  desktopId: string;
  desktopLabel?: string;
  actor: ComputerActor;
  access: ComputerAccess;
  reason: string;
  revision: number;
  status: "pending" | "granting" | "granted" | "denied" | "cancelled" | "indeterminate" | "released" | "unavailable";
  /** Original physical assignment identity. Its presence alone never authorizes input. */
  assignmentId?: string;
  createdAt: string;
  detail?: string;
}
export interface ComputerWorkScope {
  work: ComputerWorkRef;
  rootWork: ComputerWorkRef;
  currentExecution: ComputerExecutionRef | null;
  currentRootExecution: ComputerExecutionRef | null;
}
export interface ComputerAutomationState extends ComputerWorkScope {
  active: boolean;
  status: "enabled" | "cancelling" | "cancel-unconfirmed";
  leases: ComputerLease[];
  requests: ComputerAccessRequest[];
  /** Projection of the original controller/release facts, never an independent task table. */
  cleanups: ComputerCleanup[];
}
export interface ComputerCleanup {
  execution: ComputerExecutionRef;
  desktopId?: string;
  status: "cancelling" | "cancel-unconfirmed";
}
export interface ComputerAutomationProjection {
  state: ComputerAutomationState;
  activities: ComputerActivityEntry[];
}

export function parseComputerActivity(value: unknown): ComputerActivity {
  if (!computerObject(value) || !computerId(value.app) || !computerId(value.updatedAt)
    || !["observe", "click", "type", "key", "scroll", "drag", "set_value", "secondary"].includes(String(value.operation))
    || !["running", "idle", "error"].includes(String(value.status))
    || 'sessionId' in value) throw new Error("computer_activity_invalid");
  const execution = value.execution === undefined ? undefined : parseComputerExecutionRef(value.execution);
  return { app: value.app, updatedAt: value.updatedAt, operation: value.operation as ComputerActivity["operation"], status: value.status as ComputerActivity["status"],
    ...(execution ? { execution } : {}) };
}

/** A projection wake-up, not an assignment or a complete state replacement. */
export interface ComputerAutomationInvalidation { work: ComputerWorkRef }
export function parseComputerAutomationInvalidation(value: unknown): ComputerAutomationInvalidation {
  if (!computerObject(value) || Object.keys(value).some(key => key !== "work")) throw new Error("computer_automation_invalidation_invalid");
  return { work: parseComputerWorkRef(value.work) };
}

export function parseComputerAutomationProjection(value: unknown): ComputerAutomationProjection {
  if (!computerObject(value) || !Array.isArray(value.activities)) throw new Error("computer_automation_projection_invalid");
  return { state: parseComputerAutomationState(value.state), activities: value.activities.map((entry: unknown) => {
    if (!computerObject(entry) || !computerId(entry.desktopId)) throw new Error("computer_activity_entry_invalid");
    return { desktopId: entry.desktopId, activity: parseComputerActivity(entry.activity) };
  }) };
}

/** One shared public decoder for HTTP and event consumers. Malformed state is not idle. */
export function parseComputerAutomationState(value: unknown): ComputerAutomationState {
  if (!computerObject(value) || typeof value.active !== "boolean"
    || !["enabled", "cancelling", "cancel-unconfirmed"].includes(String(value.status))
    || !Array.isArray(value.leases) || !Array.isArray(value.requests) || !Array.isArray(value.cleanups)) {
    throw new Error("computer_automation_state_invalid");
  }
  const work = parseComputerWorkRef(value.work), rootWork = parseComputerWorkRef(value.rootWork);
  const currentExecution = value.currentExecution === null ? null : parseComputerExecutionRef(value.currentExecution);
  const currentRootExecution = value.currentRootExecution === null ? null : parseComputerExecutionRef(value.currentRootExecution);
  if (work.runtime !== rootWork.runtime || currentExecution && !sameComputerWork(currentExecution.work, work)
    || currentRootExecution && !sameComputerWork(currentRootExecution.work, rootWork)) throw new Error("computer_automation_scope_invalid");
  const assignment = (entry: unknown) => {
    if (!computerObject(entry) || !computerId(entry.id) || !computerId(entry.desktopId)
      || entry.access !== "observe" && entry.access !== "control"
      || entry.desktopLabel !== undefined && !computerId(entry.desktopLabel)) throw new Error("computer_assignment_invalid");
    return { id: entry.id, desktopId: entry.desktopId, actor: parseComputerActor(entry.actor), access: entry.access,
      ...(entry.desktopLabel === undefined ? {} : { desktopLabel: entry.desktopLabel }) };
  };
  const leases: ComputerLease[] = value.leases.map((entry: unknown) => {
    const base = assignment(entry);
    if (!computerObject(entry) || !computerId(entry.grantedAt) || entry.suspended !== undefined && typeof entry.suspended !== "boolean") throw new Error("computer_lease_invalid");
    return { ...base, access: base.access as ComputerAccess, grantedAt: entry.grantedAt, ...(entry.suspended === undefined ? {} : { suspended: entry.suspended }) };
  });
  const requests: ComputerAccessRequest[] = value.requests.map((entry: unknown) => {
    const base = assignment(entry);
    if (!computerObject(entry) || !computerId(entry.createdAt) || !computerId(entry.reason)
      || !["pending", "granting", "granted", "denied", "cancelled", "indeterminate", "released", "unavailable"].includes(String(entry.status))
      || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1
      || entry.assignmentId !== undefined && !computerId(entry.assignmentId)
      || entry.detail !== undefined && typeof entry.detail !== "string") throw new Error("computer_request_invalid");
    return { ...base, access: base.access as ComputerAccess, reason: entry.reason, createdAt: entry.createdAt,
      revision: Number(entry.revision), status: entry.status as ComputerAccessRequest["status"], ...(entry.assignmentId === undefined ? {} : { assignmentId: entry.assignmentId }), ...(entry.detail === undefined ? {} : { detail: entry.detail }) };
  });
  const cleanups: ComputerCleanup[] = value.cleanups.map((entry: unknown) => {
    if (!computerObject(entry) || entry.status !== "cancelling" && entry.status !== "cancel-unconfirmed"
      || entry.desktopId !== undefined && !computerId(entry.desktopId)) throw new Error("computer_cleanup_invalid");
    return { execution: parseComputerExecutionRef(entry.execution), status: entry.status,
      ...(entry.desktopId === undefined ? {} : { desktopId: entry.desktopId }) };
  });
  return { work, rootWork, currentExecution, currentRootExecution, active: value.active,
    status: value.status as ComputerAutomationState["status"], leases, requests, cleanups };
}
export interface ComputerAccessParams {
  desktopId?: string;
  requestId?: string;
  access?: ComputerAccess;
  reason?: string;
  /** Wait for the request's decision using events; omit to continue other work. */
  wait?: boolean;
}
/** Transient visual feedback from an actual driver operation. Never includes typed text. */
export interface ComputerGesture {
  id: string;
  desktopId: string;
  execution?: ComputerExecutionRef;
  actorLabel?: string;
  kind: ComputerAction["kind"] | "move";
  mechanism?: "pointer" | "keyboard" | "semantic";
  phase: "target" | "dispatched" | "completed" | "cancelled" | "failed";
  at: string;
  /** Absolute physical desktop coordinates, after native element relocation. */
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  target?: ComputerFrame;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
}

/** A versioned reference to a file in a managed desktop user's home. */
export interface ComputerArtifact {
  id: string;
  desktopId: string;
  sourceHostId: string;
  scopeId: string;
  threadId: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
  modifiedAt: string;
  registeredAt: string;
}

export interface ComputerDesktopPrepareParams {
  /** Omit to prepare this Host. A saved connection prepares its own Host. */
  connectionId?: string;
  width?: number;
  height?: number;
  automationEpoch?: string;
}

/** Original desktop lifecycle result; helper completion is distinct from desktop readiness. */
export interface ComputerDesktopChangeResult {
  desktop: ComputerDesktop;
  inputWriterStopped: boolean;
  receipt: ComputerActionReceipt;
  cancelled?: boolean;
  /** Original assignment cleanup is distinct from a confirmed backend transition. */
  assignmentReleases?: Array<{ assignmentId: string; confirmed: boolean; detail?: string }>;
  /** Target-owned exact assignments ended by this stop, restricted to the calling peer origin. */
  endedAssignments?: { origin: string; assignmentIds: string[] };
}

/** What the resident platform driver can actually do right now. */
export interface ComputerCapabilities {
  platform: ComputerPlatform;
  /** Driver implementation identity, e.g. `windows-uia`, `linux-atspi`. */
  driver: string;
  driverVersion?: string;
  /** Application protocols implemented by this driver, independent of whether an app is running. */
  applicationTools?: { browser: boolean; office: boolean };
  /** Accessibility/UIA tree reading. */
  observeTree: boolean;
  /** Window/desktop image capture. */
  screenshot: boolean;
  /** Semantic pattern actions (Invoke/Select/SetValue/...). */
  elementAction: boolean;
  /** Real global pointer/keyboard injection (SendInput/XTest/...). */
  coordinateInput: boolean;
  /** Text entry (background messages or synthesized keys). */
  textInput: boolean;
  /** Pointer drag support. */
  drag: boolean;
  /** Screen geometry for interpreting coordinates (physical pixels). */
  displays?: Array<{ x: number; y: number; width: number; height: number; primary?: boolean }>;
  dpiAware?: boolean;
  /** Display/session kind, e.g. `windows-console`, `x11`, `wayland`, `aqua`. */
  sessionType?: string;
  /** The driver enumerates all top-level windows and can target one by handle/title. */
  multiWindow?: boolean;
  /** A cancel reaches an in-flight native operation at its internal checkpoints. */
  interruptibleInput?: boolean;
  /** Occluded/offscreen window content capture (not just the screen grid). */
  occludedCapture?: boolean;
  /** Independent macOS permission checks; probing never requests authorization. */
  permissions?: { accessibility?: "granted" | "not-granted"; screenCapture?: "granted" | "not-granted" };
  /** Lifecycle and negotiated input transport of the original portal session. */
  authorization?: "idle" | "starting" | "active" | "closed";
  inputTransport?: "dbus" | "eis" | null;
  availableDevices?: number;
  status: "ready" | "unavailable" | "unprobed";
  /** Honest reason when a capability is missing or the driver failed. */
  detail?: string;
}

export interface ComputerFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One accessibility-tree node from an observation, addressed by `index`. */
export interface ComputerElement {
  index: number;
  /** Driver-private child-index path captured with this observation (macOS AX). */
  path?: number[];
  runtimeId?: number[];
  automationId?: string;
  name?: string;
  controlType?: string;
  localizedControlType?: string;
  className?: string;
  value?: string;
  nativeWindowHandle?: number;
  /** Element bounds, relative to the window when `windowBounds` is present. */
  frame?: ComputerFrame;
  /** Semantic actions the element advertises (Invoke, Toggle, ...). */
  actions?: string[];
}

/** One top-level window a process owns (BC4.B multi-window identity). */
export interface ComputerWindowDescriptor {
  /** Window selector (HWND on Windows, CGWindowNumber on macOS, zero-based AT-SPI child index on Linux). */
  handle: number;
  title?: string;
  bounds?: ComputerFrame;
  visible?: boolean;
  minimized?: boolean;
  /** True for the process's designated main window. */
  main?: boolean;
}

export interface ComputerAppDescriptor {
  name: string;
  pid: number;
  windowTitle?: string;
  /** Every top-level window the process owns, when the driver can enumerate them. */
  windows?: ComputerWindowDescriptor[];
}

/**
 * A point-in-time read of one app window on one desktop. Element indexes are
 * only valid against the observation that produced them.
 */
export interface ComputerObservation {
  id: string;
  desktopId: string;
  machineId: string;
  app: ComputerAppDescriptor;
  windowTitle?: string;
  /** The window this observation bound to, when the driver resolved one. */
  windowHandle?: number;
  /** Opaque native capture generation; the Host returns it only to the original driver. */
  nativeTarget?: string;
  /** Window DPI scale (physical px per logical px) at capture time. */
  dpiScale?: number;
  /** All top-level windows the observed process owned at capture time. */
  windows?: ComputerWindowDescriptor[];
  windowBounds?: ComputerFrame;
  treeLines: string[];
  /** Display page in this fixed observation; element indexes are never renumbered. */
  treePage?: { offset: number; total: number; nextOffset?: number };
  elements: ComputerElement[];
  focusedSummary?: string;
  selectedText?: string;
  screenshot?: { mime: "image/png"; base64: string; width?: number; height?: number; source?: "window" | "screen" };
  capturedAt: string;
}

/** Structured action against one observed app on a desktop. */
export interface ComputerAction {
  kind: "click" | "type" | "key" | "scroll" | "drag" | "set_value" | "secondary";
  /** App selector: process name, window title substring, or pid. */
  app: string;
  /** Window selector within the app: native handle number or window title. */
  window?: number | string;
  /**
   * Elements require the newest tree for this app/window. Coordinates require
   * the retained latest screenshot; a tree-only read does not discard it.
   * Native dispatch validates screenshot geometry before sending coordinates.
   */
  observationId?: string;
  /** Element index from the referenced observation. */
  elementIndex?: number;
  /** Pixels of the exact screenshot in observationId, before any UI display scaling. */
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  clickCount?: number;
  mouseButton?: "left" | "right" | "middle";
  /** Auto uses real pointer/keyboard input. Explicit accessibility/app_post select their native mechanisms. */
  clickMethod?: "auto" | "accessibility" | "app_post" | "global";
  direction?: "up" | "down" | "left" | "right";
  pages?: number;
  text?: string;
  /** Key chord, e.g. `enter`, `ctrl+s`, `f5`. */
  key?: string;
  value?: string;
  /** Secondary action name from the element's `actions` list. */
  action?: string;
  /** Capture after input only when requested. Default none supports deterministic action batches. */
  returnState?: "none" | "tree" | "screenshot";
}

export interface ComputerActionResult {
  /** Original executor evidence for this call, independent of application effect and assignment lifetime. */
  inputWriterStopped: boolean;
  /** The driver accepted and dispatched the input — NOT a claim of app effect. */
  accepted: boolean;
  /**
   * `unknown`: transport/driver failure after submission cannot prove that
   * input did not occur. `partial`: a mid-operation cancel aborted the action
   * after some of its input already reached the desktop.
   */
  outcome?: "unknown" | "partial";
  /** True when a cancel superseded this action before/while it ran. */
  cancelled?: boolean;
  /** Driver-reported detail (pattern used, input path taken). */
  detail?: string;
  /** Post-action observation when the driver returned one. */
  observation?: ComputerObservation;
  /** Execution evidence, independent of application task completion. */
  receipt?: ComputerActionReceipt;
}

export interface ComputerActionReceipt {
  effect: "none" | "dispatched" | "partial" | "verified" | "unknown";
  reason?: { code: "target-changed" | "focus-changed" | "target-unavailable" | "unsupported" | "input-rejected" | "cancelled" | "control-changed" | "connection-lost" | "session-closed" | "verification-failed" | "driver-error"; message: string };
  recovery?: "observe" | "reconnect" | "wait-for-control";
  /** Counts accepted input events, not characters visible in an app. */
  dispatchedEvents?: number;
}

export interface ComputerListParams {
  machineId?: string;
}

export interface ComputerListResult {
  machines: ComputerMachine[];
  desktops: ComputerDesktop[];
  defaultDesktopId?: string | null;
}

export interface ComputerObserveParams {
  /** Absent = the caller's default desktop target. */
  desktopId?: string;
  app: string;
  /** Window selector within the app: native handle number or window title. */
  window?: number | string;
  includeScreenshot?: boolean;
  /** Read another page from the same retained observation without scanning again. */
  observationId?: string;
  offset?: number;
  /** Accessibility-tree lines per page; defaults to 100, max returns all remaining lines. */
  textLimit?: number | "max";
  maxTreeNodes?: number;
  maxTreeDepth?: number;
}

export interface ComputerObserveResult {
  observation: ComputerObservation;
}

export interface ComputerAppsParams {
  /** Absent = the caller's default desktop target. */
  desktopId?: string;
}

export interface ComputerAppsResult {
  apps: ComputerAppDescriptor[];
}

export interface ComputerActParams {
  desktopId?: string;
  action: ComputerAction;
  /** Frozen by a script before execution; control changes invalidate the batch. */
  automationEpoch?: string;
}

export interface ComputerActResult {
  result: ComputerActionResult;
}

export interface ComputerCancelParams {
  desktopId?: string;
}

export interface ComputerCancelResult {
  /** Queued actions dropped; in-flight ops still settle but report cancelled. */
  cancelled: number;
  /** False when a lost driver cannot confirm cleanup of its in-flight input. */
  released?: boolean;
}

export interface ComputerReleaseParams {
  desktopId?: string;
}

export interface ComputerReleaseResult {
  released: boolean;
}

// ---------------------------------------------------------------------------
// EE — cross-environment open / file transfer (design §5.6)
// ---------------------------------------------------------------------------

/**
 * Open a URL, file or application on a desktop's own machine. The target is
 * resolved where the desktop runs: `localhost` and `file:` paths mean the
 * target machine's own filesystem and loopback — never the caller's.
 */
export interface ComputerOpenParams {
  desktopId?: string;
  automationEpoch?: string;
  /** Any well-formed URL the target's handlers accept (http(s), file:, app schemes). */
  url?: string;
  /** Absolute path on the target machine, opened with its default handler. */
  path?: string;
  /** Application/binary resolved on the target machine. */
  command?: string;
  args?: string[];
}

export interface ComputerOpenResult {
  accepted: boolean;
  /** Process id on the target machine when the launcher reports one. */
  pid?: number;
  detail?: string;
  /** The dispatch was cancelled after queue admission — the open may still have launched. */
  cancelled?: boolean;
  /** A response lost in transit — the open may still have happened. */
  outcome?: "unknown";
}

/**
 * Write one file into the managed desktop user's home, returning its stored
 * revision. A one-shot copy — it does not create any continuous sync.
 */
export interface ComputerFileWriteParams {
  desktopId?: string;
  relativePath: string;
  contentBase64: string;
}

export interface ComputerFileWriteResult {
  version: { sha256: string; byteLength: number; modifiedAt: string };
}

/** EE §6.2: component recipe install. At least one of groups/packages required. */
export interface ComputerInstallSoftwareParams {
  desktopId?: string;
  groups?: string[];
  packages?: string[];
}

export interface ComputerInstallSoftwareResult {
  results: ComputerSoftwareResult[];
}

// ---------------------------------------------------------------------------
// EE §7.2 — browser bridge: CDP attach to the SAME visible browser session
// ---------------------------------------------------------------------------

export type ComputerBrowserOp = "status" | "launch" | "tabs" | "snapshot" | "act";

export interface ComputerBrowserAct {
  kind: "navigate" | "evaluate" | "click" | "type" | "screenshot";
  url?: string;
  expression?: string;
  x?: number;
  y?: number;
  text?: string;
}

export interface ComputerBrowserParams {
  desktopId?: string;
  op: ComputerBrowserOp;
  automationEpoch?: string;
  /** Tab to attach for snapshot/act; optional only when exactly one page is open. */
  tabId?: string;
  /** launch: explicit browser binary on the target machine. */
  binary?: string;
  /** launch: profile directory on the target machine (persistent session). */
  profile?: string;
  /** Explicit CDP port on the target machine; default profile uses DevToolsActivePort. */
  port?: number;
  act?: ComputerBrowserAct;
  /** snapshot: accessibility-tree line cap (default 600). */
  limit?: number;
}

export interface ComputerBrowserResult {
  ok: boolean;
  /** Transport-loss semantics: the op may have reached the target. */
  outcome?: "unknown" | "partial";
  cancelled?: boolean;
  automationEpoch?: string;
  status?: { running: boolean; browser?: string; wsUrl?: string; detail?: string };
  alreadyRunning?: boolean;
  tabs?: Array<{ id: string; title?: string; url?: string }>;
  tab?: string;
  lines?: string[];
  /** AX tree had additional visible nodes beyond the requested limit. */
  truncated?: boolean;
  frameId?: string;
  result?: unknown;
  type?: string;
  exception?: boolean;
  image?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// EE5b — LibreOffice bridge (UNO, same live instance)
// ---------------------------------------------------------------------------

export type ComputerOfficeOp = "status" | "launch" | "docs" | "open" | "act";

export interface ComputerOfficeAct {
  kind: "read" | "write" | "insert" | "save" | "export";
  /** Open document id, unique title or URL; omitted = current active document. */
  doc?: string;
  /** read/write: sheet name (default first sheet). */
  sheet?: string;
  /** read/write: cell range, e.g. "A1:B4". */
  range?: string;
  /** write: 2-D values matching the range exactly. */
  values?: unknown[][];
  /** insert: text appended at the end of a Writer document. */
  text?: string;
  /** save-as/export destination on the target machine. */
  path?: string;
  url?: string;
  /** export: native filter name; omitted = this document kind's PDF filter. */
  filter?: string;
}

export interface ComputerOfficeDoc {
  id?: string;
  title: string;
  url?: string | null;
  kind?: string;
  modified?: boolean;
}

export interface ComputerOfficeParams {
  desktopId?: string;
  op: ComputerOfficeOp;
  automationEpoch?: string;
  /** open: file path or URL to load into the live instance. */
  path?: string;
  url?: string;
  act?: ComputerOfficeAct;
}

export interface ComputerOfficeResult {
  ok: boolean;
  /** Transport-loss semantics: the op may have reached the target. */
  outcome?: "unknown" | "partial";
  cancelled?: boolean;
  automationEpoch?: string;
  status?: { running: boolean; detail?: string };
  alreadyRunning?: boolean;
  docs?: ComputerOfficeDoc[];
  doc?: ComputerOfficeDoc;
  sheet?: string;
  range?: string;
  values?: unknown[][];
  text?: string;
  target?: string;
  modified?: boolean;
  /** Readback captured around this write in the same live document. */
  changes?: { sheet: string; range: string; before: unknown[][]; after: unknown[][] };
  changesUnavailable?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// EE6 — operation evidence journal (§10 diagnostics)
// ---------------------------------------------------------------------------

/**
 * One durable step on a desktop: who asked, what was attempted on which
 * target, and what came back. Content discipline per §10 — identifiers and
 * status only; never typed text, expressions, file bytes, or credentials.
 */
export interface ComputerEvidenceEntry {
  /** Per-desktop sequence; `since` resumes after a previously seen seq. */
  seq: number;
  at: string;
  /** Original admitted work and Run; labels and caller-provided session IDs never replace it. */
  execution?: ComputerExecutionRef;
  lane: "observe" | "action";
  /** Service funnel: observe | act | open | fileWrite | browser | office | control. */
  tool: string;
  /** Sub-operation: action kind, browser op, control transition… */
  op?: string;
  /** Hash of the selector; raw titles, URLs and paths may contain private content. */
  target?: string;
  outcome: "ok" | "error" | "cancelled" | "unknown" | "rejected";
  error?: string;
  observationId?: string;
}

export interface ComputerEvidenceParams {
  desktopId?: string;
  /** Restrict to one original admitted execution. */
  execution?: ComputerExecutionRef;
  /** Return only entries with seq > since. */
  since?: number;
  /** Page size (default 50); with since, read oldest unseen steps first. */
  limit?: number;
}

export interface ComputerEvidenceResult {
  desktopId: string;
  entries: ComputerEvidenceEntry[];
  nextSince: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// BC5 — shared desktop view + control ownership
// ---------------------------------------------------------------------------

/**
 * Who may emit input on a desktop. `agent` = the serialized automation lane;
 * `human` = a viewer that took over through `computer.takeover`.
 */
export type ComputerControlOwner = "agent" | "human";

/**
 * Server-side control record for one desktop (BC5). Ownership is independent
 * of viewer connections: when the holder's view channel drops, the record
 * stays `human` with `reachable=false` — a recoverable pending owner, not an
 * automatic handback — until the same viewer reconnects or a takeover
 * transfers control again.
 */
export interface ComputerControlState {
  /** Current assignment, retained while the user temporarily holds input. */
  operator?: ComputerActor;
  workStatus?: "active" | "cancelling" | "cancel-unconfirmed";
  /** Model-facing execution identity, absent on human viewer receipts. */
  executionId?: string;
  desktopId: string;
  owner: ComputerControlOwner;
  /** Viewer id holding human control; absent while the agent owns it. */
  holderId?: string;
  /** False when the holder's view channel is lost — control stays reserved. */
  reachable: boolean;
  /** ISO time of the last ownership transition. */
  since: string;
  /** Opaque Host lifetime + input generation. Never reuse after a handoff. */
  automationEpoch: string;
  /** Input is fenced while an ownership transfer drains and releases it. */
  transitioning?: boolean;
  activity?: ComputerActivity;
}

/**
 * One piece of human input routed through the same desktop lane (BC5.C).
 * Coordinates are absolute desktop pixels; ownership is validated by the
 * Host — a viewer cannot write while `owner` is `agent`.
 */
export interface ComputerHumanInput {
  kind: "click" | "down" | "up" | "move" | "scroll" | "key" | "text";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  count?: number;
  direction?: "up" | "down" | "left" | "right";
  pages?: number;
  key?: string;
  text?: string;
}

/** One captured desktop frame for view subscribers (BC5.B). */
export interface ComputerDesktopFrame {
  mime: "image/png" | "image/jpeg";
  base64: string;
  /** Physical pixel bounds the frame covers. */
  bounds: ComputerFrame;
  capturedAt: string;
}

export interface ComputerControlParams {
  desktopId?: string;
}

export interface ComputerControlResult {
  control: ComputerControlState;
}

export interface ComputerDesktopStopParams { desktopId: string; automationEpoch: string }
export interface ComputerDesktopStopResult { control: ComputerControlState; released: boolean }

export interface ComputerTakeoverParams {
  desktopId?: string;
  /** Viewer identity that will hold human control. */
  holderId?: string;
}

export interface ComputerTakeoverResult {
  control: ComputerControlState;
  /** Queued automated actions dropped by the takeover. */
  cancelled: number;
  /** False when the driver could not confirm held input was released. */
  released: boolean;
}

export interface ComputerHandbackParams {
  desktopId?: string;
  /** Must match the current holder when one was recorded. */
  holderId?: string;
}

export interface ComputerHandbackResult {
  control: ComputerControlState;
  /** Fresh observation state is required — stale indexes were invalidated. */
  requiresObservation: true;
}

export interface ComputerInputParams {
  desktopId?: string;
  holderId?: string;
  controlEpoch?: string;
  input: ComputerHumanInput;
}

export interface ComputerInputResult {
  accepted: boolean;
  detail?: string;
}

export interface ComputerCaptureFrameParams {
  desktopId?: string;
  /** JPEG quality hint for drivers that encode lossy frames. */
  quality?: number;
}

export interface ComputerCaptureFrameResult {
  frame: ComputerDesktopFrame;
}

// ---------------------------------------------------------------------------
// BC7 — virtual machine lifecycle (libvirt backend)
// ---------------------------------------------------------------------------

/** Configured virtualization provider entry (stored in Host settings). */
export interface ComputerVmProviderConfig {
  id: string;
  label?: string;
  kind: "libvirt";
  /**
   * libvirt connection URI — `qemu:///system` local, `qemu+ssh://…` remote.
   * Credentials never live here; ssh/agent auth belongs to the environment.
   */
  uri: string;
  /** Storage pool new volumes are allocated in (default `default`). */
  storagePool?: string;
  /** Virtual network the guest NIC attaches to (default `default`). */
  network?: string;
}

/** One recorded step of a VM create/cleanup journal. */
export interface ComputerVmStep {
  /** Step identity, e.g. `resolve`, `volume`, `define`, `cleanup`. */
  step: string;
  status: "done" | "failed";
  detail?: string;
  at: string;
}

/** Provider-side identity of a virtual machine (recorded on the machine). */
export interface ComputerVmBinding {
  /** Provider entry id this Host used — matches `ComputerVmProviderConfig.id`. */
  providerId: string;
  kind: "libvirt";
  uri: string;
  /** Frozen pool identity; editing provider defaults cannot redirect deletion. */
  storagePool?: string;
  /** Actual domain UUID — the identity all lifecycle calls key on. */
  domainUuid: string;
  /** Storage volumes this Host allocated for the domain. */
  volumePaths: string[];
  /** Create/cleanup journal — replay evidence of what actually completed. */
  steps: ComputerVmStep[];
  guest?: {
    recipe: "debian13-xvnc";
    image?: { ref: string; version: string; sha512: string };
    runtimeSha256?: string;
    imageUploaded?: boolean;
    state: "preparing" | "ready" | "failed" | "stopped";
    detail?: string;
    connectionId?: string;
    hostId?: string;
    apiUrl?: string;
  };
}

/** Live provider-side domain state. */
export type ComputerVmState =
  | "running"
  | "paused"
  | "shutoff"
  | "crashed"
  | "unknown";

export interface ComputerVmDescriptor {
  /** Local machine record id (`computer.machine:<id>`). */
  machineId: string;
  name: string;
  binding: ComputerVmBinding;
  /** Last known domain state; `unknown` when the provider cannot be read. */
  state: ComputerVmState;
  statusDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComputerVmCreateParams {
  /** Which configured provider to create on. */
  providerId: string;
  /** Guest/domain name; also the volume name prefix. */
  name: string;
  memoryMiB?: number;
  vcpus?: number;
  diskGiB?: number;
  /** Absolute path of a backing image/template the new volume clones. */
  baseImage?: string;
  /** Prepare a Debian guest Host and persistent graphical desktop automatically. */
  managed?: boolean;
}

export interface ComputerVmCreateResult {
  machine: ComputerMachine;
  /** False when create reconciled the domain from this durable creation. */
  created: boolean;
}

export interface ComputerVmActionParams {
  machineId: string;
  action: "start" | "shutdown" | "reboot";
}

export interface ComputerVmDeleteParams {
  machineId: string;
  /** True removes the recorded data volumes; false keeps persistent disks. */
  deleteDisks?: boolean;
}

export interface ComputerVmListResult {
  vms: ComputerVmDescriptor[];
}
