import { getRuntimeUrlResolver, runtimeFetch } from '@varin/application-client';
import type {
  ComputerControlState,
  ComputerDesktop,
  ComputerDesktopFrame,
  ComputerHumanInput,
  ComputerMachine,
} from '@varin/protocol';

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

// --- BC5: shared desktop view + control -------------------------------------

const desktopPost = async <T>(desktopId: string, action: string, body: unknown, fallback: string): Promise<T> => (
  readJson<T>(
    await runtimeFetch(`/api/computers/desktops/${encodeURIComponent(desktopId)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    fallback,
  )
);

export const computerControl = async (desktopId: string): Promise<ComputerControlState> => {
  const result = await readJson<{ control: ComputerControlState }>(
    await runtimeFetch(`/api/computers/desktops/${encodeURIComponent(desktopId)}/control`),
    'Unable to read desktop control',
  );
  return result.control;
};

export const takeoverDesktop = (desktopId: string, holderId: string) => (
  desktopPost<{ control: ComputerControlState; cancelled: number; released: boolean }>(
    desktopId, 'takeover', { holderId }, 'Unable to take over the desktop',
  )
);

export const handbackDesktop = (desktopId: string, holderId: string) => (
  desktopPost<{ control: ComputerControlState; requiresObservation: true }>(
    desktopId, 'handback', { holderId }, 'Unable to return desktop control',
  )
);

export const sendDesktopInput = (desktopId: string, holderId: string, input: ComputerHumanInput) => (
  desktopPost<{ accepted: boolean; detail?: string }>(
    desktopId, 'input', { holderId, input }, 'Unable to deliver desktop input',
  )
);

/** One frame/control event from a desktop view stream (BC5.B). */
export type DesktopStreamEvent =
  | { type: 'control'; control: ComputerControlState }
  | { type: 'frame'; frame: ComputerDesktopFrame }
  | { type: 'error'; error: string };

/**
 * Subscribe to a desktop's frame stream. The returned EventSource only feeds
 * this view — closing it unsubscribes the viewer without touching the task
 * or the desktop itself.
 */
export const subscribeDesktopStream = (desktopId: string, viewerId: string): EventSource => (
  new EventSource(getRuntimeUrlResolver().sse(
    `/api/computers/desktops/${encodeURIComponent(desktopId)}/stream`,
    { viewer: viewerId },
  ))
);
