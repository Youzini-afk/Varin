import { runtimeFetch } from '@varin/application-client';
import type { ComputerDesktop, ComputerMachine } from '@varin/protocol';

/** Computer Use catalog entry served by the Host computer service (BC4). */
export interface ComputerCatalog {
  machines: ComputerMachine[];
  desktops: ComputerDesktop[];
  defaultDesktopId: string | null;
}

const readJson = async <T>(response: Response, fallback: string): Promise<T> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.error === 'string' ? body.error : fallback;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};

export const listComputers = async (): Promise<ComputerCatalog> => (
  readJson<ComputerCatalog>(await runtimeFetch('/api/computers'), 'Unable to list computers')
);

/** Re-probe a desktop's driver; the response carries the real capability table. */
export const probeComputerDesktop = async (desktopId: string): Promise<ComputerDesktop> => {
  const result = await readJson<{ desktop: ComputerDesktop }>(
    await runtimeFetch(`/api/computers/desktops/${encodeURIComponent(desktopId)}/probe`, { method: 'POST' }),
    'Unable to probe the desktop',
  );
  return result.desktop;
};

export const setDefaultComputerTarget = async (desktopId: string | null): Promise<void> => {
  await readJson<{ ok: true }>(
    await runtimeFetch('/api/computers/default-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desktopId }),
    }),
    'Unable to set the default computer target',
  );
};
