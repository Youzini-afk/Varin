import React from 'react';
import { parsePluginInstallLink, publishPluginInstallIntent, type VarinDesktopBridge } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';

export function openPluginInstallLink(raw: string): boolean {
  const intent = parsePluginInstallLink(raw);
  if (!intent) return false;
  publishPluginInstallIntent(intent);
  useUIStore.getState().setSettingsPage('extensions');
  useUIStore.getState().setSettingsDialogOpen(true);
  return true;
}

/** Accept navigation on this Surface; the plugin page resolves against its actual Application Host. */
export function usePluginInstallLinks(enabled: boolean): void {
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    if (openPluginInstallLink(window.location.href)) {
      const url = new URL(window.location.href);
      url.searchParams.delete('varin-plugin');
      url.searchParams.delete('extensionId');
      window.history.replaceState(window.history.state, '', url);
    }
    const bridge = (window as unknown as { __VARIN_DESKTOP__?: Partial<VarinDesktopBridge> }).__VARIN_DESKTOP__;
    let disposed = false;
    let remove: (() => void) | undefined;
    if (bridge?.listen) {
      void bridge.listen('varin:plugin-install-link', event => { openPluginInstallLink(event.payload.url); }).then(cleanup => {
        if (disposed) cleanup(); else remove = cleanup;
      }).catch(() => { /* The public Web entry remains available if the native bridge has gone away. */ });
    }
    return () => { disposed = true; remove?.(); };
  }, [enabled]);
}
