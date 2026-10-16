import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot } from '@varin/application-client';
import { threadSummary } from '@/test/threadFixtures';
import { useThreadStore } from '@/stores/useThreadStore';
import { useSelectedThreadSnapshot } from './useSelectedThreadSnapshot';

const api = vi.hoisted(() => ({ snapshot: vi.fn(), observe: vi.fn() }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: api }) }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'visible-thread', branchId: 'visible-thread:main' };
const snapshot = (title = 'Current context'): ThreadSnapshot => ({
  identity, eventCursor: 7, thread: threadSummary(identity.threadId, { title }), activeRun: null,
  history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [],
  launch: null, modelSelection: { desired: null, active: null }, policySelection: null, context: { checkpoint: null, jobs: [] },
});
let root: Root; let container: HTMLDivElement;
function ContextView({ active }: { active: boolean }) {
  const { snapshot } = useSelectedThreadSnapshot(active);
  return <p>{snapshot?.thread.title}</p>;
}
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  api.snapshot.mockReset().mockResolvedValue(snapshot());
  api.observe.mockReset().mockImplementation((_cursor, _listener, { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
  useThreadStore.setState({ selectedIdentity: identity });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('releases the offscreen context observation and reconstructs it only when visible again', async () => {
  await act(async () => root.render(<ContextView active={false} />));
  expect(api.snapshot).not.toHaveBeenCalled(); expect(api.observe).not.toHaveBeenCalled();
  await act(async () => root.render(<ContextView active />));
  expect(api.observe).toHaveBeenCalledTimes(1); expect(container.textContent).toBe('Current context');
  const firstSignal = api.observe.mock.calls[0]![2].signal as AbortSignal;
  await act(async () => root.render(<ContextView active={false} />));
  expect(firstSignal.aborted).toBe(true); expect(container.textContent).toBe('');
  api.snapshot.mockResolvedValue(snapshot('Reopened context'));
  await act(async () => root.render(<ContextView active />));
  expect(api.observe).toHaveBeenCalledTimes(2); expect(container.textContent).toBe('Reopened context');
});

it('does not publish or subscribe from a snapshot that finishes after its view became hidden', async () => {
  let finish!: (value: ThreadSnapshot) => void;
  api.snapshot.mockReturnValueOnce(new Promise<ThreadSnapshot>(resolve => { finish = resolve; }));
  await act(async () => root.render(<ContextView active />));
  await act(async () => root.render(<ContextView active={false} />));
  await act(async () => finish(snapshot('Hidden stale result')));
  expect(api.observe).not.toHaveBeenCalled(); expect(container.textContent).toBe('');
  await act(async () => root.render(<ContextView active />));
  expect(api.observe).toHaveBeenCalledTimes(1); expect(container.textContent).toBe('Current context');
});
