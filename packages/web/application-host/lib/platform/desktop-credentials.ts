import type { SettingsFileStore } from '@varin/settings-store';
import type { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';

/** Reuse the original desktop-local subject and token. Only the original Host's
 * auth owner can mint a replacement; no shell-side copy of the auth database. */
export function createDesktopLocalCredentials(options: {
  read: SettingsFileStore['read'];
  update: SettingsFileStore['update'];
  auth: Pick<ReturnType<typeof createRemoteClientAuthRuntime>, 'issueDesktopLocalClient'>;
}) {
  let pending: Promise<{ clientToken: string }> | undefined;
  return () => pending ??= (async () => {
    const settings = await options.read();
    if (settings.desktopLocalClientToken !== undefined && settings.desktopLocalClientToken !== null
      && typeof settings.desktopLocalClientToken !== 'string') {
      throw new Error('Existing desktop local credential is invalid');
    }
    const stored = typeof settings.desktopLocalClientToken === 'string' ? settings.desktopLocalClientToken.trim() : '';
    const created = await options.auth.issueDesktopLocalClient(stored);
    if (created.token !== stored) {
      await options.update(current => { current.desktopLocalClientToken = created.token; });
    }
    return { clientToken: created.token };
  })().finally(() => { pending = undefined; });
}
