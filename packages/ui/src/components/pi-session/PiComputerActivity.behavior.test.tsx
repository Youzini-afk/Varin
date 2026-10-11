import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputerAccessRequest, ComputerActivityEntry, ComputerAutomationState, ComputerAutomationProjection, ComputerWorkRef } from '@varin/protocol';
import type { VarinEvent } from '@/lib/varinEvents';
import { PiComputerActivity } from './PiComputerActivity';
import { ComputerAutomationSection } from './ComputerAutomationSection';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import { createThreadsHttpAPI, ThreadRequestError, type ThreadComputerAPI } from '@varin/application-client';

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
  const api: ThreadComputerAPI = { decide: vi.fn(), state: vi.fn(async () => initial), stop: vi.fn<ThreadComputerAPI['stop']>(() => new Promise(resolve => { finishStop = resolve; })) };
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
  const api: ThreadComputerAPI = { decide: vi.fn(), state: vi.fn(async () => idle), stop: vi.fn(async () => ({ state: automation(child, null).state })) };
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
  const api: ThreadComputerAPI = { decide: vi.fn(), state: vi.fn<ThreadComputerAPI['state']>((work, signal) => new Promise(resolve => reads.push({ work, signal, finish: resolve }))), stop: vi.fn() };
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
  const api: ThreadComputerAPI = { decide: vi.fn(), state: vi.fn(async () => idle), stop: vi.fn(async () => { throw new ThreadRequestError(409, code); }) };
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

function accessRequest(rootWork: ComputerWorkRef, requester?: ComputerWorkRef): ComputerAccessRequest {
  const work = requester ?? { runtime: 'agent', threadId: 'child', branchId: 'child-branch' };
  return { id: 'child-request', revision: 3, desktopId: 'desktop-requested', desktopLabel: 'Requested desktop',
    actor: { execution: { work, runId: 'child-run' }, rootWork, rootExecution: null, label: 'Research child',
      registry: work.runtime === 'pi' ? { scopeId: 'scope', threadId: 'child' } : null,
      roleAccess: work.runtime === 'pi' ? { kind: 'pi-role', readOnly: false } : { kind: 'tool-invocation' } },
    access: 'control', status: 'pending', reason: 'Inspect the original results window\nKeep its current document open.', createdAt: 'now' };
}

const button = (container: Element, label: string) => [...container.querySelectorAll('button')].find(value => value.textContent === label)!;

it('sends idle root decisions through the real HTTP client with the exact revision and stable retry intent', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'root-branch' };
  const current = automation(work, null);
  current.state.requests = [accessRequest(work)];
  const commands: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (String(input).endsWith('/computer/state')) return Response.json(current);
    expect(String(input)).toBe('/api/threads/computer/decide');
    const command = JSON.parse(String(init?.body)) as Record<string, unknown>; commands.push(command);
    if (commands.length <= 2) throw new TypeError('Connection interrupted');
    current.state.requests = [{ ...current.state.requests[0]!, revision: 4, status: 'denied', detail: 'Access declined' }];
    return Response.json({ state: current.state });
  }));
  const api = createThreadsHttpAPI().computer;
  await act(async () => root!.render(<Probe work={work} api={api} />));
  expect(container.textContent).toContain(current.state.requests[0]!.reason);
  await act(async () => button(container, 'computer.automation.grant').click());
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('Connection interrupted');
  await act(async () => button(container, 'computer.automation.grant').click());
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toEqual({ ...work, requestId: 'child-request', expectedRevision: 3, decision: 'grant', key: expect.any(String) });
  await act(async () => button(container, 'computer.automation.deny').click());
  expect(commands[2]).toEqual({ ...work, requestId: 'child-request', expectedRevision: 3, decision: 'deny', key: expect.any(String) });
  expect(commands[2]!.key).not.toBe(commands[0]!.key);
  expect(container.textContent).toContain('computer.automation.requestStatus.denied');
  expect(container.textContent).toContain('Access declined');
  expect(button(container, 'computer.automation.grant')).toBeUndefined();
  expect(container.textContent).not.toContain('computer.automation.stop');
});

