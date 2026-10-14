/** Child MCP consumes B's original preparation receipt, never the parent's execution directory. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient, McpPreparation } from './agent-runtime-client.js';
import type { ManagedSourceAddress } from '../harness/managed-remote-types.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { McpBinding, McpChildDerivationReceipt, McpChildDerivationOrigin, DelegatedExecution } from './protocol.generated.js';
import type { ManagedMcpRevocations, ManagedMcpSnapshot } from '../harness/managed-mcp-contract.js';
import { isManagedMcpRevocations } from '../harness/managed-mcp-contract.js';
import type { createManagedMcpLease, ManagedMcpLease } from './managed-mcp-lease.js';
import { selectMcpServers } from './managed-mcp-preparation.js';

export interface ManagedChildMcpContribution {
  lease: ManagedMcpLease;
  receipt?: McpChildDerivationReceipt;
  releaseDerivation(): Promise<void>;
}
export type ManagedChildMcpPreparer = (input: McpPreparation, signal?: AbortSignal) => Promise<ManagedChildMcpContribution>;

async function releaseDerivation(client: ManagedSourceClient, address: ManagedSourceAddress, executionId: string, signal?: AbortSignal): Promise<void> {
  const reply = await client.service({ ...address, requestId: `mcp-derivation-release:${randomUUID()}`,
    operation: { kind: 'mcp', action: { kind: 'derivation_release', executionId } } }, signal);
  if (!reply.ok) throw new Error(reply.error.code);
  if ((reply.value as { released?: unknown })?.released !== true) throw new Error('mcp_child_derivation_cleanup_unconfirmed');
}

/** Only evidence-backed Source/resource relocation is projected here; immutable selection stays frozen. */
export function derivedChildMcpSelection(selection: McpBinding, receipt: McpChildDerivationReceipt): McpBinding {
  const original = selectMcpServers(selection, owner => owner.kind === 'managed_host');
  if (!isDeepStrictEqual(receipt.proof.selection, original)) throw new Error('mcp_child_original_selection_changed');
  const next = structuredClone(selection);
  const replacements = new Map<string, string>();
  if (!isDeepStrictEqual(Object.keys(receipt.provenance.servers).sort(), Object.keys(original.provenance.servers).sort()))
    throw new Error('mcp_child_derived_servers_changed');
  for (const [name, selected] of Object.entries(original.provenance.servers)) {
    const derived = receipt.provenance.servers[name]!;
    if (!isDeepStrictEqual({ ...derived, resource_key: selected.resource_key,
      owner: { ...derived.owner, source_authority: selected.owner.source_authority } }, selected)
      || !isDeepStrictEqual(derived.owner.source_authority, receipt.proof.source_authority)
      || !derived.resource_key) throw new Error('mcp_child_derived_definition_changed');
    next.provenance.servers[name] = structuredClone(derived);
    replacements.set(selected.resource_key, derived.resource_key);
  }
  for (const [name, resource] of Object.entries(next.resources)) next.resources[name] = replacements.get(resource) ?? resource;
  return next;
}

