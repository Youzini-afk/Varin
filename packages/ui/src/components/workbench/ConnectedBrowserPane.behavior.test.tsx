import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserPageSnapshot } from '@varin/application-client';
import type { BrowserResource, BrowserResourceBinding } from '@varin/protocol';
import { ConnectedBrowserPage, ConnectedBrowserSurface } from './ConnectedBrowserPane';

const mocks = vi.hoisted(() => ({ list: vi.fn(), pages: vi.fn(), observe: vi.fn(), control: vi.fn(), task: vi.fn(), selectTask: vi.fn(),
  thread: null as { runtime: 'agent'; threadId: string; branchId: string } | null, host: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', () => ({
  browserResources: mocks, getRuntimeEndpointGeneration: () => mocks.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) => `${key}${params ? ` ${Object.values(params).join(' ')}` : ''}` }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (read: (state: unknown) => unknown) => read({ selectedIdentity: mocks.thread }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setSettingsPage: vi.fn(), setSettingsDialogOpen: vi.fn() }) } }));
let root: Root | undefined;
let container: HTMLDivElement;
const binding = { browserId: 'office', instanceId: 'session-original', pageId: 'tab-original' };
const resource: BrowserResource = { browserId: 'office', instanceId: 'session-original', label: 'Chrome', deviceName: 'Office device', state: 'online', capabilities: ['tabs', 'read', 'act', 'activate'] };
const snapshot = (title: string, controller: 'human' | 'agent' = 'agent'): BrowserPageSnapshot => ({
  observation: { page: { browserId: binding.browserId, pageId: binding.pageId, title, url: 'https://original.test', loading: false, canGoBack: false, canGoForward: false, retained: true },
    observationId: title, viewport: { width: 10, height: 10, scale: 1 }, frames: [], elements: [{ role: 'heading', name: title }] },
  usage: { controller, activeThreadId: 'original-task', waitingThreadIds: ['waiting-task'] },
});
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  container = document.createElement('div'); document.body.append(container);
  mocks.list.mockResolvedValue([resource]); mocks.pages.mockResolvedValue([snapshot('Original page').observation.page]); mocks.observe.mockResolvedValue(snapshot('Original page'));
  mocks.thread = null; mocks.task.mockResolvedValue({ preferredBrowserId: null }); mocks.selectTask.mockResolvedValue({ preferredBrowserId: 'office' });
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.host = 1; mocks.listeners.clear(); });
const render = async (node: React.ReactNode) => act(async () => { root ??= createRoot(container); root.render(node); });

it('shows readable activity and real observations; takeover and resume reobserve the same tab', async () => {
  await render(<ConnectedBrowserPage resource={resource} binding={binding} />);
  expect(container.textContent).not.toContain('session-original');
  expect(container.textContent).toContain('Original page');
  expect(container.textContent).toContain('browser.resource.waitingCount 1');
  expect(container.querySelector('iframe')).toBeNull();
  mocks.control.mockResolvedValue({ usage: snapshot('', 'human').usage }); mocks.observe.mockResolvedValue(snapshot('After takeover', 'human'));
  await act(async () => button('browser.takeOver').click());
  expect(mocks.control.mock.calls[0].slice(0, 2)).toEqual([binding, 'takeover']);
  expect(container.textContent).toContain('After takeover');
  mocks.control.mockResolvedValue({ usage: snapshot('').usage }); mocks.observe.mockResolvedValue(snapshot('After resume'));
  await act(async () => button('browser.resume').click());
  expect(mocks.control.mock.calls[1].slice(0, 2)).toEqual([binding, 'resume']);
  expect(container.textContent).toContain('After resume');
  await act(async () => button('browser.resource.openOnDevice').click());
  expect(mocks.control.mock.calls[2].slice(0, 2)).toEqual([binding, 'activate']);
});

it('viewing a browser does not change task placement; the task action selects it through the owner', async () => {
  mocks.thread = { runtime: 'agent', threadId: 'work', branchId: 'branch' };
  await render(<ConnectedBrowserSurface binding={binding} onBindingChange={vi.fn()} preview={null} />);
  expect(mocks.selectTask).not.toHaveBeenCalled();
  await act(async () => button('browser.resource.useForTask').click());
  expect(mocks.selectTask).toHaveBeenCalledWith('work', 'office');
  expect(container.textContent).toContain('browser.resource.taskSelected');
});

