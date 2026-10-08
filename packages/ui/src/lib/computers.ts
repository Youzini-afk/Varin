import { getRuntimeUrlResolver, runtimeFetch } from '@varin/application-client';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  ComputerControlState,
  ComputerActivityEntry,
  ComputerAutomationState,
  ComputerGesture,
  ComputerArtifact,
  ComputerDesktop,
  ComputerDesktopFrame,
  ComputerHumanInput,
  ComputerMachine,
  ComputerVmDescriptor,
  ComputerVmProviderConfig,
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

/** No probing, screenshot capture or persistent desktop subscription. */
export const readComputerActivity = async (sessionId: string): Promise<ComputerActivityEntry[]> => (
  await readJson<{ activities: ComputerActivityEntry[] }>(
    await runtimeFetch(`/api/computers/activity?sessionId=${encodeURIComponent(sessionId)}`), 'Unable to read computer activity',
  )
).activities;
export interface ComputerAutomationProjection { state: ComputerAutomationState; activities: ComputerActivityEntry[] }
export const readComputerAutomation = async (sessionId: string): Promise<ComputerAutomationProjection> => readJson(
  await runtimeFetch(`/api/computers/automation?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' }), 'Unable to read Computer Use state');
export const stopComputerAutomation = async (sessionId: string, desktopId?: string): Promise<{ state: ComputerAutomationState }> => readJson(
  await runtimeFetch('/api/computers/automation/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, desktopId }) }), 'Unable to confirm computer work cancellation');

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

export const sendDesktopInput = (desktopId: string, holderId: string, input: ComputerHumanInput, controlEpoch: string) => (
  desktopPost<{ accepted: boolean; detail?: string }>(
    desktopId, 'input', { holderId, input, controlEpoch }, 'Unable to deliver desktop input',
  )
);

/** One frame/control event from a desktop view stream (BC5.B). */
export type DesktopStreamEvent =
  | { type: 'gesture'; gesture: ComputerGesture }
  | { type: 'control'; control: ComputerControlState }
  | { type: 'frame'; frame: ComputerDesktopFrame }
  | { type: 'error'; error: string };

/**
 * Subscribe to a desktop's frame stream. The returned EventSource only feeds
 * this view — closing it unsubscribes the viewer without touching the task
 * or the desktop itself.
 */
export const subscribeDesktopStream = (desktopId: string, viewerId: string, frames = true): EventSource => (
  new EventSource(getRuntimeUrlResolver().sse(
    `/api/computers/desktops/${encodeURIComponent(desktopId)}/stream`,
    { viewer: viewerId, ...(frames ? {} : { frames: '0' }) },
  ))
);

export const prepareComputerDesktop = async (input: import('@varin/protocol').ComputerDesktopPrepareParams): Promise<ComputerDesktop> => (
  (await readJson<{ desktop: ComputerDesktop }>(await runtimeFetch('/api/computers/desktops/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }), 'Unable to prepare desktop')).desktop
);

export const changeComputerDesktop = async (desktopId: string, action: 'start' | 'stop'): Promise<ComputerDesktop> => (
  (await desktopPost<{ desktop: ComputerDesktop }>(desktopId, 'lifecycle', { action }, 'Unable to change desktop lifecycle')).desktop
);

export const downloadComputerArtifact = async (artifact: ComputerArtifact): Promise<void> => {
  const response = await runtimeFetch(`/api/computers/artifacts/${encodeURIComponent(artifact.id)}/content`);
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(typeof result?.error === 'string' ? result.error : 'Unable to download desktop artifact');
  }
  if (response.headers.get('x-varin-artifact-sha256') !== artifact.sha256) {
    throw new Error('The downloaded artifact revision did not match the work record');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const receivedHash = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (receivedHash !== artifact.sha256 || bytes.byteLength !== artifact.byteLength) {
    throw new Error('The downloaded file changed after its work revision was recorded');
  }
  const file = new Blob([bytes]);
  const href = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = artifact.relativePath.split('/').at(-1) || 'artifact';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
};

// --- BC7: virtual machines ---------------------------------------------------

export const listVirtualMachines = async (): Promise<ComputerVmDescriptor[]> => (
  (await readJson<{ vms: ComputerVmDescriptor[] }>(
    await runtimeFetch('/api/computers/vms'),
    'Unable to list virtual machines',
  )).vms
);

interface VmCreateInput {
  providerId: string;
  name: string;
  memoryMiB?: number;
  vcpus?: number;
  diskGiB?: number;
  baseImage?: string;
  managed?: boolean;
}

export const createVirtualMachine = async (input: VmCreateInput): Promise<{ machine: ComputerMachine; created: boolean }> => (
  readJson(
    await runtimeFetch('/api/computers/vms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Unable to create the virtual machine',
  )
);

export const runVmAction = async (
  machineId: string,
  action: 'start' | 'shutdown' | 'reboot' | 'upgrade',
): Promise<ComputerVmDescriptor> => (
  (await readJson<{ vm: ComputerVmDescriptor }>(
    await runtimeFetch(`/api/computers/vms/${encodeURIComponent(machineId)}/${action}`, { method: 'POST' }),
    'Unable to run the VM action',
  )).vm
);

/** `deleteDisks` removes the recorded data volumes; default keeps them. */
export const deleteVirtualMachine = async (machineId: string, deleteDisks = false): Promise<void> => {
  await readJson<{ ok: true }>(
    await runtimeFetch(`/api/computers/vms/${encodeURIComponent(machineId)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteDisks }),
    }),
    'Unable to delete the virtual machine',
  );
};

// --- VM provider configuration (Host settings `computerVmProviders`) ---------

const readSettings = async (): Promise<Record<string, unknown>> => {
  const response = await runtimeFetch('/api/config/settings', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load settings');
  return response.json() as Promise<Record<string, unknown>>;
};

const writeSettings = async (changes: Record<string, unknown>): Promise<void> => {
  const response = await runtimeFetch('/api/config/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!response.ok) throw new Error('Unable to save settings');
};

export const listVmProviderConfigs = async (): Promise<ComputerVmProviderConfig[]> => {
  const settings = await readSettings();
  const raw = Array.isArray(settings.computerVmProviders) ? settings.computerVmProviders : [];
  return raw.filter((entry): entry is ComputerVmProviderConfig =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as ComputerVmProviderConfig).id === 'string'
    && (entry as ComputerVmProviderConfig).kind === 'libvirt'
    && typeof (entry as ComputerVmProviderConfig).uri === 'string');
};

export const saveVmProviderConfigs = async (providers: ComputerVmProviderConfig[]): Promise<void> => {
  await writeSettings({ computerVmProviders: providers });
};
