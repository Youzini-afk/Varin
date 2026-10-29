/**
 * Framework-neutral desktop IPC contract.
 *
 * This module is the single type owner for every `desktop_*` command
 * exposed by the Electron preload/main bridge. Electron main, preload,
 * and the UI package all import from here so the compiler can prove
 * command/args/result correlation across all three consumers.
 *
 * It must not import React, Zustand, Electron, Node `fs`/`process`,
 * or any Host-private implementation.
 */

// ---------------------------------------------------------------------------
// Shared DTO types (previously duplicated in UI)
// ---------------------------------------------------------------------------

export type DesktopSshRemoteMode = 'managed' | 'external';
export type DesktopSshInstallMethod = 'npm' | 'bun' | 'download_release' | 'upload_bundle';
export type DesktopSshSecretStore = 'never' | 'settings';

export type DesktopSshStoredSecret = {
  enabled: boolean;
  value?: string;
  store: DesktopSshSecretStore;
};

export type DesktopSshPortForwardType = 'local' | 'remote' | 'dynamic';

export type DesktopSshPortForward = {
  id: string;
  enabled: boolean;
  type: DesktopSshPortForwardType;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
};

export type DesktopSshInstance = {
  id: string;
  nickname?: string;
  sshCommand: string;
  sshParsed?: {
    destination: string;
    args: string[];
  };
  connectionTimeoutSec: number;
  remoteVarin: {
    mode: DesktopSshRemoteMode;
    keepRunning: boolean;
    preferredPort?: number;
    installMethod: DesktopSshInstallMethod;
    uploadBundleOverSsh: boolean;
  };
  localForward: {
    preferredLocalPort?: number;
    bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0';
  };
  auth: {
    sshPassword?: DesktopSshStoredSecret;
    varinPassword?: DesktopSshStoredSecret;
  };
  portForwards: DesktopSshPortForward[];
};

export type DesktopSshInstancesConfig = {
  instances: DesktopSshInstance[];
};

export type DesktopSshPhase =
  | 'idle'
  | 'config_resolved'
  | 'auth_check'
  | 'master_connecting'
  | 'remote_probe'
  | 'installing'
  | 'updating'
  | 'server_detecting'
  | 'server_starting'
  | 'forwarding'
  | 'ready'
  | 'degraded'
  | 'error';

export type DesktopSshInstanceStatus = {
  id: string;
  phase: DesktopSshPhase;
  detail?: string | null;
  localUrl?: string | null;
  localPort?: number | null;
  remotePort?: number | null;
  startedByUs: boolean;
  retryAttempt: number;
  requiresUserAction: boolean;
  updatedAtMs: number;
};

export type DesktopSshImportCandidate = {
  host: string;
  pattern: boolean;
  source: string;
  sshCommand: string;
};

// ---------------------------------------------------------------------------
// Hosts DTO (previously in UI desktopHosts.ts)
// ---------------------------------------------------------------------------

export type DesktopHostRelay = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

export type DesktopHost = {
  id: string;
  label: string;
  /** Legacy/UI URL. During migration this may equal apiUrl. For relay hosts this is a display-only `relay://<serverId>` pseudo-URL. */
  url: string;
  /** API endpoint used by packaged Electron UI for this instance. Absent for relay-only hosts. */
  apiUrl?: string;
  /** Remote client bearer token for packaged-client API access. */
  clientToken?: string;
  /** Extra headers for desktop runtime API requests. */
  requestHeaders?: Record<string, string>;
  /** When set, this host is reached over the private relay tunnel. */
  relay?: DesktopHostRelay;
};

export type DesktopHostsConfig = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted: boolean;
  localOrigin?: string | null;
};

export type DesktopHostsConfigInput = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted?: boolean;
  localClientToken?: string | null;
};

// ---------------------------------------------------------------------------
// Update DTO
// ---------------------------------------------------------------------------

export type DesktopUpdateCheckResult = {
  available: boolean;
  currentVersion: string;
  version: string | null;
  body: string | null;
  date: string | null;
};

// ---------------------------------------------------------------------------
// Capture DTO
// ---------------------------------------------------------------------------

export type DesktopCaptureResult = {
  mime: string;
  base64: string;
  width: number;
  height: number;
};

// ---------------------------------------------------------------------------
// File read DTO
// ---------------------------------------------------------------------------

