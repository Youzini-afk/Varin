import { createHash } from 'node:crypto';
import type { BrowserConnection, BrowserSettings, BrowserSettingsSnapshot } from '@varin/protocol';
import { createCdpBrowserOwner } from './cdp-owner.js';
import type { BrowserResources } from './browser-resources.js';

type Document = Record<string, unknown>;
const object = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export class BrowserSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export async function probeBrowserConnection(value: unknown) {
  const connection = parseBrowserSettings({ connections: [value], defaultBrowserId: null }).connections[0]!;
  const owner = createCdpBrowserOwner({ browserId: connection.id, endpoint: connection.endpoint, ...(connection.headers ? { headers: connection.headers } : {}) });
  try { await owner.connect(); return { resource: await owner.resource(), pages: (await owner.list()).length }; }
  finally { await owner.dispose(); }
}
export function parseBrowserSettings(value: unknown): BrowserSettings {
  if (value === undefined) return { connections: [], defaultBrowserId: null };
  if (!object(value) || !Array.isArray(value.connections)
    || value.defaultBrowserId !== null && !text(value.defaultBrowserId)) throw new BrowserSettingsError('Invalid browser settings');
  const ids = new Set<string>();
  const connections = value.connections.map((item): BrowserConnection => {
    if (!object(item) || !text(item.id) || ids.has(item.id) || !text(item.label) || !text(item.endpoint)) throw new BrowserSettingsError('Each browser connection needs a unique ID, name and CDP address');
    const url = new URL(item.endpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new BrowserSettingsError('CDP requires an HTTP or WebSocket address');
    if (item.scratchDirectory !== undefined && !text(item.scratchDirectory)) throw new BrowserSettingsError('Browser file transfer needs a directory on the browser device');
    if (item.headers !== undefined && (!object(item.headers) || !Object.values(item.headers).every(value => typeof value === 'string'))) throw new BrowserSettingsError('CDP headers must be name/value pairs');
    ids.add(item.id);
    return { id: item.id, label: item.label.trim(), endpoint: item.endpoint.trim(),
      ...(item.scratchDirectory ? { scratchDirectory: item.scratchDirectory as string } : {}),
      ...(item.headers ? { headers: item.headers as Record<string, string> } : {}) };
  });
  return { connections, defaultBrowserId: value.defaultBrowserId as string | null };
}
const revision = (settings: BrowserSettings) => createHash('sha256').update(JSON.stringify(settings)).digest('hex');

/** Uses the existing settings transaction owner. Runtime connections remain BrowserResources' owners. */
export function createBrowserSettings(options: {
  resources: BrowserResources;
  read(): Promise<Document>;
  update(change: (current: Document) => Document): Promise<unknown>;
  environment?: { endpoint?: string | undefined; scratchDirectory?: string | undefined };
}) {
  const installed = new Map<string, BrowserConnection>();
  let flight = Promise.resolve();
  const settingsOf = (document: Document) => parseBrowserSettings(document.browser === undefined ? {
    connections: options.environment?.endpoint ? [{ id: 'configured-cdp', label: 'Chromium (CDP)', endpoint: options.environment.endpoint,
      ...(options.environment.scratchDirectory ? { scratchDirectory: options.environment.scratchDirectory } : {}) }] : [],
    defaultBrowserId: null,
  } : document.browser);
  const read = async (): Promise<BrowserSettingsSnapshot> => {
    const document = await options.read();
    const settings = settingsOf(document);
    return { ...settings, revision: revision(settings) };
  };
  const refresh = () => {
    const work = flight.then(async () => {
      const settings = await read();
      const connections = [...settings.connections];
      const seen = new Set(connections.map(item => item.id));
      for (const id of installed.keys()) if (!seen.has(id)) { await options.resources.unregister(id); installed.delete(id); }
      for (const connection of connections) {
        const previous = installed.get(connection.id);
        if (previous && JSON.stringify(previous) === JSON.stringify(connection)) continue;
        if (previous && JSON.stringify({ ...previous, label: connection.label }) === JSON.stringify(connection)) {
          options.resources.updateMetadata(connection.id, connection.label); installed.set(connection.id, connection); continue;
        }
        if (previous) await options.resources.unregister(connection.id);
        options.resources.register(createCdpBrowserOwner({ browserId: connection.id, ...connection }), connection.label, 'This Host', { source: 'cdp' });
        installed.set(connection.id, connection);
      }
    });
    flight = work.catch(() => undefined);
    return work;
  };
  const save = async (expectedRevision: string, value: unknown) => {
    const settings = parseBrowserSettings(value);
    for (const connection of settings.connections) if (!installed.has(connection.id) && options.resources.has(connection.id)) throw new BrowserSettingsError('This browser ID is already used by another resource');
    await options.update(document => {
      if (revision(settingsOf(document)) !== expectedRevision) throw new BrowserSettingsError('Browser settings changed. Reload before saving.', 409);
      return { ...document, browser: settings };
    });
    await refresh();
    return read();
  };
  // These are explicit user preferences, separate from the registry's live page bindings.
  const preferred = async (threadId?: string) => {
    const document = await options.read();
    const tasks = object(document.browserTaskSelections) ? document.browserTaskSelections : {};
    return { task: threadId && text(tasks[threadId]) ? tasks[threadId] as string : null,
      default: settingsOf(document).defaultBrowserId };
  };
  const selectTask = async (threadId: string, browserId: string | null) => {
    await options.update(document => {
      const tasks = { ...(object(document.browserTaskSelections) ? document.browserTaskSelections : {}) };
      if (browserId) tasks[threadId] = browserId; else delete tasks[threadId];
      return { ...document, browserTaskSelections: tasks };
    });
    options.resources.clearBinding(threadId);
  };
  return { read, save, refresh, preferred, selectTask };
}
export type BrowserSettingsOwner = ReturnType<typeof createBrowserSettings>;
