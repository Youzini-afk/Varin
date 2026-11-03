import { getRuntimeEndpointGeneration, getRuntimeKey, type BrowserHttpClient } from '@varin/application-client';
import type { BrowserPage } from '@varin/protocol';
import { isDesktopLocalOriginActive } from './desktop';
import { invokeDesktopCommand } from './desktopNative';

const ownedPrefix = 'browser:page:';
export function embeddedBrowserPageId(directory: string, tabId: string): string {
  return tabId.startsWith(ownedPrefix) ? tabId.slice(ownedPrefix.length) : `ui:${encodeURIComponent(directory.replace(/\\/g, '/'))}:${tabId}`;
}
export function closeEmbeddedBrowserPage(directory: string, tabId: string) {
  if (closeRemote(remoteKey(directory, tabId))) return;
  closeEmbeddedBrowserPageId(embeddedBrowserPageId(directory, tabId));
}
export function closeEmbeddedBrowserPageId(pageId: string) {
  const remote = [...remotePages.entries()].find(([key, value]) => JSON.parse(key)[0] === getRuntimeKey() && value.pageId === pageId);
  if (remote) { closeRemote(remote[0]); return; }
  if (!isDesktopLocalOriginActive()) return;
  void invokeDesktopCommand('desktop_browser_action', { pageId, action: { action: 'close' } }).catch(() => undefined);
}

const remotePages = new Map<string, { pageId: string; client: BrowserHttpClient }>();
const remoteKey = (directory: string, tabId: string) => JSON.stringify([getRuntimeKey(), directory, tabId]);
export function rememberRemoteBrowserPage(directory: string, tabId: string, page: BrowserPage, client: BrowserHttpClient) {
  if (client.generation !== getRuntimeEndpointGeneration()) return;
  const key = remoteKey(directory, tabId);
  if (!remoteClosing.has(key)) remotePages.set(key, { pageId: page.pageId, client });
}
export function getRemoteBrowserPage(directory: string, tabId: string) { return remotePages.get(remoteKey(directory, tabId)); }

type Preparation = { pending: Promise<BrowserPage>; client: BrowserHttpClient };
const remotePreparing = new Map<string, Preparation>();
const remoteClosing = new Map<string, Promise<void>>();
function closeRemote(key: string): boolean {
  if (remoteClosing.has(key)) return true;
  const preparation = remotePreparing.get(key), remote = remotePages.get(key);
  if (!preparation && !remote) return false;
  const client = remote?.client ?? preparation!.client;
  // Tab disposal is separate from viewer unmount. Once creation has dispatched,
  // retain its result until this original page has really been closed.
  const page = remote ? Promise.resolve(remote.pageId) : preparation!.pending.then(value => value.pageId);
  const closing = page.then(async pageId => {
    await client.action(pageId, { action: 'close' });
    if (remotePreparing.get(key) === preparation) remotePreparing.delete(key);
    remotePages.delete(key);
    if (remoteClosing.get(key) === closing) remoteClosing.delete(key);
  });
  remoteClosing.set(key, closing);
  // Unknown creation/close outcome stays recorded and is never replayed on mount.
  void closing.catch(() => {});
  return true;
}
export function prepareRemoteBrowserPage(directory: string, tabId: string, client: BrowserHttpClient, url: string): Promise<BrowserPage> {
  const key = remoteKey(directory, tabId), existing = remotePreparing.get(key);
  if (remoteClosing.has(key)) return Promise.reject(new Error('The original Browser page has not finished closing'));
  if (existing) return existing.pending;
  const pending = client.open(url).then(page => {
    // Bind the result to the Host selected at dispatch, not whichever Host is
    // active when the original creation eventually completes.
    if (!remoteClosing.has(key)) remotePages.set(key, { pageId: page.pageId, client });
    return page;
  });
  // Retain even an unknown failure: remount/reconnect must not replay creation.
  remotePreparing.set(key, { pending, client }); return pending;
}
