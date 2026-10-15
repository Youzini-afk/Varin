import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { switchRuntimeEndpoint, type ThreadIdentity } from '@varin/application-client';
import type { ThreadUsage } from '@varin/protocol';
const api = vi.hoisted(() => ({ usage: vi.fn(), observe: vi.fn() }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: api }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button> }));
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadTokenUsage } from './ThreadTokenUsage';
let root: Root; let container: HTMLElement;
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:usage', branchId: 'branch:usage' };
const snapshot = (modelId = 'reported-model'): ThreadUsage => ({ threadId: identity.threadId, branchId: identity.branchId, throughCursor: 42, notDispatchedRequests: 1,
  rows: [{ kind: 'conversation', providerId: null, providerFamily: 'native-family', modelId, measurement: 'actual', requests: 2, pendingRequests: 1,
    inputTokens: { known: '18446744073709551616', missing: 0 }, outputTokens: { known: '0', missing: 1 }, cachedInputTokens: { known: null, missing: 2 },
    cacheWriteTokens: { known: null, missing: 2 }, reasoningTokens: { known: null, missing: 2 } }],
});
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('CustomEvent', window.CustomEvent); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = window.document.getElementById('root')! as unknown as HTMLElement; root = createRoot(container);
  api.usage.mockReset(); api.observe.mockReset().mockImplementation(() => new Promise(() => {}));
  useThreadStore.setState({ selectedIdentity: identity });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('renders original branch measurements without zero-filling missing values or rounding large token counts', async () => {
  const value = snapshot(); value.rows.push({ ...value.rows[0]!, modelId: 'estimated-model', measurement: 'estimated' }); api.usage.mockResolvedValue(value);
  await act(async () => root.render(<ThreadTokenUsage />));
  expect(api.usage).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
  expect(api.observe).toHaveBeenCalledWith(42, expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(container.textContent).toContain(BigInt('18446744073709551616').toLocaleString());
  expect(container.textContent).toContain('0 recorded; 1 request(s) unreported');
  expect(container.textContent).toContain('Unknown'); expect(container.textContent).toContain('Estimated usage');
  expect(container.textContent).toContain('1 pending'); expect(container.textContent).toContain('Child threads and standalone utility');
});
it('retains the last same-branch snapshot after observation failure and refresh reconnects', async () => {
  api.usage.mockResolvedValue(snapshot()); api.observe.mockRejectedValueOnce(new Error('Host unavailable'));
  await act(async () => root.render(<ThreadTokenUsage />));
  expect(container.textContent).toContain('reported-model'); expect(container.textContent).toContain('Showing the last recorded snapshot');
  api.usage.mockResolvedValue(snapshot('refreshed-model'));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('refreshed-model'); expect(container.textContent).not.toContain('Host unavailable');
});
it('discards previous Host responses even when the new Host has the same thread identifiers', async () => {
  let release!: (value: ThreadUsage) => void; api.usage.mockReturnValueOnce(new Promise<ThreadUsage>(resolve => { release = resolve; })).mockResolvedValue(snapshot('new-host-model'));
  await act(async () => root.render(<ThreadTokenUsage />));
  const originalSignal = api.usage.mock.calls[0]![1] as AbortSignal;
  await act(async () => { switchRuntimeEndpoint({ apiBaseUrl: 'http://usage-next.test', runtimeKey: 'usage-next' }); useThreadStore.setState({ selectedIdentity: { ...identity } }); });
  expect(originalSignal.aborted).toBe(true);
  await act(async () => release(snapshot('old-host-model')));
  expect(container.textContent).toContain('new-host-model'); expect(container.textContent).not.toContain('old-host-model');
});
it('coalesces durable event bursts while one usage read is pending', async () => {
  let event!: (event: unknown) => void; api.observe.mockImplementation((_cursor, onEvent) => { event = onEvent; return new Promise(() => {}); });
  let release!: (value: ThreadUsage) => void;
  api.usage.mockResolvedValueOnce(snapshot()).mockReturnValueOnce(new Promise<ThreadUsage>(resolve => { release = resolve; })).mockResolvedValue(snapshot('latest'));
  await act(async () => root.render(<ThreadTokenUsage />));
  await act(async () => { for (let cursor = 43; cursor < 48; cursor++) event({ kind: 'model.settled', cursor }); });
  expect(api.usage).toHaveBeenCalledTimes(2);
  await act(async () => release(snapshot('intermediate')));
  expect(api.usage).toHaveBeenCalledTimes(3); expect(container.textContent).toContain('latest');
});
