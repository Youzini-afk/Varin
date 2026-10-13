/** Original dispatch dependency cuts. Storage owns references; this owner only holds live definitions. */
import { isDeepStrictEqual } from 'node:util';
import type { McpCompositionDefinitions, McpCompositionSnapshot, McpDefinitionLease } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { McpBinding, SourceAuthorityAddress, SourceAuthorityResult, SourceMcpChildBinding, SourceMcpChildResult } from '../kernel/protocol.generated.js';
import type { ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { ManagedMcpChildAction } from './managed-mcp-contract.js';

type Scope = Pick<ManagedSourceCleanupScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>;
export type ManagedMcpChildInspection = Pick<SourceMcpChildResult, 'reference' | 'phase' | 'grantState'> & { live: boolean };
function failure(code: string): never {
  throw Object.assign(new Error(code), { code, dispatched: false, settlement: 'unknown' });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** A cancelled caller leaves the original work and its cleanup duty intact. */
async function waiting<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
export function createManagedMcpChildren(options: {
  kernel: Pick<KernelClient, 'sourceRequest'>;
  view(scope: Scope, handleId: string, signal: AbortSignal): Promise<{ lease: McpCompositionSnapshot; beforeDispatch(): Promise<void> }>;
}) {
  interface Entry {
    scope: Scope; binding: SourceMcpChildBinding; selection?: McpBinding; handleId?: string;
    definitions?: McpCompositionDefinitions; confirmed: boolean; pending: boolean; released: boolean;
    admission: AbortController; work?: Promise<ManagedMcpChildInspection>; persistence?: Promise<SourceMcpChildResult>;
    uses: Set<Promise<unknown>>; releasing?: Promise<{ retire: boolean; dependenciesDrained: true }>;
  }
  const entries = new Map<string, Entry>(), closed = new Set<string>(), closing = new Map<string, Promise<void>>();
  const address = (scope: Scope): SourceAuthorityAddress => ({ principalId: scope.principal.principalId,
    coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch });
  const scopeKey = (scope: Scope) => JSON.stringify(Object.values(address(scope)));
  const key = (scope: Scope, binding: SourceMcpChildBinding) => `${scopeKey(scope)}:${binding.operationId}`;
  const entry = (scope: Scope, binding: SourceMcpChildBinding) => {
    const selected = entries.get(key(scope, binding));
    if (selected && !isDeepStrictEqual(selected.binding, binding)) failure('mcp_child_binding_changed');
    return selected;
  };
  const reserve = (scope: Scope, binding: SourceMcpChildBinding) => {
    const selected: Entry = { scope: freeze(structuredClone(scope)), binding: freeze(structuredClone(binding)),
      confirmed: false, pending: false, released: false, admission: new AbortController(), uses: new Set() };
    entries.set(key(scope, binding), selected); return selected;
  };
  const detach = (selected: Entry) => {
    const definitions = selected.definitions; delete selected.definitions;
    definitions?.release();
  };
  const stopped = (selected: Entry) => {
    if (selected.released || closed.has(scopeKey(selected.scope))) failure('mcp_child_reference_released');
    selected.admission.signal.throwIfAborted();
  };
  const checked = (selected: Entry, result: SourceMcpChildResult) => {
    if (!isDeepStrictEqual(result.reference.binding, selected.binding)) failure('mcp_child_binding_changed');
    return result;
  };
  const projection = (selected: Entry | undefined, result: SourceMcpChildResult): ManagedMcpChildInspection => ({
    reference: result.reference, phase: result.phase, grantState: result.grantState,
    live: !!selected?.definitions && selected.confirmed && !selected.released && !selected.releasing
      && !closed.has(scopeKey(selected.scope)) && !result.reference.released && result.grantState === 'active'
      && (result.phase === 'ready' || result.phase === 'retaining'),
  });
  const persist = (selected: Entry, first: boolean): Promise<SourceMcpChildResult> => {
    if (selected.persistence) return selected.persistence;
    selected.pending = true;
    // No requester signal: an interrupted content-lane ACK cannot release or replace
    // this exact token. A retry may only write this original immutable selection.
    const work = Promise.resolve().then(async () => {
      const result = checked(selected, await options.kernel.sourceRequest<SourceMcpChildResult>('source.mcp.child', {
        ...address(selected.scope), binding: selected.binding, action: 'retain', selection: selected.selection!,
      }));
      selected.pending = false;
      if (result.created && !result.reference.released) selected.confirmed = true;
      else if (first) detach(selected); // Another heap won; this candidate is not the original holder.
      // A lost first ACK followed by created:false cannot prove this heap won.
      // Keep that uncertain token for exact cleanup, but never expose it for use.
      return result;
    });
    selected.persistence = work;
    void work.then(() => { if (selected.persistence === work) delete selected.persistence; }, () => {
      if (selected.persistence === work) delete selected.persistence;
    });
    return work;
  };
  const join = async (selected: Entry) => {
    await Promise.allSettled([...(selected.work ? [selected.work] : []), ...(selected.persistence ? [selected.persistence] : []), ...selected.uses]);
  };
  const release = (scope: Scope, binding: SourceMcpChildBinding): Promise<{ retire: boolean; dependenciesDrained: true }> => {
    const selected = entry(scope, binding) ?? reserve(scope, binding);
    if (selected.releasing) return selected.releasing;
    // Reserve cleanup synchronously, including release before the first retain arrives.
    const work = Promise.resolve().then(async () => {
      const result = checked(selected, await options.kernel.sourceRequest<SourceMcpChildResult>('source.mcp.child', {
        ...address(selected.scope), binding: selected.binding, action: 'release',
      }));
      if (!result.reference.released) failure('mcp_child_release_unconfirmed');
      selected.released = true; selected.admission.abort();
      await join(selected); detach(selected);
      return { retire: result.phase === 'draining', dependenciesDrained: true as const };
    });
    selected.releasing = work;
    void work.catch(() => { if (selected.releasing === work) delete selected.releasing; });
    return work;
  };
  return {
    async retain(scope: Scope, action: Extract<ManagedMcpChildAction, { kind: 'child_retain' }>, signal: AbortSignal): Promise<ManagedMcpChildInspection> {
      signal.throwIfAborted();
      const binding = freeze(structuredClone(action.binding)), selection = freeze(structuredClone(action.selection)), handleId = action.handleId;
      const prior = entry(scope, binding);
      if (closed.has(scopeKey(scope)) || prior?.released || prior?.releasing) failure('mcp_child_reference_released');
      if (prior?.selection && (!isDeepStrictEqual(prior.selection, selection) || prior.handleId !== handleId)) failure('mcp_child_selection_changed');
      if (prior?.work) return waiting(prior.work, signal);
      const selected = prior ?? reserve(scope, binding);
      selected.selection = selection; selected.handleId = handleId;
      selected.work = (async () => {
        let attempted = false;
        try {
          // A missing local token is not permission to reconstruct one after restart.
          // Read authoritative metadata; a failed read is never interpreted as absence.
          const authority = await options.kernel.sourceRequest<SourceAuthorityResult>('source.authority.inspect', address(selected.scope), selected.admission.signal);
          stopped(selected);
          const existing = authority.mcpChildren.find(child => child.binding.operationId === binding.operationId);
          if (existing) {
            if (!isDeepStrictEqual(existing.binding, binding)) failure('mcp_child_binding_changed');
            const original = checked(selected, await options.kernel.sourceRequest<SourceMcpChildResult>('source.mcp.child', {
              ...address(selected.scope), binding, action: 'read',
            }, selected.admission.signal));
            if (original.selection && !isDeepStrictEqual(original.selection, selection)) failure('mcp_child_selection_changed');
            selected.released ||= original.reference.released;
            return projection(selected, original);
          }
          const view = await options.view(selected.scope, handleId, selected.admission.signal);
          stopped(selected);
          selected.definitions = view.lease.retainDefinitions(selection.provenance);
          await view.beforeDispatch(); stopped(selected);
          attempted = true;
          const result = await persist(selected, true);
          return projection(selected, result);
        } finally {
          if (!attempted) detach(selected);
        }
      })();
      void selected.work.catch(() => undefined);
      return waiting(selected.work, signal);
    },
    async inspect(scope: Scope, binding: SourceMcpChildBinding, signal?: AbortSignal): Promise<ManagedMcpChildInspection> {
      const selected = entry(scope, binding);
      if (selected?.work) await waiting(selected.work.then(() => undefined, () => undefined), signal);
      if (selected?.pending && !selected.released && !selected.releasing && !closed.has(scopeKey(scope)))
        await waiting(persist(selected, false), signal);
      signal?.throwIfAborted();
      const result = await options.kernel.sourceRequest<SourceMcpChildResult>('source.mcp.child', {
        ...address(scope), binding, action: 'inspect',
      }, signal);
      if (selected) checked(selected, result);
      return projection(selected, result);
    },
    release,
    async withRetainedDefinitions<T>(scope: Scope, binding: SourceMcpChildBinding,
      use: (original: { contributions: readonly McpDefinitionLease[]; selection: Readonly<McpBinding>; signal: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted();
      const selected = entry(scope, binding);
      if (!selected || selected.releasing) failure('mcp_child_original_definitions_unavailable');
      stopped(selected);
      const active = signal ? AbortSignal.any([signal, selected.admission.signal]) : selected.admission.signal;
      const work = Promise.resolve().then(async () => {
        if (selected.work) await selected.work.catch(() => undefined);
        stopped(selected); active.throwIfAborted();
        const result = checked(selected, await options.kernel.sourceRequest<SourceMcpChildResult>('source.mcp.child', {
          ...address(selected.scope), binding: selected.binding, action: 'inspect',
        }, active));
        if (!projection(selected, result).live || !selected.definitions || !selected.selection) failure('mcp_child_original_definitions_unavailable');
        active.throwIfAborted();
        return use({ contributions: selected.definitions.contributions, selection: selected.selection, signal: active });
      });
      selected.uses.add(work);
      void work.then(() => selected.uses.delete(work), () => selected.uses.delete(work));
      return waiting(work, signal);
    },
    close(scope: Scope): Promise<void> {
      const id = scopeKey(scope), prior = closing.get(id);
      if (prior) return prior;
      closed.add(id);
      const selected = [...entries.values()].filter(item => scopeKey(item.scope) === id);
      for (const item of selected) { item.admission.abort(); }
      const work = (async () => {
        const results = await Promise.allSettled(selected.map(async item => {
          try { await release(item.scope, item.binding); }
          finally {
            // Explicit Source close must drain local tokens even if the durable
            // tombstone ACK failed; that failure remains visible for cleanup retry.
            item.released = true; await join(item); detach(item);
          }
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        for (const item of selected) entries.delete(key(item.scope, item.binding));
      })();
      closing.set(id, work);
      void work.catch(() => { if (closing.get(id) === work) closing.delete(id); });
      return work;
    },
  };
}