export type DesktopReadFileResult = {
  mime: string;
  base64: string;
  size: number;
};

// ---------------------------------------------------------------------------
// Window state DTO
// ---------------------------------------------------------------------------

export type DesktopLaunchAtLoginStatus = {
  supported: boolean;
  enabled: boolean;
};

export type DesktopMinimizeToTrayStatus = {
  supported: boolean;
  enabled: boolean;
};

export type DesktopKeepAwakeStatus = {
  supported: boolean;
  enabled: boolean;
  active: boolean;
};

export type DesktopLocalHostMode = {
  /** Saved preference for this desktop, independent of the selected Agent. */
  enabled: boolean;
  /** Next-launch policy after environment and recovery-shell constraints. */
  effectiveEnabled: boolean;
  environmentDisabled: boolean;
  environmentRemoteTarget: boolean;
  canDisable: boolean;
  runtime: 'embedded' | 'external' | 'stopped';
  requiresRestart: boolean;
};

export type DesktopLocalHostModeInput = { enabled: boolean; selectLocalOnRestart?: boolean };

export type DesktopVibrancyResult = {
  enabled: boolean;
  requiresRestart: boolean;
};

export type DesktopWindowPinnedState = {
  pinned: boolean;
};

export type DesktopWindowMaximizedState = {
  maximized: boolean;
};

export type DesktopFocusResult = {
  focused: boolean;
};

// ---------------------------------------------------------------------------
// Host probe / auth DTO
// ---------------------------------------------------------------------------

export type DesktopHostProbeResult = {
  status: 'auth' | 'incompatible' | 'ok' | 'unreachable' | 'update-recommended' | 'wrong-service';
  latencyMs: number;
};

export type DesktopRemotePasswordLoginResult = {
  ok: boolean;
  token?: string;
  status?: number;
};

// ---------------------------------------------------------------------------
// Installed apps DTO
// ---------------------------------------------------------------------------

export type DesktopInstalledApp = {
  iconDataUrl: string | null;
  name: string;
};

export type DesktopInstalledAppsResult = {
  apps: DesktopInstalledApp[];
  hasCache: boolean;
  isCacheStale: boolean;
  supported?: boolean;
};

export type DesktopAppIconEntry = {
  app: string;
  data_url?: string | null;
  dataUrl?: string | null;
};

// ---------------------------------------------------------------------------
// Dialog DTO (varin:dialog:open)
// ---------------------------------------------------------------------------

export type DesktopDialogOptions = {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  directory?: boolean;
  multiple?: boolean;
  returnGrant?: boolean;
};

export type DesktopDialogFileGrant = {
  path: string;
  outsideFileGrant: string;
  expiresAt: number;
};

export type DesktopDialogPath = { path: string };
export type DesktopDialogResult =
  | string
  | string[]
  | DesktopDialogPath
  | DesktopDialogFileGrant
  | Array<DesktopDialogPath | DesktopDialogFileGrant>
  | null;

// ---------------------------------------------------------------------------
// Preload bootstrap payload (local/remote discriminated union)
// ---------------------------------------------------------------------------

export interface PreloadBootstrapShared {
  localPage: boolean;
  localOrigin: string;
  apiBaseUrl: string;
  macosMajor: number;
  macVibrancy: boolean;
  trayEnabled: boolean;
}

export interface PreloadBootstrapRemotePayload extends PreloadBootstrapShared {
  localPage: false;
}

export interface PreloadBootstrapLocalPayload extends PreloadBootstrapShared {
  localPage: true;
  clientToken: string;
  requestHeaders: Record<string, unknown>;
  homeDirectory: string;
  relayHostId: string;
}

export type PreloadBootstrapPayload = PreloadBootstrapRemotePayload | PreloadBootstrapLocalPayload;

// ---------------------------------------------------------------------------
// Desktop event map (events delivered via varin:emit / listen)
// ---------------------------------------------------------------------------

export type DesktopUpdateProgressEvent =
  | { event: 'Started'; data: { contentLength: number | null } }
  | { event: 'Progress'; data: { chunkLength: number; downloaded: number; total: number } }
  | { event: 'Finished'; data: Record<string, never> };

export type DesktopTrayAction = { type: string } & Record<string, unknown>;