export function createManagedChildMcpPreparer(options: {
  runtime(): AgentRuntimeClient;
  createLease: typeof createManagedMcpLease;
}): ManagedChildMcpPreparer {
  return async (input, signal) => {
    const runtime = options.runtime(), child = input.child;
    const source = input.source, frozen = input.delegatedBinding ?? input.requiredBinding;
    if (!child || !source || source.mode !== 'materialized' || source.resourceOwner.kind !== 'managed_host'
      || !frozen || child.receipt?.run_id !== input.runId || child.child_thread_id !== input.threadId)
      throw new Error('mcp_child_materialized_source_required');
    const selection = selectMcpServers(frozen, owner => owner.kind === 'managed_host');
    const servers = Object.values(selection.provenance.servers);
    const original = servers[0]?.owner.source_authority;
    if (!servers.length || !original || servers.some(server =>
      !isDeepStrictEqual(server.owner.resource_owner, source.resourceOwner)
      || server.owner.execution_scope !== 'workspace' || !isDeepStrictEqual(server.owner.source_authority, original)))
      throw new Error('mcp_child_original_source_changed');
    let origin: McpChildDerivationOrigin | undefined;
    if (input.delegatedBinding) {
      if (child.trigger.kind === 'dispatch') {
        const operation = await runtime.operation(child.child_operation_id, signal);
        if (operation.id !== child.child_operation_id || operation.run_id !== child.parent_run_id || !operation.execution_owner)
          throw new Error('mcp_child_original_owner_unavailable');
        origin = { kind: 'dispatch', parent_source_authority: original,
          binding: { operationId: operation.id, parentRunId: operation.run_id,
            executionOwner: operation.execution_owner, executionEpoch: operation.epoch } };
      } else origin = { kind: 'continuation', previous_run_id: child.trigger.previous_run_id };
    }
    const controller = new AbortController();
    let prepared: Awaited<ReturnType<typeof createManagedMcpLease>> | undefined;
    try {
      return await runtime.withManagedSourceAuthority(input.runId, { ...source, tools: [...source.tools] }, async access => {
        const address = { coordinatorHostId: runtime.coordinatorHostId, authorityId: access.binding.authorityId, resourceEpoch: access.binding.resourceEpoch };
        const listeners = new Map<string, (facts: ManagedMcpRevocations) => void>();
        prepared = await options.createLease({ access, coordinatorHostId: runtime.coordinatorHostId, owner: source.resourceOwner,
          lifetime: controller.signal, ...(signal ? { signal } : {}),
          ...(origin ? { derivation: { executionId: child.execution_id, origin,
            ...(origin.kind === 'continuation' ? { selection } : {}) } } : { selection, restoration: { executionId: child.execution_id } }),
          observeRevocations: (handle, receive) => { listeners.set(handle, receive); return () => { listeners.delete(handle); }; },
        });
        if (origin) {
          const receipt = prepared.receipt;
          if (!receipt || receipt.proof.execution_id !== child.execution_id || receipt.proof.child_run_id !== input.runId
            || receipt.proof.child_thread_id !== input.threadId || !isDeepStrictEqual(receipt.proof.origin, origin)
            || !isDeepStrictEqual(receipt.proof.source_authority, { coordinator_host_id: address.coordinatorHostId,
              authority_id: address.authorityId, resource_epoch: address.resourceEpoch })
            || !isDeepStrictEqual(receipt.proof.source, access.binding.source)
            || !isDeepStrictEqual(receipt.proof.physical_root, access.binding.physicalRoot)
            || child.source?.kind !== 'ready' || !isDeepStrictEqual(receipt.proof.pin, child.source.pin)
            || !isDeepStrictEqual(receipt.provenance, prepared.snapshot.binding.provenance))
            throw new Error('mcp_child_derivation_receipt_changed');
          derivedChildMcpSelection(frozen, receipt);
        } else if (prepared.receipt) throw new Error('mcp_child_saved_binding_rederived');
        signal?.throwIfAborted();
        // This fixed view observes revocations without refreshing its frozen schema/configuration.
        const watch = async (snapshot: ManagedMcpSnapshot) => {
          let revision = snapshot.revision;
          while (!controller.signal.aborted) {
            const reply = await access.client.service({ ...address, requestId: `mcp-child-change:${randomUUID()}`,
              operation: { kind: 'mcp', action: { kind: 'changed', incarnation: snapshot.incarnation, after: revision } } }, controller.signal);
            if (!reply.ok) throw new Error(reply.error.code);
            const change = reply.value as { incarnation: string; revision: number; revocations: Record<string, ManagedMcpRevocations> };
            if (!change || change.incarnation !== snapshot.incarnation || !Number.isSafeInteger(change.revision) || change.revision <= revision
              || !change.revocations || typeof change.revocations !== 'object' || Array.isArray(change.revocations)
              || !Object.values(change.revocations).every(isManagedMcpRevocations)) throw new Error('mcp_change_owner_invalid');
            revision = change.revision;
            for (const [handle, receive] of listeners) { const facts = change.revocations[handle]; if (facts) receive(facts); }
          }
        };
        void watch(prepared.snapshot).catch(error => { controller.abort(error); });
        const lease = prepared.lease;
        return { lease: { ...lease, release() { controller.abort(); lease.release(); },
          releaseAndDrain() { controller.abort(); return lease.releaseAndDrain(); } },
          ...(prepared.receipt ? { receipt: prepared.receipt } : {}),
          // Read through a fresh client: the preparer's signal/lifetime can already be closed.
          releaseDerivation: async () => releaseDerivation(await runtime.managedSource(source.resourceOwner as Extract<typeof source.resourceOwner, { kind: 'managed_host' }>), address, child.execution_id),
        };
      }, signal, { purpose: 'mcp_owner', ...(!origin ? { original } : {}) });
    } catch (error) {
      controller.abort(error);
      if (prepared) {
        try { await prepared.lease.releaseAndDrain(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Child MCP view cleanup failed'); }
      }
      throw error;
    }
  };
}

/** Called by the original terminal child duty before resources_released, also after Host restart. */
export async function releaseManagedChildDerivations(runtime: AgentRuntimeClient, child: DelegatedExecution, signal?: AbortSignal): Promise<void> {
  if (!child.receipt || !child.launch.mcp_binding || !Object.values(child.launch.mcp_binding.provenance.servers)
    .some(server => server.owner.resource_owner.kind === 'managed_host')) return;
  const launch = await runtime.launch(child.receipt.run_id, signal), source = launch?.selection.source;
  if (!source || source.resource_owner.kind !== 'managed_host') throw new Error('mcp_child_original_source_unavailable');
  // Native admission never grants mcp_owner/derivation authority to a FixedBranch.
  if (source.mode !== 'materialized') return;
  const client = await runtime.managedSource(source.resource_owner, signal);
  const authorities = await client.inspectScope({ coordinatorHostId: runtime.coordinatorHostId,
    threadId: child.child_thread_id, runId: child.receipt.run_id }, signal);
  const candidates = authorities.filter(authority => authority.purpose === 'mcp_owner'
    && authority.scope.kind === 'run' && authority.scope.runId === child.receipt!.run_id
    && authority.scope.threadId === child.child_thread_id && isDeepStrictEqual(authority.binding.source, source));
  const drained = await Promise.allSettled(candidates.map(authority => releaseDerivation(client,
    { coordinatorHostId: runtime.coordinatorHostId, authorityId: authority.binding.authorityId, resourceEpoch: authority.binding.resourceEpoch }, child.execution_id, signal)));
  const failures = drained.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Child MCP proof cleanup failed');
}