it('keeps request decisions out of child and Pi work, including calls through a retained view', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'child', branchId: 'child-branch' };
  const rootWork = { ...work, threadId: 'root' };
  const child = automation(work, 'child-run');
  child.state.rootWork = rootWork; child.state.currentRootExecution = null;
  child.state.requests = [accessRequest(rootWork, work)];
  const piWork = { runtime: 'pi' as const, sessionId: 'root' }, piChild = { ...piWork, sessionId: 'child' };
  const pi = automation(piWork, null); pi.state.requests = [accessRequest(piWork, piChild)];
  const api: ThreadComputerAPI = { state: vi.fn(async () => child), stop: vi.fn(), decide: vi.fn() };
  mocks.read.mockResolvedValue(pi);
  let childView!: ReturnType<typeof useComputerAutomation>, piView!: ReturnType<typeof useComputerAutomation>;
  await act(async () => root!.render(<><Probe work={work} api={api} report={view => { childView = view; }} />
    <Probe work={piWork} report={view => { piView = view; }} /></>));
  expect(button(container, 'computer.automation.grant')).toBeUndefined();
  expect(button(container, 'computer.automation.deny')).toBeUndefined();
  await act(async () => { await childView.decide(child.state.requests[0]!, 'grant'); await piView.decide(pi.state.requests[0]!, 'grant'); });
  expect(api.decide).not.toHaveBeenCalled();
});

it('stops the original child assignment from idle root work and never substitutes the root Run in the child view', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'root-branch' };
  const child = { ...work, threadId: 'child', branchId: 'child-branch' };
  const actor = accessRequest(work, child).actor;
  const idle = automation(work, null);
  idle.state.active = true;
  const lease = { id: 'child-assignment', desktopId: 'child-desktop', actor, access: 'control' as const, grantedAt: 'now' };
  idle.state.leases = [lease, { ...lease, id: 'same-execution-desktop' }];
  let selected = idle;
  const api: ThreadComputerAPI = { state: vi.fn(async () => selected), decide: vi.fn(), stop: vi.fn(async () => ({ state: selected.state })) };
  let captured!: ReturnType<typeof useComputerAutomation>;
  await act(async () => root!.render(<Probe work={work} api={api} />));
  expect([...container.querySelectorAll('button')].filter(value => value.textContent === 'computer.automation.stop')).toHaveLength(1);
  const stop = button(container, 'computer.automation.stop');
  expect(stop.parentElement?.closest('button')).toBeNull();
  await act(async () => stop.click());
  expect(api.stop).toHaveBeenLastCalledWith(child, { runId: 'child-run', desktopId: 'child-desktop' });
  selected = automation(child, 'child-run');
  selected.state.rootWork = work; selected.state.currentRootExecution = { work, runId: 'root-run' };
  selected.state.leases = [lease, { ...lease, id: 'root-assignment', desktopId: 'root-desktop', actor: { ...actor,
    execution: { work, runId: 'root-run' }, rootExecution: { work, runId: 'root-run' } } }];
  await act(async () => root!.render(<Probe work={child} api={api} report={view => { captured = view; }} />));
  expect([...container.querySelectorAll('button')].filter(value => value.textContent === 'computer.automation.stop')).toHaveLength(1);
  await act(async () => button(container, 'computer.automation.stop').click());
  expect(api.stop).toHaveBeenLastCalledWith(child, { runId: 'child-run', desktopId: undefined });
  await act(async () => captured.stop());
  expect(api.stop).toHaveBeenLastCalledWith(child, { runId: 'child-run', desktopId: undefined });
  expect(api.stop).toHaveBeenCalledTimes(3);
});

it('retains newer child assignment facts across late decisions, root completion and a new root Run', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'branch' };
  const initial = automation(work, 'first-root-run'); initial.state.requests = [accessRequest(work)];
  const assigned = automation(work, null);
  assigned.state.requests = [{ ...initial.state.requests[0]!, revision: 5, status: 'granted', assignmentId: 'child-assignment' }];
  assigned.state.leases = [{ id: 'child-assignment', desktopId: 'desktop-requested', desktopLabel: 'Child desktop',
    actor: initial.state.requests[0]!.actor, access: 'control', grantedAt: 'now' }];
  let finish!: (result: { state: ComputerAutomationState }) => void;
  const api: ThreadComputerAPI = { state: vi.fn(async () => initial), stop: vi.fn(),
    decide: vi.fn<ThreadComputerAPI['decide']>(() => new Promise(resolve => { finish = resolve; })) };
  let captured!: ReturnType<typeof useComputerAutomation>;
  await act(async () => root!.render(<Probe work={work} api={api} observedRunId="first-root-run" report={view => { captured = view; }} />));
  const staleDecision = captured.decide;
  await act(async () => button(container, 'computer.automation.grant').click());
  expect(button(container, 'computer.automation.deny').disabled).toBe(true);
  expect(button(container, 'computer.automation.stop').disabled).toBe(false);
  vi.mocked(api.state).mockResolvedValue(assigned);
  await emit({ type: 'computer-automation', state: assigned.state });
  await act(async () => root!.render(<Probe work={work} api={api} observedRunId={null} report={view => { captured = view; }} />));
  await act(async () => finish({ state: { ...initial.state, requests: [{ ...initial.state.requests[0]!, status: 'granting', revision: 4 }] } }));
  expect(container.textContent).toContain('computer.automation.requestStatus.granted');
  expect(container.textContent).toContain('Child desktop');
  expect(button(container, 'computer.automation.stop')).toBeDefined();
  expect(container.textContent).not.toContain('computer.automation.requestStatus.granting');
  await act(async () => staleDecision(initial.state.requests[0]!, 'deny'));
  expect(api.decide).toHaveBeenCalledTimes(1);
  const next = { ...assigned, state: { ...assigned.state, currentExecution: { work, runId: 'next-root-run' }, currentRootExecution: { work, runId: 'next-root-run' } } };
  vi.mocked(api.state).mockResolvedValue(next);
  await act(async () => root!.render(<Probe work={work} api={api} observedRunId="next-root-run" />));
  expect(container.textContent).toContain('Child desktop');
  expect(container.textContent).toContain('next-root-run');
});

