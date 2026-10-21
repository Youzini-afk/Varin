interface StoppableRuntime { stop(): Promise<unknown> | unknown }
interface TerminalRuntime { shutdown(): Promise<unknown> }
interface DocumentsAuthorityRuntime { dispose(): Promise<unknown> }
interface UiAuthRuntime { dispose(): unknown }
interface TunnelController { stop?(): unknown }
interface ClosableServer { close(callback: () => void): unknown }

/** A failed owner must not skip the remaining owners' drain and durable close. */
export const createShutdownCollector = () => {
  const errors: Error[] = [];
  return {
    errors,
    async run(name: string, stop: () => unknown): Promise<void> {
      try {
        await stop();
      } catch (error) {
        errors.push(new Error(`${name} shutdown failed`, { cause: error }));
        console.error(`[Shutdown] ${name} failed:`, error);
      }
    },
  };
};

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
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    scheduledTasksRuntime,
    getTerminalRuntime,
    setTerminalRuntime,
    getDocumentsAuthority,
    setDocumentsAuthority,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
  } = dependencies;
  let shutdownPromise: Promise<void> | null = null;

  const runShutdown = async (
    options: { exitProcess?: boolean | undefined } = {},
  ): Promise<void> => {
    if (getIsShuttingDown()) return;
    setIsShuttingDown(true);
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();

    await scheduledTasksRuntime?.stop?.();

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
        // Continue closing the remaining server resources.
      } finally {
        setTerminalRuntime(null);
      }
    }

    const server = getServer();
    if (server && typeof server.close === 'function') {
      let closeTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => { server.close(resolve); }),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(() => resolve(), shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
    }

    const documentsAuthority = getDocumentsAuthority?.();
    if (documentsAuthority) {
      try {
        await documentsAuthority.dispose();
      } catch (error) {
        // Continue closing process-owned resources after a failed authority cleanup.
        console.error('Document authority shutdown failed:', error instanceof Error ? error.message : error);
      } finally {
        setDocumentsAuthority?.(null);
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const tunnelController = getActiveTunnelController();
    if (tunnelController) {
      try {
        tunnelController.stop?.();
      } finally {
        setActiveTunnelController(null);
        tunnelAuthController.clearActiveTunnel();
      }
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) process.exit(0);
  };

  const gracefulShutdown = (
    options: { exitProcess?: boolean | undefined } = {},
  ): Promise<void> => {
    shutdownPromise ??= runShutdown(options);
    return shutdownPromise;
  };

  return { gracefulShutdown };
};
