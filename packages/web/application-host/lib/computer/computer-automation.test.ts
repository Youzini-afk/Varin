import { describe, expect, it, vi } from 'vitest';
import type { ComputerActor } from '@varin/protocol';
import { createComputerAutomation } from './computer-automation.js';

const actor = (sessionId: string, readOnly = false, rootSessionId = 'main'): ComputerActor => ({ sessionId, runId: `${sessionId}:run`, threadId: sessionId,
  scopeId: 'scope', rootSessionId, rootRunId: `${rootSessionId}:run`, label: sessionId, readOnly });
function fixture() {
  const actors = new Map(['main', 'worker', 'lookup'].map(id => [id, actor(id, id === 'lookup')]));
  const release = vi.fn(async () => ({ released: true }));
  const notify = vi.fn(async () => {}), revoke = vi.fn(async () => {});
  const coordinator = createComputerAutomation({ resolveActor: async id => actors.get(id) ?? null, release,
    controlAvailable: () => true, notify, revokeSession: revoke, bindDesktop: async () => {}, onChange: () => {} });
  return { actors, release, notify, revoke, coordinator };
}
describe('Computer Use execution and physical desktop ownership', () => {
  it('requires child requests, wakes the main thread once, waits on events, and coordinates the main thread too', async () => {
    const { coordinator: c, notify } = fixture();
    await expect(c.authorize('worker', 'observe', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await c.authorize('main', 'control', 'desktop', async () => {});
    const request = await c.request('worker', 'desktop', 'control', 'Finish a dialog');
    expect((await c.request('worker', 'desktop', 'control', 'Finish a dialog')).id).toBe(request.id);
    expect(notify).toHaveBeenCalledTimes(1);
    const waited = c.wait('worker', request.id, new AbortController().signal);
    await c.decide('main', request.id, true);
    expect((await waited).status).toBe('granted');
    await c.authorize('worker', 'control', 'desktop', async () => {});
    await expect(c.authorize('main', 'control', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await c.authorize('main', 'control', 'other-vm', async () => {});
    await c.release('worker');
    await c.authorize('main', 'control', 'desktop', async () => {});
  });
  it('lets retrieval observe alongside a writer but never grant itself control', async () => {
    const { coordinator: c } = fixture();
    await c.authorize('main', 'control', 'desktop', async () => {});
    const request = await c.request('lookup', 'desktop', 'observe', 'Read the current UI');
    await c.decide('main', request.id, true);
    await c.authorize('lookup', 'observe', 'desktop', async () => {});
    await expect(c.authorize('lookup', 'control', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await expect(c.request('lookup', 'other-vm', 'control', 'Write')).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await expect(c.decide('worker', request.id, true)).rejects.toMatchObject({ harnessCode: 'forbidden' });
  });
  it('keeps requests made while the main thread was idle visible after it wakes', async () => {
    const { coordinator: c, actors } = fixture();
    actors.set('worker', { ...actor('worker'), rootRunId: 'idle:main' });
    const request = await c.request('worker', 'desktop', 'control', 'Continue UI work');
    expect((await c.snapshot('main')).requests).toContainEqual(expect.objectContaining({ id: request.id, status: 'pending' }));
  });
  it('cancels active tickets and scripts, then permits fresh work in the same run', async () => {
    const { coordinator: c, revoke, notify } = fixture();
    let resume!: () => void;
    let admitted!: () => void;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const active = c.authorize('main', 'control', 'desktop', async () => {
      const ticket = c.context.getStore()!; admitted(); await new Promise<void>(resolve => { resume = resolve; }); ticket.assert();
    });
    const failed = expect(active).rejects.toBeDefined();
    await ready; expect(await c.stop('main')).toMatchObject({ status: 'enabled', active: false }); resume(); await failed;
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'main', runId: 'main:run' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'main' }), expect.stringContaining('user manually cancelled'), false, expect.any(String));
    await c.authorize('main', 'observe', 'desktop', async () => {});
    expect((await c.request('worker', 'desktop', 'control', 'Fresh work')).status).toBe('pending');
    await c.authorize('main', 'control', 'desktop', async () => {});
  });
  it('keeps a failed release visibly unconfirmed until retry succeeds', async () => {
    const { coordinator: c, release } = fixture();
    await c.authorize('main', 'control', 'desktop', async () => {});
    release.mockResolvedValueOnce({ released: false });
    expect((await c.stop('main')).status).toBe('cancel-unconfirmed');
    expect((await c.stop('main')).status).toBe('enabled');
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('coordinates physical desktops across Host origins and revokes opaque assignments on takeover', async () => {
    const { coordinator: c } = fixture();
    const first = await c.claim('host-a:lifetime', 'first', actor('main'), 'desktop', 'control');
    const observer = await c.claim('host-b:lifetime', 'observe', actor('lookup', true), 'desktop', 'observe');
    await c.delegated(observer, 'desktop', 'observe', async () => {});
    await expect(c.claim('host-b:lifetime', 'second', actor('main'), 'desktop', 'control')).rejects.toMatchObject({ harnessCode: 'forbidden' });
    await expect(c.authorize('main', 'control', 'desktop', async () => {})).rejects.toMatchObject({ harnessCode: 'forbidden' });
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
});
