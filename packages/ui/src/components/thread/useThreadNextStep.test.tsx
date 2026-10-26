import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadNextStep, ThreadsAPI } from '@varin/application-client';
import { useThreadNextStep } from './useThreadNextStep';

const events = vi.hoisted(() => ({ change: (_event: unknown) => {} }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (fn: typeof events.change) => { events.change = fn; return () => {}; } }));
let root: Root; let container: HTMLDivElement;
let current: ReturnType<typeof useThreadNextStep>;
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:one', branchId: 'branch:one' };
function Harness({ api, owner = 'host:one', head = 'head:one', eligible = true }: { api: ThreadsAPI; owner?: string; head?: string; eligible?: boolean }) {
  current = useThreadNextStep(api, identity, { owner, headId: head, runId: 'run:one', eligible });
  return <span>{current.text}</span>;
}
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('discards a late result after a Host or history cut changes', async () => {
  const complete: Array<(result: ThreadNextStep) => void> = [];
  const nextStep = vi.fn<NonNullable<ThreadsAPI['nextStep']>>(() => new Promise(resolve => complete.push(resolve)));
  const api = { nextStep } as unknown as ThreadsAPI;
  await act(async () => root.render(<Harness api={api} />));
  await act(async () => root.render(<Harness api={api} owner="host:two" head="head:two" />));
  expect(nextStep.mock.calls[0]![2]!.aborted).toBe(true);
  await act(async () => complete[0]!({ status: 'ready', runId: 'run:one', headId: 'head:one', text: '旧结果' }));
  expect(current.text).toBeUndefined();
  await act(async () => complete[1]!({ status: 'ready', runId: 'run:one', headId: 'head:two', text: '新结果' }));
  expect(current.text).toBe('新结果');
});

it('retains a ready suggestion across draft renders, honors dismissal, and hides it during another Run', async () => {
  const nextStep = vi.fn<NonNullable<ThreadsAPI['nextStep']>>(async () => ({ status: 'ready', runId: 'run:one', headId: 'head:one', text: '继续吧' }));
  const api = { nextStep } as unknown as ThreadsAPI;
  await act(async () => root.render(<Harness api={api} />));
  await act(async () => root.render(<Harness api={api} />));
  expect(nextStep).toHaveBeenCalledOnce(); expect(current.text).toBe('继续吧');
  await act(async () => current.dismiss()); expect(current.text).toBeUndefined();
  await act(async () => root.render(<Harness api={api} eligible={false} />));
  await act(async () => root.render(<Harness api={api} />));
  expect(nextStep).toHaveBeenCalledOnce(); expect(current.text).toBeUndefined();
});

it('invalidates visible suggestions as soon as settings change and applies the new disabled state', async () => {
  const nextStep = vi.fn<NonNullable<ThreadsAPI['nextStep']>>()
    .mockResolvedValueOnce({ status: 'ready', runId: 'run:one', headId: 'head:one', text: '继续吧' }).mockResolvedValueOnce({ status: 'disabled' });
  const api = { nextStep } as unknown as ThreadsAPI;
  await act(async () => root.render(<Harness api={api} />)); expect(current.text).toBe('继续吧');
  await act(async () => events.change({ type: 'settings-changed', owner: 'agent-settings' }));
  expect(current.text).toBeUndefined(); expect(nextStep).toHaveBeenCalledTimes(2);
});
