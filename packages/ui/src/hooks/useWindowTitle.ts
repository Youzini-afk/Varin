import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { setDesktopWindowTitle } from '@/lib/desktopNative';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useEffectiveDirectory } from './useEffectiveDirectory';
import { resolveWindowTitle } from '@/lib/window-title';
import { useVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { VARIN_WORKBENCH_BOT_PROFILE_ID, resolveVarinWorkbenchLayout } from '@varin/extension-contract';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';

export const useWindowTitle = () => {
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useEffectiveDirectory();
  const workbench = useVarinExtensionCatalog().snapshot?.workbench;
  const bot = Boolean(workbench?.authoritative && resolveVarinWorkbenchLayout(workbench.document, {
    surface: varinSurfaceRuntime.surface, userId: 'default',
  }).profileId === VARIN_WORKBENCH_BOT_PROFILE_ID);

  const [instanceLabel, setInstanceLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isDesktopShell()) {
      setInstanceLabel(null);
      return;
    }

    let cancelled = false;

    const refreshInstanceLabel = async () => {
      try {
        if (isDesktopLocalOriginActive()) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const localOrigin = window.__VARIN_LOCAL_ORIGIN__ || window.location.origin;
        const runtimeApiBaseUrl = getRuntimeApiBaseUrl();

        if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const cfg = await desktopHostsGet();
        const match = cfg.hosts.find((host) => runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false);
        const nextLabel = match?.label?.trim() ? redactSensitiveUrl(match.label.trim()) : 'Instance';
        if (!cancelled) {
          setInstanceLabel(nextLabel);
        }
      } catch {
        if (!cancelled) {
          setInstanceLabel('Instance');
        }
      }
    };

    void refreshInstanceLabel();

    const handleFocus = () => {
      void refreshInstanceLabel();
    };

    window.addEventListener('focus', handleFocus);
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      void refreshInstanceLabel();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
      unsubscribeRuntime();
    };
  }, []);

  const title = resolveWindowTitle({ projects, activeProjectId, directory: currentDirectory, instanceLabel, bot });

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = title;
    }

    if (!isDesktopShell()) {
      return;
    }

    const applyTitle = async () => {
      try {
        const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
        if (isMac) {
          return;
        }

        await setDesktopWindowTitle(title);
      } catch {
        return;
      }
    };

    void applyTitle();
  }, [title]);
};
