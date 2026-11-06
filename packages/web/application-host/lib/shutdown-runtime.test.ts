import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGracefulShutdownRuntime,
  createShutdownCollector,
  ShutdownDeadline,
  ShutdownIncompleteError,
  resolveShutdownTimeoutMs,
  reportShutdownOutcome,
  type GracefulShutdownDependencies,
} from './shutdown-runtime.js';

const createRuntime = (
  server: ReturnType<GracefulShutdownDependencies['getServer']>,
  documentsAuthority: ReturnType<NonNullable<GracefulShutdownDependencies['getDocumentsAuthority']>> = null,
) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  scheduledTasksRuntime: { stop: vi.fn() },
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getDocumentsAuthority: () => documentsAuthority,
  setDocumentsAuthority: vi.fn(),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('disposes document authority only after the HTTP server stops accepting work', async () => {
    const order: string[] = [];
    const server = {
      close: vi.fn((callback) => {
        order.push('server-closed');
        callback();
      }),
    };
    const documentsAuthority = {
      dispose: vi.fn(async () => { order.push('documents-disposed'); }),
    };

    const runtime = createRuntime(server, documentsAuthority);
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(order).toEqual(['server-closed', 'documents-disposed']);
    expect(documentsAuthority.dispose).toHaveBeenCalledOnce();
  });

  it('drains durable stores after failed cleanup, retaining each original failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const shutdown = createShutdownCollector();
    const producerError = new Error('watcher close failed');
    const semanticError = new AggregateError([new Error('checkpoint write failed')], 'Semantic runtime shutdown failed');
    let finishClose!: () => void;
    const closed = new Promise<void>(resolve => { finishClose = resolve; });
    const order: string[] = [];
    const stopping = (async () => {
      await shutdown.run('watchers', () => { throw producerError; });
      await shutdown.run('semantic indexes', async () => { throw semanticError; });
      await shutdown.run('workspace knowledge', async () => { order.push('close-started'); await closed; order.push('close-finished'); });
      await shutdown.run('server', () => { order.push('server-stopped'); });
    })();
    await vi.waitFor(() => expect(order).toEqual(['close-started']));
    finishClose();
    await stopping;
    expect(order).toEqual(['close-started', 'close-finished', 'server-stopped']);
    expect(shutdown.errors.map(error => error.cause)).toEqual([producerError, semanticError]);
  });
});

// These tests distinguish a bounded wait from a fictitious cancellation receipt.
describe('shared shutdown deadline', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('does not start store teardown after a stuck owner, even when that owner settles late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const deadline = new ShutdownDeadline(100);
    const shutdown = createShutdownCollector({ deadline, stopOnFailure: true });
    let finish!: () => void;
    const writer = new Promise<void>(resolve => { finish = resolve; });
    const storeClose = vi.fn();
    const stopping = (async () => {
      await shutdown.run('original-writer', () => writer);
      await shutdown.run('store.close', storeClose);
    })();
    const failure = expect(stopping).rejects.toMatchObject({ code: 'shutdown-incomplete', outcome: 'incomplete', owner: 'original-writer', reason: 'deadline' });
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    finish();
    await Promise.resolve();
    expect(storeClose).not.toHaveBeenCalled();
    await expect(shutdown.run('late-store.close', storeClose)).rejects.toBeInstanceOf(ShutdownIncompleteError);
    expect(storeClose).not.toHaveBeenCalled();
  });

  it('spends only the remaining budget on HTTP close, keeps the failed owner, and reports nonzero exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deadline = new ShutdownDeadline(100);
    const exit = vi.fn();
    const store = { dispose: vi.fn() };
    const runtime = createGracefulShutdownRuntime({
      process: { exit }, shutdownTimeoutMs: 1000,
      getExitOnShutdown: () => true, getIsShuttingDown: () => true, setIsShuttingDown: vi.fn(),
      getTerminalRuntime: () => null, setTerminalRuntime: vi.fn(),
      getServer: () => ({ close: vi.fn() }),
      getDocumentsAuthority: () => store, setDocumentsAuthority: vi.fn(),
      getUiAuthController: () => null, setUiAuthController: vi.fn(),
      getActiveTunnelController: () => null, setActiveTunnelController: vi.fn(),
      tunnelAuthController: { clearActiveTunnel: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(70);
    const stopping = runtime.gracefulShutdown({ deadline });
    expect(runtime.gracefulShutdown({ deadline })).toBe(stopping);
    const failure = expect(stopping).rejects.toMatchObject({ owner: 'http.close', reason: 'deadline' });
    await vi.advanceTimersByTimeAsync(29);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(exit).toHaveBeenCalledWith(1);
    expect(store.dispose).not.toHaveBeenCalled();
  });

  it('does not interpret owner rejection as permission to close its stores', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const shutdown = createShutdownCollector({ deadline: new ShutdownDeadline(1000), stopOnFailure: true });
    const cause = new Error('process exit unconfirmed');
    await expect(shutdown.run('process', async () => { throw cause; })).rejects.toMatchObject({ owner: 'process', reason: 'owner-failed', cause });
  });
});


describe('shutdown configuration and telemetry', () => {
  it('retains the default and rejects values outside the Node timer range', () => {
    expect(resolveShutdownTimeoutMs(undefined)).toBe(10_000);
    expect(resolveShutdownTimeoutMs('15000')).toBe(15_000);
    for (const value of ['0', '-1', 'NaN', 'Infinity', '2147483648', '1.5']) {
      expect(() => resolveShutdownTimeoutMs(value)).toThrow('VARIN_SHUTDOWN_TIMEOUT_MS');
    }
  });
  it('reports fixed outcome labels without serializing original failure details', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deadline = new ShutdownDeadline(500);
    try {
      reportShutdownOutcome(deadline);
      expect(JSON.parse(log.mock.calls[0]![1])).toMatchObject({ outcome: 'graceful', owner: null, reason: null, deadlineMs: 500 });
      reportShutdownOutcome(deadline, new ShutdownIncompleteError('writer', 'owner-failed', new Error('private-body')));
      expect(JSON.parse(error.mock.calls[0]![1])).toMatchObject({ outcome: 'incomplete', owner: 'writer', reason: 'owner-failed', deadlineMs: 500 });
      expect(error.mock.calls[0]![1]).not.toContain('private-body');
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
