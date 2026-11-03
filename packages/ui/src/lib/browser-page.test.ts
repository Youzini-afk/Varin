import { beforeEach, expect, test, vi } from 'vitest';
import type { BrowserHttpClient } from '@varin/application-client';
import type { BrowserPage } from '@varin/protocol';

const runtime = vi.hoisted(() => ({ key: 'host-a', generation: 1, local: false, invoke: vi.fn() }));
vi.mock('@varin/application-client', () => ({ getRuntimeKey: () => runtime.key, getRuntimeEndpointGeneration: () => runtime.generation }));
vi.mock('./desktop', () => ({ isDesktopLocalOriginActive: () => runtime.local }));
vi.mock('./desktopNative', () => ({ invokeDesktopCommand: runtime.invoke }));
import { closeEmbeddedBrowserPage, getRemoteBrowserPage, prepareRemoteBrowserPage, rememberRemoteBrowserPage } from './browser-page';

const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Only the creation owner supplies page identity. The registry never invents one.
const page = (pageId: string) => ({ pageId } as BrowserPage);
const client = (generation: number, pending: Promise<BrowserPage>) => ({ generation, open: vi.fn(() => pending), action: vi.fn(async () => ({})) }) as unknown as BrowserHttpClient;
beforeEach(() => { runtime.key = crypto.randomUUID(); runtime.generation++; runtime.local = false; runtime.invoke.mockClear(); });

test('late creation is retained under the dispatch Host and cannot occupy the new Host tab', async () => {
  const original = runtime.key, pending = deferred<BrowserPage>(), api = client(runtime.generation, pending.promise);
  const opening = prepareRemoteBrowserPage('/project', 'tab', api, 'https://example.invalid');
  runtime.key = 'another-host'; runtime.generation++;
  pending.resolve(page('original-page')); await opening;
  expect(getRemoteBrowserPage('/project', 'tab')).toBeUndefined();
  rememberRemoteBrowserPage('/project', 'tab', page('stale-callback'), api);
  expect(getRemoteBrowserPage('/project', 'tab')).toBeUndefined();
  runtime.key = original;
  expect(getRemoteBrowserPage('/project', 'tab')?.pageId).toBe('original-page');
  closeEmbeddedBrowserPage('/project', 'tab'); await vi.waitFor(() => expect(api.action).toHaveBeenCalledWith('original-page', { action: 'close' }));
});

test('closing during creation waits for the original page then closes it once without replay', async () => {
  const pending = deferred<BrowserPage>(), api = client(runtime.generation, pending.promise);
  const opening = prepareRemoteBrowserPage('/project', 'tab', api, 'https://example.invalid');
  expect(prepareRemoteBrowserPage('/project', 'tab', api, 'https://example.invalid')).toBe(opening);
  closeEmbeddedBrowserPage('/project', 'tab'); closeEmbeddedBrowserPage('/project', 'tab');
  expect(api.action).not.toHaveBeenCalled(); expect(runtime.invoke).not.toHaveBeenCalled();
  await expect(prepareRemoteBrowserPage('/project', 'tab', api, 'https://example.invalid')).rejects.toThrow('has not finished closing');
  pending.resolve(page('closing-page')); await opening;
  await vi.waitFor(() => expect(api.action).toHaveBeenCalledExactlyOnceWith('closing-page', { action: 'close' }));
  expect(getRemoteBrowserPage('/project', 'tab')).toBeUndefined(); expect(api.open).toHaveBeenCalledTimes(1);
});

test('unknown close remains pending and does not allow a replacement page', async () => {
  const api = client(runtime.generation, Promise.resolve(page('unknown-close')));
  vi.mocked(api.action).mockRejectedValue(new Error('Original executor stop is unknown'));
  await prepareRemoteBrowserPage('/project', 'tab', api, 'https://example.invalid');
  closeEmbeddedBrowserPage('/project', 'tab');
  await vi.waitFor(() => expect(api.action).toHaveBeenCalledOnce());
  await expect(prepareRemoteBrowserPage('/project', 'tab', api, 'https://example.invalid')).rejects.toThrow('has not finished closing');
  expect(api.open).toHaveBeenCalledTimes(1);
});
