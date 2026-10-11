import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputerActivityEntry, ComputerAutomationState, ComputerAutomationProjection, ComputerWorkRef } from '@varin/protocol';
import type { VarinEvent } from '@/lib/varinEvents';
import { PiComputerActivity } from './PiComputerActivity';
import { ComputerAutomationSection } from './ComputerAutomationSection';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import { ThreadRequestError, type ThreadComputerAPI } from '@varin/application-client';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), stop: vi.fn(), generation: 1, hostListeners: new Set<() => void>(), open: vi.fn(), listeners: new Set<(event: VarinEvent) => void>(),
}));
vi.mock('@/lib/computers', () => ({ readComputerAutomation: mocks.read, stopComputerAutomation: mocks.stop }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => mocks.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.hostListeners.add(listener); return () => { mocks.hostListeners.delete(listener); }; },
}));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: (select: (state: unknown) => unknown) => select({ runtimeKey: 'test' }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ openContextPanelTab: mocks.open }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
  mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); };
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) => `${key}${params ? ` ${Object.values(params).join(' ')}` : ''}` }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  mocks.read.mockReset(); mocks.stop.mockReset(); mocks.open.mockReset(); mocks.listeners.clear(); mocks.hostListeners.clear(); mocks.generation = 1; vi.unstubAllGlobals();
});

it('keeps newer activity over a delayed snapshot, opens the existing desktop tab, and follows session ownership', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  const work = { runtime: 'pi' as const, sessionId: 's1' };
  const state = automation(work).state;
  let finishRead!: (value: { state: ComputerAutomationState; activities: ComputerActivityEntry[] }) => void;
  mocks.read.mockReturnValue(new Promise<{ state: ComputerAutomationState; activities: ComputerActivityEntry[] }>(resolve => { finishRead = resolve; }));
  await act(async () => { root = createRoot(container); root.render(<PiComputerActivity sessionId="s1" directory="/repo" />); });
  const entry: ComputerActivityEntry = { desktopId: 'desktop-1', activity: { sessionId: 's1', execution: { work, runId: 'run' }, app: 'Editor', operation: 'click', status: 'running', updatedAt: 'now' } };
  const emit = async (event: VarinEvent) => act(async () => { for (const listener of mocks.listeners) listener(event); });
  await emit({ type: 'computer-activity', ...entry });
  await act(async () => finishRead({ state, activities: [] }));
  expect(container.textContent).toContain('Editor');
  expect(container.textContent).toContain('chat.computerActivity.working');
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.open).toHaveBeenCalledWith('/repo', { mode: 'computer', targetPath: 'desktop-1', dedupeKey: 'desktop:desktop-1', label: 'Editor' });
  await emit({ type: 'computer-activity', ...entry, activity: { ...entry.activity, sessionId: 'other', execution: { work: { runtime: 'pi', sessionId: 'other' }, runId: 'run' }, status: 'idle' } });
  expect(container.querySelector('button')).toBeNull();
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.read.mockResolvedValue({ state, activities: [{ ...entry, activity: { ...entry.activity, status: 'idle' } }] });
  await emit({ type: 'stream-ready' });
  expect(container.querySelector('button')).toBeNull();
  expect(mocks.read).toHaveBeenCalledTimes(2);
  mocks.read.mockResolvedValue({ state, activities: [entry] });
  await emit({ type: 'stream-ready' });
  expect(container.textContent).toContain('Editor');
  expect(container.textContent).toContain('chat.computerActivity.working');
});

function automation(work: ComputerWorkRef, runId: string | null = 'run'): ComputerAutomationProjection {
  const execution = runId ? { work, runId } : null;
  return { state: { work, rootWork: work, currentExecution: execution, currentRootExecution: execution,
    active: Boolean(execution), status: 'enabled', leases: [], requests: [], cleanups: [] }, activities: [] };
}
function mount() {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container); return container;
}
function Probe({ work, api, observedRunId, report }: { work: ComputerWorkRef; api?: ThreadComputerAPI; observedRunId?: string | null; report?: (view: ReturnType<typeof useComputerAutomation>) => void }) {
  const view = useComputerAutomation(work, api, observedRunId); report?.(view);
  return <div data-runtime={work.runtime}><ComputerAutomationSection view={view} directory="/repo" /><span>{view.state?.currentExecution?.runId}</span></div>;
}
const emit = async (event: VarinEvent) => act(async () => { for (const listener of mocks.listeners) listener(event); });

