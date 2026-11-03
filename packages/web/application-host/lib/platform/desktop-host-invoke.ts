import type { HostSshManager } from '../connections/ssh-manager.js';

export type DesktopHostConnections = Pick<HostSshManager,
  'readInstances' | 'setInstances' | 'importHosts' | 'connect' | 'disconnect' | 'statusesWithDefaults' | 'logsForInstance' | 'clearLogsForInstance'>;

/** Explicit legacy desktop commands, delegated to the same Host SSH owner.
 * Never accept arbitrary object paths/method names or private kernel calls. */
export async function invokeDesktopHostCommand(connections: DesktopHostConnections, input: unknown): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid desktop command');
  const { command, args: value } = input as { command?: unknown; args?: unknown };
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid desktop command arguments');
  const args = (value ?? {}) as Record<string, unknown>;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  switch (command) {
    case 'desktop_ssh_instances_get': return connections.readInstances();
    case 'desktop_ssh_instances_set': await connections.setInstances(args.config || {}); return null;
    case 'desktop_ssh_import_hosts': return connections.importHosts();
    case 'desktop_ssh_connect': await connections.connect(id); return null;
    case 'desktop_ssh_disconnect': await connections.disconnect(id); return null;
    case 'desktop_ssh_status': return connections.statusesWithDefaults(id || undefined);
    case 'desktop_ssh_logs': return connections.logsForInstance(id, Number(args.limit) || 200);
    case 'desktop_ssh_logs_clear': connections.clearLogsForInstance(id); return null;
    default: throw new Error('Unknown desktop Host command');
  }
}
