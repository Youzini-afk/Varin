/** Private inherited-pipe protocol. This is not a renderer or network API. */
export const DESKTOP_HOST_PROTOCOL = 'varin-desktop-host' as const;
export const DESKTOP_HOST_PROTOCOL_VERSION = 1 as const;
export type DesktopHostMethod = 'status' | 'quitRisk' | 'stop' | 'setDesktopState' | 'computerControl' | 'desktopInvoke' | 'browserInvoke' | 'fileGrant' | 'desktopPlatformInvoke' | 'companionInvoke' | 'companionAsset';
export interface DesktopHostRequest {
  protocol: typeof DESKTOP_HOST_PROTOCOL;
  version: typeof DESKTOP_HOST_PROTOCOL_VERSION;
  kind: 'request';
  /** Shell requests use shell:; Host requests use host:. Never reuse an in-flight ID. */
  id: string;
  method: string;
  params?: unknown;
}
export type DesktopHostResponse = {
  protocol: typeof DESKTOP_HOST_PROTOCOL;
  version: typeof DESKTOP_HOST_PROTOCOL_VERSION;
  kind: 'response';
  id: string;
} & ({ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } });
export interface DesktopHostEvent {
  protocol: typeof DESKTOP_HOST_PROTOCOL;
  version: typeof DESKTOP_HOST_PROTOCOL_VERSION;
  kind: 'event';
  event: string;
  payload: unknown;
}
export type DesktopHostFrame = DesktopHostRequest | DesktopHostResponse | DesktopHostEvent;
export const desktopHostEnvelope = { protocol: DESKTOP_HOST_PROTOCOL, version: DESKTOP_HOST_PROTOCOL_VERSION } as const;

export function isDesktopHostFrame(value: unknown): value is DesktopHostFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  if (frame.protocol !== DESKTOP_HOST_PROTOCOL || frame.version !== DESKTOP_HOST_PROTOCOL_VERSION) return false;
  if (frame.kind === 'event') return typeof frame.event === 'string';
  if (typeof frame.id !== 'string' || !/^(shell|host):[A-Za-z0-9_-]+$/.test(frame.id)) return false;
  if (frame.kind === 'request') return typeof frame.method === 'string';
  if (frame.kind !== 'response' || typeof frame.ok !== 'boolean') return false;
  if (frame.ok) return true;
  const error = frame.error as Record<string, unknown> | undefined;
  return !!error && typeof error.code === 'string' && typeof error.message === 'string';
}
