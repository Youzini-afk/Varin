import { describe, expect, it, vi } from 'vitest';
import type { ComputerActor } from '@varin/protocol';
import { createComputerAutomation } from './computer-automation.js';

describe('Catalog-backed Native assignments', () => {
  const native = (threadId: string, runId = `${threadId}:run`, rootRun = 'main:run'): ComputerActor => {
    const work = { runtime: 'agent' as const, threadId, branchId: `${threadId}:branch` };
    const rootWork = { runtime: 'agent' as const, threadId: 'main', branchId: 'main:branch' };
    return { execution: { work, runId }, rootWork, rootExecution: { work: rootWork, runId: rootRun }, label: threadId };
  };
  function nativeFixture() {
    const actors = new Map(['main', 'worker'].map(id => [id, native(id)]));
    const release = vi.fn(async () => ({ released: true }));
    const cancel = vi.fn(async () => {});
    const c = createComputerAutomation({
      resolveActor: async work => work.runtime === 'agent' ? actors.get(work.threadId) ?? null : null,
      resolveScope: async work => { const actor = work.runtime === 'agent' ? actors.get(work.threadId) : null; return actor ? { work, rootWork: actor.rootWork, currentExecution: actor.execution, currentRootExecution: actor.rootExecution } : null; },
      release, controlAvailable: () => true, cancelExecutor: async () => {}, onChange: () => {},
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
      cancelExecutor: async () => {}, onChange: () => {},
    });
    c.attachRequests({ snapshot: async () => [], cancel: async () => catalog });
    const stopping = c.stop(child.execution, 'desktop');
    await physical;
    expect(cleanup).toHaveBeenCalledWith(child, ['desktop'], expect.any(String));
    acknowledge(); await stopping;
  });

});
