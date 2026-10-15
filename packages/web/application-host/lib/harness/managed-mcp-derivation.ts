/** One-shot child execution preparation. Storage owns proof; ordinary views own RPC admission. */
import { isDeepStrictEqual } from 'node:util';
import { composeMcpAuthorityLeases, type McpAuthority, type McpAuthorityOwnedLease, type McpAuthorityScope,
  type McpCompositionSnapshot, type McpDefinitionLease } from '../mcp/authority.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { McpBinding, McpChildDerivationReceipt, McpProvenance, SourceAuthorityAddress,
  SourceMcpDerivationOutcome, SourceMcpDerivationResult } from '../kernel/protocol.generated.js';
import type { ManagedSourceCleanupScope, ManagedSourceLocalScope } from './managed-remote-types.js';
import type { ManagedMcpDerivationAction } from './managed-mcp-contract.js';
import type { createManagedMcpChildren } from './managed-mcp-children.js';

type Address = Pick<ManagedSourceCleanupScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>;
type Derive = Extract<ManagedMcpDerivationAction, { kind: 'derive' }>;
export interface ManagedMcpDerivedView { lease: McpCompositionSnapshot; receipt: McpChildDerivationReceipt }
function failure(code: string): never { throw Object.assign(new Error(code), { code, dispatched: false, settlement: 'unknown' }); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
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
/** The snapshot retains actual owned child definitions, including unconnected deferred servers. */
function snapshot(parts: Array<{ lease: McpAuthorityOwnedLease; servers: string[] }>): McpCompositionSnapshot {
  const composed = composeMcpAuthorityLeases(parts);
  let released = false;
  return { ...composed,
    retainDefinitions(exact) {
      if (released) failure('mcp_lease_released');
      const provenance = freeze(structuredClone(exact)), retained: McpDefinitionLease[] = [];
      try {
        for (const [name, expected] of Object.entries(provenance.servers))
          if (!isDeepStrictEqual(composed.binding.provenance.servers[name], expected)) failure('mcp_saved_definition_unavailable');
        for (const part of parts) {
          const servers = Object.fromEntries(part.servers.filter(name => Object.hasOwn(provenance.servers, name))
            .map(name => [name, provenance.servers[name]!]));
          if (Object.keys(servers).length) retained.push(part.lease.retainDefinitions({ servers }));
        }
      } catch (error) { for (const token of retained) token.release(); throw error; }
      let closed = false;
      return Object.freeze({ provenance, contributions: Object.freeze(retained), release() {
        if (closed) return; closed = true;
        for (const token of retained) token.release();
      } });
    },
    release() { if (released) return; released = true; composed.release(); },
  };
}

export function createManagedMcpDerivations(options: {
  kernel: Pick<KernelClient, 'sourceRequest'>;
  authority: Pick<McpAuthority, 'acquire'>;
  children: Pick<ReturnType<typeof createManagedMcpChildren>, 'withRetainedDefinitions'>;
}) {
  interface Entry {
    scope: ManagedSourceLocalScope; action: Derive; admission: AbortController;
    authorityScope: McpAuthorityScope; readmit(signal: AbortSignal): Promise<void>;
    prepared(candidate: ManagedMcpDerivedView): void;
    owned: McpAuthorityOwnedLease[]; candidate?: ManagedMcpDerivedView;
    confirmed?: SourceMcpDerivationResult; outcome?: SourceMcpDerivationOutcome; settled: boolean;
    work?: Promise<ManagedMcpDerivedView>; finished: boolean; disposed: boolean;
    draining?: Promise<void>; releasing?: Promise<{ released: true }>;
  }
  const entries = new Map<string, Entry>(), closed = new Set<string>();
  const address = (scope: Address): SourceAuthorityAddress => ({ principalId: scope.principal.principalId,
    coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch });
  const scopeKey = (scope: Address) => JSON.stringify(Object.values(address(scope)));
  const keyOf = (scope: Address, executionId: string) => `${scopeKey(scope)}:${executionId}`;
  const stopped = (entry: Entry) => {
    if (entry.disposed || closed.has(scopeKey(entry.scope))) failure('mcp_child_derivation_closed');
    entry.admission.signal.throwIfAborted();
  };
  const checked = (entry: Entry, result: SourceMcpDerivationResult) => {
    if (result.reference.executionId !== entry.action.executionId
      || entry.confirmed && result.reference.requestHash !== entry.confirmed.reference.requestHash)
      failure('mcp_child_derivation_changed');
    return result;
  };
  const persist = async (entry: Entry) => {
    // A lost outcome ACK retries this body only, never acquisition or an SDK request.
    const result = checked(entry, await options.kernel.sourceRequest<SourceMcpDerivationResult>('source.mcp.derivation', {
      ...address(entry.scope), executionId: entry.action.executionId, action: 'settle', outcome: entry.outcome!,
    }));
    if (result.reference.released || !isDeepStrictEqual(result.outcome, entry.outcome)) failure('mcp_child_derivation_unconfirmed');
    entry.settled = true;
  };
  const drainOwned = async (entry: Entry) => {
    const results = await Promise.allSettled([Promise.resolve().then(() => entry.candidate?.lease.release()),
      ...entry.owned.map(lease => Promise.resolve().then(() => lease.releaseAndDrain()))]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  const prepare = async (entry: Entry): Promise<ManagedMcpDerivedView> => {
    stopped(entry); await entry.readmit(entry.admission.signal); stopped(entry);
    const begin = checked(entry, await options.kernel.sourceRequest<SourceMcpDerivationResult>('source.mcp.derivation', {
      ...address(entry.scope), executionId: entry.action.executionId, action: 'begin', origin: entry.action.origin,
      ...(entry.action.selection ? { selection: entry.action.selection } : {}),
    }));
    // Only the acknowledged original insertion may open child execution resources.
    // An existing durable begin after heap loss cannot establish a new winner.
    if (!begin.created || begin.reference.released || !begin.proof || begin.outcome
      || begin.grantState !== 'active' || begin.phase !== 'ready') failure('mcp_child_original_derivation_unavailable');
    entry.confirmed = begin;
    const proof = freeze(structuredClone(begin.proof));
    try {
      stopped(entry);
      if (entry.scope.scope.kind !== 'run' || entry.scope.source.mode !== 'materialized'
        || proof.execution_id !== entry.action.executionId || proof.child_run_id !== entry.scope.scope.runId
        || proof.child_thread_id !== entry.scope.scope.threadId || !isDeepStrictEqual(proof.source, entry.scope.source)
        || !isDeepStrictEqual(proof.physical_root, entry.scope.physicalRoot)
        || !isDeepStrictEqual(proof.source_authority, entry.authorityScope.sourceAuthority)
        || !isDeepStrictEqual(proof.origin, entry.action.origin)
        || entry.action.origin.kind === 'continuation' && !isDeepStrictEqual(proof.selection, entry.action.selection))
        failure('mcp_child_derivation_proof_changed');
      const directResources = new Set(proof.selection.tools
        .filter(tool => ['direct', 'direct_task'].includes(proof.selection.routes[tool.name]?.kind ?? ''))
        .map(tool => proof.selection.resources[tool.name]).filter(Boolean));
      const acquire = async (contributions: readonly { provenance: McpProvenance; token?: McpDefinitionLease }[], signal: AbortSignal) => {
        const all = Object.fromEntries(contributions.flatMap(part => Object.entries(part.provenance.servers)));
        const count = contributions.reduce((total, part) => total + Object.keys(part.provenance.servers).length, 0);
        if (Object.keys(all).length !== count || !isDeepStrictEqual({ servers: all }, proof.selection.provenance))
          failure('mcp_child_original_definitions_changed');
        const results = await Promise.allSettled(contributions.map(async part => {
          try {
            signal.throwIfAborted(); await entry.readmit(signal); stopped(entry);
            const lease = await options.authority.acquire(entry.authorityScope, {
              servers: Object.entries(part.provenance.servers).filter(([, server]) => directResources.has(server.resource_key)).map(([name]) => name),
              ...(part.token ? { deriveFrom: part.token } : { deriveExactCurrent: part.provenance }), signal,
            });
            entry.owned.push(lease); // Own even a late, aborted candidate before checking cancellation.
            signal.throwIfAborted(); stopped(entry); await entry.readmit(signal);
            return { lease, servers: Object.keys(part.provenance.servers) };
          } catch (error) { entry.admission.abort(error); throw error; }
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        return results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
      };
      const origin = proof.origin;
      const parts = origin.kind === 'dispatch'
        ? await options.children.withRetainedDefinitions({ principal: entry.scope.principal,
          coordinatorHostId: origin.parent_source_authority.coordinator_host_id,
          authorityId: origin.parent_source_authority.authority_id, resourceEpoch: origin.parent_source_authority.resource_epoch,
        }, origin.binding, async original => {
          if (!isDeepStrictEqual(original.selection, proof.selection)) failure('mcp_child_original_selection_changed');
          return acquire(original.contributions.map(token => ({ token, provenance: token.provenance })),
            AbortSignal.any([original.signal, entry.admission.signal]));
        })
        : await acquire([{ provenance: proof.selection.provenance }], entry.admission.signal);
      stopped(entry); await entry.readmit(entry.admission.signal); stopped(entry);
      const lease = snapshot(parts);
      const receipt = freeze({ proof, provenance: structuredClone(lease.binding.provenance) });
      entry.candidate = { lease, receipt };
      // Register the original root's revocation tokens even if the requester has
      // left or the later durable outcome acknowledgement is lost.
      entry.prepared(entry.candidate);
      entry.outcome = freeze({ kind: 'derived', provenance: receipt.provenance });
    } catch (error) {
      entry.admission.abort(error);
      entry.outcome = { kind: 'failed', code: typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code : 'mcp_child_derivation_failed' };
      // Keep all original candidate identities if either durable publication or close fails.
      const cleanup = await Promise.allSettled([drainOwned(entry), persist(entry)]);
      const failures = cleanup.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError([error, ...failures.map(result => result.reason)], 'mcp_child_derivation_cleanup_failed');
      throw error;
    }
    await persist(entry); stopped(entry);
    return entry.candidate!;
  };
  const setWork = (entry: Entry, work: Promise<ManagedMcpDerivedView>) => {
    entry.finished = false; entry.work = work;
    void work.then(() => { entry.finished = true; }, () => { entry.finished = true; });
    return work;
  };
  const dispose = (entry: Entry, drain: boolean): Promise<void> => {
    entry.disposed = true; entry.admission.abort(); entry.candidate?.lease.release();
    if (drain && entry.draining) return entry.draining;
    const work = (async () => {
      await entry.work?.catch(() => undefined);
      entry.candidate?.lease.release();
      if (drain) await drainOwned(entry);
    })();
    if (drain) {
      entry.draining = work;
      void work.catch(() => { if (entry.draining === work) delete entry.draining; });
    }
    return work;
  };
  const release = async (scope: Address, executionId: string): Promise<{ released: true }> => {
    const entry = entries.get(keyOf(scope, executionId));
    if (entry?.releasing) return entry.releasing;
    const work = (async () => {
      const result = await options.kernel.sourceRequest<SourceMcpDerivationResult>('source.mcp.derivation', {
        ...address(scope), executionId, action: 'release',
      });
      if (result.reference.executionId !== executionId || !result.reference.released) failure('mcp_child_derivation_release_unconfirmed');
      return { released: true as const };
    })();
    if (entry) { entry.releasing = work; void work.catch(() => { if (entry.releasing === work) delete entry.releasing; }); }
    return work;
  };
  return {
    derive(scope: ManagedSourceLocalScope, action: Derive, authorityScope: McpAuthorityScope,
      readmit: Entry['readmit'], prepared: Entry['prepared'], signal?: AbortSignal): Promise<ManagedMcpDerivedView> {
      signal?.throwIfAborted();
      if (closed.has(scopeKey(scope))) failure('mcp_child_derivation_closed');
      const key = keyOf(scope, action.executionId);
      let entry = entries.get(key);
      if (entry && !isDeepStrictEqual(entry.action, action)) failure('mcp_child_derivation_changed');
      if (!entry) {
        entry = { scope, action: freeze(structuredClone(action)), authorityScope, readmit, prepared, admission: new AbortController(),
          owned: [], finished: false, disposed: false, settled: false };
        entries.set(key, entry);
        setWork(entry, Promise.resolve().then(() => prepare(entry!)));
      } else {
        stopped(entry);
        if (entry.finished && entry.candidate && !entry.settled && entry.outcome?.kind === 'derived') {
          const selected = entry;
          setWork(entry, persist(entry).then(() => { stopped(selected); return selected.candidate!; }));
        }
      }
      return waiting(entry.work!, signal);
    },
    async inspect(scope: Address, executionId: string, signal?: AbortSignal) {
      const entry = entries.get(keyOf(scope, executionId));
      if (entry?.work) await waiting(entry.work.then(() => undefined, () => undefined), signal);
      if (entry?.candidate && !entry.disposed && !entry.settled && entry.outcome?.kind === 'derived') {
        const selected = entry;
        // Readback may repair only this heap's exact original outcome publication.
        // The Source service's one-shot request tombstone never needs to be reopened.
        await waiting(setWork(entry, persist(entry).then(() => { stopped(selected); return selected.candidate!; })), signal);
      }
      const result = await options.kernel.sourceRequest<SourceMcpDerivationResult>('source.mcp.derivation', {
        ...address(scope), executionId, action: 'read',
      }, signal);
      if (entry) checked(entry, result);
      const live = !!entry?.candidate && entry.settled && !entry.disposed && !entry.admission.signal.aborted
        && !!entry.confirmed && result.grantState === 'active' && result.phase === 'ready';
      return { result, live, ...(live ? { candidate: entry!.candidate!, action: entry!.action } : {}) };
    },
    release,
    releaseView(scope: Address, handleId: string, creationRequestId: string) {
      const selected = [...entries.values()].filter(entry => scopeKey(entry.scope) === scopeKey(scope) && entry.action.handleId === handleId);
      if (selected.some(entry => entry.action.creationRequestId !== creationRequestId)) failure('mcp_view_creation_changed');
      // A projection can be dropped after Catalog commit but before startup succeeds.
      // Its settled original root remains Source-owned for exact later restoration.
      return Promise.all(selected.map(entry => entry.settled && entry.candidate && !entry.disposed
        ? Promise.resolve() : dispose(entry, true))).then(() => undefined);
    },
    async seal(scope: Address) {
      closed.add(scopeKey(scope));
      await Promise.all([...entries.values()].filter(entry => scopeKey(entry.scope) === scopeKey(scope))
        .map(entry => dispose(entry, false)));
    },
    async close(scope: Address) {
      closed.add(scopeKey(scope));
      const selected = [...entries.values()].filter(entry => scopeKey(entry.scope) === scopeKey(scope));
      // Fence all admissions synchronously before awaiting any native receipt or SDK close.
      // Ordinary physical Source retirement does not acknowledge A's launch commit.
      // Only the separate commit/terminal duty releases durable proof and outcome bodies.
      const results = await Promise.allSettled(selected.map(entry => dispose(entry, true)));
      for (let index = 0; index < selected.length; index++) if (results[index]?.status === 'fulfilled') {
        const entry = selected[index]!, key = keyOf(entry.scope, entry.action.executionId);
        if (entries.get(key) === entry) entries.delete(key);
      }
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
