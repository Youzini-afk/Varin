import React from 'react';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeApiBaseUrl } from '@varin/application-client';
import {
  desktopHostsGet,
  getDesktopHostApiUrl,
  locationMatchesHost,
  redactSensitiveUrl,
} from '@/lib/desktopHosts';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { projectPiTraySessions, type PiTraySession } from '@/lib/pi-runtime/piTraySnapshot';

const FLUSH_DEBOUNCE_MS = 500;
const CATALOG_REFRESH_MS = 45_000;

type TrayApproval = {
  kind: 'permission' | 'question';
  id: string;
  sessionId: string;
  sessionTitle: string;
  label: string;
  directory: string;
};


type TraySnapshot = {
  approvals: TrayApproval[];
  dockBadgeCount: number;
  instanceName: string;
  sessions: PiTraySession[];
};

const isTrayPlatform = (): boolean => {
  if (typeof window === 'undefined') return false;
  const platform = (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__;
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
};

const isTrayEnabled = (): boolean => (
  typeof window !== 'undefined' && window.__VARIN_ELECTRON__?.trayEnabled !== false
);


const resolveInstanceName = async (): Promise<string> => {
  try {
    if (isDesktopLocalOriginActive()) return 'Local Varin';
    const localOrigin = (window as unknown as { __VARIN_LOCAL_ORIGIN__?: string }).__VARIN_LOCAL_ORIGIN__
      || window.location.origin;
    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) return 'Local Varin';
    const config = await desktopHostsGet();
    const match = config.hosts.find((host) => (
      runtimeApiBaseUrl
        ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host))
        : false
    ));
    if (match?.label?.trim()) return redactSensitiveUrl(match.label.trim());
    return 'Varin';
  } catch {
    return 'Varin';
  }
};

const buildSnapshot = (instanceName: string): TraySnapshot => {
  const sessionState = usePiSessionStore.getState();
  return {
    approvals: [],
    dockBadgeCount: 0,
    instanceName,
    sessions: projectPiTraySessions(
      sessionState.summaries,
      sessionState.records,
      useProjectsStore.getState().projects,
    ),
  };
};

export const useTraySync = (options: { enabled?: boolean } = {}): void => {
  const enabled = options.enabled ?? true;
  React.useEffect(() => {
    if (!enabled || !isTrayPlatform() || !isTrayEnabled() || !canUseElectronDesktopIPC()) return;

    let disposed = false;
    let flushTimer: number | null = null;
    let instanceName = 'Varin';
    let lastSerialized = '';

    const flushNow = () => {
      if (disposed) return;
      const snapshot = buildSnapshot(instanceName);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      void invokeDesktop('desktop_tray_update', snapshot);
    };

    const scheduleFlush = () => {
      if (disposed || flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushNow();
      }, FLUSH_DEBOUNCE_MS);
    };

    const refreshCatalog = () => {
      const state = usePiSessionStore.getState();
      if (state.catalogLoading) return;
      void state.loadCatalog().catch(() => undefined);
    };

    const unsubscribeSessions = usePiSessionStore.subscribe(() => scheduleFlush());
    const unsubscribeProjects = useProjectsStore.subscribe(() => scheduleFlush());

    const sessionState = usePiSessionStore.getState();
    if (!sessionState.catalogLoaded && !sessionState.catalogLoading) refreshCatalog();
    const catalogRefreshTimer = window.setInterval(refreshCatalog, CATALOG_REFRESH_MS);

    void resolveInstanceName().then((name) => {
      if (disposed) return;
      instanceName = name;
      flushNow();
    });

    flushNow();

    return () => {
      disposed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      window.clearInterval(catalogRefreshTimer);
      unsubscribeSessions();
      unsubscribeProjects();
    };
  }, [enabled]);
};
