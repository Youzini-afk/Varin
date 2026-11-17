import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExternalAccessRuntime, ExternalAccessRuntimeError,
  type ExternalAccessOpenContext, type ExternalAccessRecord, type ExternalAccessResource,
  type ExternalAccessRuntimeOptions,
} from './external-access-runtime.js';

type Configuration = { origin: string; token: string };
const config = (origin = 'https://example.test'): Configuration => ({ origin, token: 'private-token' });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };

function fixture(initial: Partial<ExternalAccessRecord<Configuration>> = {}) {
  let stored: ExternalAccessRecord<Configuration> = { revision: 0, config: null, enabled: false, ...initial };
  const events: string[] = [];
  const resources: Array<ExternalAccessResource & { context: ExternalAccessOpenContext; config: Configuration }> = [];
  const read = vi.fn(async () => structuredClone(stored));
  const compareAndSwap = vi.fn(async (expected: number, next: ExternalAccessRecord<Configuration>) => {
    if (expected !== stored.revision) return false;
    stored = structuredClone(next);
    events.push(`write:${stored.enabled}`);
    return true;
  });
  const makeResource = (context: ExternalAccessOpenContext, configuration: Configuration): ExternalAccessResource => {
    const resource = {
      context, config: configuration, state: 'enabled' as const,
      fence: vi.fn(() => { events.push('fence'); }),
      stop: vi.fn(async () => { events.push('stop'); }),
    };
    resources.push(resource);
    return resource;
  };
  const open = vi.fn(async (configuration: Configuration, context: ExternalAccessOpenContext) => {
    events.push(`open:${configuration.origin}`);
    return makeResource(context, configuration);
  });
  const options: ExternalAccessRuntimeOptions<Configuration> = {
    read, compareAndSwap, open,
    normalizeConfig: (input) => {
      const value = input as Configuration;
      if (!value || !value.origin?.startsWith('https://')) throw new Error('secret rejected input');
      return value;
    },
    retryDelaysMs: [10, 20],
  };
  const runtime = createExternalAccessRuntime(options);
  return { runtime, options, open, read, compareAndSwap, resources, events, makeResource,
    stored: () => structuredClone(stored), replace: (next: ExternalAccessRecord<Configuration>) => { stored = next; } };
}

afterEach(() => vi.useRealTimers());

