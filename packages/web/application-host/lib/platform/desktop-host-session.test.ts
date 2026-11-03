import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostSession, type ManagedDesktopHostController } from './desktop-host-session.js';
import { desktopHostEnvelope, type DesktopHostFrame } from '../../desktop-host-protocol.js';
import type { StartWebUiServerOptions } from '../../public-contract.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<ManagedDesktopHostController> = {}) {
  const frames: DesktopHostFrame[] = [];
  const exit = vi.fn();
  const controller: ManagedDesktopHostController = {
    getPort: () => 47123, getTunnelUrl: () => null, getQuitRiskStatus: async () => ({ scheduledTasks: {}, tunnel: { active: false } }),
    isReady: () => true, stop: vi.fn(async () => {}), getDesktopLocalCredentials: async () => ({ clientToken: 'private-existing-token' }), ...overrides,
  };
  let hooks!: StartWebUiServerOptions;
  const start = vi.fn(async (options: StartWebUiServerOptions) => { hooks = options; return controller; });
  const session = createDesktopHostSession({ start, serverOptions: { port: 0 }, send: async frame => { frames.push(frame); }, exit });
  return { frames, exit, controller, start, session, get hooks() { return hooks; } };
}
const request = (method: string, params?: unknown, id = 'shell:1') => ({ ...desktopHostEnvelope, kind: 'request', id, method, params });

describe('managed desktop Host lifecycle', () => {
  it('emits ready only after the original owner and credentials are ready', async () => {
    const credentials = deferred<{ clientToken: string }>();
    const f = fixture({ getDesktopLocalCredentials: () => credentials.promise });
    const starting = f.session.start();
    await Promise.resolve();
    expect(f.frames).toEqual([]);
    credentials.resolve({ clientToken: 'existing-identity' });
    await starting;
    expect(f.frames).toMatchObject([{ kind: 'event', event: 'ready', payload: { port: 47123, origin: 'http://127.0.0.1:47123', clientToken: 'existing-identity' } }]);
    expect(f.hooks.attachSignals).toBe(false);
    expect(f.hooks.exitOnShutdown).toBe(false);
  });

  it('does not report a stop or permit restart before real owner drain', async () => {
    const drain = deferred<void>();
    const f = fixture({ stop: vi.fn(() => drain.promise) });
    await f.session.start();
    const stopping = f.session.receive(request('stop'));
    await Promise.resolve();
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.frames.some(frame => frame.kind === 'response')).toBe(false);
    expect(f.session.phase).toBe('stopping');
    drain.resolve();
    await stopping;
    expect(f.frames.slice(-2)).toMatchObject([{ kind: 'event', event: 'stopped' }, { kind: 'response', ok: true, result: { stopped: true } }]);
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it('keeps a failed stop unsuccessful and never auto-restarts', async () => {
    const f = fixture({ stop: async () => { throw new Error('Executor exit not confirmed'); } });
    await f.session.start();
    await f.session.receive(request('stop'));
    expect(f.frames.at(-1)).toMatchObject({ kind: 'response', ok: false, error: { code: 'host_stop_failed' } });
    expect(f.frames.some(frame => frame.kind === 'event' && frame.event === 'stopped')).toBe(false);
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('a close during startup suppresses readiness but still drains the started owner', async () => {
    const begun = deferred<ManagedDesktopHostController>();
    const f = fixture();
    f.start.mockImplementation(() => begun.promise);
    const starting = f.session.start();
    const stopping = f.session.receive(request('stop'));
    begun.resolve(f.controller);
    await Promise.all([starting, stopping]);
    expect(f.frames.some(frame => frame.kind === 'event' && frame.event === 'ready')).toBe(false);
    expect(f.controller.stop).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it('rejects a lost shell callback as unknown and drains only once on EOF', async () => {
    const f = fixture();
    await f.session.start();
    const opening = Promise.resolve(f.hooks.openFilesystemPath!('/original/path'));
    const failure = expect(opening).rejects.toThrow('outcome is unknown');
    f.session.disconnect(); f.session.disconnect();
    await failure;
    await f.session.stop();
    expect(f.controller.stop).toHaveBeenCalledTimes(1);
    expect(f.frames.filter(frame => frame.kind === 'request')).toHaveLength(1);
  });

  it('matches callback replies without replay and validates message direction', async () => {
    const f = fixture(); await f.session.start();
    const opening = f.hooks.openFilesystemPath!('/original/path');
    const sent = f.frames.at(-1)!;
    expect(sent).toMatchObject({ kind: 'request', id: 'host:1', method: 'openFilesystemPath' });
    await f.session.receive({ ...desktopHostEnvelope, kind: 'response', id: 'host:1', ok: true, result: null });
    await opening;
    await expect(f.session.receive(request('stop', null, 'host:2'))).rejects.toThrow('direction');
    await expect(f.session.receive({ ...desktopHostEnvelope, kind: 'response', id: 'host:1', ok: true, result: null })).rejects.toThrow('Unknown');
  });

  it('routes computer controls only to the original active holder', async () => {
    const f = fixture(); await f.session.start();
    const takeover = vi.fn(async () => {});
    f.hooks.onComputerControlsReady!({ holderId: 'original-holder', takeover, handback: async () => {}, cancel: async () => {} });
    await f.session.receive(request('computerControl', { holderId: 'different-holder', action: 'takeover' }));
    expect(takeover).not.toHaveBeenCalled();
    await f.session.receive(request('computerControl', { holderId: 'original-holder', action: 'takeover' }));
    expect(takeover).toHaveBeenCalledTimes(1);
  });

  it('requests a clean restart only after drain, never before', async () => {
    const drain = deferred<void>(); const f = fixture({ stop: () => drain.promise });
    await f.session.start();
    const restarting = f.hooks.restartApplicationHost!();
    expect(f.frames.some(frame => frame.kind === 'event' && frame.event === 'restartRequested')).toBe(false);
    drain.resolve(); await restarting;
    expect(f.frames.at(-1)).toMatchObject({ kind: 'event', event: 'restartRequested' });
    expect(f.exit).toHaveBeenCalledWith(0);
  });
});