export type VarinDesktopEventMap = {
  'varin:update-progress': DesktopUpdateProgressEvent;
  'varin:open-thread': { directory: string | null; threadId: string; branchId: string; apiBaseUrl?: string | undefined; relayHostId?: string | undefined };
  'varin:open-draft-thread': { directory: string; projectId: string };
  'varin:window-resized': void;
  'varin:window-maximized-changed': { maximized: boolean };
  'varin:installed-apps-updated': DesktopInstalledApp[];
  'varin:system-resume': { timestamp: number };
  'varin:tray-action': DesktopTrayAction;
  'varin:vibrancy-ready': { ready: boolean };
  'varin:ssh-instance-status': DesktopSshInstanceStatus;
  'varin:browser': import('@varin/protocol').BrowserEvent;
  'varin:menu-action': string;
  'varin:check-for-updates': void;
};

export type VarinDesktopEvent = keyof VarinDesktopEventMap;
export type VarinDesktopEventArguments<E extends VarinDesktopEvent> =
  VarinDesktopEventMap[E] extends void ? [] : [detail: VarinDesktopEventMap[E]];

// ---------------------------------------------------------------------------
// Web render DTO (offscreen Chromium for harness webfetch)
// ---------------------------------------------------------------------------

export type DesktopWebRenderResult = {
  html: string;
  finalUrl: string;
  timedOut: boolean;
};

// ---------------------------------------------------------------------------
// Command map — desktop_* commands with typed args and results
// ---------------------------------------------------------------------------

/** Decorative companion data only: no content, execution or approval capability. */
export interface DesktopCompanionScene {
  revision: number;
  scope: string;
  kind: 'reading' | 'editing' | 'searching' | 'dispatch' | 'question' | 'permission' | 'organize' | 'verify' | 'status' | null;
  phase: 'active' | 'resolve' | 'withdraw';
  outcome: 'allowed' | 'denied' | 'answered' | null;
  count: number | null;
  suppressed: boolean;
  reducedMotion: boolean;
  menuOpen: boolean;
  cue: 'transition' | 'engaged' | 'present' | 'read' | 'page-turn' | 'type' | 'review' | 'revise' | 'scan-left' | 'scan-right' | 'select' | 'split' | 'dispatch-left' | 'dispatch-right' | 'watch' | 'ask' | 'offer' | 'attend' | 'acknowledge' | 'organize-align' | 'organize-select' | 'verify-scan' | 'verify-compare';
  cueInstance?: number;
  status?: 'queued' | 'external' | 'retry' | 'failure' | 'cancelling' | 'disconnected' | 'synchronizing' | 'uncertain';
}

