import { FULL_CONTROL_CAPABILITIES } from '../client-auth/remote-clients.js';

export type ConnectionAccess = 'configuration' | 'execution' | 'proxy';
const configuration = ['instance:read', 'instance:write', 'config:read', 'config:write'];

/** Connection records contain peer credentials. A directory-scoped or read-only
 * principal cannot administer them, execute SSH, or inherit a peer's authority. */
export function hasHostConnectionAccess(context: unknown, operation: ConnectionAccess): boolean {
  if (!context || typeof context !== 'object') return false;
  const auth = context as Record<string, unknown>;
  if (auth.type === 'session') return true;
  if (auth.type !== 'client' || !auth.client || typeof auth.client !== 'object') return false;
  const client = auth.client as Record<string, unknown>;
  if (typeof client.id !== 'string' || !client.id) return false;
  if (client.allowedDirectories !== undefined && (!Array.isArray(client.allowedDirectories) || client.allowedDirectories.length > 0)) return false;
  const capabilities = new Set(Array.isArray(client.capabilities) ? client.capabilities.filter(value => typeof value === 'string') : []);
  const permits = (capability: string) => capabilities.has('*') || capabilities.has('admin')
    || capabilities.has(capability) || capabilities.has(capability.replace(/:[^:]+$/, ':*'));
  const required = operation === 'proxy' ? FULL_CONTROL_CAPABILITIES
    : operation === 'execution' ? [...configuration, 'terminal:use', 'process:control'] : configuration;
  return required.every(permits);
}
