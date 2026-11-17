/** Host-owned self-hosted external access. Publishing a listener does not verify the HTTPS endpoint. */
export interface ExternalAccessBackend {
  host: string;
  port: number;
}

/** Operator-supplied FRP settings. The token is resolved only by the Host. */
export interface ExternalAccessFrpConfiguration {
  server: { address: string; port: number; tls: { caFile: string; serverName: string } };
  proxy: { name: string; remotePort: number };
  tokenEnv: string;
}

export interface ExternalAccessConfigurationView {
  id: string;
  name: string;
  provider: 'reverse-proxy' | 'external-forwarding' | 'frp';
  publicOrigin: string;
  backend: ExternalAccessBackend;
  /** Available only in a management view; absent on older Hosts or redacted views. */
  frp?: ExternalAccessFrpConfiguration;
}

export interface ExternalAccessFrpcComponent {
  state: 'available' | 'missing' | 'invalid' | 'unsupported';
  source: 'configured' | 'path' | 'managed' | null;
  version: string | null;
  managedVersion: string;
  installSupported: boolean;
  error?: string;
  executablePath?: string;
}

export interface ExternalAccessCheck {
  state: 'verified' | 'unverified';
  checkedAt: number;
  origin: string;
  reason?: 'dns' | 'not_public' | 'tls' | 'timeout' | 'unreachable' | 'different_endpoint';
}

export interface ExternalAccessSnapshot {
  /** The saved revision currently serving requests; null while disconnected. */
  activeRevision?: number | null;
  source: 'settings' | 'environment';
  hostName?: string;
  /** Preserves the settings generation even after the last entry is removed. */
  settingsRevision?: number;
  pairingDefaults?: { linkTtlMs: number; temporaryAccessTtlMs: number };
  entry: { revision: number; enabled: boolean; configuration: ExternalAccessConfigurationView } | null;
  listener: (ExternalAccessBackend & { origin: string }) | null;
  phase: 'disabled' | 'enabled' | 'starting' | 'unverified' | 'reconnecting' | 'stopping' | 'failed' | 'connected';
  accessCheck?: ExternalAccessCheck;
  error?: string;
}

export type ExternalAccessAction = 'enable' | 'disable' | 'retry';