export interface VarinDesktopCommandMap {
  // --- window/chrome ---
  desktop_start_window_drag: { args: void; result: null };
  desktop_get_companion: { args: void; result: { enabled: boolean; visible: boolean } };
  desktop_set_companion: { args: { enabled: boolean }; result: { enabled: boolean; visible: boolean } };
  desktop_companion_scene: { args: { descriptor: DesktopCompanionScene; viewport: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } }; result: null };
  desktop_companion_stool: { args: { phase: 'clear' } | { phase: 'lift' | 'landing'; viewport: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } }; result: null };
  desktop_companion_drag: { args: { phase: 'start'; anchor: { x: number; y: number } } | { phase: 'move' | 'end' }; result: null };
  desktop_companion_passthrough: { args: { enabled: boolean }; result: { supported: boolean; enabled: boolean } };
  desktop_set_window_title: { args: { title: string }; result: null };
  desktop_set_window_theme: { args: { themeMode?: string; themeVariant?: string }; result: null };
  desktop_is_window_fullscreen: { args: void; result: boolean };
  desktop_minimize_current_window: { args: void; result: null };
  desktop_toggle_current_window_maximized: { args: void; result: DesktopWindowMaximizedState };
  desktop_close_current_window: { args: void; result: null };
  desktop_get_current_window_state: { args: void; result: DesktopWindowMaximizedState };
  desktop_get_window_pinned: { args: void; result: DesktopWindowPinnedState };
  desktop_set_window_pinned: { args: { pinned: boolean }; result: DesktopWindowPinnedState };
  desktop_show_app_menu: { args: { x?: number; y?: number }; result: null };
  desktop_focus_main_window: {
    args: { threadId?: string; branchId?: string; directory?: string; mode?: string; projectId?: string };
    result: DesktopFocusResult;
  };
  desktop_new_window: { args: void; result: null };
  desktop_new_window_at_url: {
    args: { url: string; clientToken?: string; requestHeaders?: Record<string, unknown> };
    result: null;
  };
  desktop_new_window_for_host: { args: { hostId: string }; result: null };
  desktop_open_draft_mini_chat_window: {
    args: { directory?: string; projectId?: string };
    result: null;
  };
  desktop_open_thread_mini_chat_window: {
    args: { threadId: string; branchId: string; directory?: string };
    result: null;
  };

  // --- system ---
  desktop_get_launch_at_login: { args: void; result: DesktopLaunchAtLoginStatus };
  desktop_set_launch_at_login: { args: { enabled: boolean }; result: DesktopLaunchAtLoginStatus };
  desktop_get_minimize_to_tray: { args: void; result: DesktopMinimizeToTrayStatus };
  desktop_set_minimize_to_tray: { args: { enabled: boolean }; result: DesktopMinimizeToTrayStatus };
  desktop_get_keep_awake: { args: void; result: DesktopKeepAwakeStatus };
  desktop_set_keep_awake: { args: { enabled: boolean }; result: DesktopKeepAwakeStatus };
  desktop_get_app_version: { args: void; result: string };
  desktop_get_lan_address: { args: void; result: string | null };
  desktop_set_vibrancy: { args: { enabled: boolean }; result: DesktopVibrancyResult };
  desktop_clear_cache: { args: void; result: null };
  desktop_get_local_host_mode: { args: void; result: DesktopLocalHostMode };
  desktop_set_local_host_mode: { args: DesktopLocalHostModeInput; result: DesktopLocalHostMode };
  desktop_restart_without_update: { args: void; result: null };
  desktop_restart: { args: void; result: null };

  // --- capture/file/shell ---
  desktop_browser_capture_page: { args: { webContentsId: number }; result: DesktopCaptureResult };
  desktop_browser_present: { args: { pageId: string; viewId: string; url: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }; result: import('@varin/protocol').BrowserPage };
  desktop_browser_layout: { args: { pageId: string; viewId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }; result: null };
  desktop_browser_detach: { args: { pageId: string; viewId: string }; result: null };
  desktop_browser_action: { args: { pageId: string; action: import('@varin/protocol').BrowserAction }; result: import('@varin/protocol').BrowserActionResult };
  desktop_browser_read: { args: import('@varin/protocol').BrowserReadRequest; result: import('@varin/protocol').BrowserObservation };
  desktop_browser_control: { args: { pageId: string; paused: boolean }; result: import('@varin/protocol').BrowserPage };
  desktop_capture_page_rect: {
    args: { x?: number; y?: number; width?: number; height?: number };
    result: DesktopCaptureResult;
  };
  desktop_save_markdown_file: { args: { defaultFileName: string; content: string }; result: string | null };
  desktop_read_file: { args: { path: string }; result: DesktopReadFileResult };
  desktop_open_path: { args: { path: string; app?: string }; result: null };
  desktop_open_external_url: { args: { url: string }; result: null };
  desktop_reveal_path: { args: { path: string }; result: null };
  desktop_open_in_app: { args: { projectPath: string; appId: string; appName: string }; result: null };
  desktop_open_file_in_app: { args: { filePath: string; appId: string; appName: string }; result: null };
  desktop_filter_installed_apps: { args: { apps: string[] }; result: string[] };
  desktop_fetch_app_icons: { args: { apps: string[] }; result: DesktopAppIconEntry[] };
  desktop_get_installed_apps: {
    args: { apps?: string[]; force?: boolean };
    result: DesktopInstalledAppsResult;
  };

  // --- host/auth ---
  desktop_hosts_get: { args: void; result: DesktopHostsConfig & { localOrigin: string | null } };
  desktop_hosts_set: {
    args: { input: DesktopHostsConfigInput } | { config: DesktopHostsConfigInput };
    result: null;
  };
  desktop_host_probe: {
    args: { url: string; clientToken?: string; requestHeaders?: Record<string, unknown>; expectedServerId?: string };
    result: DesktopHostProbeResult;
  };
  desktop_remote_password_login: {
    args: { url: string; password: string; trustDevice?: boolean; requestHeaders?: Record<string, unknown> };
    result: DesktopRemotePasswordLoginResult;
  };
  desktop_install_id_get: { args: void; result: string };
  desktop_local_client_token_get: { args: void; result: string };

  // --- update ---
  desktop_check_for_updates: { args: void; result: DesktopUpdateCheckResult };
  desktop_download_and_install_update: { args: void; result: null };

  // --- tray/notification ---
  desktop_notify: {
    args: {
      title?: string;
      body?: string;
      threadId?: string; branchId?: string;
      directory?: string;
      requireHidden?: boolean;
      tag?: string;
      kind?: string;
      payload?: Record<string, unknown>;
    };
    result: null;
  };
  desktop_tray_update: { args: { dockBadgeCount?: number } & Record<string, unknown>; result: null };

  // --- SSH ---
  desktop_ssh_instances_get: { args: void; result: { instances: unknown[] } };
  desktop_ssh_instances_set: { args: { config: DesktopSshInstancesConfig }; result: null };
  desktop_ssh_import_hosts: { args: void; result: DesktopSshImportCandidate[] };
  desktop_ssh_connect: { args: { id: string }; result: null };
  desktop_ssh_disconnect: { args: { id: string }; result: null };
  desktop_ssh_status: { args: { id?: string }; result: DesktopSshInstanceStatus[] };
  desktop_ssh_logs: { args: { id: string; limit?: number }; result: string[] };
  desktop_ssh_logs_clear: { args: { id: string }; result: null };

  // --- web render (offscreen Chromium for harness webfetch) ---
  desktop_web_render: { args: { url: string; timeoutMs?: number }; result: DesktopWebRenderResult };
}

