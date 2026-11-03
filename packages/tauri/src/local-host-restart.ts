import { getRuntimeApiBaseUrl, getRuntimeKey, setLocalRuntimeUrlAuthToken, switchRuntimeEndpointSafely } from '@varin/application-client';
import type { DesktopBootstrapTarget, TauriDesktopBootstrap } from './bootstrap.js';
import type { DesktopNativeTransport } from './bridge.js';

const sameOrigin = (left: string, right: string): boolean => {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
};

/** Restart rotates the local Host connection, not the selected work surface.
 * A native-only notification contains no bearer. Re-read the current window's
 * authorized bootstrap and retain the existing shared draft/document guards. */
export async function refreshLocalDesktopHost(
  target: DesktopBootstrapTarget,
  transport: DesktopNativeTransport,
  readBootstrap: (value: unknown) => TauriDesktopBootstrap | null,
  detail: unknown,
  isDisposed: () => boolean = () => false,
): Promise<void> {
  const previous = detail && typeof detail === 'object' && 'previousOrigin' in detail ? detail.previousOrigin : null;
  if (typeof previous !== 'string' || !sameOrigin(previous, target.__VARIN_LOCAL_ORIGIN__ ?? '')) return;
  const fresh = readBootstrap(await transport.invoke('varin_bootstrap'));
  if (!fresh || !fresh.localOrigin || isDisposed()) return;
  // A new Host invalidates local grants even when its port and long-lived
  // credential are unchanged. Leave the selected remote authentication intact.
  setLocalRuntimeUrlAuthToken(null, null);
  const stillLocal = () => !isDisposed() && getRuntimeKey() === 'local' && sameOrigin(getRuntimeApiBaseUrl(), previous);
  if (!stillLocal()) { target.__VARIN_LOCAL_ORIGIN__ = fresh.localOrigin; return; }
  // Per-window native identity must also still select its replacement local Host.
  if (!sameOrigin(fresh.apiBaseUrl, fresh.localOrigin)) throw new Error('Native restart did not confirm the local Host connection');
  const superseded = new Error('The selected runtime changed during local Host recovery');
  const guard = () => { if (!stillLocal()) throw superseded; };
  try {
    await switchRuntimeEndpointSafely({ apiBaseUrl: fresh.apiBaseUrl, clientToken: fresh.clientToken,
      requestHeaders: fresh.requestHeaders, runtimeKey: 'local', relay: null }, {
      beforePrepare: guard,
      beforeCommit: () => {
        guard();
        target.__VARIN_LOCAL_ORIGIN__ = fresh.localOrigin;
        target.__VARIN_RELAY_HOST_ID__ = fresh.relayHostId;
        target.__VARIN_DESKTOP_BOOT_OUTCOME__ = fresh.bootOutcome;
      },
    });
  } catch (error) {
    if (error !== superseded) throw error;
    // Keep the new local address available for an explicit later switch, but
    // never replace the remote endpoint or its credentials chosen meanwhile.
    if (!isDisposed()) target.__VARIN_LOCAL_ORIGIN__ = fresh.localOrigin;
  }
}