it('shows uncertain and missing assignments as non-actionable facts and fences decisions after navigation or Host change', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'first' };
  const next = { ...work, branchId: 'second' };
  const first = automation(work, null); first.state.requests = [accessRequest(work)];
  const second = automation(next, null);
  second.state.requests = [{ ...accessRequest(next), status: 'indeterminate', detail: 'Physical outcome unknown' },
    { ...accessRequest(next), id: 'lost-request', status: 'unavailable', assignmentId: 'lost-assignment', detail: 'Original assignment is missing' }];
  const commands: Array<{ signal?: AbortSignal; finish(value: { state: ComputerAutomationState }): void }> = [];
  const api: ThreadComputerAPI = { state: vi.fn(async target => target.branchId === 'first' ? first : second), stop: vi.fn(),
    decide: vi.fn<ThreadComputerAPI['decide']>((_work, _request, signal) => new Promise(resolve => commands.push({ signal, finish: resolve }))) };
  let captured!: ReturnType<typeof useComputerAutomation>;
  await act(async () => root!.render(<Probe work={work} api={api} report={view => { captured = view; }} />));
  const oldDecision = captured.decide;
  await act(async () => button(container, 'computer.automation.grant').click());
  await act(async () => root!.render(<Probe work={next} api={api} />));
  expect(commands[0]!.signal?.aborted).toBe(true);
  await act(async () => { commands[0]!.finish({ state: first.state }); await oldDecision(first.state.requests[0]!, 'deny'); });
  expect(api.decide).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Physical outcome unknown');
  expect(container.textContent).toContain('Original assignment is missing');
  expect(button(container, 'computer.automation.grant')).toBeUndefined();
  expect(button(container, 'computer.automation.deny')).toBeUndefined();
  expect(container.textContent).not.toContain('computer.automation.requestStatus.released');
  expect(container.textContent).not.toContain('computer.automation.requestStatus.granted');
  await act(async () => root!.render(<Probe work={work} api={api} />));
  await act(async () => button(container, 'computer.automation.grant').click());
  vi.mocked(api.state).mockResolvedValue({ ...first, state: { ...first.state, requests: [{ ...first.state.requests[0]!, status: 'cancelled', detail: 'New Host state' }] } });
  await act(async () => { mocks.generation += 1; for (const listener of mocks.hostListeners) listener(); });
  expect(commands[1]!.signal?.aborted).toBe(true);
  await act(async () => commands[1]!.finish({ state: first.state }));
  expect(container.textContent).toContain('New Host state');
  expect(button(container, 'computer.automation.grant')).toBeUndefined();
});

