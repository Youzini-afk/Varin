/** Inbound resource service, independent of the Agent's outbound connection registry,
 * model accounts, scheduler and Bot. Mount only behind the owning Host's pairing authority. */
import type { Express } from 'express';
import { createResourceService } from './resources.js';
import { createManagedRemoteExecutionService } from './managed-remote-service.js';
import { createManagedSourceService, type ManagedSourceServiceOptions } from './managed-source-service.js';
import { registerManagedRemoteRoutes, type ManagedRemoteRoutesOptions } from './managed-remote-routes.js';
import type { KernelClient } from '../kernel/kernel-client.js';

interface TargetRoutes {
  documents: NonNullable<ManagedRemoteRoutesOptions['documents']>;
  requireAuth: NonNullable<ManagedRemoteRoutesOptions['requireAuth']>;
  resolveAuthContext: NonNullable<ManagedRemoteRoutesOptions['resolveAuthContext']>;
  isDraining: () => boolean;
}

export function createManagedResourceTarget(options: {
  kernel: KernelClient;
  capacity?: Omit<Parameters<typeof createResourceService>[0], 'client'>;
  /** The separate managed Storage routes must really be installed to advertise Storage. */
  storageAvailable: boolean;
  onError(error: Error): void;
}) {
  const identity = options.kernel.handshake;
  if (!identity) throw new Error('Managed target requires a handshaken resource kernel');
  const resources = createResourceService({ ...options.capacity, client: options.kernel });
  const execution = createManagedRemoteExecutionService({
    client: options.kernel, hostId: identity.hostId, resources,
    storageAvailable: options.storageAvailable, onError: options.onError,
  });
  const scans = new Set<Promise<void>>();
  const recover = () => {
    const scan = execution.reconcile().catch(options.onError).finally(() => scans.delete(scan));
    scans.add(scan);
  };
  const removeExit = options.kernel.subscribeExit(execution.disconnect);
  const removeReady = options.kernel.subscribeReady(recover);
  recover(); // Reattach to durable original jobs; never submit a replacement.
  return {
    resources, execution,
    attachSources: (source: Omit<ManagedSourceServiceOptions, 'kernel' | 'hostId'>) =>
      execution.setSourceOwner(createManagedSourceService({ ...source, kernel: options.kernel, hostId: identity.hostId })),
    mount: (app: Express, routes: TargetRoutes) => registerManagedRemoteRoutes(app, { ...routes, service: execution }),
    async dispose() {
      removeReady();
      removeExit();
      await Promise.all([execution.detachObservers(), ...scans]);
      await resources.dispose();
    },
  };
}
