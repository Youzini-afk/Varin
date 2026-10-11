import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputerActor, ComputerControlState, ComputerDesktop } from '@varin/protocol';
import { ComputerDesktopPane } from './ComputerDesktopView';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key, host: 1, listeners: new Set<() => void>(), stop: vi.fn(), localStop: vi.fn(), takeover: vi.fn(), handback: vi.fn(),
  streams: [] as Array<{ onmessage: null | ((event: { data: string }) => void); onerror: null | (() => void); close: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => mocks.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; },
}));
vi.mock('@/lib/computers', () => ({
  stopComputerAutomation: mocks.localStop, stopDesktopComputerWork: mocks.stop, handbackDesktop: mocks.handback, takeoverDesktop: mocks.takeover, sendDesktopInput: vi.fn(),
  subscribeDesktopStream: () => { const source = { onmessage: null, onerror: null, close: vi.fn() }; mocks.streams.push(source); return source; },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('./VncDesktop', () => ({ VncDesktop: () => null }));
vi.mock('./ComputerFeedback', () => ({ ComputerFeedback: () => null }));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  mocks.stop.mockReset(); mocks.localStop.mockReset(); mocks.takeover.mockReset(); mocks.handback.mockReset(); mocks.streams.length = 0; mocks.listeners.clear(); mocks.host = 1; vi.unstubAllGlobals();
});
const desktop: ComputerDesktop = { id: 'desktop', label: 'Desktop', machineId: 'machine', kind: 'remote-session', status: 'available', remote: { connectionId: 'peer', desktopId: 'real-target', hostId: 'remote-host' } };
const control = (operator?: ComputerActor): ComputerControlState => ({ desktopId: desktop.id, owner: 'agent', reachable: true,
  since: 'now', automationEpoch: 'physical-epoch', ...(operator ? { operator, workStatus: 'active' } : {}) });
const emit = async (index: number, value: ComputerControlState) => act(async () => {
  mocks.streams[index]!.onmessage?.({ data: JSON.stringify({ type: 'control', control: value }) });
});

it('routes a foreign operator through the pinned desktop and retains ownerless unconfirmed cleanup after Host replacement', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  await act(async () => { root = createRoot(container); root.render(<ComputerDesktopPane desktop={desktop} />); });
  const work = { runtime: 'agent' as const, threadId: 'child', branchId: 'branch' };
  const rootWork = { ...work, threadId: 'root' };
  const operator: ComputerActor = { execution: { work, runId: 'child-run' }, rootWork, rootExecution: { work: rootWork, runId: 'root-run' },
    registry: null, label: 'Child', roleAccess: { kind: 'tool-invocation' } };
  mocks.stop.mockResolvedValue({ control: { ...control(operator), workStatus: 'cancel-unconfirmed' }, released: false });
  await emit(0, control(operator));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'computer.automation.stop')!.click());
  expect(mocks.stop).toHaveBeenCalledWith(desktop.id, 'physical-epoch');
  expect(mocks.localStop).not.toHaveBeenCalled();
  await act(async () => { mocks.host += 1; for (const listener of mocks.listeners) listener(); });
  expect(mocks.streams[0]!.close).toHaveBeenCalledOnce();
  await emit(0, control(operator));
  expect(container.textContent).not.toContain('computer.automation.stop');
  await emit(1, { ...control(), workStatus: 'cancel-unconfirmed' });
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
  expect(container.textContent).toContain('computer.automation.error.releaseUnconfirmed');
  const takeover = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'settings.computers.view.takeover')!;
  expect(takeover.disabled).toBe(false);
  expect(container.textContent).toContain('computer.automation.stop');
});

it('ignores a late physical Stop response after a newer control epoch or Host replaces the view', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  await act(async () => { root = createRoot(container); root.render(<ComputerDesktopPane desktop={desktop} />); });
  const work = { runtime: 'agent' as const, threadId: 'same-as-local', branchId: 'same-as-local' };
  const operator: ComputerActor = { execution: { work, runId: 'same-run' }, rootWork: work, rootExecution: { work, runId: 'same-run' }, registry: null, label: 'Remote Agent', roleAccess: { kind: 'tool-invocation' } };
  const pending: Array<(result: { control: ComputerControlState; released: boolean }) => void> = [];
  mocks.stop.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  await emit(0, control(operator));
  const stop = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'computer.automation.stop')!;
  await act(async () => stop().click());
  const next = { ...control(operator), automationEpoch: 'new-epoch', workStatus: 'cancel-unconfirmed' as const };
  await emit(0, next);
  await act(async () => pending[0]!({ control: { ...control(), automationEpoch: 'old-released' }, released: true }));
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
  await act(async () => stop().click());
  expect(mocks.stop).toHaveBeenLastCalledWith(desktop.id, 'new-epoch');
  await act(async () => { mocks.host += 1; for (const listener of mocks.listeners) listener(); });
  await emit(1, { ...next, automationEpoch: 'other-host-epoch' });
  await act(async () => pending[1]!({ control: control(), released: true }));
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
  await act(async () => stop().click());
  expect(mocks.stop).toHaveBeenLastCalledWith(desktop.id, 'other-host-epoch');
  expect(mocks.localStop).not.toHaveBeenCalled();
});

it.each(['takeover', 'handback'] as const)('keeps newer unconfirmed control over a late %s reply', async action => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  await act(async () => { root = createRoot(container); root.render(<ComputerDesktopPane desktop={desktop} />); });
  await emit(0, control());
  const button = (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent === `settings.computers.view.${name}`)!;
  if (action === 'handback') {
    mocks.takeover.mockImplementation(async (_id: string, viewer: string) => ({ control: { ...control(), owner: 'human', holderId: viewer, automationEpoch: 'human-epoch' }, released: true, cancelled: 0 }));
    await act(async () => button('takeover').click());
  }
  let finish!: (value: { control: ComputerControlState }) => void;
  mocks[action].mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button(action).click());
  const viewer = mocks.takeover.mock.calls[0]![1] as string;
  await emit(0, { ...control(), owner: action === 'takeover' ? 'human' : 'agent', holderId: viewer, automationEpoch: 'new-epoch', workStatus: 'cancel-unconfirmed' });
  await act(async () => finish({ control: { ...control(), owner: action === 'takeover' ? 'human' : 'agent', holderId: viewer, automationEpoch: 'old-epoch' } }));
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
  expect(container.textContent).toContain('computer.automation.stop');
});

it('does not publish a late takeover error over a newer control observation', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  await act(async () => { root = createRoot(container); root.render(<ComputerDesktopPane desktop={desktop} />); });
  await emit(0, control());
  let fail!: (error: Error) => void;
  mocks.takeover.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'settings.computers.view.takeover')!.click());
  await emit(0, { ...control(), automationEpoch: 'new-epoch', workStatus: 'cancel-unconfirmed' });
  await act(async () => fail(new Error('obsolete takeover failure')));
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
  expect(container.textContent).not.toContain('obsolete takeover failure');
});