// ---------------------------------------------------------------------------
// Derived command types
// ---------------------------------------------------------------------------

export type VarinDesktopCommand = keyof VarinDesktopCommandMap;

export type VarinDesktopCommandArgs<K extends VarinDesktopCommand> =
  VarinDesktopCommandMap[K]['args'];

export type VarinDesktopCommandResult<K extends VarinDesktopCommand> =
  VarinDesktopCommandMap[K]['result'];

export type VarinDesktopCommandInvocation<K extends VarinDesktopCommand> =
  VarinDesktopCommandMap[K]['args'] extends void
    ? []
    : [args: VarinDesktopCommandMap[K]['args']];

// ---------------------------------------------------------------------------
// Desktop bridge interface (typed invoke/openDialog/grantFileAccess/etc.)
// ---------------------------------------------------------------------------

export interface VarinDesktopBridge {
  invoke<K extends VarinDesktopCommand>(
    cmd: K,
    ...invocation: VarinDesktopCommandInvocation<K>
  ): Promise<VarinDesktopCommandResult<K>>;
  openDialog(options?: DesktopDialogOptions): Promise<DesktopDialogResult>;
  grantFileAccess(filePath: string): Promise<DesktopDialogFileGrant>;
  openExternal(url: string): Promise<null>;
  listen<E extends VarinDesktopEvent>(
    event: E,
    handler: (evt: { payload: VarinDesktopEventMap[E] }) => void,
  ): Promise<() => void>;
}

// ---------------------------------------------------------------------------
// Command catalog — one exhaustive runtime value tied to the type map
// ---------------------------------------------------------------------------

