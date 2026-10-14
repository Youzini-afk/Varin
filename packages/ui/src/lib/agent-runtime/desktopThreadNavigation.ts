import { getRuntimeApiBaseUrl } from '@varin/application-client';

const endpoint = (value: string): string => {
  try { const url = new URL(value); url.hash = ''; return url.toString().replace(/\/$/, ''); } catch { return value; }
};
/** Events are delivered only after Electron selects their original source Host. */
export const isDesktopThreadNavigationTarget = (
  target: { apiBaseUrl?: string | undefined; relayHostId?: string | undefined },
  current: { apiBaseUrl: string; relayHostId: string } = {
    apiBaseUrl: getRuntimeApiBaseUrl(),
    relayHostId: typeof window === 'undefined' ? '' : (window as typeof window & { __VARIN_RELAY_HOST_ID__?: string }).__VARIN_RELAY_HOST_ID__ || '',
  },
): boolean => target.apiBaseUrl !== undefined && endpoint(target.apiBaseUrl) === endpoint(current.apiBaseUrl)
  && (target.relayHostId || '') === current.relayHostId;
