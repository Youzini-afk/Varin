/** Host-owned self-hosted external access. Publishing a listener does not verify the HTTPS endpoint. */
export interface ExternalAccessBackend {
  host: string;
  port: number;
}

export interface ExternalAccessConfigurationView {
  id: string;
  name: string;
  provider: 'reverse-proxy' | 'frp';
  publicOrigin: string;
  backend: ExternalAccessBackend;
}

export interface ExternalAccessSnapshot {
  source: 'settings' | 'environment';
  entry: { revision: number; enabled: boolean; configuration: ExternalAccessConfigurationView } | null;
  listener: (ExternalAccessBackend & { origin: string }) | null;
  phase: 'disabled' | 'starting' | 'unverified' | 'reconnecting' | 'stopping' | 'failed' | 'connected';
  error?: string;
}

export type ExternalAccessAction = 'enable' | 'disable' | 'retry';
