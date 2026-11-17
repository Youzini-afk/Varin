import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  baseUrl: '', runtimeKey: 'local', endpointChanged: null as (() => void) | null,
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(), reload: vi.fn(),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@varin/application-client', () => ({
  getRuntimeApiBaseUrl: () => state.baseUrl,
  getRuntimeKey: () => state.runtimeKey,
  runtimeFetch: state.fetch,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    state.endpointChanged = listener;
    return () => { state.endpointChanged = null; };
  },
}));
const dom = parseHTML('<html><body></body></html>');
Object.defineProperty(dom.window, 'location', { configurable: true, value: { reload: state.reload } });
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.document);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const { createRoot } = await import('react-dom/client');
const { BrowserSessionSignOut } = await import('./BrowserSessionSignOut');
let root: ReturnType<typeof createRoot>;
let container: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { baseUrl: '', runtimeKey: 'local' });
  state.fetch.mockImplementation(async path => Response.json(path === '/auth/session'
    ? { authenticated: true, browserDevice: { id: 'browser-1', label: 'Paired test browser' } }
    : { signedOut: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => vi.unstubAllGlobals());
const render = async () => { await act(async () => root.render(<BrowserSessionSignOut />)); };

it.each([
  { authenticated: true, scope: 'client' },
  { authenticated: true },
  { authenticated: false, browserDevice: { id: 'untrusted' } },
])('does not offer browser sign-out without authenticated cookie identity: %j', async payload => {
  state.fetch.mockResolvedValue(Response.json(payload));
  await render();
  expect(container.querySelector('button')).toBeNull();
});

it('revokes this browser once and reloads only after confirmed sign-out', async () => {
  await render();
  expect(container.textContent).toContain('Paired test browser');
  expect(container.textContent).toContain('sessionAuth.browser.signOutDescription');
  let finish!: (response: Response) => void;
  state.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => {
    container.querySelector('button')!.click();
    container.querySelector('button')!.click();
  });
  expect(state.fetch).toHaveBeenCalledTimes(2); // Status plus one DELETE, not two.
  expect(state.fetch).toHaveBeenLastCalledWith('/auth/browser-session', expect.objectContaining({ method: 'DELETE', credentials: 'include' }));
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(state.reload).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({ signedOut: true })));
  expect(state.reload).toHaveBeenCalledTimes(1);
});

it('keeps a retryable sign-out action on failure rather than claiming logout', async () => {
  await render();
  state.fetch.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
  await act(async () => container.querySelector('button')!.click());
  expect(state.reload).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('sessionAuth.browser.signOutFailed');
  expect(container.querySelector('button')!.disabled).toBe(false);
  await act(async () => container.querySelector('button')!.click());
  expect(state.reload).toHaveBeenCalledTimes(1);
});

it('discards stale status when changing hosts', async () => {
  let finish!: (response: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  state.fetch.mockResolvedValueOnce(Response.json({ authenticated: true, scope: 'client' }));
  await act(async () => {
    state.runtimeKey = 'host:other';
    state.endpointChanged?.();
    finish(Response.json({ authenticated: true, browserDevice: { id: 'old-browser' } }));
  });
  expect(container.querySelector('button')).toBeNull();
});

it('does not reload a newer host when the old browser sign-out finishes', async () => {
  await render();
  let finish!: (response: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => container.querySelector('button')!.click());
  state.fetch.mockResolvedValueOnce(Response.json({ authenticated: true }));
  await act(async () => {
    state.runtimeKey = 'host:other';
    state.endpointChanged?.();
    finish(Response.json({ signedOut: true }));
  });
  expect(container.querySelector('button')).toBeNull();
  expect(state.reload).not.toHaveBeenCalled();
});
