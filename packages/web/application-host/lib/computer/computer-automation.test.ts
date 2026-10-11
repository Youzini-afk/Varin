import { describe, expect, it, vi } from 'vitest';
import type { ComputerActor } from '@varin/protocol';
import { createComputerAutomation } from './computer-automation.js';

const work = (sessionId: string) => ({ runtime: 'pi' as const, sessionId });
const actor = (sessionId: string, readOnly = false, rootSessionId = 'main'): ComputerActor => ({
  execution: { work: work(sessionId), runId: `${sessionId}:run` }, rootWork: work(rootSessionId),
  rootExecution: { work: work(rootSessionId), runId: `${rootSessionId}:run` },
  registry: { scopeId: 'scope', threadId: sessionId }, label: sessionId, roleAccess: { kind: 'pi-role', readOnly } });
function fixture() {
  const actors = new Map(['main', 'worker', 'lookup'].map(id => [id, actor(id, id === 'lookup')]));
  const release = vi.fn(async () => ({ released: true }));
  const notify = vi.fn(async () => {}), revoke = vi.fn(async () => {});
  const resolveActor = vi.fn(async (ref: import('@varin/protocol').ComputerWorkRef) => actors.get(ref.runtime === 'pi' ? ref.sessionId : '') ?? null);
  const coordinator = createComputerAutomation({ resolveActor,
    resolveScope: async ref => { const a = actors.get(ref.runtime === 'pi' ? ref.sessionId : '')!; return { work: ref, rootWork: a.rootWork, currentExecution: a.execution, currentRootExecution: a.rootExecution }; }, release,
    controlAvailable: () => true, notify, revokeSession: revoke, bindDesktop: async () => {}, onChange: () => {} });
  return { actors, release, notify, revoke, coordinator, resolveActor };
}
describe('Computer Use execution and physical desktop ownership', () => {
  it('requires child requests, wakes the main thread once, waits on events, and coordinates the main thread too', async () => {
    const { coordinator: c, notify } = fixture();
    await expect(c.authorize(work('worker'), 'observe', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
    const request = await c.request(work('worker'), 'desktop', 'control', 'Finish a dialog');
    expect((await c.request(work('worker'), 'desktop', 'control', 'Finish a dialog')).id).toBe(request.id);
    expect(notify).toHaveBeenCalledTimes(1);
    const waited = c.wait(work('worker'), request.id, new AbortController().signal);
    await c.decide(work('main'), request.id, true);
    expect((await waited).status).toBe('granted');
    await c.authorize(work('worker'), 'control', 'desktop', async () => {});
    await expect(c.authorize(work('main'), 'control', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await c.authorize(work('main'), 'control', 'other-vm', async () => {});
    await c.release(work('worker'));
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
  });
  it('lets retrieval observe alongside a writer but never grant itself control', async () => {
    const { coordinator: c } = fixture();
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
    const request = await c.request(work('lookup'), 'desktop', 'observe', 'Read the current UI');
    await c.decide(work('main'), request.id, true);
    await c.authorize(work('lookup'), 'observe', 'desktop', async () => {});
    await expect(c.authorize(work('lookup'), 'control', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await expect(c.request(work('lookup'), 'other-vm', 'control', 'Write')).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await expect(c.decide(work('worker'), request.id, true)).rejects.toMatchObject({ harnessCode: 'forbidden' });
  });
  it('keeps requests made while the main thread was idle visible after it wakes', async () => {
    const { coordinator: c, actors } = fixture();
    actors.set('worker', { ...actor('worker'), rootExecution: null });
    const request = await c.request(work('worker'), 'desktop', 'control', 'Continue UI work');
    expect((await c.snapshot(work('main'))).requests).toContainEqual(expect.objectContaining({ id: request.id, status: 'pending' }));
  });
  it('cancels active tickets and scripts, then permits fresh work in the same run', async () => {
    const { coordinator: c, revoke, notify } = fixture();
    let resume!: () => void;
    let admitted!: () => void;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const active = c.authorize(work('main'), 'control', 'desktop', async () => {
      const ticket = c.context.getStore()!; admitted(); await new Promise<void>(resolve => { resume = resolve; }); ticket.assert();
    });
    const failed = expect(active).rejects.toBeDefined();
    await ready; expect(await c.stop(actor('main').execution)).toMatchObject({ status: 'enabled', active: false }); resume(); await failed;
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ execution: actor('main').execution }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ execution: actor('main').execution }), expect.stringContaining('user manually cancelled'), false, expect.any(String));
    await c.authorize(work('main'), 'observe', 'desktop', async () => {});
    expect((await c.request(work('worker'), 'desktop', 'control', 'Fresh work')).status).toBe('pending');
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
  });
  it('keeps a failed release visibly unconfirmed until retry succeeds', async () => {
    const { coordinator: c, release } = fixture();
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
    release.mockResolvedValueOnce({ released: false });
    expect((await c.stop(actor('main').execution)).status).toBe('cancel-unconfirmed');
    expect((await c.stop(actor('main').execution)).status).toBe('enabled');
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('coordinates physical desktops across Host origins and revokes opaque assignments on takeover', async () => {
    const { coordinator: c } = fixture();
    const first = await c.claim('host-a:lifetime', 'first', actor('main'), 'desktop', 'control');
    const observer = await c.claim('host-b:lifetime', 'observe', actor('lookup', true), 'desktop', 'observe');
    await c.delegated(observer, 'desktop', 'observe', async () => {});
    await expect(c.claim('host-b:lifetime', 'second', actor('main'), 'desktop', 'control')).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await expect(c.authorize(work('main'), 'control', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await c.dropClaim('host-b:lifetime', 'observe', actor('lookup', true), 'desktop', 'observe');
    await c.delegated(first, 'desktop', 'control', async () => {});
    c.resetDesktop('desktop');
    await expect(c.delegated(first, 'desktop', 'control', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await c.claim('host-b:lifetime', 'fresh', actor('main'), 'desktop', 'control');
  });
  it('fences a delayed remote claim after release and permits a fresh work segment', async () => {
    const { coordinator: c } = fixture();
    await c.dropClaim('peer', 'delayed', actor('main'), 'desktop', 'control');
    await expect(c.claim('peer', 'delayed', actor('main'), 'desktop', 'control')).rejects.toMatchObject({ harnessCode: 'forbidden' });
    const token = await c.claim('peer', 'fresh', actor('main'), 'desktop', 'control');
    await c.dropClaim('peer', 'delayed', actor('main'), 'desktop', 'control');
    await c.delegated(token, 'desktop', 'control', async () => {});
  });
  it('exact child Stop fences an earlier resolve even when the same Run receives a fresh grant', async () => {
    const { coordinator: c, resolveActor } = fixture();
    const initial = await c.request(work('worker'), 'desktop', 'control', 'initial');
    await c.decide(work('main'), initial.id, true);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    resolveActor.mockImplementationOnce(async () => { await gate; return actor('worker'); });
    const execute = vi.fn(async () => {});
    const old = c.authorize(work('worker'), 'control', 'desktop', execute);
    const rejected = expect(old).rejects.toThrow(/cancelled before admission/);
    await c.stop(actor('worker').execution);
    const fresh = await c.request(work('worker'), 'desktop', 'control', 'fresh');
    await c.decide(work('main'), fresh.id, true);
    resume(); await rejected; expect(execute).not.toHaveBeenCalled();
    await c.authorize(work('worker'), 'control', 'desktop', async () => {});
  });
  it('an ended local execution cannot terminate a peer with the same real identity', async () => {
    const { coordinator: c } = fixture();
    await c.finishRun(actor('main').execution);
    const token = await c.claim('peer-host', 'assignment', actor('main'), 'desktop', 'control');
    await c.delegated(token, 'desktop', 'control', async () => {});
    await c.dropClaim('other-host', 'assignment', actor('main'), 'desktop', 'control');
    await c.delegated(token, 'desktop', 'control', async () => {});
  });
  it('old execution cleanup stays exact after a new current Run starts', async () => {
    const { coordinator: c, actors } = fixture();
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
    const original = actor('main').execution;
    const newer = { ...actor('main'), execution: { work: work('main'), runId: 'new' }, rootExecution: { work: work('main'), runId: 'new' } };
    actors.set('main', newer);
    expect((await c.snapshot(work('main'))).cleanups).toContainEqual({ execution: original, desktopId: 'desktop', status: 'cancel-unconfirmed' });
    await c.stop(original);
    await c.authorize(work('main'), 'control', 'desktop', async () => {});
    await expect(c.stop(original)).rejects.toMatchObject({ computerCode: 'computer-execution-stale' });
    expect(c.controller('desktop')?.execution.runId).toBe('new');
  });

});

describe('Catalog-backed Native assignments', () => {
  const native = (threadId: string, runId = `${threadId}:run`, rootRun = 'main:run'): ComputerActor => {
    const work = { runtime: 'agent' as const, threadId, branchId: `${threadId}:branch` };
    const rootWork = { runtime: 'agent' as const, threadId: 'main', branchId: 'main:branch' };
    return { execution: { work, runId }, rootWork, rootExecution: { work: rootWork, runId: rootRun }, registry: null, label: threadId, roleAccess: { kind: 'tool-invocation' } };
  };
  function nativeFixture() {
    const actors = new Map(['main', 'worker'].map(id => [id, native(id)]));
    const release = vi.fn(async () => ({ released: true }));
    const cancel = vi.fn(async () => {});
    const c = createComputerAutomation({
      resolveActor: async work => work.runtime === 'agent' ? actors.get(work.threadId) ?? null : null,
      resolveScope: async work => { const actor = work.runtime === 'agent' ? actors.get(work.threadId) : null; return actor ? { work, rootWork: actor.rootWork, currentExecution: actor.execution, currentRootExecution: actor.rootExecution } : null; },
      release, controlAvailable: () => true, notify: async () => {}, revokeSession: async () => {}, bindDesktop: async () => {}, onChange: () => {},
    });
    c.attachRequests({ snapshot: async () => [], cancel });
    return { c, actors, release, cancel };
  }
  it('retains a child assignment across root completion and a new root Run, and releases observation without control', async () => {
    const { c, actors, release } = nativeFixture();
    const child = native('worker'), root = native('main');
    await c.grantRequest(child.execution, child.rootWork, root.execution, 'desktop', 'observe', 'request-assignment');
    await expect(c.authorize(child.execution.work, 'observe', 'desktop', async () => {})).rejects.toThrow(/assignment-unavailable/);
    c.confirmRequest('request-assignment');
    await c.finishRun(root.execution);
    actors.set('main', native('main', 'main:new', 'main:new'));
    actors.set('worker', native('worker', 'worker:run', 'main:new'));
    await c.authorize(child.execution.work, 'observe', 'desktop', async () => {});
    await expect(c.authorize(child.execution.work, 'control', 'desktop', async () => {})).rejects.toThrow(/assignment-unavailable/);
    expect((await c.snapshot(root.execution.work)).leases.map(lease => lease.id)).toEqual(['request-assignment']);
    expect(release).not.toHaveBeenCalled();
    await c.release(child.execution.work, 'desktop');
    expect(release).toHaveBeenCalledTimes(1);
    expect(c.assignmentState('request-assignment')).toBe('released');
  });
  it('captures an accepted grant callback in root Stop while allowing a later request from the same child Run', async () => {
    const { c, cancel } = nativeFixture();
    const child = native('worker'), root = native('main');
    let admitted!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const old = c.manage(child.execution.work, child.execution, async signal => {
      admitted(); await gate;
      return c.grantRequest(child.execution, child.rootWork, root.execution, 'desktop', 'control', 'old', signal);
    }, 'desktop');
    const rejected = expect(old).rejects.toThrow(/cancelled/);
    await started;
    await c.stop(root.execution, 'desktop');
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ execution: root.execution }), 'desktop', true);
    resume(); await rejected;
    expect(c.assignment('old')).toBeUndefined();
    await c.grantRequest(child.execution, child.rootWork, root.execution, 'desktop', 'control', 'fresh');
    c.confirmRequest('fresh');
    await c.authorize(child.execution.work, 'control', 'desktop', async () => {});
  });
  it('starts captured physical-marker cleanup even while Catalog cancellation is still pending', async () => {
    const child = native('worker');
    let stopped!: () => void, acknowledge!: () => void;
    const physical = new Promise<void>(resolve => { stopped = resolve; });
    const catalog = new Promise<void>(resolve => { acknowledge = resolve; });
    const cleanup = vi.fn(async () => { stopped(); });
    const c = createComputerAutomation({
      resolveActor: async () => child,
      resolveScope: async work => ({ work, rootWork: child.rootWork, currentExecution: child.execution, currentRootExecution: child.rootExecution }),
      pendingReleases: () => [{ actor: child, desktopId: 'desktop' }],
      cancelWork: cleanup, release: async () => ({ released: false }), controlAvailable: () => false,
      notify: async () => {}, revokeSession: async () => {}, bindDesktop: async () => {}, onChange: () => {},
    });
    c.attachRequests({ snapshot: async () => [], cancel: async () => catalog });
    const stopping = c.stop(child.execution, 'desktop');
    await physical;
    expect(cleanup).toHaveBeenCalledWith(child, ['desktop'], expect.any(String));
    acknowledge(); await stopping;
  });

});
