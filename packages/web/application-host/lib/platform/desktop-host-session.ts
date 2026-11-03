import { createDesktopNotificationOwner } from './desktop-notification-owner.js';
import type { DesktopPlatformOwner } from './desktop-platform.js';
import type { DesktopNetworkOwner } from './native-network-owner.js';
import type { BrowserOwner } from '@varin/protocol';
import { invokeDesktopHostCommand, type DesktopHostConnections } from './desktop-host-invoke.js';
import type { StartWebUiServerOptions, WebUiServerController, DesktopRuntimeConfig } from '../../public-contract.js';
import { desktopHostEnvelope, isDesktopHostFrame, type DesktopHostFrame, type DesktopHostRequest } from '../../desktop-host-protocol.js';

export interface DesktopNativePort {
  request(method: string, params: unknown): Promise<unknown>;
  subscribe(listener: (event: string, payload: unknown) => void): () => void;
}
export type ManagedDesktopBrowserOwner = BrowserOwner & {
  dispose(): Promise<void>;
  invoke?(input: unknown): Promise<unknown>;
  renderWebPage?(url: string, input?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ html: string; finalUrl: string; timedOut: boolean }>;
};

export interface ManagedDesktopCompanionOwner { invoke(input: unknown): Promise<unknown>; asset(input: unknown): Promise<unknown>; subscribe(listener: () => void): () => void; dispose(): Promise<void> }

type ComputerControls = Parameters<NonNullable<StartWebUiServerOptions['onComputerControlsReady']>>[0];
export type ManagedDesktopHostController = Pick<WebUiServerController, 'getPort' | 'getQuitRiskStatus' | 'getTunnelUrl' | 'isReady' | 'stop' | 'mintOutsideFileGrant'> & {
  connections?: DesktopHostConnections;
  getDesktopLocalCredentials?(): Promise<{ clientToken: string }>;
};

/** Owns only the process lifecycle and desktop callbacks. The original Host still
 * owns admission, authentication, durable execution, resources and all shutdown. */
