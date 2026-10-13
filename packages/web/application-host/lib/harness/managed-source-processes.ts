/** Live projections only. Source/Storage own authorization, output and every input receipt. */
import type { KernelClient, KernelProcessSubscription } from '../kernel/kernel-client.js';
import type { SourceAuthorityResult } from '../kernel/protocol.generated.js';
import type { ManagedSourceAddress, ManagedSourcePrincipal, ManagedSourceProcessAddress, ManagedSourceService } from './managed-remote-types.js';

export function createManagedSourceProcesses(options: {
  kernel: KernelClient;
  access(principal: ManagedSourcePrincipal, input: ManagedSourceProcessAddress, signal?: AbortSignal): Promise<SourceAuthorityResult>;
  release(principal: ManagedSourcePrincipal, input: ManagedSourceProcessAddress): Promise<void>;
}) {
  interface ProcessView { address: ManagedSourceProcessAddress; principalId: string; principal: ManagedSourcePrincipal;
    ready: Promise<KernelProcessSubscription>; closing?: Promise<void> }
  const views = new Map<string, ProcessView>();
  const key = (principal: ManagedSourcePrincipal, input: ManagedSourceAddress & { subscriptionId: string }) =>
    JSON.stringify([principal.principalId, input.coordinatorHostId, input.authorityId, input.resourceEpoch, input.subscriptionId]);
  const processPermission = (principal: ManagedSourcePrincipal) => {
    if (!['filesystem:read', 'terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))
      throw new Error('Current source process capability was revoked');
  };
  const close = (id: string, view: ProcessView): Promise<void> => {
    view.closing ??= view.ready.then(handle => handle.close().finally(() => options.release(view.principal, view.address)))
      .finally(() => { if (views.get(id) === view) views.delete(id); });
    return view.closing;
  };
  const methods: Pick<ManagedSourceService, 'processSubscribe' | 'processControl' | 'processWrite' | 'processResize'> = {
    async processSubscribe(principal, input, observer, signal) {
      processPermission(principal);
      if (!input.subscriptionId || !Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error('Invalid process stream address');
      const id = key(principal, input);
      if (views.has(id)) throw new Error('Original process view is already open');
      let admitted = false;
      const ready = (async () => {
        const authority = await options.access(principal, input, signal);
        admitted = true;
        signal?.throwIfAborted();
        const scoped = options.kernel.scoped(options.kernel.sourceAuthorityGrant(authority));
        return scoped.processSubscribe({ workspaceId: authority.source.workspace_id, rootId: authority.physicalRoot!.rootId,
          processId: input.processId, cursor: input.cursor }, (event, acknowledge) => observer({ ...event,
            subscriptionId: input.subscriptionId, grantId: input.authorityId }, acknowledge));
      })().catch(async error => { if (admitted) await options.release(principal, input); throw error; });
      const view = { address: input, principalId: principal.principalId, principal, ready };
      views.set(id, view);
      const abort = () => { void close(id, view).catch(() => undefined); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const handle = await ready;
        if (signal?.aborted) { await close(id, view); signal.throwIfAborted(); }
        const closed = handle.closed.finally(() => { signal?.removeEventListener('abort', abort); if (views.get(id) === view) views.delete(id); });
        void closed.catch(() => undefined);
        return { closed, acknowledge: (stream, sequence) => handle.acknowledge(stream, sequence), close: () => close(id, view) };
      } catch (error) { signal?.removeEventListener('abort', abort); if (views.get(id) === view) views.delete(id); throw error; }
    },
    async processControl(principal, input) {
      const id = key(principal, input), view = views.get(id);
      if (!view) {
        if (input.kind === 'close') return { subscriptionId: input.subscriptionId, closed: true };
        throw new Error('Original process view is unavailable');
      }
      if (view.address.processId !== input.processId) throw new Error('Original process view identity changed');
      if (input.kind === 'close') { await close(id, view); return { subscriptionId: input.subscriptionId, closed: true }; }
      processPermission(principal);
      if (input.kind !== 'ack' || !['data', 'control'].includes(input.stream) || !Number.isSafeInteger(input.sequence)) throw new Error('Invalid process stream credit');
      await (await view.ready).acknowledge(input.stream, input.sequence);
      return { subscriptionId: input.subscriptionId, closed: false };
    },
    async processWrite(principal, input) {
      processPermission(principal);
      const authority = await options.access(principal, input);
      return options.kernel.scoped(options.kernel.sourceAuthorityGrant(authority)).processWrite({
        workspaceId: authority.source.workspace_id, rootId: authority.physicalRoot!.rootId, processId: input.processId,
        operationId: input.operationId, bytesBase64: input.bytesBase64, ...(input.eof === undefined ? {} : { eof: input.eof }) });
    },
    async processResize(principal, input) {
      processPermission(principal);
      const authority = await options.access(principal, input);
      return options.kernel.scoped(options.kernel.sourceAuthorityGrant(authority)).processResize({
        workspaceId: authority.source.workspace_id, rootId: authority.physicalRoot!.rootId, processId: input.processId,
        operationId: input.operationId, cols: input.cols, rows: input.rows });
    },
  };
  return { ...methods, async release(principal: ManagedSourcePrincipal, input: ManagedSourceAddress) {
    await Promise.all([...views].filter(([, view]) => view.principalId === principal.principalId
      && view.address.coordinatorHostId === input.coordinatorHostId && view.address.authorityId === input.authorityId
      && view.address.resourceEpoch === input.resourceEpoch).map(([id, view]) => close(id, view)));
  } };
}
