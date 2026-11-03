import type { SettingsFileStore } from '@varin/settings-store';
import type { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';

/** Reuse the original desktop-local subject and token. Only the original Host's
 * auth owner can mint a replacement; no shell-side copy of the auth database. */
export function createDesktopLocalCredentials(options: {
  read: SettingsFileStore['read'];
  update: SettingsFileStore['update'];
  auth: Pick<ReturnType<typeof createRemoteClientAuthRuntime>, 'authenticateBearerToken' | 'createClient'>;
}) {
  let pending: Promise<{ clientToken: string }> | undefined;
  return () => pending ??= (async () => {
    const settings = await options.read();
    const stored = typeof settings.desktopLocalClientToken === 'string' ? settings.desktopLocalClientToken.trim() : '';
    const authenticated = stored ? await options.auth.authenticateBearerToken(stored) : null;
    if (authenticated?.client.clientKind === 'desktop-local') return { clientToken: stored };
    const created = await options.auth.createClient({
      label: 'Varin Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local', reuseDedupeIdentity: true,
    });
    await options.update(current => { current.desktopLocalClientToken = created.token; });
    return { clientToken: created.token };
  })().finally(() => { pending = undefined; });
}
