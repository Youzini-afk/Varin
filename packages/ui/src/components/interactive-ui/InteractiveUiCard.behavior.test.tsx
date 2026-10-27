import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { InteractiveUiError } from '@varin/application-client';
import { UiWorkView, InteractiveUiPanel } from './InteractiveUiCard';
import { uiSession } from '@/lib/interactive-ui/sessions';

const api = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn(async () => {}), state: vi.fn(), observe: vi.fn(), openPanel: vi.fn(), t: (key: string) => key }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createInteractiveUiHttpAPI: () => api }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: api.t }) }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: ({ size: _size, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null, DialogTitle: () => null }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign(() => false, { getState: () => ({ openContextPanelTab: api.openPanel }) }), normalizeContextPanelDirectoryKey: (value: string) => value }));
vi.mock('@/components/ui/context-menu', () => ({ ContextMenu: ({ children }: React.PropsWithChildren) => children,
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => children, ContextMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  ContextMenuItem: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>, ContextMenuSeparator: () => <hr /> }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: {}, threadComposerKey: vi.fn(), threadHostKey: vi.fn() }));
vi.mock('@/lib/agent-editor/attachments', () => ({ addContentReference: vi.fn() }));
vi.mock('@/lib/interactive-ui/work-projection', () => ({ projectUiWork: vi.fn(), releaseUiWork: vi.fn(), restoreUiWork: vi.fn() }));
vi.mock('@/lib/interactive-ui/modules', () => ({ prepareUiFiles: async (files: Record<string, string>) => files, createUiExport: vi.fn() }));

it('keeps inline content mounted while inspecting source, restores measured height and runs loaded HTML despite registration failure', async () => {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '', fontFamily: 'system-ui' }));
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  let reject!: (error: Error) => void;
  api.attach.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const scrollIntent = vi.fn(); container.addEventListener('varin:conversation-scroll-intent', scrollIntent);
  const session = uiSession('card', { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, 0);
  session.cardMounted = true;
  const files = { 'index.html': '<h1>可见报告</h1><script>window.ready = true;</script>' };
  session.display = { source: { ref: 'ui:work@1' }, files, assets: {}, entry: 'index.html', title: '报告', committed: true, status: '' };
  const render = (panel = false) => root.render(<><UiWorkView session={session} {...session.display!} cwd="/project" />
    {panel && <InteractiveUiPanel sessionKey={session.key} />}</>);
  const click = async (key: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === key)!.click());
  const postMessage = vi.fn();
  try {
    await act(async () => render());
    const frame = container.querySelector('iframe')!;
    await click('ui.content.source');
    expect(api.openPanel).toHaveBeenCalledWith('/project', expect.objectContaining({ mode: 'ui', targetPath: session.key }));
    expect(session.placement).toBe('inline');
    await act(async () => render(true));
    expect(container.querySelector('pre code')?.textContent).toBe(files['index.html']);
    expect(container.querySelector('iframe')).toBe(frame);
    const frameWindow = { postMessage }; Object.defineProperty(frame, 'contentWindow', { value: frameWindow });
    const channel = /data-channel="([^"]+)"/.exec(frame.getAttribute('srcDoc') ?? frame.getAttribute('srcdoc') ?? frame.srcdoc)![1];
    await act(async () => {
      const event = new window.Event('message'); Object.assign(event, { source: frameWindow, data: { channel, type: 'ready' } }); window.dispatchEvent(event);
      const resize = new window.Event('message'); Object.assign(resize, { source: frameWindow, data: { channel, type: 'resize', height: 2400, width: 800 } }); window.dispatchEvent(resize);
      const intent = new window.Event('message'); Object.assign(intent, { source: frameWindow, data: { channel, type: 'scroll-intent', intent: 'away-from-end' } }); window.dispatchEvent(intent);
    });
    expect(frame.style.height).toBe('2400px');
    expect(session.inlineSize).toEqual({ height: 2400, width: 800 });
    expect(scrollIntent.mock.calls[0]?.[0].detail).toBe('away-from-end');
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    const updates = () => postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'update');
    expect(updates()).toEqual([expect.objectContaining({ files, committed: false })]);
    await act(async () => reject(new InteractiveUiError(403, 'View unavailable')));
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(updates()).toEqual([expect.objectContaining({ committed: false }), expect.objectContaining({ files, committed: true })]);
    await act(async () => render(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(updates()).toHaveLength(2);
    await act(async () => root.render(null));
    await act(async () => render());
    expect(container.querySelector('iframe')?.style.height).toBe('2400px');
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it('acknowledges explicit saves after persistence and drains writes before detaching the final automatic state', async () => {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '', fontFamily: 'system-ui' }));
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  api.detach.mockClear(); api.state.mockReset();
  api.attach.mockResolvedValueOnce({ viewRef: 'ui-view:durable', token: 'lease' });
  api.observe.mockImplementationOnce((...args: unknown[]) => new Promise<void>(resolve => {
    (args.at(-1) as AbortSignal).addEventListener('abort', () => resolve(), { once: true });
  }));
  const pending: { resolve(): void; reject(error: Error): void }[] = [];
  api.state.mockImplementation(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })));
  const session = uiSession('durable-card', { runtime: 'agent', threadId: 'state-thread', branchId: 'branch' }, 0);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const posted = vi.fn(), frameWindow = { postMessage: posted };
  try {
    await act(async () => root.render(<UiWorkView session={session} source={{ ref: 'ui:state@1' }} files={{ 'index.html': '<p>state</p>' }} entry="index.html" title="state" committed />));
    const frame = container.querySelector('iframe')!; Object.defineProperty(frame, 'contentWindow', { value: frameWindow });
    const channel = /data-channel="([^"]+)"/.exec(frame.getAttribute('srcDoc') ?? frame.getAttribute('srcdoc') ?? frame.srcdoc)![1];
    const post = (data: object) => { const event = new window.Event('message'); Object.assign(event, { source: frameWindow, data: { channel, ...data } }); window.dispatchEvent(event); };
    await act(async () => post({ type: 'ready' }));
    const first = { data: { n: 1 }, controls: {}, scroll: { x: 0, y: 0 } };
    const second = { ...first, data: { n: 2 } };
    await act(async () => { post({ type: 'state', id: 'save:1', state: first }); post({ type: 'state', id: 'save:2', state: second }); });
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls.some(([message]) => message.type === 'state-saved')).toBe(false);
    await act(async () => pending[0]!.resolve());
    expect(posted).toHaveBeenCalledWith({ channel, type: 'state-saved', id: 'save:1' }, '*');
    expect(api.state).toHaveBeenCalledTimes(2);
    const final = { ...first, data: { n: 3 } };
    await act(async () => { post({ type: 'state', state: final }); root.render(null); });
    expect(api.detach).not.toHaveBeenCalled();
    await act(async () => pending[1]!.reject(new Error('disk unavailable')));
    expect(posted).toHaveBeenCalledWith({ channel, type: 'state-save-error', id: 'save:2', error: 'disk unavailable' }, '*');
    expect(api.detach).toHaveBeenCalledWith(session.identity, 'ui-view:durable', 'lease', final);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
