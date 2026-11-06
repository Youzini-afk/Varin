const MAX_TIMER_MS = 2_147_483_647;
export const resolveShutdownTimeoutMs = (value: string | undefined): number => {
  if (value === undefined || !value.trim()) return 10_000;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMER_MS) {
    throw new Error(`VARIN_SHUTDOWN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_MS}`);
  }
  return timeout;
};

/** A stop deadline bounds observation, never claims to cancel an original owner. */
export class ShutdownIncompleteError extends Error {
  readonly code = 'shutdown-incomplete';
  readonly outcome = 'incomplete';
  constructor(readonly owner: string, readonly reason: 'deadline' | 'owner-failed', cause?: unknown) {
    super(`Shutdown incomplete: ${owner} ${reason === 'deadline' ? 'did not drain before the stop deadline' : 'failed to drain'}`, { cause });
    this.name = 'ShutdownIncompleteError';
  }
}

/** One monotonic absolute deadline shared by every stop phase, including native exit and HTTP close. */
export class ShutdownDeadline {
  readonly expiresAt: number;
  readonly startedAt = performance.now();
  private failure: ShutdownIncompleteError | undefined;
  constructor(readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) throw new Error('Invalid shutdown timeout');
    this.expiresAt = this.startedAt + timeoutMs;
  }
  assertRemaining(owner: string): void {
    if (this.failure) throw this.failure;
    if (performance.now() >= this.expiresAt) throw this.expire(owner);
  }
  private expire(owner: string): ShutdownIncompleteError {
    return this.failure ??= new ShutdownIncompleteError(owner, 'deadline');
  }
  async run<T>(owner: string, stop: () => T | PromiseLike<T>): Promise<T> {
    this.assertRemaining(owner);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Retain rejection handling even after the deadline. The original owner is
      // still running; callers must not close its stores or release its leases.
      const work = Promise.resolve(stop());
      const result = await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(this.expire(owner)), Math.max(0, this.expiresAt - performance.now()));
      })]);
      this.assertRemaining(owner);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Fixed labels and timing only; never include owner identities, request bodies or causes. */
export const reportShutdownOutcome = (deadline: ShutdownDeadline, error?: unknown): void => {
  const failure = error instanceof ShutdownIncompleteError ? error : undefined;
  const record = {
    outcome: error === undefined ? 'graceful' : 'incomplete',
    owner: failure?.owner ?? (error === undefined ? null : 'host'),
    reason: failure?.reason ?? (error === undefined ? null : 'owner-failed'),
    elapsedMs: Math.round(performance.now() - deadline.startedAt),
    deadlineMs: deadline.timeoutMs,
  };
  if (error === undefined) console.log('[Shutdown]', JSON.stringify(record));
  else console.error('[Shutdown]', JSON.stringify(record));
};

export const createShutdownCollector = (options: { deadline?: ShutdownDeadline; stopOnFailure?: boolean } = {}) => {
  const errors: Error[] = [];
  return {
    errors,
    async run(name: string, stop: () => unknown): Promise<void> {
      try {
        if (options.deadline) await options.deadline.run(name, stop);
        else await stop();
      } catch (error) {
        if (error instanceof ShutdownIncompleteError) throw error;
        const failure = new ShutdownIncompleteError(name, 'owner-failed', error);
        errors.push(failure);
        console.error(`[Shutdown] ${name} failed to drain`);
        // In a dependent owner graph, failure is not evidence that its writers
        // stopped. Independent owners may opt into collection, but never a timeout.
        if (options.stopOnFailure) throw failure;
      }
    },
  };
};

interface StoppableRuntime { stop(): Promise<unknown> | unknown }
interface TerminalRuntime { shutdown(): Promise<unknown> }
interface DocumentsAuthorityRuntime { dispose(): Promise<unknown> }
interface UiAuthRuntime { dispose(): unknown }
interface TunnelController { stop?(): unknown }
interface ClosableServer { close(callback: (error?: Error) => void): unknown }

export interface GracefulShutdownDependencies<
  Terminal extends TerminalRuntime = TerminalRuntime,
  Documents extends DocumentsAuthorityRuntime = DocumentsAuthorityRuntime,
  UiAuth extends UiAuthRuntime = UiAuthRuntime,
  Tunnel extends TunnelController = TunnelController,
> {
  getActiveTunnelController(): Tunnel | null;
  getDocumentsAuthority?(): Documents | null;
  getExitOnShutdown(): boolean;
  getIsShuttingDown(): boolean;
  getServer(): ClosableServer | null;
  getTerminalRuntime(): Terminal | null;
  getUiAuthController(): UiAuth | null;
  process: { exit(code?: number): unknown };
  scheduledTasksRuntime?: StoppableRuntime | null | undefined;
  setActiveTunnelController(value: Tunnel | null): void;
  setDocumentsAuthority?(value: Documents | null): void;
  setIsShuttingDown(value: boolean): void;
  setTerminalRuntime(value: Terminal | null): void;
  setUiAuthController(value: UiAuth | null): void;
  shutdownTimeoutMs: number;
  tunnelAuthController: { clearActiveTunnel(): void };
}

export const createGracefulShutdownRuntime = <
  Terminal extends TerminalRuntime,
  Documents extends DocumentsAuthorityRuntime,
  UiAuth extends UiAuthRuntime,
  Tunnel extends TunnelController,
>(dependencies: GracefulShutdownDependencies<Terminal, Documents, UiAuth, Tunnel>) => {
  let shutdownPromise: Promise<void> | null = null;
  const gracefulShutdown = (options: { exitProcess?: boolean | undefined; deadline?: ShutdownDeadline; reportOutcome?: boolean } = {}): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    const deadline = options.deadline ?? new ShutdownDeadline(dependencies.shutdownTimeoutMs);
    dependencies.setIsShuttingDown(true);
    const shutdown = createShutdownCollector({ deadline, stopOnFailure: true });
    const exitProcess = options.exitProcess ?? dependencies.getExitOnShutdown();
    shutdownPromise = (async () => {
      await shutdown.run('scheduledTasks.stop', () => dependencies.scheduledTasksRuntime?.stop());
      const terminal = dependencies.getTerminalRuntime();
      if (terminal) {
        await shutdown.run('terminal.shutdown', () => terminal.shutdown());
        dependencies.setTerminalRuntime(null);
      }
      const server = dependencies.getServer();
      if (server) await shutdown.run('http.close', () => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }));
      const documents = dependencies.getDocumentsAuthority?.();
      if (documents) {
        await shutdown.run('documents.dispose', () => documents.dispose());
        dependencies.setDocumentsAuthority?.(null);
      }
      const uiAuth = dependencies.getUiAuthController();
      if (uiAuth) {
        await shutdown.run('uiAuth.dispose', () => uiAuth.dispose());
        dependencies.setUiAuthController(null);
      }
      const tunnel = dependencies.getActiveTunnelController();
      if (tunnel) {
        await shutdown.run('tunnel.stop', () => tunnel.stop?.());
        dependencies.setActiveTunnelController(null);
        dependencies.tunnelAuthController.clearActiveTunnel();
      }
      if (options.reportOutcome !== false) reportShutdownOutcome(deadline);
      if (exitProcess) dependencies.process.exit(0);
    })().catch(error => {
      if (options.reportOutcome !== false) reportShutdownOutcome(deadline, error);
      if (exitProcess) dependencies.process.exit(1);
      throw error;
    });
    return shutdownPromise;
  };
  return { gracefulShutdown };
};
