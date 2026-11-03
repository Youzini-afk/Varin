import type { Server } from 'node:http';
import type { TunnelStartRequest } from '../tunnels/types.js';

type StartupTunnelRequest = TunnelStartRequest;

interface TunnelAuthController {
  issueBootstrapToken(options: { ttlMs: number | null }): { token: string };
  setActiveTunnel(input: { mode: string; publicUrl: string; tunnelId: string }): void;
}

export const createServerStartupRuntime = (dependencies: {
  TUNNEL_MODE_MANAGED_LOCAL: string;
  TUNNEL_MODE_MANAGED_REMOTE: string;
  TUNNEL_MODE_QUICK: string;
  crypto: { randomUUID(): string };
  getSignalsAttached(): boolean;
  gracefulShutdown(): Promise<void>;
  normalizeTunnelBootstrapTtlMs(value: unknown): number | null;
  process: NodeJS.Process;
  readSettingsFromDisk(): Promise<Record<string, unknown>>;
  server: Server;
  setSignalsAttached(value: boolean): void;
  startTunnelWithNormalizedRequest(input: Record<string, unknown>): Promise<{ mode: string; publicUrl: string }>;
  tunnelAuthController: TunnelAuthController;
}) => {
  const {
    process,
    crypto,
    server,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDisk,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached,
    setSignalsAttached,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
  } = dependencies;

  const resolveBindHost = (host?: string): string =>
    host
    || (typeof process.env.VARIN_HOST === 'string' && process.env.VARIN_HOST.trim().length > 0
      ? process.env.VARIN_HOST.trim()
      : '127.0.0.1');

  const startListeningAndMaybeTunnel = async ({
    port,
    fallbackPorts = [],
    bindHost,
    startupTunnelRequest,
    onTunnelReady,
  }: {
    bindHost: string;
    onTunnelReady?: (publicUrl: string, connectUrl: string | null) => void;
    port: number;
    fallbackPorts?: readonly number[];
    startupTunnelRequest?: StartupTunnelRequest | null;
  }): Promise<{ activePort: number }> => {
    let activePort = port;
    const remainingPorts = [...fallbackPorts];
    if ([port, ...remainingPorts].some(value => !Number.isInteger(value) || value < 0 || value > 65535)) throw new Error('Invalid listening port');

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('error', onError);
        server.off('listening', onListening);
        const next = remainingPorts.shift();
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && next !== undefined) {
          server.once('error', onError);
          server.listen(next, bindHost, onListening);
          return;
        }
        reject(error);
      };
      server.once('error', onError);
      const onListening = async (): Promise<void> => {
        server.off('error', onError);
        const addressInfo = server.address();
        activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

        try {
          process.send?.({ type: 'varin:ready', port: activePort });
        } catch {
          // ignore
        }

        const displayHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')
          ? 'localhost'
          : (bindHost.includes(':') ? `[${bindHost}]` : bindHost);
        console.log(`Varin server listening on ${bindHost}:${activePort}`);
        console.log(`Health check: http://${displayHost}:${activePort}/health`);
        console.log(`Web interface: http://${displayHost}:${activePort}`);

        if (startupTunnelRequest) {
          const startupModeLabel = startupTunnelRequest.mode === TUNNEL_MODE_QUICK
            ? 'Quick Tunnel'
            : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_LOCAL
              ? 'Managed Local Tunnel'
              : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_REMOTE ? 'Managed Remote Tunnel' : 'Tunnel'));
          console.log(`\nInitializing ${startupModeLabel} for provider '${startupTunnelRequest.provider}'...`);
          try {
            const { publicUrl, mode } = await startTunnelWithNormalizedRequest({
              provider: startupTunnelRequest.provider,
              mode: startupTunnelRequest.mode,
              intent: startupTunnelRequest.intent,
              hostname: startupTunnelRequest.hostname,
              token: startupTunnelRequest.token,
              configPath: startupTunnelRequest.configPath,
              selectedPresetId: '',
              selectedPresetName: '',
            });
            if (publicUrl) {
              tunnelAuthController.setActiveTunnel({
                tunnelId: crypto.randomUUID(),
                publicUrl,
                mode,
              });
              const settings = await readSettingsFromDisk();
              const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
                ? null
                : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
              const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
              const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
              if (onTunnelReady) {
                onTunnelReady(publicUrl, connectUrl);
              } else {
                console.log(`\n🌐 Tunnel URL: ${connectUrl}`);
                console.log('🔑 One-time connect link (expires after first use)\n');
              }
            } else if (onTunnelReady) {
              onTunnelReady(publicUrl, null);
            }
          } catch (error) {
            console.error(`Failed to start tunnel: ${error instanceof Error ? error.message : String(error)}`);
            console.log('Continuing without tunnel...');
          }
        }

        resolve();
      };

      server.listen(port, bindHost, onListening);
    });

    return { activePort };
  };

  const attachProcessHandlers = ({ attachSignals }: { attachSignals: boolean }): void => {
    if (attachSignals && !getSignalsAttached()) {
      const handleSignal = async (): Promise<void> => {
        await gracefulShutdown();
      };
      // Cover every signal a shell or dev harness may use to stop/restart us so
      // workers and platform services are closed cleanly: SIGINT/SIGQUIT
      // (Ctrl+C/Ctrl+\), SIGTERM (kill/default), SIGHUP
      // (terminal close), SIGUSR2 (nodemon restart for `dev:server:watch`).
      process.on('SIGTERM', handleSignal);
      process.on('SIGINT', handleSignal);
      process.on('SIGQUIT', handleSignal);
      process.on('SIGHUP', handleSignal);
      process.on('SIGUSR2', handleSignal);
      setSignalsAttached(true);
    }

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      gracefulShutdown();
    });
  };

  return {
    resolveBindHost,
    startListeningAndMaybeTunnel,
    attachProcessHandlers,
  };
};