export function createDesktopHostSession(options: {
  mode?: 'host' | 'browser';
  start?(options: StartWebUiServerOptions): Promise<ManagedDesktopHostController>;
  serverOptions: StartWebUiServerOptions;
  createBrowserOwner?(port: DesktopNativePort): ManagedDesktopBrowserOwner;
  createCompanionOwner?(port: DesktopNativePort): ManagedDesktopCompanionOwner;
  createNetworkOwner?(port: DesktopNativePort): DesktopNetworkOwner;
  createPlatformOwner?(network: DesktopNetworkOwner, getLocalOrigin: () => string | null, port: DesktopNativePort, onInstalledAppsUpdated: (apps: unknown) => void): DesktopPlatformOwner;
  send(frame: DesktopHostFrame): Promise<void>;
  exit(code: number): void;
}) {
  let phase: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' = 'starting';
  let connected = true;
  let focused = false;
  let runtimeConfig: DesktopRuntimeConfig | null = null;
  let controlWindows: number[] = [];
  let controls: ComputerControls | undefined;
  let controller: ManagedDesktopHostController | undefined;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let requestId = 0;
  let browser: ManagedDesktopBrowserOwner | undefined;
  let network: DesktopNetworkOwner | undefined;
  let notifications: ReturnType<typeof createDesktopNotificationOwner> | undefined;
  let platform: DesktopPlatformOwner | undefined;
  let companion: ManagedDesktopCompanionOwner | undefined;
  let unsubscribeCompanion: (() => void) | undefined;
  let unsubscribeBrowser: (() => void) | undefined;
  const nativeListeners = new Set<(event: string, payload: unknown) => void>();
  const active = new Set<string>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const event = (name: string, payload: unknown = null) => options.send({ ...desktopHostEnvelope, kind: 'event', event: name, payload });
  const notify = (name: string, payload: unknown) => { void event(name, payload).catch(() => disconnect()); };
  const callShell = (method: string, params: unknown): Promise<unknown> => {
    if (!connected) return Promise.reject(new Error('Desktop shell disconnected; action was not dispatched'));
    const id = `host:${++requestId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void options.send({ ...desktopHostEnvelope, kind: 'request', id, method, params }).catch(error => {
        pending.delete(id); reject(error);
      });
    });
  };
  const stop = () => stopping ??= (async () => {
    // A close received during startup fences readiness and waits for the actual
    // owner. Do not abandon a starting kernel and spawn a second one.
    phase = 'stopping';
    if (connected) await event('stopping').catch(() => disconnect());
    await startup?.catch(() => undefined);
    // Closing the original page can settle a cancelled browser invocation that
    // the Host is still draining. Neither side may pretend cancellation is stop.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => controller?.stop({ exitProcess: false })),
      Promise.resolve().then(() => browser?.dispose()),
      Promise.resolve().then(() => notifications?.dispose()),
      Promise.resolve().then(() => network?.dispose()),
      Promise.resolve().then(() => companion?.dispose()),
      Promise.resolve().then(() => platform?.dispose()),
    ]);
    unsubscribeCompanion?.(); unsubscribeCompanion = undefined;
    unsubscribeBrowser?.(); unsubscribeBrowser = undefined; nativeListeners.clear();
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Managed desktop Host shutdown was not confirmed');
    phase = 'stopped';
    if (connected) await event('stopped').catch(() => disconnect());
  })().catch(error => { phase = 'failed'; throw error; });
  const disconnect = (exitCode = 0) => {
    if (!connected) return;
    connected = false;
    for (const request of pending.values()) request.reject(new Error('Desktop shell disconnected; dispatched action outcome is unknown'));
    pending.clear();
    for (const listener of nativeListeners) {
      try { listener('browser.native.disconnected', null); } catch { /* A failed observer cannot prevent owner drain. */ }
      try { listener('companion.native.disconnected', null); } catch { /* Native window effects are not replayed. */ }
      try { listener('network.native.disconnected', null); } catch { /* The original network outcome remains unknown. */ }
    }
    void stop().then(() => options.exit(exitCode), () => options.exit(1));
  };
  const start = () => startup ??= (async () => {
    const nativePort: DesktopNativePort = { request: callShell, subscribe(listener) { nativeListeners.add(listener); return () => { nativeListeners.delete(listener); }; } };
    if (options.createBrowserOwner) {
      browser = options.createBrowserOwner(nativePort);
      unsubscribeBrowser = browser.subscribe(payload => notify('browser', payload));
    }
    network = options.createNetworkOwner?.(nativePort);
    if (network) notifications = createDesktopNotificationOwner({
      transport: network,
      getLocalOrigin: () => controller?.isReady() ? `http://127.0.0.1:${controller.getPort()}` : null,
      onNotification: (target, notification) => notify('remoteNotification', { ...target, notification }),
    });
    if (network) platform = options.createPlatformOwner?.(network, () => controller?.isReady() ? `http://127.0.0.1:${controller.getPort()}` : null, nativePort, apps => notify('installedAppsUpdated', apps));
    companion = options.createCompanionOwner?.(nativePort);
    unsubscribeCompanion = companion?.subscribe(() => notify('companionLibraryChanged', null));
    if (!options.start && options.mode !== 'browser') throw new Error('Application Host start function is missing');
    controller = await options.start?.({
      ...options.serverOptions,
      // This private managed entry point owns policy, regardless of caller options.
      requireClientAuth: true,
      ...(browser ? { browser } : {}),
      ...(browser?.renderWebPage ? { renderWebPage: async (url: string, signal?: AbortSignal) => {
        const result = await browser!.renderWebPage!(url, signal ? { signal } : {});
        if (!result.html) throw new Error(result.timedOut ? 'Web render timed out' : 'Web render failed');
        return result.html;
      } } : {}),
      ...(network ? { desktopNetworkFetch: network.fetch } : {}),
      attachSignals: false,
      exitOnShutdown: false,
      getIsWindowFocused: () => focused,
      getDesktopRuntimeConfig: () => runtimeConfig,
      computerControlWindows: () => controlWindows,
      onDesktopNotification: payload => notify('notification', payload),
      onConnectionStatus: payload => notify('connectionStatus', payload),
      onComputerGesture: payload => notify('computerGesture', payload),
      onComputerControl: payload => notify('computerControl', payload),
      onComputerControlsReady: value => { controls = value; notify('computerControlsReady', { holderId: value.holderId }); },
      openFilesystemPath: async targetPath => { await callShell('openFilesystemPath', { path: targetPath }); },
      restartApplicationHost: async () => {
        await stop();
        // The parent must observe successful exit before creating a replacement.
        // Unexpected crashes never cause automatic replay or a restart loop.
        if (connected) await event('restartRequested');
        options.exit(0);
      },
    });
    if (phase !== 'starting' || !connected) return;
    if (controller && !controller.isReady()) throw new Error('Application Host returned before becoming ready');
    const credentials = await controller?.getDesktopLocalCredentials?.();
    if (controller && !credentials?.clientToken?.trim()) throw new Error('Application Host private credentials are unavailable');
    if (phase !== 'starting' || !connected) return;
    phase = 'ready';
    await event('ready', controller
      ? { mode: 'host', origin: `http://127.0.0.1:${controller.getPort()}`, port: controller.getPort(), pid: process.pid, ...credentials }
      : { mode: 'browser', pid: process.pid });
  })().catch(async error => {
    phase = 'failed';
    if (connected) await event('failed', { code: 'host_start_failed', message: 'Application Host startup failed; see the private Host log' }).catch(() => disconnect());
    throw error;
  });
  const execute = async (request: DesktopHostRequest): Promise<unknown> => {
    switch (request.method) {
      case 'status': return { phase, port: controller?.getPort() ?? null, tunnelUrl: controller?.getTunnelUrl() ?? null };
      case 'quitRisk':
        if (!controller || phase !== 'ready') throw new Error('Application Host is not ready');
        return controller.getQuitRiskStatus();
      case 'stop': await stop(); return { stopped: true };
      case 'fileGrant': {
        if (!controller?.mintOutsideFileGrant || phase !== 'ready') throw new Error('Local Application Host file grants are unavailable');
        const input = request.params as { path?: unknown } | undefined;
        if (typeof input?.path !== 'string' || !input.path.trim()) throw new Error('File path is required');
        return controller.mintOutsideFileGrant(input.path);
      }
      case 'desktopPlatformInvoke':
        if (!platform || phase !== 'ready') throw new Error('Desktop platform is not ready');
        return platform.invoke(request.params);
      case 'companionInvoke':
        if (!companion || phase !== 'ready') throw new Error('Desktop companion is not ready');
        return companion.invoke(request.params);
      case 'companionAsset':
        if (!companion || phase !== 'ready') throw new Error('Desktop companion is not ready');
        return companion.asset(request.params);
      case 'browserInvoke':
        if (!browser?.invoke || phase !== 'ready') throw new Error('Desktop browser is not ready');
        return browser.invoke(request.params);
      case 'desktopInvoke': {
        const command = request.params && typeof request.params === 'object' && 'command' in request.params ? request.params.command : undefined;
        if (typeof command === 'string' && (command.startsWith('desktop_browser_') || command === 'desktop_web_render')) {
          if (!browser?.invoke || phase !== 'ready') throw new Error('Desktop browser is not ready');
          return browser.invoke(request.params);
        }
        if (!controller?.connections || phase !== 'ready') throw new Error('Application Host connections are not ready');
        return invokeDesktopHostCommand(controller.connections, request.params);
      }
      case 'setDesktopState': {
        const state = request.params as Record<string, unknown> | undefined;
        if (!state || typeof state.focused !== 'boolean') throw new Error('Invalid desktop state');
        const config = state.runtimeConfig as DesktopRuntimeConfig | null | undefined;
        if (config != null && (typeof config.apiBaseUrl !== 'string' || !config.requestHeaders || typeof config.requestHeaders !== 'object' || Array.isArray(config.requestHeaders) || Object.values(config.requestHeaders).some(value => typeof value !== 'string'))) throw new Error('Invalid desktop runtime configuration');
        if (state.controlWindows !== undefined && (!Array.isArray(state.controlWindows) || !state.controlWindows.every(value => Number.isSafeInteger(value) && value > 0))) throw new Error('Invalid desktop window handles');
        if (state.notificationTargets !== undefined) await notifications?.setTargets(state.notificationTargets);
        focused = state.focused;
        runtimeConfig = config ?? null;
        controlWindows = (state.controlWindows as number[] | undefined) ?? [];
        return null;
      }
      case 'computerControl': {
        const input = request.params as { holderId?: unknown; action?: unknown } | undefined;
        if (!controls || input?.holderId !== controls.holderId) throw new Error('Computer control holder is no longer active');
        if (input.action === 'takeover') await controls.takeover();
        else if (input.action === 'handback') await controls.handback();
        else if (input.action === 'cancel') await controls.cancel();
        else throw new Error('Unknown computer control action');
        return null;
      }
      default: throw new Error('Unknown desktop Host method');
    }
  };
  const receive = async (value: unknown): Promise<void> => {
    if (!isDesktopHostFrame(value)) throw new Error('Invalid desktop Host protocol frame');
    if (value.kind === 'event') {
      if (!(options.createBrowserOwner && value.event === 'browser.native') && !(options.createNetworkOwner && value.event === 'network.native') && !(options.createCompanionOwner && value.event === 'companion.native')) throw new Error('Unknown desktop Host native event');
      for (const listener of nativeListeners) listener(value.event, value.payload);
      return;
    }
    if (value.kind === 'response') {
      if (!value.id.startsWith('host:')) throw new Error('Invalid desktop Host response direction');
      const request = pending.get(value.id);
      if (!request) throw new Error('Unknown desktop Host response');
      pending.delete(value.id);
      if (value.ok) request.resolve(value.result);
      else request.reject(new Error(value.error.message));
      return;
    }
    if (value.kind !== 'request' || !value.id.startsWith('shell:')) throw new Error('Invalid desktop Host request direction');
    if (active.has(value.id)) throw new Error('Duplicate in-flight desktop Host request');
    active.add(value.id);
    try {
      const result = await execute(value);
      await options.send({ ...desktopHostEnvelope, kind: 'response', id: value.id, ok: true, result });
      if (value.method === 'stop') options.exit(0);
    } catch (error) {
      await options.send({ ...desktopHostEnvelope, kind: 'response', id: value.id, ok: false, error: {
        code: value.method === 'stop' ? 'host_stop_failed' : 'host_request_failed',
        message: error instanceof Error ? error.message : 'Desktop Host request failed',
      } });
    } finally { active.delete(value.id); }
  };
  return { start, receive, disconnect, stop, get phase() { return phase; } };
}