it('isolates matching Pi and Agent IDs and binds a delayed Stop to the displayed Run', async () => {
  const container = mount();
  const pi = { runtime: 'pi' as const, sessionId: 'same' };
  const agent = { runtime: 'agent' as const, threadId: 'same', branchId: 'branch' };
  const initial = automation(agent, 'old-run'), next = automation(agent, 'new-run');
  mocks.read.mockResolvedValue(automation(pi, 'pi-run'));
  let finishStop!: (result: { state: ComputerAutomationState }) => void;
  const api: ThreadComputerAPI = { state: vi.fn(async () => initial), stop: vi.fn<ThreadComputerAPI['stop']>(() => new Promise(resolve => { finishStop = resolve; })) };
  let captured!: ReturnType<typeof useComputerAutomation>;
  await act(async () => root!.render(<><Probe work={pi} /><Probe work={agent} api={api} report={view => { captured = view; }} /></>));
  const oldStop = captured.stop;
  vi.mocked(api.state).mockResolvedValue(next);
  await emit({ type: 'computer-automation', state: next.state });
  let stopping!: Promise<void>;
  await act(async () => { stopping = oldStop(); });
  expect(api.stop).toHaveBeenCalledWith(agent, { runId: 'old-run', desktopId: undefined });
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(container.querySelector('[data-runtime="pi"]')!.textContent).toContain('pi-run');
  expect(container.querySelector('[data-runtime="agent"]')!.textContent).toContain('new-run');
  await act(async () => { finishStop({ state: { ...initial.state, active: false } }); await stopping; });
  expect(container.querySelector('[data-runtime="agent"]')!.textContent).toContain('new-run');
  expect(api.state).toHaveBeenCalledTimes(2);
  mocks.stop.mockResolvedValue({ state: { ...automation(pi, 'pi-run').state, active: false } });
  await act(async () => container.querySelector('[data-runtime="pi"] button')!.dispatchEvent(new window.Event('click', { bubbles: true })));
  expect(mocks.stop).toHaveBeenCalledWith({ work: pi, runId: 'pi-run' }, undefined);
});

it('keeps idle cleanup visible and stops its original child/branch without replacing the root view', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'current' };
  const child = { runtime: 'agent' as const, threadId: 'child', branchId: 'original' };
  const idle = automation(work, null);
  idle.state.status = 'cancel-unconfirmed';
  idle.state.cleanups = [{ execution: { work: child, runId: 'old-child-run' }, desktopId: 'desktop-old', status: 'cancel-unconfirmed' }];
  const api: ThreadComputerAPI = { state: vi.fn(async () => idle), stop: vi.fn(async () => ({ state: automation(child, null).state })) };
  await act(async () => root!.render(<Probe work={work} api={api} />));
  expect(container.textContent).toContain('old-child-run');
  expect(container.textContent).toContain('child original');
  expect(container.textContent).toContain('desktop-old');
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'computer.automation.stop')!.click());
  expect(api.stop).toHaveBeenCalledWith(child, { runId: 'old-child-run', desktopId: 'desktop-old' });
  expect(api.state).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('old-child-run');
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
});

it('fences old branch and Host responses and refreshes the owner when the observed Run changes', async () => {
  const container = mount();
  const first = { runtime: 'agent' as const, threadId: 'thread', branchId: 'first' };
  const second = { ...first, branchId: 'second' };
  const reads: Array<{ work: ComputerWorkRef; signal?: AbortSignal; finish(value: ComputerAutomationProjection): void }> = [];
  const api: ThreadComputerAPI = { state: vi.fn<ThreadComputerAPI['state']>((work, signal) => new Promise(resolve => reads.push({ work, signal, finish: resolve }))), stop: vi.fn() };
  await act(async () => root!.render(<Probe work={first} api={api} observedRunId="run-1" />));
  await act(async () => root!.render(<Probe work={second} api={api} observedRunId="run-2" />));
  expect(reads[0]!.signal!.aborted).toBe(true);
  await act(async () => { reads[1]!.finish(automation(second, 'run-2')); reads[0]!.finish(automation(first, 'late-branch')); });
  expect(container.textContent).toContain('run-2'); expect(container.textContent).not.toContain('late-branch');
  await act(async () => root!.render(<Probe work={second} api={api} observedRunId="run-3" />));
  expect(reads).toHaveLength(3);
  await act(async () => { mocks.generation += 1; for (const listener of mocks.hostListeners) listener(); });
  expect(reads[2]!.signal!.aborted).toBe(true);
  await act(async () => { reads[3]!.finish(automation(second, 'new-host')); reads[2]!.finish(automation(second, 'late-host')); });
  expect(container.textContent).toContain('new-host'); expect(container.textContent).not.toContain('late-host');
});

it.each([
  ['computer-execution-stale', 'computer.automation.error.executionStale'],
  ['computer-owner-unavailable', 'computer.automation.error.ownerUnavailable'],
])('keeps cleanup visible and explains the owner failure %s', async (code, message) => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
  const idle = automation(work, null);
  idle.state.status = 'cancel-unconfirmed';
  idle.state.cleanups = [{ execution: { work, runId: 'original-run' }, status: 'cancel-unconfirmed' }];
  const api: ThreadComputerAPI = { state: vi.fn(async () => idle), stop: vi.fn(async () => { throw new ThreadRequestError(409, code); }) };
  await act(async () => root!.render(<Probe work={work} api={api} />));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'computer.automation.stop')!.click());
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(message);
  expect(container.textContent).toContain('original-run');
  expect(container.textContent).toContain('computer.automation.error.releaseUnconfirmed');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'settings.harness.retry')!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('original-run');
  expect(api.stop).toHaveBeenCalledTimes(1);
});