export const VARIN_DESKTOP_COMMAND_CATALOG = {
  desktop_start_window_drag: true,
  desktop_get_companion: true,
  desktop_set_companion: true,
  desktop_companion_scene: true,
  desktop_companion_stool: true,
  desktop_companion_drag: true,
  desktop_companion_passthrough: true,
  desktop_set_window_title: true,
  desktop_set_window_theme: true,
  desktop_is_window_fullscreen: true,
  desktop_minimize_current_window: true,
  desktop_toggle_current_window_maximized: true,
  desktop_close_current_window: true,
  desktop_get_current_window_state: true,
  desktop_get_window_pinned: true,
  desktop_set_window_pinned: true,
  desktop_show_app_menu: true,
  desktop_focus_main_window: true,
  desktop_new_window: true,
  desktop_new_window_at_url: true,
  desktop_new_window_for_host: true,
  desktop_open_draft_mini_chat_window: true,
  desktop_open_thread_mini_chat_window: true,
  desktop_get_launch_at_login: true,
  desktop_set_launch_at_login: true,
  desktop_get_minimize_to_tray: true,
  desktop_set_minimize_to_tray: true,
  desktop_get_keep_awake: true,
  desktop_set_keep_awake: true,
  desktop_get_app_version: true,
  desktop_get_lan_address: true,
  desktop_set_vibrancy: true,
  desktop_clear_cache: true,
  desktop_get_local_host_mode: true,
  desktop_set_local_host_mode: true,
  desktop_restart_without_update: true,
  desktop_restart: true,
  desktop_browser_capture_page: true,
  desktop_browser_present: true,
  desktop_browser_layout: true,
  desktop_browser_detach: true,
  desktop_browser_action: true,
  desktop_browser_read: true,
  desktop_browser_control: true,
  desktop_capture_page_rect: true,
  desktop_save_markdown_file: true,
  desktop_read_file: true,
  desktop_open_path: true,
  desktop_open_external_url: true,
  desktop_reveal_path: true,
  desktop_open_in_app: true,
  desktop_open_file_in_app: true,
  desktop_filter_installed_apps: true,
  desktop_fetch_app_icons: true,
  desktop_get_installed_apps: true,
  desktop_hosts_get: true,
  desktop_hosts_set: true,
  desktop_host_probe: true,
  desktop_remote_password_login: true,
  desktop_install_id_get: true,
  desktop_local_client_token_get: true,
  desktop_check_for_updates: true,
  desktop_download_and_install_update: true,
  desktop_notify: true,
  desktop_tray_update: true,
  desktop_ssh_instances_get: true,
  desktop_ssh_instances_set: true,
  desktop_ssh_import_hosts: true,
  desktop_ssh_connect: true,
  desktop_ssh_disconnect: true,
  desktop_ssh_status: true,
  desktop_ssh_logs: true,
  desktop_ssh_logs_clear: true,
  desktop_web_render: true,
} as const satisfies Record<VarinDesktopCommand, true>;

export const VARIN_DESKTOP_COMMAND_LIST = Object.freeze(
  Object.keys(VARIN_DESKTOP_COMMAND_CATALOG) as VarinDesktopCommand[],
);

export const isVarinDesktopCommand = (value: unknown): value is VarinDesktopCommand => (
  typeof value === 'string' && Object.hasOwn(VARIN_DESKTOP_COMMAND_CATALOG, value)
);

export const VARIN_DESKTOP_EVENT_CATALOG = {
  'varin:update-progress': true,
  'varin:open-thread': true,
  'varin:open-draft-thread': true,
  'varin:window-resized': true,
  'varin:window-maximized-changed': true,
  'varin:installed-apps-updated': true,
  'varin:system-resume': true,
  'varin:tray-action': true,
  'varin:vibrancy-ready': true,
  'varin:ssh-instance-status': true,
  'varin:browser': true,
  'varin:menu-action': true,
  'varin:check-for-updates': true,
} as const satisfies Record<VarinDesktopEvent, true>;

export const VARIN_DESKTOP_EVENT_LIST = Object.freeze(
  Object.keys(VARIN_DESKTOP_EVENT_CATALOG) as VarinDesktopEvent[],
);

export const isVarinDesktopEvent = (value: unknown): value is VarinDesktopEvent => (
  typeof value === 'string' && Object.hasOwn(VARIN_DESKTOP_EVENT_CATALOG, value)
);

// ---------------------------------------------------------------------------
// Remote-safe command set — must be a subset of the command catalog.
// Behavior is unchanged from the existing REMOTE_SAFE_DESKTOP_COMMANDS;
// this export lets architecture tests assert the subset relationship.
// ---------------------------------------------------------------------------

export const VARIN_REMOTE_SAFE_DESKTOP_COMMANDS = [
  'desktop_new_window',
  'desktop_new_window_at_url',
  'desktop_new_window_for_host',
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_get_companion',
  'desktop_set_companion',
  'desktop_companion_scene',
  'desktop_companion_stool',
  'desktop_companion_drag',
  'desktop_companion_passthrough',
  'desktop_minimize_current_window',
  'desktop_toggle_current_window_maximized',
  'desktop_close_current_window',
  'desktop_get_current_window_state',
  'desktop_get_app_version',
  'desktop_capture_page_rect',
] as const satisfies readonly VarinDesktopCommand[];
