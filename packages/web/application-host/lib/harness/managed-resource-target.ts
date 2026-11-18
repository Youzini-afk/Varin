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
  /** A standalone live-directory node does not expose the full Host's job, storage or raw shell endpoints. */
  liveSourceOnly?: boolean;
  onError(error: Error): void;
}) {
  const identity = options.kernel.handshake;
  if (!identity) throw new Error('Managed target requires a handshaken resource kernel');
  const resources = createResourceService({ ...options.capacity, client: options.kernel });
  const execution = createManagedRemoteExecutionService({
    client: options.kernel, hostId: identity.hostId, resources,
    storageAvailable: options.storageAvailable, liveSourceOnly: options.liveSourceOnly === true, onError: options.onError,
  });
  const scans = new Set<Promise<void>>();
  const active = new Set<Promise<void>>();
  const recover = () => {
    if (options.liveSourceOnly) return; // No legacy job admission/observers on this role.
    const scan = execution.reconcile().catch(options.onError).finally(() => scans.delete(scan));
    scans.add(scan);
  };
  const removeExit = options.kernel.subscribeExit(execution.disconnect);
  const removeReady = options.kernel.subscribeReady(recover);
  recover(); // Reattach to durable original jobs; never submit a replacement.
  return {
    resources, execution,
    attachSources: (source: Omit<ManagedSourceServiceOptions, 'kernel' | 'hostId'>) =>
      execution.setSourceOwner(createManagedSourceService({ ...source, liveSourceOnly: options.liveSourceOnly === true, kernel: options.kernel, hostId: identity.hostId })),
    mount: (app: Express, routes: TargetRoutes) => {
      if (options.liveSourceOnly) {
        // This is an explicit role surface, not an authentication shortcut. Every mounted
        // operation below still enters the same paired-client and original-source authorities.
        const posts = new Set([...['workspace/resolve', 'read', 'resource/identity'].map(name => '/documents/' + name),
          ...['capabilities', 'resolve', 'prepare', 'bind', 'authorize', 'execute', 'observe', 'cancel', 'release',
            'service', 'cancelService', 'releaseReceipt', 'inspectScope', 'releaseScope', 'inspectReadScope', 'closeReadScope', 'fileReceipt',
            'processAccess', 'processControl', 'processWrite', 'processResize', 'processSubscribe'].map(name => '/sources/' + name)]);
        app.use('/api/harness/managed-execution/v1', (req, res, next) => {
          if (req.method === 'GET' && req.path === '/identity' || req.method === 'POST' && posts.has(req.path)) return next();
          res.status(404).json({ code: 'resource-node-operation-unavailable' });
        });
      }
      registerManagedRemoteRoutes(app, { ...routes, service: execution, ...(options.liveSourceOnly ? {
        trackRequest(work: Promise<void>) {
          active.add(work);
          const done = () => { active.delete(work); };
          void work.then(done, done);
        },
      } : {}) });
    },
    async dispose() {
      removeReady();
      removeExit();
      await Promise.allSettled([...active]);
      await Promise.all([execution.detachObservers(), ...scans]);
      await resources.dispose();
    },
  };
}
