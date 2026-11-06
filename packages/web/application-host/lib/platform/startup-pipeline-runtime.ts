import { recordStartupPerformance } from './startup-performance.js';

type TerminalOptions = Parameters<typeof import('../terminal/runtime.js').createTerminalRuntime>[0];
type DictationOptions = Parameters<typeof import('../dictation/runtime.js').createDictationRuntime>[0];
type ServerStartupDependencies = Parameters<typeof import('./server-startup-runtime.js').createServerStartupRuntime>[0];
type StaticRoutesRuntime = ReturnType<typeof import('./static-routes-runtime.js').createStaticRoutesRuntime>;
type StartupTunnelOptions = Parameters<
  ReturnType<typeof import('./server-startup-runtime.js').createServerStartupRuntime>['startListeningAndMaybeTunnel']
>[0];

type PipelineOptions = Omit<TerminalOptions, 'TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS'>
  & Omit<DictationOptions, 'modelsDir'>
  & ServerStartupDependencies
  & {
    apiOnly: boolean;
    attachSignals: boolean;
    dictationModelsDir: string;
    host?: string;
    onTunnelReady?: StartupTunnelOptions['onTunnelReady'];
    port: number;
    startupTunnelRequest?: StartupTunnelOptions['startupTunnelRequest'];
    staticRoutesRuntime: StaticRoutesRuntime;
    terminalHeartbeatIntervalMs: number;
    tunnelRuntimeContext: { setActivePort(value: number): void };
  };

export const createStartupPipelineRuntime = (dependencies: {
  createDictationRuntime: typeof import('../dictation/runtime.js').createDictationRuntime;
  createServerStartupRuntime: typeof import('./server-startup-runtime.js').createServerStartupRuntime;
  createTerminalRuntime: typeof import('../terminal/runtime.js').createTerminalRuntime;
}) => {
  const {
    createTerminalRuntime,
    createDictationRuntime,
    createServerStartupRuntime,
  } = dependencies;

  const run = async (options: PipelineOptions) => {
    const pipelineStartedAt = performance.now();
    recordStartupPerformance('web.pipeline.start');
    const {
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      terminalHeartbeatIntervalMs,
      staticRoutesRuntime,
      process,
      crypto,
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
      host,
      port,
      startupTunnelRequest,
      onTunnelReady,
      tunnelRuntimeContext,
      attachSignals,
      apiOnly,
      dictationModelsDir,
      documents,
    } = options;

    const terminalRuntime = createTerminalRuntime({
      app,
      server,
      fs,
      path,
      ...(uiAuthController ? { uiAuthController } : {}),
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: terminalHeartbeatIntervalMs,
      ...(options.loadPtyProvider ? { loadPtyProvider: options.loadPtyProvider } : {}),
      ...(options.inspectNativeProcesses ? { inspectNativeProcesses: options.inspectNativeProcesses } : {}),
      ...(documents ? { documents } : {}),
    });

    const dictationRuntime = createDictationRuntime({
      ...(options.isDraining ? { isDraining: options.isDraining } : {}),
      app,
      server,
      express,
      ...(uiAuthController ? { uiAuthController } : {}),
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      modelsDir: dictationModelsDir,
    });

    if (apiOnly) {
      staticRoutesRuntime.registerApiOnlyFallbackRoutes(app);
    } else {
      staticRoutesRuntime.registerStaticRoutes(app);
    }

    const serverStartupRuntime = createServerStartupRuntime({
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
    });

    const bindHost = serverStartupRuntime.resolveBindHost(host);
    const startupResult = await serverStartupRuntime.startListeningAndMaybeTunnel({
      port,
      bindHost,
      ...(startupTunnelRequest ? { startupTunnelRequest } : {}),
      ...(onTunnelReady ? { onTunnelReady } : {}),
    });
    recordStartupPerformance('web.listener.ready', {
      durationMs: performance.now() - pipelineStartedAt,
    });
    tunnelRuntimeContext.setActivePort(startupResult.activePort);

    serverStartupRuntime.attachProcessHandlers({ attachSignals });

    return {
      terminalRuntime,
      dictationRuntime,
    };
  };

  return {
    run,
  };
};
