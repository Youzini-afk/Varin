import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ComputerAutomationProjection } from '@varin/protocol';
import { createThreadsHttpAPI, ThreadRequestError } from '../src/threads-http.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';

const identity = { runtime: 'agent' as const, threadId: 'same', branchId: 'branch' };
const projection: ComputerAutomationProjection = { state: { work: identity, rootWork: identity,
  currentExecution: null, currentRootExecution: null, active: true, status: 'cancel-unconfirmed',
  leases: [], requests: [], cleanups: [{ execution: { work: identity, runId: 'old-run' }, desktopId: 'desktop', status: 'cancel-unconfirmed' }] }, activities: [] };

it('reads original idle cleanup and submits the exact displayed execution through the thread envelope', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  let denied = false;
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return denied ? Response.json({ code: 'computer_execution_unavailable' }, { status: 409 })
      : Response.json(String(input).endsWith('/state') ? projection : { state: projection.state });
  };
  try {
    const api = createThreadsHttpAPI().computer;
    const controller = new AbortController();
    assert.deepEqual(await api.state(identity, controller.signal), projection);
    assert.deepEqual(await api.stop(identity, { runId: 'old-run', desktopId: 'desktop' }), { state: projection.state });
    assert.equal(calls[0]!.path, '/api/threads/computer/state');
    assert.deepEqual(calls[0]!.body, identity);
    assert.equal(calls[0]!.signal, controller.signal);
    assert.equal(calls[1]!.path, '/api/threads/computer/stop');
    assert.deepEqual(calls[1]!.body, { ...identity, runId: 'old-run', desktopId: 'desktop' });
    denied = true;
    await assert.rejects(api.stop(identity, { runId: 'old-run' }), error => error instanceof ThreadRequestError
      && error.code === 'computer_execution_unavailable' && error.status === 409);
  } finally { globalThis.fetch = original; }
});

it('rejects late computer reads and stop responses after abort or Host change', async () => {
  const original = globalThis.fetch;
  let release!: (value: unknown) => void;
  globalThis.fetch = async input => String(input).includes('/auth/')
    ? Response.json({ token: 'test', expiresAt: Date.now() + 60_000 })
    : { ok: true, json: () => new Promise(resolve => { release = resolve; }) } as Response;
  try {
    const api = createThreadsHttpAPI().computer;
    const controller = new AbortController();
    const read = api.state(identity, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); release(projection);
    await assert.rejects(read, { name: 'AbortError' });
    const stop = api.stop(identity, { runId: 'old-run' });
    await new Promise(resolve => setImmediate(resolve));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://next-computer-host.test', runtimeKey: 'next-computer-host' });
    release({ state: projection.state });
    await assert.rejects(stop, /Application Host changed/);
  } finally { globalThis.fetch = original; }
});
