import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BrowserEvent, BrowserFrame, BrowserPage } from '@varin/protocol';
import { RemoteBrowserPane } from './RemoteBrowserPane';
import { BROWSER_POSITION_SCRIPT, BROWSER_SELECTION_SCRIPT, browserInspectorScripts } from '@/lib/remote-browser-view';

const mocks = vi.hoisted(() => ({
  api: { catalog: vi.fn(), events: vi.fn(), frames: vi.fn(), control: vi.fn(), resize: vi.fn(), input: vi.fn(), action: vi.fn(), read: vi.fn() },
  capture: undefined as undefined | (() => Promise<unknown>),
  selected: { runtime: 'agent', threadId: 'thread', branchId: 'branch' },
  draftImage: vi.fn(), draftText: vi.fn(), annotation: vi.fn(), position: vi.fn(), toast: { success: vi.fn(), error: vi.fn() },
  t: (key: string) => key,
}));
vi.mock('@varin/application-client', () => ({ createBrowserHttpClient: () => mocks.api }));
vi.mock('@/components/ui/button', () => ({ Button: ({ size: _size, variant: _variant, ...props }: React.ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props} /> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui', () => ({ toast: mocks.toast }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/lib/desktopRuntime', () => ({ getDesktopRuntime: () => undefined }));
vi.mock('@/lib/desktopNative', () => ({ invokeDesktopCommand: vi.fn() }));
vi.mock('@/lib/url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setContextPanelTabTargetPath: mocks.position }) } }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (select: (state: unknown) => unknown) => select({ selectedIdentity: mocks.selected }) }));
vi.mock('@/lib/browser-page', () => ({ getRemoteBrowserPage: () => undefined, rememberRemoteBrowserPage: vi.fn(), prepareRemoteBrowserPage: vi.fn() }));
vi.mock('@/lib/agent-editor/material-navigation', () => ({ registerBrowserMaterialCapture: (_directory: string, _tab: string, capture: () => Promise<unknown>) => { mocks.capture = capture; return () => { mocks.capture = undefined; }; } }));
vi.mock('@/lib/agent-runtime/draftAttachments', () => ({ addThreadDraftImage: mocks.draftImage }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ appendThreadDraftText: mocks.draftText }));
vi.mock('@/lib/preview/screenshot-capture', () => ({
  desktopAnnotationToFile: mocks.annotation,
  isPreviewElementMetadata: (value: unknown) => Boolean(value && typeof value === 'object' && 'bounds' in value),
  formatPreviewAnnotationMarkdown: ({ pageUrl }: { pageUrl: string }) => `Annotation: ${pageUrl}`,
}));

let root: Root, container: HTMLElement, page: BrowserPage;
let events: (event: BrowserEvent) => void, frames: (frame: BrowserFrame) => void;
let resize: () => void;
const dispatch = async (element: Element, type: string, extra: Record<string, unknown> = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, extra);
  await act(async () => { element.dispatchEvent(event); }); return event;
};
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)!;
const render = async (initialPosition?: { x: number; y: number }) => act(async () => root.render(<RemoteBrowserPane initialUrl="https://example.com/" directory="/work" tabID="browser:page:page" initialPosition={initialPosition} />));
const emitFrame = async () => act(async () => frames({ browserId: 'browser', pageId: 'page', pageGeneration: 'generation', ownerGeneration: 'owner', controlEpoch: page.controlEpoch!, streamId: 'viewer', sequence: 1, viewport: { width: 800, height: 600, scale: 1 }, mimeType: 'image/jpeg', bytes: new Uint8Array() }));
const takeControl = async () => { await dispatch(button('browser.takeOver'), 'click'); await emitFrame(); };

