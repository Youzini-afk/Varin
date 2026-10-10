import type { Express } from 'express';
import type { Server } from 'node:http';
import type {
  PiRuntimeBroker,
  PiRuntimeBrokerFactoryOptions,
  PiRuntimeBrokerOptions,
  PiRuntimeLifecycle,
} from '@varin/runtime-broker';
import type {
  ApplicationExtensionCatalog,
  ApplicationExtensionRuntime,
  ExtensionPackageManager,
} from '@varin/extension-host';

export interface DesktopNotificationPayload {
  badge?: number | undefined;
  body?: string | undefined;
  data?: Record<string, unknown> | undefined;
  tag?: string | undefined;
  title?: string | undefined;
  [key: string]: unknown;
}

export interface DesktopRuntimeConfig {
  apiBaseUrl: string;
  requestHeaders: Record<string, string>;
}

export type HostPiRuntimeBrokerFactoryOptions = PiRuntimeBrokerFactoryOptions
  & Pick<PiRuntimeBrokerOptions, 'admitSessionExecution'>;

export interface StartWebUiServerOptions {
  apiOnly?: boolean | undefined;
  attachSignals?: boolean | undefined;
  createPiRuntimeBroker?: ((options: HostPiRuntimeBrokerFactoryOptions) => PiRuntimeBroker) | undefined;
  /** Electron system-network transport for desktop outbound HTTP(S). */
  desktopNetworkFetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  exitOnShutdown?: boolean | undefined;
  extensionCatalog?: ApplicationExtensionCatalog | undefined;
  extensionPackages?: ExtensionPackageManager | undefined;
  extensionRuntime?: ApplicationExtensionRuntime | undefined;
  getDesktopRuntimeConfig?: (() => DesktopRuntimeConfig | null) | undefined;
  getIsWindowFocused?: (() => boolean) | undefined;
  host?: string | undefined;
  hostEntry?: string | undefined;
  onDesktopNotification?: ((payload: DesktopNotificationPayload) => void) | undefined;
  onConnectionStatus?: ((status: import('@varin/application-client').DesktopSshInstanceStatus) => void) | undefined;
  onComputerGesture?: ((gesture: import('@varin/protocol').ComputerGesture) => void) | undefined;
  onComputerControl?: ((control: import('@varin/protocol').ComputerControlState) => void) | undefined;
  onComputerControlsReady?: ((controls: { holderId: string; takeover(): Promise<void>; handback(): Promise<void>; cancel(): Promise<void> }) => void) | undefined;
  computerControlWindows?: (() => number[]) | undefined;
  onTunnelReady?: ((publicUrl: string, connectUrl: string | null) => void) | undefined;
  openFilesystemPath?: ((targetPath: string) => void | Promise<void>) | undefined;
  piRuntimeBroker?: PiRuntimeBroker | undefined;
  piRuntimeLifecycle?: PiRuntimeLifecycle | undefined;
  pickPiPackageRoot?: (() => Promise<string | null>) | undefined;
  port?: number | undefined;
  requirePiRuntime?: boolean | undefined;
  /** Trusted desktop-only offscreen renderer used by harness.web.render. */
  renderWebPage?: ((url: string, signal?: AbortSignal) => Promise<string>) | undefined;
  standalonePayloadDir?: string | undefined;
  tryCfTunnel?: boolean | undefined;
  tunnelConfigPath?: string | null | undefined;
  tunnelHostname?: string | undefined;
  tunnelMode?: string | undefined;
  tunnelProvider?: string | undefined;
  tunnelToken?: string | undefined;
  uiPassword?: string | null | undefined;
}

export interface QuitRiskStatus {
  scheduledTasks: unknown;
  tunnel: { active: boolean };
}

export interface WebUiServerController {
  connections: import('./lib/connections/ssh-manager.js').HostSshManager;
  expressApp: Express;
  getPort(): number;
  getQuitRiskStatus(): Promise<QuitRiskStatus>;
  getTunnelUrl(): string | null;
  httpServer: Server;
  isReady(): boolean;
  stop(options?: { exitProcess?: boolean | undefined }): Promise<void>;
}

export interface ParseServeCliOptionsInput {
  argv?: readonly string[] | undefined;
  cloudflareProvider: string;
  defaultPort: number;
  env?: NodeJS.ProcessEnv | undefined;
  managedLocalMode: string;
}

export interface ParsedServeCliArgs {
  apiOnly: boolean;
  host?: string | undefined;
  port: number;
  tryCfTunnel: boolean;
  tunnelConfigPath?: string | null | undefined;
  tunnelHostname?: string | undefined;
  tunnelMode?: string | undefined;
  tunnelProvider?: string | undefined;
  tunnelToken?: string | undefined;
  uiPassword: string | null;
}

export interface OutsideFileGrantOptions {
  crypto?: Pick<typeof import('node:crypto'), 'randomUUID'> | undefined;
  fsPromises?: Pick<typeof import('node:fs/promises'), 'realpath' | 'stat'> | undefined;
  path?: Pick<typeof import('node:path'), 'dirname'> | undefined;
  scopes?: readonly string[] | undefined;
}

export interface OutsideFileGrantResult {
  expiresAt: number;
  outsideFileGrant: string;
  path: string;
}