it('refreshes an unchanged root Run and its known child family on invalidation, keeping failed reads visible', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'root-branch' };
  const child = { ...work, threadId: 'child', branchId: 'child-branch' };
  let pending = false, failed = false;
  const api: ThreadComputerAPI = { decide: vi.fn(), stop: vi.fn(), state: vi.fn(async target => {
    if (failed) throw new ThreadRequestError(503, 'computer-owner-unavailable');
    const snapshot = automation(target, target.threadId === 'root' ? 'same-root-run' : 'child-run');
    snapshot.state.rootWork = work; snapshot.state.currentRootExecution = { work, runId: 'same-root-run' };
    if (pending) snapshot.state.requests = [accessRequest(work, child)];
    return snapshot;
  }) };
  await act(async () => root!.render(<><Probe work={work} api={api} observedRunId="same-root-run" /><Probe work={child} api={api} observedRunId="child-run" /></>));
  expect(api.state).toHaveBeenCalledTimes(2);
  await emit({ type: 'computer-automation-invalidated', work: { ...work, branchId: 'other-branch' } });
  await emit({ type: 'computer-automation-invalidated', work: { runtime: 'pi', sessionId: 'root' } });
  expect(api.state).toHaveBeenCalledTimes(2);
  pending = true;
  await emit({ type: 'computer-automation-invalidated', work });
  expect(api.state).toHaveBeenCalledTimes(4);
  expect(vi.mocked(api.state).mock.calls.slice(-2).map(call => call[0])).toEqual([work, child]);
  expect(container.textContent).toContain('same-root-run');
  expect(container.textContent).toContain('computer.automation.requestStatus.pending');
  expect([...container.querySelectorAll('button')].filter(value => value.textContent === 'computer.automation.grant')).toHaveLength(1);
  failed = true;
  await emit({ type: 'computer-automation-invalidated', work });
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('computer.automation.error.ownerUnavailable');
  expect(container.textContent).toContain('computer.automation.requestStatus.pending');
  failed = false;
  await emit({ type: 'computer-automation-invalidated', work });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('coalesces repeated invalidations without aborting or starving a read and drops its trailing refresh after navigation', async () => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'first' };
  const next = { ...work, branchId: 'second' };
  const reads: Array<{ signal?: AbortSignal; finish(value: ComputerAutomationProjection): void }> = [];
  const api: ThreadComputerAPI = { decide: vi.fn(), stop: vi.fn(), state: vi.fn<ThreadComputerAPI['state']>((_work, signal) => new Promise(resolve => reads.push({ signal, finish: resolve }))) };
  await act(async () => root!.render(<Probe work={work} api={api} />));
  for (let index = 0; index < 3; index += 1) await emit({ type: 'computer-automation-invalidated', work });
  expect(reads).toHaveLength(1);
  expect(reads[0]!.signal!.aborted).toBe(false);
  await act(async () => reads[0]!.finish(automation(work, 'initial-result')));
  expect(container.textContent).toContain('initial-result');
  expect(reads).toHaveLength(2);
  for (let index = 0; index < 3; index += 1) await emit({ type: 'computer-automation-invalidated', work });
  expect(reads).toHaveLength(2);
  expect(reads[1]!.signal!.aborted).toBe(false);
  await act(async () => root!.render(<Probe work={next} api={api} />));
  expect(reads[1]!.signal!.aborted).toBe(true);
  expect(reads).toHaveLength(3);
  await act(async () => { reads[2]!.finish(automation(next, 'new-branch')); reads[1]!.finish(automation(work, 'old-read')); });
  expect(container.textContent).toContain('new-branch');
  expect(container.textContent).not.toContain('old-read');
  expect(reads).toHaveLength(3);
});

it.each(['decide', 'stop'] as const)('does not publish a late %s response over an invalidated projection', async action => {
  const container = mount();
  const work = { runtime: 'agent' as const, threadId: 'root', branchId: 'branch' };
  const original = automation(work, 'run'); original.state.requests = [accessRequest(work)];
  let finish!: (value: { state: ComputerAutomationState }) => void;
  const later = () => new Promise<{ state: ComputerAutomationState }>(resolve => { finish = resolve; });
  const api: ThreadComputerAPI = { state: vi.fn(async () => original), decide: vi.fn(later), stop: vi.fn(later) };
  let captured!: ReturnType<typeof useComputerAutomation>;
  await act(async () => root!.render(<Probe work={work} api={api} report={view => { captured = view; }} />));
  const reads: Array<(value: ComputerAutomationProjection) => void> = [];
  vi.mocked(api.state).mockImplementation(() => new Promise(resolve => reads.push(resolve)));
  let refreshing!: Promise<void>;
  await act(async () => { refreshing = captured.refresh(); });
  await act(async () => button(container, action === 'decide' ? 'computer.automation.grant' : 'computer.automation.stop').click());
  const refreshed = { ...original, state: { ...original.state, requests: [{ ...original.state.requests[0]!, revision: 4, status: 'denied' as const, detail: 'New decision fact' }] } };
  await emit({ type: 'computer-automation-invalidated', work });
  expect(reads).toHaveLength(1);
  await act(async () => finish({ state: { ...original.state, requests: [{ ...original.state.requests[0]!, detail: 'Stale control response' }] } }));
  expect(container.textContent).not.toContain('Stale control response');
  expect(reads).toHaveLength(2);
  await act(async () => { reads[1]!(refreshed); reads[0]!(original); await refreshing; });
  expect(container.textContent).toContain('New decision fact');
  expect(container.textContent).not.toContain('computer.automation.requestStatus.pending');
});
