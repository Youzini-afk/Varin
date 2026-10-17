import type { Express } from 'express';
import type expressModule from 'express';

import type { registerMobileRoutes } from '../mobile/routes.js';
import type { registerNotificationRoutes } from '../notifications/routes.js';
import type { registerTtsRoutes } from '../tts/routes.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type {
  AuthAccessDependencies,
  CommonRequestMiddlewareDependencies,
  ServerStatusDependencies,
} from './core-routes.js';
import type { registerVarinRoutes } from './varin-routes.js';

type UiAuthOptions = NonNullable<Parameters<typeof createUiAuth>[0]>;
type UiAuthController = ReturnType<typeof createUiAuth>;
type NotificationDependencies = Parameters<typeof registerNotificationRoutes>[1];
type MobileDependencies = Parameters<typeof registerMobileRoutes>[1];
type TtsDependencies = Parameters<typeof registerTtsRoutes>[1];
type VarinDependencies = Parameters<typeof registerVarinRoutes>[1];

export type ServerBootstrapOptions =
  Omit<ServerStatusDependencies, 'express' | 'uiAuthController'>
  & Omit<AuthAccessDependencies, 'express' | 'uiAuthController'>
  & TtsDependencies
  & Omit<NotificationDependencies, 'uiAuthController'>
  & VarinDependencies
  & {
    clientPairingRuntime: AuthAccessDependencies['clientPairingRuntime'];
    mobileDeviceStore: MobileDependencies['deviceStore'];
    mobilePairingRuntime: MobileDependencies['pairingRuntime'];
    mobilePushRuntime: MobileDependencies['mobilePushRuntime'];
    uiPassword: UiAuthOptions['password'];
    verboseRequestLogs?: CommonRequestMiddlewareDependencies['verboseRequestLogs'];
  };

export interface ServerBootstrapDependencies {
  createUiAuth(options: UiAuthOptions): UiAuthController;
  express: typeof expressModule;
  registerAuthAndAccessRoutes(app: Express, dependencies: AuthAccessDependencies): void;
  registerCommonRequestMiddleware(app: Express, dependencies: CommonRequestMiddlewareDependencies): void;
  registerMobileRoutes?: typeof registerMobileRoutes;
  registerNotificationRoutes: typeof registerNotificationRoutes;
  registerVarinRoutes: typeof registerVarinRoutes;
  registerServerStatusRoutes(app: Express, dependencies: ServerStatusDependencies): void;
  registerTtsRoutes: typeof registerTtsRoutes;
}

export const createServerBootstrapRuntime = (dependencies: ServerBootstrapDependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerMobileRoutes,
    registerVarinRoutes,
    express,
  } = dependencies;

  const setupBaseRoutes = (app: Express, options: ServerBootstrapOptions): {
    uiAuthController: UiAuthController;
  } => {
    const {
      process,
      varinVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      verboseRequestLogs,
      uiPassword,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerPort = () => null,
      getTunnelUrl = () => null,
      getServerLabel,
      readSettingsFromDisk,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      updateSettingsOnDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      setPushInitialized,
      fs,
      path,
      server,
      __dirname,
      varinDataDir,
      mobileDeviceStore,
      mobilePairingRuntime,
      mobilePushRuntime,
    } = options;

    const uiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDisk,
      clientAuthController: remoteClientAuthRuntime,
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      varinVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      tunnelAuthController,
      uiAuthController,
      ...(getServerId ? { getServerId } : {}),
      getServerPort,
      getTunnelUrl,
    });

    registerCommonRequestMiddleware(app, {
      express,
      ...(verboseRequestLogs !== undefined ? { verboseRequestLogs } : {}),
    });

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      readSettingsFromDisk,
      normalizeTunnelSessionTtlMs,
      ...(getRelayPairingCandidate ? { getRelayPairingCandidate } : {}),
      ...(reconcileRelay ? { reconcileRelay } : {}),
      ...(getPairingTransports ? { getPairingTransports } : {}),
      ...(getDirectCandidateUrls ? { getDirectCandidateUrls } : {}),
      ...(getServerId ? { getServerId } : {}),
      ...(getServerLabel ? { getServerLabel } : {}),
    });

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDisk,
      updateSettingsOnDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      ...(clearPendingPushBadge ? { clearPendingPushBadge } : {}),
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      setPushInitialized,
    });

    if (typeof registerMobileRoutes === 'function') {
      registerMobileRoutes(app, {
        uiAuthController,
        deviceStore: mobileDeviceStore,
        pairingRuntime: mobilePairingRuntime,
        mobilePushRuntime,
      });
    }

    registerVarinRoutes(app, {
      fs,
      path,
      process,
      server,
      __dirname,
      varinDataDir,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
