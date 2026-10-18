import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { InteractiveUiError } from '@varin/application-client';
import { UiWorkView } from './InteractiveUiCard';
import type { UiSession } from '@/lib/interactive-ui/sessions';

const api = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn(async () => {}), t: (key: string) => key }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createInteractiveUiHttpAPI: () => api }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: api.t }) }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: ({ size: _size, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null, DialogTitle: () => null }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: () => false, normalizeContextPanelDirectoryKey: (value: string) => value }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: {}, threadComposerKey: vi.fn(), threadHostKey: vi.fn() }));
vi.mock('@/lib/agent-editor/attachments', () => ({ addContentReference: vi.fn() }));
vi.mock('@/lib/interactive-ui/work-projection', () => ({ projectUiWork: vi.fn(), releaseUiWork: vi.fn(), restoreUiWork: vi.fn() }));
vi.mock('@/lib/interactive-ui/modules', () => ({ prepareUiFiles: async (files: Record<string, string>) => files, createUiExport: vi.fn() }));

it('shows loaded HTML and source while view registration is pending, and runs it once even if registration fails', async () => {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '', fontFamily: 'system-ui' }));
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  let reject!: (error: Error) => void;
  api.attach.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const session: UiSession = { key: 'card', host: 0, identity: { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, placement: 'inline' };
  const files = { 'index.html': '<h1>可见报告</h1><script>window.ready = true;</script>' };
  const render = () => root.render(<UiWorkView session={session} source={{ ref: 'ui:work@1' }} files={files} entry="index.html" title="报告" committed />);
  const click = async (key: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === key)!.click());
  const postMessage = vi.fn();
  try {
    await act(async () => render());
    await click('ui.content.source'); expect(container.querySelector('pre code')?.textContent).toBe(files['index.html']);
    await click('ui.content.preview');
    const frame = container.querySelector('iframe')!;
    const frameWindow = { postMessage }; Object.defineProperty(frame, 'contentWindow', { value: frameWindow });
    const channel = /data-channel="([^"]+)"/.exec(frame.getAttribute('srcDoc') ?? frame.getAttribute('srcdoc') ?? frame.srcdoc)![1];
    await act(async () => {
      const event = new window.Event('message'); Object.assign(event, { source: frameWindow, data: { channel, type: 'ready' } }); window.dispatchEvent(event);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    const updates = () => postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'update');
    expect(updates()).toEqual([expect.objectContaining({ files, committed: false })]);
    await act(async () => reject(new InteractiveUiError(403, 'View unavailable')));
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(updates()).toEqual([expect.objectContaining({ committed: false }), expect.objectContaining({ files, committed: true })]);
    await act(async () => render());
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(updates()).toHaveLength(2);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
