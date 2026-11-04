import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContentReference, ThreadSnapshot } from '@varin/application-client';
import { ConversationContext, type ConversationPresentation } from '../conversation/ConversationContext';
import { NativeObjectContent } from './NativeObjectContent';
import { useNativeObjectActions } from '@/lib/interactive-ui/native-object-actions';
const catalog = vi.hoisted(() => ({ threads: [] }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: Object.assign((select: (value: typeof catalog) => unknown) => select(catalog), { getState: () => catalog }) }));
vi.mock('@/stores/useThreadContextUsageStore', () => ({ contextUsageKey: () => 'owner', useThreadContextUsageStore: Object.assign((select: (value: { views: object }) => unknown) => select({ views: {} }), { getState: () => ({ views: {} }) }) }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ openThreadFromNavigation: vi.fn() }));
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: () => <span>Agent</span> }));
vi.mock('@/components/conversation/childPresentation', () => ({ ChildState: ({ state }: { state: string }) => <span>{state}</span> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { const { document, window } = parseHTML('<html><body></body></html>'); vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function owner(): ConversationPresentation { return { api: {} as ConversationPresentation['api'], identity: { runtime: 'agent', threadId: 't', branchId: 'b' }, head: null, toolExecutions: {}, quote: vi.fn(), openFile: vi.fn(async () => {}), fileTarget: vi.fn() }; }
it('opens only through the conversation file owner and reports permission failure inline', async () => {
  const value = owner(); value.openFile = vi.fn(async () => { throw new Error('Original source is unavailable'); });
  await act(async () => { root.render(<ConversationContext.Provider value={value}><NativeObjectContent refValue="file:call-a/src%2Fmain.ts" /></ConversationContext.Provider>); });
  await act(async () => { container.querySelector('button')!.click(); });
  expect(value.openFile).toHaveBeenCalledWith('call-a', 'src/main.ts'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('Original source is unavailable');
});
it('keeps unsupported and malformed references readable without a navigation fallback', async () => {
  const value = owner();
  await act(async () => { root.render(<ConversationContext.Provider value={value}><NativeObjectContent refValue="file:%broken/path" /><NativeObjectContent refValue="https://example.com/admin" /></ConversationContext.Provider>); });
  expect(container.querySelectorAll('button')).toHaveLength(0); expect(container.textContent).toContain('Invalid file reference'); expect(container.textContent).toContain('https://example.com/admin'); expect(value.openFile).not.toHaveBeenCalled();
});
it('updates task status from the shared owner but keeps a user reference frozen', async () => {
  const value = owner();
  const snapshot = { identity: value.identity, thread: { thread_id: 't', title: 'Research', branches: [] }, activeRun: { state: 'running' } } as unknown as ThreadSnapshot;
  value.snapshot = snapshot;
  let capture!: (ref: string) => Promise<ContentReference>;
  function Capture() { capture = useNativeObjectActions().reference; return <NativeObjectContent refValue="t" />; }
  await act(async () => { root.render(<ConversationContext.Provider value={value}><Capture /></ConversationContext.Provider>); });
  expect(container.textContent).toContain('running'); const frozen = await capture('t');
  const next = { ...value, snapshot: { ...snapshot, activeRun: { ...snapshot.activeRun!, state: 'completed' as const } } };
  await act(async () => { root.render(<ConversationContext.Provider value={next}><Capture /></ConversationContext.Provider>); });
  expect(container.textContent).toContain('completed'); expect(frozen.text).toContain('running'); expect(frozen.source).toMatchObject({ kind: 'object', objectRef: 't', state: 'running', capturedAt: expect.any(String) });
});
