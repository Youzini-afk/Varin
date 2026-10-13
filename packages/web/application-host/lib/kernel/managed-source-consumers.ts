/** Coordinator adapters retain the selected endpoint and borrow only its original resource authority. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadSource } from '@varin/application-client';
import type { ManagedRemoteTargetRegistry, ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceBinding, SourceServiceOperation, SourceServiceResponse } from '../harness/managed-remote-types.js';
import type { ResourceReader } from '../agent-resources/source-reader.js';
import type { ThreadSourceRemoteOwner } from './thread-sources.js';
import type { ManagedSourceQueryTransport } from './source-query.js';
import type { ThreadResourceScope, ThreadResourceScopeOptions } from './thread-resource-scope.js';
import { resourceSource, resourceThreadSource } from './thread-context.js';

export interface ManagedSourceAccess {
  client: ManagedSourceClient;
  binding: ManagedSourceBinding;
}
export interface ManagedSourceConsumerOptions {
  coordinatorHostId(): string;
  registry: Pick<ManagedRemoteTargetRegistry, 'source' | 'sourceTargets'>;
  /** The Run's original admitted binding. Never replace it with a fresh grant for an old effect. */
  withRunAuthority<T>(runId: string, source: ThreadSource, consume: (access: ManagedSourceAccess) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export function createManagedSourceConsumers(options: ManagedSourceConsumerOptions): {
  threads: ThreadSourceRemoteOwner;
  resources: Pick<ThreadResourceScope, 'prepare' | 'withScope'>;
  query: ManagedSourceQueryTransport;
} {
  const service = async <Operation extends SourceServiceOperation>(access: ManagedSourceAccess, operation: Operation, signal?: AbortSignal): Promise<SourceServiceResponse<Operation>> => {
    signal?.throwIfAborted();
    return await access.client.service({ coordinatorHostId: options.coordinatorHostId(), authorityId: access.binding.authorityId,
      resourceEpoch: access.binding.resourceEpoch, requestId: `source-service:${randomUUID()}`, operation }, signal);
  };
  const withRead = async <T>(identity: Parameters<ThreadResourceScope['prepare']>[0], source: ThreadSource,
    consume: (access: ManagedSourceAccess) => Promise<T>, config: ThreadResourceScopeOptions = {}): Promise<T> => {
    if (config.runId) return options.withRunAuthority(config.runId, source, consume, config.signal);
    if (source.resourceOwner.kind !== 'managed_host') throw new Error('Managed source requires its exact target owner');
    const client = await options.registry.source(source.resourceOwner, config.signal);
    const key = `source-read:${randomUUID()}`;
    // Admission drains before cancellation can release the returned native authority.
    const binding = await client.bind({ coordinatorHostId: options.coordinatorHostId(), source,
      scope: { kind: 'source_read', threadId: identity.threadId, branchId: identity.branchId, key },
      purpose: 'read', retention: 'caller' });
    const access = { client, binding };
    try {
      config.signal?.throwIfAborted();
      if (!isDeepStrictEqual(resourceSource(source), resourceSource(resourceThreadSource(binding.source)))) throw new Error('Managed source admission changed the original selection');
      return await consume(access);
    } finally {
      await client.release({ coordinatorHostId: options.coordinatorHostId(), authorityId: binding.authorityId,
        resourceEpoch: binding.resourceEpoch, mode: 'retire' });
    }
  };
  const threads: ThreadSourceRemoteOwner = {
    list: (_identity, signal) => options.registry.sourceTargets(signal),
    async resolve(_identity, request, signal) {
      if (request.resourceOwner.kind !== 'managed_host') throw new Error('Managed source requires its exact target owner');
      const client = await options.registry.source(request.resourceOwner, signal);
      const resolved = await client.resolve({ coordinatorHostId: options.coordinatorHostId(), path: request.path }, signal);
      if (resolved.hostId !== request.resourceOwner.hostId) throw new Error('Managed source resolution changed Host');
      return { resourceOwner: request.resourceOwner, workspaceId: resolved.workspaceId, path: resolved.canonicalRoot };
    },
    async prepare(input, signal) {
      if (input.resourceOwner.kind !== 'managed_host') throw new Error('Managed source requires its exact target owner');
      const client = await options.registry.source(input.resourceOwner, signal);
      const prepared = await client.prepare({ coordinatorHostId: options.coordinatorHostId(), input }, signal);
      if (!isDeepStrictEqual(prepared.source.resourceOwner, input.resourceOwner) || prepared.source.workspaceId !== input.workspaceId
        || prepared.source.mode !== input.mode) throw new Error('Managed source preparation changed the original selection');
      return prepared;
    },
    async admit(source, identity, _runId, signal) {
      // Launch admission precedes the Run's main binding (including a recovered epoch).
      // Its original source is checked by a short readonly scope, without materializing a Run.
      await withRead(identity, source, access => service(access, { kind: 'validate' }, signal), { ...(signal ? { signal } : {}) });
    },
  };
  const resources: Pick<ThreadResourceScope, 'prepare' | 'withScope'> = {
    async prepare(identity, source, admitted, config = {}) {
      if (!source) throw new Error('Managed resource preparation requires its original source');
      return withRead(identity, source, access => service(access, { kind: 'resources_prepare', identity, admitted,
        ...(config.instructionDirectories ? { instructionDirectories: config.instructionDirectories } : {}),
        ...(config.supportingFiles ? { supportingFiles: config.supportingFiles } : {}) }, config.signal), config);
    },
    async withScope(identity, source, admitted, consume, config = {}) {
      if (!source || !config.snapshot) throw new Error('Managed resource reads require their original source snapshot');
      const snapshot = config.snapshot;
      return withRead(identity, source, async access => {
        await service(access, { kind: 'resources_prepare', identity, admitted, snapshot,
          ...(config.request ? { request: config.request } : {}) }, config.signal);
        const readers: ResourceReader[] = snapshot.readers.map(declared => ({ ...declared,
          read: (path, signal) => service(access, { kind: 'resource_read', identity, snapshot,
            reference: { domainId: declared.domainId, viewId: declared.viewId, path }, ...(config.request ? { request: config.request } : {}) }, signal),
          list: (path, signal) => service(access, { kind: 'resource_list', identity, snapshot,
            reference: { domainId: declared.domainId, viewId: declared.viewId, path }, ...(config.request ? { request: config.request } : {}) }, signal),
        }));
        const result = await consume({ admittedScope: { ...snapshot.scope }, readers });
        await service(access, { kind: 'validate' }, config.signal);
        return result;
      }, config);
    },
  };
  const query: ManagedSourceQueryTransport = {
    async service(query, operation, signal) {
      if (!query.runId) throw new Error('Managed query requires its original coordinator Run');
      const source = resourceThreadSource(query.source)!;
      return options.withRunAuthority(query.runId, source, access => {
        if (!isDeepStrictEqual(query.source, access.binding.source) || !isDeepStrictEqual(query.physicalRoot, access.binding.physicalRoot)) throw new Error('Managed query changed its original source authority');
        return service(access, operation, signal);
      }, signal);
    },
  };
  return { threads, resources, query };
}
