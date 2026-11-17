import { isAbsolute } from 'node:path';
import type { ExternalAccessSnapshot } from '@varin/application-client';
import { verifyPublicEndpoint } from '../platform/external-endpoint-proof.js';
import type { createPublicIngress, ExternalIngressConfiguration } from '../platform/public-ingress.js';
import { externalAccessConfigurationView, parseExternalAccessConfiguration, type ExternalAccessConfiguration } from './external-access-config.js';
import { createExternalAccessRuntime, type ExternalAccessFailureCode, type ExternalAccessRecord, type ExternalAccessRuntimeStatus } from './external-access-runtime.js';
import { startFrpTunnel, type FrpTunnelController } from './providers/frp.js';
import { createReverseProxyTunnelProvider } from './providers/reverse-proxy.js';

type PublicIngress = ReturnType<typeof createPublicIngress>;
const phase: Record<ExternalAccessRuntimeStatus['state'], ExternalAccessSnapshot['phase']> = {
  disabled: 'disabled',
  connecting: 'starting',
  'awaiting-verification': 'unverified',
  connected: 'connected',
  reconnecting: 'reconnecting',
  stopping: 'stopping',
  failed: 'failed',
};

type Options = {
  createIngress(configuration: ExternalIngressConfiguration): PublicIngress;
  read(): Promise<ExternalAccessRecord<ExternalAccessConfiguration>>;
  compareAndSwap(expectedRevision: number, next: ExternalAccessRecord<ExternalAccessConfiguration>): Promise<boolean>;
  reserve(): () => void;
  env?: NodeJS.ProcessEnv;
  startFrp?: typeof startFrpTunnel;
  verifyEndpoint?: typeof verifyPublicEndpoint;
};

export function createSelfHostedAccess(options: Options) {
  const { env = process.env, startFrp = startFrpTunnel, verifyEndpoint = verifyPublicEndpoint } = options;
  let activeIngress: PublicIngress | null = null;
  const runtime = createExternalAccessRuntime<ExternalAccessConfiguration>({
    read: options.read,
    compareAndSwap: options.compareAndSwap,
    normalizeConfig: (input) => parseExternalAccessConfiguration(input, (input as ExternalAccessConfiguration)?.id),
    classifyError(error): ExternalAccessFailureCode {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EADDRINUSE') return 'port_in_use';
      if (code === 'EACCES' || code === 'ENOENT' || code === 'invalid_config' || code === 'invalid_configuration'
        || code === 'missing_dependency' || code === 'missing_credential' || code === 'unsupported_platform' || code === 'tls_failed') return 'invalid_config';
      if (code === 'connection_lost') return 'network_error';
      if (code === 'process_exit' && (error as { retryable?: boolean }).retryable) return 'process_exited';
      if (code === 'authentication_failed' || code === 'network_error' || code === 'process_exited' || code === 'provider_in_use') return code;
      return 'start_failed';
    },
    async open(configuration, context) {
      const release = options.reserve();
      let ingress: PublicIngress | undefined;
      let child: FrpTunnelController | undefined;
      let controller: Awaited<ReturnType<ReturnType<typeof createReverseProxyTunnelProvider>['start']>> | undefined;
      let detachDisconnect: (() => void) | undefined;
      let disconnected = false;
      let fenceOnAbort = () => undefined as void;
      const stop = async (): Promise<void> => {
        const operations = [
          Promise.resolve().then(() => controller?.stop?.()),
          Promise.resolve().then(() => child?.stop()),
          Promise.resolve().then(() => ingress?.close()),
        ];
        const failed = (await Promise.allSettled(operations)).find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (activeIngress === ingress) activeIngress = null;
        release();
      };
      const fence = () => {
        detachDisconnect?.();
        context.signal.removeEventListener('abort', fenceOnAbort);
        ingress?.setEnabled(false);
      };
      fenceOnAbort = fence;
      try {
        context.signal.throwIfAborted();
        ingress = options.createIngress({ origin: configuration.publicOrigin, ...configuration.backend });
        const backend = new URL('http://localhost');
        backend.hostname = configuration.backend.host.includes(':') ? `[${configuration.backend.host}]` : configuration.backend.host;
        backend.port = String(configuration.backend.port);
        context.signal.addEventListener('abort', fenceOnAbort, { once: true });
        if (configuration.provider === 'reverse-proxy') {
          const guarded = ingress;
          const provider = createReverseProxyTunnelProvider({
            async openPublicIngress() {
              await guarded.listen();
              context.signal.throwIfAborted();
              return { originUrl: backend.origin, setEnabled: guarded.setEnabled, close: guarded.close };
            },
          });
          controller = await provider.start({
            provider: 'reverse-proxy', mode: 'reverse-proxy', intent: 'persistent-public',
            configPath: undefined, hostname: '', token: '',
            reverseProxy: { publicOrigin: configuration.publicOrigin, backend: configuration.backend },
          }, { activePort: configuration.backend.port, originUrl: backend.origin });
        } else {
          const executablePath = env.VARIN_FRPC_PATH;
          if (!executablePath || !isAbsolute(executablePath)) throw Object.assign(new Error('FRP executable path is not configured'), { code: 'invalid_config' });
          await ingress.listen();
          context.signal.throwIfAborted();
          child = await startFrp({
            ...configuration.frp,
            publicOrigin: configuration.publicOrigin,
            executablePath,
            backend: { originUrl: backend.origin },
          }, { signal: context.signal, env });
          detachDisconnect = child.onDisconnect((reason) => {
            // Fence immediately, even before the lifecycle queues a restart.
            disconnected = true;
            fence();
            context.onDisconnected(reason);
          });
        }
        context.signal.throwIfAborted();
        if (disconnected) throw Object.assign(new Error('FRP disconnected during activation'), { code: 'network_error' });
        ingress.setEnabled(true);
        activeIngress = ingress;
        const challenge = ingress.issueEndpointProof();
        let verified: boolean;
        try {
          verified = await verifyEndpoint({ origin: configuration.publicOrigin, challenge, signal: context.signal });
        } finally { challenge.clear(); }
        context.signal.throwIfAborted();
        return { verification: verified ? 'verified' : 'unverified', fence, stop };
      } catch (error) {
        fence();
        await stop();
        throw error;
      }
    },
  });

  return {
    ...runtime,
    getIngress: (): PublicIngress | null => activeIngress,
    async snapshot(includeOperatorDetails = false): Promise<ExternalAccessSnapshot> {
      const entry = await runtime.read();
      const status = runtime.getStatus();
      const binding = activeIngress?.enabled ? activeIngress.configuration : null;
      return {
        source: 'settings',
        entry: entry.config ? { revision: entry.revision, enabled: entry.enabled, configuration: externalAccessConfigurationView(entry.config, includeOperatorDetails) } : null,
        listener: binding ? { host: binding.host, port: binding.port, origin: binding.origin } : null,
        phase: phase[status.state],
        ...(status.error ? { error: status.error.message } : {}),
      };
    },
  };
}