describe('persistent external access lifecycle', () => {
  it('saves without enabling or opening and only restores saved enabled intent', async () => {
    const f = fixture();
    expect(await f.runtime.save(config(), 0)).toMatchObject({ revision: 1, enabled: false, state: 'disabled' });
    await f.runtime.start();
    expect(f.open).not.toHaveBeenCalled();
    await expect(f.runtime.retry(1)).rejects.toMatchObject({ code: 'not_enabled' });
    const restored = createExternalAccessRuntime(f.options);
    await restored.start();
    expect(f.open).not.toHaveBeenCalled();
    await f.runtime.enable(1);
    expect(f.stored()).toMatchObject({ enabled: true, revision: 2 });
    expect(f.open).toHaveBeenCalledOnce();
    await f.runtime.shutdown();
  });

  it('distinguishes a bound external backend from managed provider publication', async () => {
    const f = fixture({ enabled: true, config: config() });
    expect(await f.runtime.start()).toMatchObject({ state: 'enabled' });
    await f.runtime.shutdown();
    f.open.mockImplementationOnce(async (configuration, context) => ({ ...f.makeResource(context, configuration), state: 'connected' }));
    const restored = createExternalAccessRuntime(f.options);
    expect(await restored.start()).toMatchObject({ state: 'connected' });
    expect(f.stored().enabled).toBe(true);
    await restored.shutdown();
  });

  it('only publishes actual state changes; reading its snapshot is not an event loop', async () => {
    const f = fixture();
    const onStatus = vi.fn();
    const runtime = createExternalAccessRuntime({ ...f.options, onStatus });
    await runtime.start();
    await runtime.read();
    expect(onStatus).not.toHaveBeenCalled();
    await runtime.save(config(), 0);
    expect(onStatus).toHaveBeenCalledOnce();
    await runtime.read();
    expect(onStatus).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it('rejects cross-client stale writes without changing configuration or runtime', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.runtime.save(config('https://first.test'), 0),
      f.runtime.save(config('https://second.test'), 0),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'revision_conflict' } });
    expect(f.stored().config?.origin).toBe('https://first.test');
    f.compareAndSwap.mockResolvedValueOnce(false);
    await expect(f.runtime.enable(1)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('keeps the current generation on save and applies only on an explicit retry', async () => {
    const f = fixture({ enabled: true, config: config() });
    await f.runtime.start();
    await f.runtime.save(config('https://new.test'), 0);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.resources[0]?.fence).not.toHaveBeenCalled();
    expect(f.runtime.getStatus()).toMatchObject({ revision: 1, activeRevision: 0 });
    await f.runtime.retry(1);
    expect(f.events).toEqual(['open:https://example.test', 'write:true', 'fence', 'fence', 'stop', 'open:https://new.test']);
    expect(f.runtime.getStatus().activeRevision).toBe(1);
    await f.runtime.shutdown();
  });

  it('writes disabled intent before fencing and awaits actual resource teardown', async () => {
    const f = fixture({ enabled: true, config: config() });
    await f.runtime.start();
    const stopped = deferred<void>();
    vi.mocked(f.resources[0]!.stop).mockImplementationOnce(async () => { f.events.push('stop'); await stopped.promise; });
    let resolved = false;
    const disabling = f.runtime.disable(0).then((status) => { resolved = true; return status; });
    await flush();
    expect(f.stored().enabled).toBe(false);
    expect(f.events.slice(1)).toEqual(['write:false', 'fence', 'fence', 'stop']);
    expect(resolved).toBe(false);
    expect(f.runtime.getStatus().state).toBe('stopping');
    stopped.resolve();
    expect(await disabling).toMatchObject({ state: 'disabled', activeRevision: null });
  });

  it('fences shutdown synchronously without changing saved intent, and restores on restart', async () => {
    const f = fixture({ enabled: true, config: config(), revision: 3 });
    await f.runtime.start();
    const shutdown = f.runtime.shutdown();
    expect(f.resources[0]?.fence).toHaveBeenCalledOnce();
    expect(f.runtime.getStatus().state).toBe('stopping');
    await shutdown;
    expect(f.compareAndSwap).not.toHaveBeenCalled();
    expect(f.stored()).toMatchObject({ enabled: true, revision: 3 });
    const restarted = createExternalAccessRuntime(f.options);
    await restarted.start();
    expect(f.open).toHaveBeenCalledTimes(2);
    await restarted.shutdown();
  });

  it('can commit disable while an earlier open is pending, and closes a late result', async () => {
    const f = fixture({ config: config() });
    const pending = deferred<ExternalAccessResource>();
    let context: ExternalAccessOpenContext | undefined;
    f.open.mockImplementationOnce(async (_configuration, received) => { context = received; return pending.promise; });
    const enabling = f.runtime.enable(0);
    await flush();
    expect(context?.signal.aborted).toBe(false);
    const disabling = f.runtime.disable(1);
    await flush();
    expect(f.stored()).toMatchObject({ enabled: false, revision: 2 });
    expect(context?.signal.aborted).toBe(true);
    const late = f.makeResource(context!, config());
    pending.resolve(late);
    await Promise.all([enabling, disabling]);
    expect(late.stop).toHaveBeenCalledOnce();
    expect(f.runtime.getStatus()).toMatchObject({ state: 'disabled', enabled: false, activeRevision: null });
  });

  it('does not disconnect a working generation when persisting disable fails', async () => {
    const f = fixture({ config: config(), enabled: true });
    await f.runtime.start();
    f.compareAndSwap.mockRejectedValueOnce(new Error('secret database path'));
    await expect(f.runtime.disable(0)).rejects.toMatchObject({ code: 'persistence_failed' });
    expect(f.resources[0]?.fence).not.toHaveBeenCalled();
    expect(f.runtime.getStatus()).toMatchObject({ enabled: true, state: 'enabled' });
    await f.runtime.shutdown();
  });

  it('rolls failed replacement back to the previous runtime without overwriting saved desired config', async () => {
    const f = fixture({ config: config(), enabled: true });
    await f.runtime.start();
    await f.runtime.save(config('https://candidate.test'), 0);
    f.open.mockRejectedValueOnce(new ExternalAccessRuntimeError('port_in_use'));
    expect(await f.runtime.retry(1)).toMatchObject({
      revision: 1, activeRevision: 0, state: 'enabled',
      error: { code: 'port_in_use', retryable: false },
    });
    expect(f.open.mock.calls.map(([configuration]) => configuration.origin)).toEqual([
      'https://example.test', 'https://candidate.test', 'https://example.test',
    ]);
    expect(f.stored().config?.origin).toBe('https://candidate.test');
    await f.runtime.shutdown();
  });

  it.each(['invalid_config', 'authentication_failed', 'port_in_use', 'provider_in_use'] as const)('does not auto-retry %s or clear enabled intent', async (code) => {
    vi.useFakeTimers();
    const f = fixture({ config: config() });
    f.open.mockRejectedValue(new ExternalAccessRuntimeError(code));
    expect(await f.runtime.enable(0)).toMatchObject({ state: 'failed', enabled: true, error: { code, retryable: false } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.open).toHaveBeenCalledOnce();
    await f.runtime.shutdown();
  });

  it('keeps reconnecting at the final backoff until the network recovers', async () => {
    vi.useFakeTimers();
    const f = fixture({ config: config(), enabled: true });
    f.open.mockRejectedValue(new ExternalAccessRuntimeError('network_error'));
    expect(await f.runtime.start()).toMatchObject({ state: 'reconnecting', retryAttempt: 1 });
    await vi.advanceTimersByTimeAsync(30);
    expect(f.open).toHaveBeenCalledTimes(3);
    expect(f.runtime.getStatus()).toMatchObject({ state: 'reconnecting', retryAttempt: 3 });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.open).toHaveBeenCalledTimes(8);
    f.open.mockImplementation(async (configuration, context) => f.makeResource(context, configuration));
    await vi.advanceTimersByTimeAsync(20);
    expect(f.runtime.getStatus()).toMatchObject({ state: 'enabled', retryAttempt: 0 });
    await f.runtime.shutdown();
  });

  it('fences a real disconnect before recovery, and ignores stale provider callbacks', async () => {
    vi.useFakeTimers();
    const f = fixture({ config: config(), enabled: true });
    await f.runtime.start();
    f.resources[0]!.context.onDisconnected(new ExternalAccessRuntimeError('process_exited'));
    expect(f.resources[0]?.fence).toHaveBeenCalled();
    await flush();
    expect(f.runtime.getStatus()).toMatchObject({ state: 'reconnecting', activeRevision: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.open).toHaveBeenCalledTimes(2);
    f.resources[0]!.context.onDisconnected(new ExternalAccessRuntimeError('authentication_failed'));
    expect(f.runtime.getStatus()).toMatchObject({ state: 'enabled', error: null });
    await f.runtime.disable(0);
    f.resources[1]!.context.onDisconnected(new ExternalAccessRuntimeError('network_error'));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it.each(['disable', 'shutdown', 'save'] as const)('cancels a scheduled retry on %s', async (action) => {
    vi.useFakeTimers();
    const f = fixture({ config: config(), enabled: true });
    f.open.mockRejectedValue(new ExternalAccessRuntimeError('network_error'));
    await f.runtime.start();
    if (action === 'disable') await f.runtime.disable(0);
    else if (action === 'shutdown') await f.runtime.shutdown();
    else await f.runtime.save(config('https://new.test'), 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.runtime.getStatus().retryAt).toBeNull();
    await f.runtime.shutdown();
  });

  it('does not release resource ownership or open replacements when teardown fails', async () => {
    const f = fixture({ config: config(), enabled: true });
    await f.runtime.start();
    vi.mocked(f.resources[0]!.stop).mockRejectedValueOnce(new Error('still running token=secret'));
    expect(await f.runtime.retry(0)).toMatchObject({ state: 'failed', error: { code: 'stop_failed' }, activeRevision: 0 });
    expect(f.open).toHaveBeenCalledOnce();
    await f.runtime.disable(0);
    expect(f.resources[0]?.stop).toHaveBeenCalledTimes(2);
    expect(f.runtime.getStatus().state).toBe('disabled');
  });

  it('keeps secrets and raw failures out of status, including observer snapshots', async () => {
    const f = fixture({ config: config(), enabled: true });
    const observed: unknown[] = [];
    f.options.onStatus = (status) => { observed.push(status); };
    f.open.mockRejectedValueOnce(new Error('private-token https://user:password@example.test'));
    await f.runtime.start();
    expect(JSON.stringify([f.runtime.getStatus(), observed])).not.toMatch(/private-token|password|example\.test/);
    expect(f.runtime.getStatus().error?.code).toBe('start_failed');
    await f.runtime.shutdown();
  });

  it('retains the structured disconnect cause when a provisional open aborts', async () => {
    vi.useFakeTimers();
    const f = fixture({ config: config(), enabled: true });
    f.open.mockImplementationOnce(async (_configuration, context) => {
      context.onDisconnected(new ExternalAccessRuntimeError('network_error'));
      throw new Error('AbortError with secret diagnostics');
    });
    expect(await f.runtime.start()).toMatchObject({ state: 'reconnecting', error: { code: 'network_error' } });
    await f.runtime.shutdown();
  });

  it('ignores callbacks from a failed candidate after restoring the old generation', async () => {
    const f = fixture({ config: config(), enabled: true });
    await f.runtime.start();
    await f.runtime.save(config('https://candidate.test'), 0);
    let failedContext: ExternalAccessOpenContext | undefined;
    f.open.mockImplementationOnce(async (_configuration, context) => {
      failedContext = context;
      throw new ExternalAccessRuntimeError('authentication_failed');
    });
    await f.runtime.retry(1);
    failedContext!.onDisconnected(new ExternalAccessRuntimeError('network_error'));
    expect(f.runtime.getStatus()).toMatchObject({
      state: 'enabled', activeRevision: 0, error: { code: 'authentication_failed' }, retryAt: null,
    });
    await f.runtime.shutdown();
  });

  it('does not rearm old-config retries when a save occurs during an in-flight recovery', async () => {
    vi.useFakeTimers();
    const f = fixture({ config: config(), enabled: true });
    f.open.mockRejectedValueOnce(new ExternalAccessRuntimeError('network_error'));
    await f.runtime.start();
    const attempt = deferred<ExternalAccessResource>();
    f.open.mockImplementationOnce(async () => attempt.promise);
    await vi.advanceTimersByTimeAsync(10);
    await f.runtime.save(config('https://new.test'), 0);
    attempt.reject(new ExternalAccessRuntimeError('network_error'));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.runtime.getStatus()).toMatchObject({ state: 'failed', retryAt: null });
    await f.runtime.shutdown();
  });

  it('still releases resources when the synchronous fence throws', async () => {
    const f = fixture({ config: config(), enabled: true });
    await f.runtime.start();
    vi.mocked(f.resources[0]!.fence).mockImplementation(() => { throw new Error('fence failed'); });
    expect(await f.runtime.disable(0)).toMatchObject({ state: 'disabled', activeRevision: null });
    expect(f.resources[0]!.stop).toHaveBeenCalledOnce();
  });

});