it('does not offer local URL opening when activate is unsupported and retains failed observation honestly', async () => {
  await render(<ConnectedBrowserPage resource={{ ...resource, capabilities: ['read'] }} binding={binding} />);
  expect(button('browser.resource.openOnDevice')).toBeUndefined();
  expect(container.textContent).toContain('browser.resource.openUnavailable');
  mocks.observe.mockRejectedValueOnce(new Error('Connection lost'));
  await act(async () => button('browser.resource.observe').click());
  expect(container.textContent).toContain('Connection lost');
  expect(container.textContent).toContain('browser.resource.lastObservation');
  expect(container.textContent).toContain('Original page');
});

it('keeps the binding across owner replacement and never displays a different local preview', async () => {
  mocks.list.mockResolvedValue([{ ...resource, instanceId: 'replacement' }]);
  await render(<ConnectedBrowserSurface binding={binding} onBindingChange={vi.fn()} preview={<div>Unrelated preview</div>} />);
  expect(container.textContent).toContain('browser.resource.instanceEnded');
  expect(container.textContent).not.toContain('Unrelated preview');
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.pages).not.toHaveBeenCalled();
});

it('ignores late page and control responses after the selected binding changes; closing the view sends no release', async () => {
  let resolveRead!: (value: BrowserPageSnapshot) => void;
  mocks.observe.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  const renderPage = (next: BrowserResourceBinding) => render(<ConnectedBrowserSurface binding={next} onBindingChange={vi.fn()} preview={null} />);
  await renderPage(binding);
  mocks.observe.mockResolvedValue(snapshot('New selection'));
  await renderPage({ ...binding, pageId: 'tab-second' });
  await act(async () => resolveRead(snapshot('Late obsolete selection')));
  expect(container.textContent).not.toContain('Late obsolete selection');
  expect(container.textContent).toContain('New selection');
  let resolveControl!: (value: { usage: BrowserPageSnapshot['usage'] }) => void;
  mocks.control.mockImplementationOnce(() => new Promise(resolve => { resolveControl = resolve; }));
  await act(async () => { button('browser.takeOver').click(); button('browser.takeOver').click(); });
  expect(mocks.control).toHaveBeenCalledOnce();
  await act(async () => root?.unmount()); root = undefined;
  await act(async () => resolveControl({ usage: snapshot('', 'human').usage }));
  expect(mocks.control).toHaveBeenCalledOnce();
});

it('uses the declared screenshot-only capability and requires an explicit choice after instance replacement', async () => {
  mocks.observe.mockResolvedValue({ ...snapshot('Screen'), observation: { ...snapshot('Screen').observation, image: { mimeType: 'image/png', base64: 'aGVsbG8=', width: 10, height: 10 } } });
  await render(<ConnectedBrowserPage resource={{ ...resource, capabilities: ['screenshot'] }} binding={binding} />);
  expect(mocks.observe.mock.calls[0].slice(0, 2)).toEqual([binding, 'screenshot']);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
  mocks.list.mockResolvedValue([{ ...resource, instanceId: 'current-session' }]);
  const change = vi.fn();
  await render(<ConnectedBrowserSurface binding={binding} onBindingChange={change} preview={null} />);
  expect(change).not.toHaveBeenCalled();
  await act(async () => button('browser.resource.useCurrentInstance').click());
  expect(change).toHaveBeenCalledWith({ browserId: 'office', instanceId: 'current-session' });
});

it('discards a late observation after a Host switch even when the new Host has the same resource labels', async () => {
  let resolveOld!: (value: BrowserPageSnapshot) => void;
  mocks.observe.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const observed = vi.fn();
  await render(<ConnectedBrowserSurface binding={binding} onBindingChange={vi.fn()} onObservedPage={observed} preview={null} />);
  mocks.observe.mockResolvedValue(snapshot('New host observation'));
  await act(async () => { mocks.host += 1; for (const listener of mocks.listeners) listener(); });
  await act(async () => resolveOld(snapshot('Old host observation')));
  expect(container.textContent).toContain('New host observation');
  expect(container.textContent).not.toContain('Old host observation');
  expect(observed).toHaveBeenCalledOnce();
});

it('does not reobserve when persisting a changed page URL recreates the same binding object', async () => {
  function Page() {
    const [target, setTarget] = React.useState(binding);
    return <ConnectedBrowserPage resource={resource} binding={target} onObservedPage={() => setTarget({ ...binding })} />;
  }
  await render(<Page />);
  expect(mocks.observe).toHaveBeenCalledOnce();
});
