import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import { ResearchFactsPanel } from './ResearchFactsPanel';
import { HarnessThreadStateContext, type HarnessThreadStateValue } from '@/components/pi-session/HarnessThreadStateContext';
import type { VarinEvent } from '@/lib/varinEvents';

const mocks = vi.hoisted(() => ({
  translate: (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
  ),
  listeners: new Set<(event: VarinEvent) => void>(),
}));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@varin/application-client')>()),
  runtimeFetch: vi.fn(),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/varinEvents', () => ({
  subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

const attempt = {
  attemptId: 'attempt-1',
  specId: 'spec-1',
  backend: 'local',
  machineId: 'local',
  state: 'running',
  collection: 'none',
  createdAt: 1,
};

const machine = {
  machineId: 'local',
  kind: 'local',
  state: 'available',
  connection: { status: 'connected', checkedAt: 1 },
  capacity: { cpuCores: 8, memoryMb: 32768, gpus: [{ index: 0, name: 'RTX 4090', memoryMb: 24576 }] },
  usage: { cpuPercent: 42, memoryMb: 4096, gpus: [{ index: 0, utilizationPercent: 68, usedMemoryMb: 4096 }], observedAt: 2, source: 'local-probe', stale: true },
  commitments: [{ commitmentId: 'c-1', machineId: 'local', attemptId: 'attempt-1', resources: {}, state: 'confirmed' }],
  queued: [{ attemptId: 'attempt-2', queuedAt: 3, reason: 'insufficient cpu' }],
};

const source = {
  sourceId: 'source-1',
  kind: 'dataset',
  label: 'fixtures',
  path: 'data/fixtures',
  state: 'available',
  createdAt: 1,
};

