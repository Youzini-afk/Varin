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
  provider: 'reverse-proxy' | 'frp';
  publicOrigin: string;
  backend: ExternalAccessBackend;
  /** Available only in a management view; absent on older Hosts or redacted views. */
  frp?: ExternalAccessFrpConfiguration;
}

export interface ExternalAccessSnapshot {
  source: 'settings' | 'environment';
  entry: { revision: number; enabled: boolean; configuration: ExternalAccessConfigurationView } | null;
  listener: (ExternalAccessBackend & { origin: string }) | null;
  phase: 'disabled' | 'starting' | 'unverified' | 'reconnecting' | 'stopping' | 'failed' | 'connected';
  error?: string;
}

export type ExternalAccessAction = 'enable' | 'disable' | 'retry';
