import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGracefulShutdownRuntime,
  createShutdownCollector,
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