beforeEach(async () => {
  vi.clearAllMocks(); mocks.selected = { runtime: 'agent', threadId: 'thread', branchId: 'branch' };
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { randomUUID: () => 'viewer' });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close() {} })));
  vi.stubGlobal('navigator', { userAgent: 'test', clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.stubGlobal('ClipboardItem', undefined);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 800, height: 600, x: 0, y: 0, left: 0, top: 0, bottom: 600, right: 800, toJSON() {} });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as unknown as HTMLCanvasElement['getContext'];
  document.oninput = null;
  const { createRoot } = await import('react-dom/client');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  page = { pageId: 'page', browserId: 'browser', generation: 'generation', controlEpoch: 'original', url: 'https://example.com/', title: 'Page', loading: false, retained: true, canGoBack: true, canGoForward: false, agentPaused: false };
  mocks.api.catalog.mockResolvedValue({ pages: [page], devices: [{ browserId: 'browser', label: 'Original browser', state: 'connected' }] });
  mocks.api.events.mockImplementation((_page: string, listener: typeof events) => { events = listener; return () => {}; });
  mocks.api.frames.mockImplementation((_page: string, _stream: string, listener: typeof frames, signal: AbortSignal) => { frames = listener; return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
  mocks.api.control.mockImplementation(async (_page: string, stream: string, paused: boolean) => { page = { ...page, agentPaused: paused, controlViewerId: paused ? stream : undefined, controlEpoch: 'controlled' }; return page; });
  mocks.api.resize.mockResolvedValue(undefined); mocks.api.input.mockResolvedValue(undefined);
  mocks.api.action.mockImplementation(async (_page: string, action: { script?: string }) => ({ page, action: 'evaluate', value: action.script === BROWSER_POSITION_SCRIPT ? { x: 12, y: 345 } : action.script === BROWSER_SELECTION_SCRIPT ? 'selected input text' : undefined }));
  mocks.api.read.mockImplementation(async () => ({ page, viewport: { width: 800, height: 600, scale: 1 }, image: { base64: 'image', width: 800, height: 600 } }));
  mocks.annotation.mockResolvedValue(new File(['image'], 'annotation.png')); mocks.draftImage.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

test('clipboard keystrokes keep local browser defaults and paste is sent once through the current input lease', async () => {
  await render(); await emitFrame(); await takeControl();
  const input = container.querySelector('textarea')!;
  const key = await dispatch(input, 'keydown', { key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  expect(key.defaultPrevented).toBe(false); expect(mocks.api.input).not.toHaveBeenCalled();
  await dispatch(input, 'paste', { clipboardData: { getData: () => 'pasted text' } });
  expect(mocks.api.input).toHaveBeenCalledWith(expect.objectContaining({ controlEpoch: 'controlled', input: { type: 'text', text: 'pasted text' } }));
  await dispatch(input, 'copy'); expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected input text');
});

test('rejects input from a previous viewport epoch until the matching frame arrives', async () => {
  await render(); await emitFrame(); await takeControl();
  page = { ...page, controlEpoch: 'resized' }; await act(async () => events({ kind: 'page', page }));
  const input = container.querySelector('textarea')!;
  await dispatch(input, 'paste', { clipboardData: { getData: () => 'stale' } }); expect(mocks.api.input).not.toHaveBeenCalled();
  await emitFrame(); await dispatch(input, 'paste', { clipboardData: { getData: () => 'fresh' } });
  expect(mocks.api.input).toHaveBeenCalledWith(expect.objectContaining({ controlEpoch: 'resized', input: { type: 'text', text: 'fresh' } }));
});

test('restores a saved material location once and captures the original page without replacing its state', async () => {
  await render({ x: 12, y: 345 });
  expect(mocks.api.action).toHaveBeenCalledWith('page', { action: 'evaluate', script: 'scrollTo(12,345)' });
  await act(async () => events({ kind: 'page', page: { ...page, loading: true } }));
  await act(async () => events({ kind: 'page', page: { ...page, loading: false } }));
  expect(mocks.api.action).toHaveBeenCalledTimes(1);
  expect(await mocks.capture!()).toEqual({ x: 12, y: 345 });
});

test('resizes when the controlled pane changes size, never for an observer', async () => {
  await render(); await emitFrame(); expect(mocks.api.resize).not.toHaveBeenCalled();
  await takeControl(); expect(mocks.api.resize).toHaveBeenLastCalledWith('page', 'viewer', 800, 600);
  const viewport = container.querySelector('canvas')!.parentElement!;
  viewport.getBoundingClientRect = () => ({ width: 1024, height: 720 } as DOMRect);
  await act(async () => resize()); expect(mocks.api.resize).toHaveBeenLastCalledWith('page', 'viewer', 1024, 720);
});

test('inspect takes control and attaches a screenshot and BrowserOwner identity to the selected chat draft', async () => {
  await render(); await emitFrame();
  const originalAction = mocks.api.action.getMockImplementation()!;
  mocks.api.action.mockImplementation(async (id, action) => action.script === browserInspectorScripts('viewer', 1).start
    ? { page: { ...page, agentPaused: false }, value: { target: { bounds: { x: 10, y: 20, width: 80, height: 40 } }, position: { x: 12, y: 345 }, url: page.url } } : originalAction(id, action));
  await dispatch(button('contextPanel.preview.inspect.toggle'), 'click');
  expect(mocks.api.read).toHaveBeenCalledWith({ pageId: 'page', view: 'screenshot' });
  expect(mocks.draftImage).toHaveBeenCalledWith(mocks.selected, expect.any(File));
  expect(mocks.draftText).toHaveBeenCalledWith(mocks.selected, 'Browser: browser\nPage: page\nAnnotation: https://example.com/');
  expect(button('browser.resume')).toBeTruthy(); // the old evaluate snapshot must not revoke the current lease
});

test('cancelling an in-flight inspection discards its late result and keeps navigation usable', async () => {
  await render(); await emitFrame(); await takeControl();
  let finish!: (value: unknown) => void;
  const originalAction = mocks.api.action.getMockImplementation()!;
  mocks.api.action.mockImplementation((id, action) => action.script === browserInspectorScripts('viewer', 1).start
    ? new Promise(resolve => { finish = resolve; }) : originalAction(id, action));
  await dispatch(button('contextPanel.preview.inspect.toggle'), 'click');
  await dispatch(button('contextPanel.preview.inspect.toggle'), 'click');
  expect(mocks.api.action).toHaveBeenCalledWith('page', { action: 'evaluate', script: browserInspectorScripts('viewer', 1).cancel });
  await act(async () => finish({ page, value: { target: { bounds: { x: 1, y: 1, width: 2, height: 2 } }, position: { x: 12, y: 345 }, url: page.url } }));
  expect(mocks.api.read).not.toHaveBeenCalled(); expect(mocks.draftImage).not.toHaveBeenCalled();
  await dispatch(button('browser.back'), 'click'); expect(mocks.api.action).toHaveBeenCalledWith('page', { action: 'back' });
});


test('changing chats cancels inspection instead of attaching a late result to either draft', async () => {
  await render(); await emitFrame(); await takeControl();
  let finish!: (value: unknown) => void;
  const originalAction = mocks.api.action.getMockImplementation()!;
  mocks.api.action.mockImplementation((id, action) => action.script === browserInspectorScripts('viewer', 1).start
    ? new Promise(resolve => { finish = resolve; }) : originalAction(id, action));
  await dispatch(button('contextPanel.preview.inspect.toggle'), 'click');
  mocks.selected = { runtime: 'agent', threadId: 'other', branchId: 'other-branch' }; await render();
  expect(mocks.api.action).toHaveBeenCalledWith('page', { action: 'evaluate', script: browserInspectorScripts('viewer', 1).cancel });
  await act(async () => finish({ page, value: { target: { bounds: { x: 1, y: 1, width: 2, height: 2 } }, position: { x: 12, y: 345 }, url: page.url } }));
  expect(mocks.draftImage).not.toHaveBeenCalled(); expect(mocks.draftText).not.toHaveBeenCalled();
});