const factsResponse = (nextAttempt = attempt, nextMachine = machine) => {
  vi.mocked(runtimeFetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/experiments')) return new Response(JSON.stringify({ attempts: [nextAttempt], text: '' }), { status: 200 });
    if (url.endsWith('/resources')) return new Response(JSON.stringify({ machines: [nextMachine], generatedAt: 5, text: '' }), { status: 200 });
    if (url.endsWith('/sources')) return new Response(JSON.stringify({ sources: [source], text: '' }), { status: 200 });
    return new Response('not found', { status: 404 });
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

let root: Root;
let container: HTMLElement;

const state = (overrides: Partial<HarnessThreadStateValue> = {}): HarnessThreadStateValue => ({
  workspaceId: 'workspace-1',
  parent: { kind: 'session', id: 'session-1' },
  merge: vi.fn(),
  reload: vi.fn(async () => {}),
  threads: [],
  rootThreads: [],
  branches: [],
  loadError: null,
  ...overrides,
});

const render = async (value: HarnessThreadStateValue = state()) => {
  await act(async () => root.render(
    <HarnessThreadStateContext.Provider value={value}>
      <ResearchFactsPanel />
    </HarnessThreadStateContext.Provider>,
  ));
};

const emit = (event: VarinEvent) => {
  for (const listener of [...mocks.listeners]) listener(event);
};

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.listeners.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ResearchFactsPanel', () => {
  it('loads attempts, machines and sources through the session routes', async () => {
    factsResponse();
    await render();
    expect(vi.mocked(runtimeFetch).mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      '/api/harness/sessions/session-1/experiments',
      '/api/harness/sessions/session-1/resources',
      '/api/harness/sessions/session-1/sources',
    ]));
    const text = container.textContent ?? '';
    expect(text).toContain('attempt-1');
    expect(text).toContain('local');
    expect(text).toContain('queued');
    expect(text).toContain('research-facts.queued');
    expect(text).toContain('fixtures');
    expect(text).toContain('RTX 4090');
    expect(text).toContain('local-probe');
    expect(text).toContain('research-facts.stale');
  });

  it('shows managed target identity and coordinator ownership for queued remote work', async () => {
    const remoteAttempt = { ...attempt, backend: 'managed-remote', machineId: 'managed:host-1', state: 'queued' };
    const remoteMachine = {
      ...machine,
      machineId: 'managed:host-1',
      kind: 'managed-remote',
      target: {
        hostId: 'host-1',
        connectionId: 'connection-1',
        source: 'configured-host',
        capabilities: ['experiment', 'artifact-read'],
        coordinatorHostId: 'coordinator-1',
        acceptedJobsSurviveClientDisconnect: false,
        unassignedWorkRequiresCoordinator: true,
      },
    };
    factsResponse(remoteAttempt, remoteMachine);
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('host-1');
    expect(text).toContain('connection-1');
    expect(text).toContain('coordinator-1');
    expect(text).toContain('research-facts.awaitingCoordinator');
    expect(text).toContain('research-facts.targetSource.configured-host');
  });

  it('keeps an accepted remote run independent from the coordinator host location', async () => {
    const remoteAttempt = { ...attempt, backend: 'managed-remote', machineId: 'managed:host-1', state: 'running' };
    const remoteMachine = {
      ...machine,
      machineId: 'managed:host-1',
      kind: 'managed-remote',
      target: {
        hostId: 'host-1',
        connectionId: 'connection-1',
        source: 'configured-host',
        capabilities: ['experiment'],
        coordinatorHostId: 'local',
        acceptedJobsSurviveClientDisconnect: true,
        unassignedWorkRequiresCoordinator: false,
      },
    };
    factsResponse(remoteAttempt, remoteMachine);
    await render();
    expect(container.textContent ?? '').toContain('research-facts.remoteAccepted');
  });

  it('reloads when a harness-experiment-changed event matches the workspace', async () => {
    factsResponse();
    await render();
    const before = vi.mocked(runtimeFetch).mock.calls.length;
    await act(async () => emit({ type: 'harness-experiment-changed', workspaceId: 'other-workspace', fact: 'attempt' }));
    expect(vi.mocked(runtimeFetch).mock.calls.length).toBe(before);
    await act(async () => emit({ type: 'harness-experiment-changed', workspaceId: 'workspace-1', fact: 'attempt' }));
    expect(vi.mocked(runtimeFetch).mock.calls.length).toBeGreaterThan(before);
  });

  it('posts cancel for an active attempt through the session route', async () => {
    factsResponse();
    await render();
    const cancelButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.cancel');
    expect(cancelButton).toBeTruthy();
    vi.mocked(runtimeFetch).mockClear();
    factsResponse();
    await act(async () => { cancelButton!.click(); });
    const cancelCall = vi.mocked(runtimeFetch).mock.calls.find(([input]) => String(input).endsWith('/cancel'));
    expect(cancelCall).toBeTruthy();
    expect(String(cancelCall![0])).toBe('/api/harness/sessions/session-1/experiments/attempt-1/cancel');
    expect((cancelCall![1] as RequestInit).method).toBe('POST');
  });

  it('reruns a failed attempt through the real rerun route', async () => {
    const failed = { ...attempt, state: 'failed' };
    factsResponse(failed);
    await render();
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/rerun')) {
        return new Response(JSON.stringify({ spec: { specId: 'spec-1' }, attempt: { ...failed, attemptId: 'attempt-2', state: 'submitted', retryOfAttemptId: 'attempt-1' }, text: 'rerun' }));
      }
      if (url.endsWith('/experiments')) return new Response(JSON.stringify({ attempts: [failed] }));
      if (url.endsWith('/resources')) return new Response(JSON.stringify({ machines: [], generatedAt: 6 }));
      if (url.endsWith('/sources')) return new Response(JSON.stringify({ sources: [] }));
      return new Response('not found', { status: 404 });
    });
    const rerunButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.rerun');
    expect(rerunButton).toBeTruthy();
    await act(async () => rerunButton!.click());
    const rerunCall = vi.mocked(runtimeFetch).mock.calls.find(([input]) => String(input).endsWith('/rerun'));
    expect(rerunCall).toBeTruthy();
    expect((rerunCall![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((rerunCall![1] as RequestInit).body))).toEqual(expect.objectContaining({ requestId: expect.any(String) }));
  });

  it('cancels selected attempts through the batch route', async () => {
    factsResponse();
    await render();
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/cancel-many')) return new Response(JSON.stringify({ items: [{ attemptId: 'attempt-1', ok: true, attempt: { ...attempt, state: 'stopping' } }] }));
      if (url.endsWith('/experiments')) return new Response(JSON.stringify({ attempts: [attempt] }));
      if (url.endsWith('/resources')) return new Response(JSON.stringify({ machines: [], generatedAt: 6 }));
      if (url.endsWith('/sources')) return new Response(JSON.stringify({ sources: [] }));
      return new Response('not found', { status: 404 });
    });
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    const cancelSelected = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.cancelSelected');
    expect(cancelSelected).toBeTruthy();
    await act(async () => cancelSelected!.click());
    const cancelCall = vi.mocked(runtimeFetch).mock.calls.find(([input]) => String(input).endsWith('/cancel-many'));
    expect(cancelCall).toBeTruthy();
    expect(JSON.parse(String((cancelCall![1] as RequestInit).body))).toEqual({ attemptIds: ['attempt-1'] });
  });

  it('ignores an older reload after switching sessions', async () => {
    factsResponse();
    await render();
    const oldResponses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let oldIndex = 0;
    vi.mocked(runtimeFetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/sessions/session-1/')) return oldResponses[oldIndex++].promise;
      if (url.endsWith('/experiments')) return Promise.resolve(new Response(JSON.stringify({ attempts: [{ ...attempt, attemptId: 'attempt-2' }] })));
      if (url.endsWith('/resources')) return Promise.resolve(new Response(JSON.stringify({ machines: [], generatedAt: 6 })));
      if (url.endsWith('/sources')) return Promise.resolve(new Response(JSON.stringify({ sources: [] })));
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    await act(async () => emit({ type: 'harness-experiment-changed', workspaceId: 'workspace-1', fact: 'attempt' }));
    await render(state({ parent: { kind: 'session', id: 'session-2' } }));
    await act(async () => {
      oldResponses[0].resolve(new Response(JSON.stringify({ attempts: [attempt] })));
      oldResponses[1].resolve(new Response(JSON.stringify({ machines: [machine], generatedAt: 5 })));
      oldResponses[2].resolve(new Response(JSON.stringify({ sources: [source] })));
    });
    expect(container.textContent ?? '').toContain('attempt-2');
    expect(container.textContent ?? '').not.toContain('attempt-1');
  });

  it('keeps previous facts visible and reports a refresh failure', async () => {
    factsResponse();
    await render();
    vi.mocked(runtimeFetch).mockRejectedValue(new Error('network down'));
    await act(async () => emit({ type: 'stream-ready' }));
    expect(container.textContent ?? '').toContain('attempt-1');
    expect(container.textContent ?? '').toContain('research-facts.refreshFailed');
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('expands one attempt for logs and artifact download entry', async () => {
    factsResponse();
    await render();
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/experiments/attempt-1')) {
        return new Response(JSON.stringify({ attempt, artifacts: [{ artifactId: 'artifact-1', attemptId: 'attempt-1', name: 'result.bin', kind: 'file', state: 'available', byteLength: 3 }] }));
      }
      if (url.includes('/logs?')) {
        return new Response(JSON.stringify({ attemptId: 'attempt-1', stream: 'stdout', offset: 0, nextOffset: 3, eof: true, text: 'out', origin: 'artifact' }));
      }
      if (url.includes('/artifacts/artifact-1')) return new Response(new Blob(['bin']));
      return new Response('not found', { status: 404 });
    });
    const detailsButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.viewDetails');
    expect(detailsButton).toBeTruthy();
    await act(async () => detailsButton!.click());
    expect(container.textContent ?? '').toContain('result.bin');
    expect(vi.mocked(runtimeFetch).mock.calls.some(([input]) => String(input).endsWith('/experiments/attempt-1'))).toBe(true);
    const loadButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.loadLog');
    expect(loadButton).toBeTruthy();
    await act(async () => loadButton!.click());
    expect(vi.mocked(runtimeFetch).mock.calls.some(([input]) => String(input).includes('/experiments/attempt-1/logs?'))).toBe(true);
  });

  it('does not offer download for an unavailable remote artifact', async () => {
    factsResponse();
    await render();
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/experiments/attempt-1')) {
        return new Response(JSON.stringify({
          attempt,
          artifacts: [{
            artifactId: 'remote-artifact',
            attemptId: 'attempt-1',
            name: 'remote.bin',
            kind: 'file',
            state: 'available',
            remote: {
              machineId: 'managed:host-1',
              outputId: 'output-1',
              path: '/srv/varin/output/remote.bin',
              retainedBy: 'execution-target',
              accessible: 'unreachable',
            },
          }],
        }));
      }
      return new Response('not found', { status: 404 });
    });
    const detailsButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.viewDetails');
    await act(async () => detailsButton!.click());
    const text = container.textContent ?? '';
    expect(text).toContain('/srv/varin/output/remote.bin');
    expect(text).toContain('research-facts.remoteUnreachable');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'research-facts.download')).toBe(false);
  });

  it('ignores a log response from a details controller replaced by an attempt refresh', async () => {
    factsResponse();
    await render();
    const pendingLog = deferred<Response>();
    const refreshed = { ...attempt, state: 'completed' };
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/experiments')) return new Response(JSON.stringify({ attempts: [refreshed] }));
      if (url.endsWith('/resources')) return new Response(JSON.stringify({ machines: [], generatedAt: 6 }));
      if (url.endsWith('/sources')) return new Response(JSON.stringify({ sources: [] }));
      if (url.endsWith('/experiments/attempt-1')) return new Response(JSON.stringify({ attempt: refreshed, artifacts: [] }));
      if (url.includes('/logs?')) return pendingLog.promise;
      return new Response('not found', { status: 404 });
    });
    const detailsButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.viewDetails');
    await act(async () => detailsButton!.click());
    const loadButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.loadLog');
    await act(async () => loadButton!.click());
    await act(async () => emit({ type: 'harness-experiment-changed', workspaceId: 'workspace-1', fact: 'attempt' }));
    await act(async () => pendingLog.resolve(new Response(JSON.stringify({ attemptId: 'attempt-1', stream: 'stdout', offset: 0, nextOffset: 5, eof: true, text: 'stale-log', origin: 'live' }))));
    expect(container.textContent ?? '').not.toContain('stale-log');
  });

  it('does not offer collect for a lost attempt', async () => {
    factsResponse({ ...attempt, state: 'lost' });
    await render();
    expect(container.textContent ?? '').toContain('research-facts.attempt.lost');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'research-facts.collect')).toBe(false);
  });

  it('keeps artifacts returned by collect available for the selected attempt', async () => {
    const completed = { ...attempt, state: 'completed' };
    const collected = { ...completed, collection: 'done' };
    factsResponse(completed);
    await render();
    const artifact = { artifactId: 'artifact-collect', attemptId: 'attempt-1', name: 'collected.txt', kind: 'file', state: 'available', byteLength: 4 };
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/collect')) return new Response(JSON.stringify({ attempt: collected, artifacts: [artifact] }));
      if (url.endsWith('/experiments')) return new Response(JSON.stringify({ attempts: [collected] }));
      if (url.endsWith('/resources')) return new Response(JSON.stringify({ machines: [], generatedAt: 6 }));
      if (url.endsWith('/sources')) return new Response(JSON.stringify({ sources: [] }));
      if (url.endsWith('/experiments/attempt-1')) return new Response(JSON.stringify({ attempt: collected, artifacts: [{ ...artifact, artifactId: 'old-artifact', name: 'old.txt' }] }));
      return new Response('not found', { status: 404 });
    });
    const collectButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.collect');
    expect(collectButton).toBeTruthy();
    await act(async () => collectButton!.click());
    const detailsButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'research-facts.viewDetails');
    await act(async () => detailsButton!.click());
    expect(container.textContent ?? '').toContain('collected.txt');
    expect(container.textContent ?? '').not.toContain('old.txt');
  });

  it('renders nothing when the session has no harness workspace', async () => {
    vi.mocked(runtimeFetch).mockResolvedValue(new Response('not found', { status: 404 }));
    await render(state({ workspaceId: '' }));
    expect(container.textContent ?? '').toBe('');
    expect(vi.mocked(runtimeFetch)).not.toHaveBeenCalled();
  });
});
