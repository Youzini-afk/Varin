import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedHostSourceOwner, ManagedSourceReceipt, ManagedSourceToolRequest } from '../harness/managed-remote-types.js';
import type { SourceToolBinding, SourceResourceAction, ToolOrigin, LaunchSource } from './protocol.generated.js';
import { controlManagedScript } from './managed-script-source.js';
import { releaseManagedPackageSource, type ManagedPackageCleanup } from './managed-package-source.js';
import { recallManagedScheduleReceipt, type ManagedScheduleReceiptQuery } from './managed-schedule-receipt.js';

export type ManagedSourceOwner = (owner: ManagedHostSourceOwner) => Promise<ManagedSourceClient>;
export type PrivateManagedSourceFrame = { v: 1; kind: 'source-resource-response'; id: string; kernelEpoch: string; result: { ok: boolean; value?: unknown; message?: string } }
  | { v: 1; kind: 'source-process-terminal'; kernelEpoch: string; source: LaunchSource; executionOwner: unknown; process: Record<string, unknown> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
interface Query {
  kind: 'tool' | 'resource' | 'control'; phase?: 'authorize' | 'execute' | 'observe' | 'cancel' | 'release'; binding: SourceToolBinding;
  context: { run_id: string; operation_id: string; origin: ToolOrigin };
  call?: { call_id: string; name: string; schema_version: string; arguments: unknown };
  journal?: ManagedSourceToolRequest['journal'] | null;
  action?: SourceResourceAction; authorizeOnly?: boolean; watchProcess?: boolean;
}
function source(binding: SourceToolBinding): LaunchSource {
  const fixed = binding.fileSource ?? binding.materializedSource;
  return { resource_owner: binding.resourceOwner, workspace_id: binding.workspaceId, execution_workspace_id: binding.executionWorkspaceId,
    mode: binding.sourceMode, live_root: binding.liveRoot ?? null, branch_id: fixed?.branchId ?? null, revision: fixed?.revision ?? null,
    environment_run_id: binding.environmentRunId ?? null };
}
/** Only the original private Rust transport can call this bridge. It never owns effects. */
export class ManagedSourceBridge {
  private owner?: ManagedSourceOwner;
  private coordinator?: () => string;
  private readonly active = new Map<string, { epoch: string; cancel?: () => Promise<unknown>; cancelled: boolean }>();
  private readonly observations = new Map<string, { control: AbortController; stopRequested: boolean }>();
  constructor(private readonly epoch: () => string | null, private readonly send: (frame: PrivateManagedSourceFrame) => Promise<void>, private readonly failed: () => void) {}
  setOwner(owner: ManagedSourceOwner, coordinator: () => string): void { if (this.owner && this.owner !== owner) throw new Error('Managed source bridge already bound'); this.owner = owner; this.coordinator = coordinator; }
  close(): void { this.active.clear(); for (const observation of this.observations.values()) observation.control.abort(); this.observations.clear(); }
  private async observeProcess(client: ManagedSourceClient, query: Query, epoch: string, initial?: ManagedSourceReceipt): Promise<void> {
    const authority = query.binding.remoteAuthority!;
    const key = `${authority.authorityId}:${query.context.operation_id}`;
    const existing = this.observations.get(key);
    if (existing) { existing.stopRequested ||= query.phase === 'cancel'; return; }
    const observation = { control: new AbortController(), stopRequested: query.phase === 'cancel' };
    const control = observation.control; this.observations.set(key, observation);
    try {
      let value = initial;
      while (!control.signal.aborted && epoch === this.epoch()) {
        if (!value) {
          try { value = await client[observation.stopRequested ? 'cancel' : 'observe']({ coordinatorHostId: this.coordinator!(), authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch, operationId: query.context.operation_id }); }
          catch {
            // Keep observing the same accepted address through a transport outage.
            // Never dispatch the original operation again.
            await new Promise<void>(resolve => { const timer = setTimeout(done, 500); function done() { clearTimeout(timer); control.signal.removeEventListener('abort', done); resolve(); } control.signal.addEventListener('abort', done, { once: true }); });
            continue;
          }
        }
        if (value.resourceEpoch !== authority.resourceEpoch || !isDeepStrictEqual(value.executionOwner, authority.executionOwner) || value.operationId !== query.context.operation_id) throw new Error('Original process owner changed');
        const process = (value as ManagedSourceReceipt & { process?: unknown }).process;
        if (value.executorStopped && record(process) && process.writerActive === false && process.treeConfirmed === true) {
          await this.send({ v: 1, kind: 'source-process-terminal', kernelEpoch: epoch, source: source(query.binding), executionOwner: authority.executionOwner, process }); return;
        }
        await new Promise<void>(resolve => { const timer = setTimeout(done, 500); function done() { clearTimeout(timer); control.signal.removeEventListener('abort', done); resolve(); } control.signal.addEventListener('abort', done, { once: true }); });
        value = undefined;
      }
    } catch { /* Disconnection preserves the original unresolved Catalog process for recall. */ }
    finally { if (this.observations.get(key) === observation) this.observations.delete(key); }
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['source-resource-request', 'source-resource-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.epoch()) return true;
    const id = value.id, epoch = value.kernelEpoch;
    if (value.kind === 'source-resource-cancel') { const pending = this.active.get(id); if (pending?.epoch === epoch) { pending.cancelled = true; void pending.cancel?.().catch(() => undefined); } return true; }
    if (this.active.has(id)) return true;
    const pending: { epoch: string; cancel?: () => Promise<unknown>; cancelled: boolean } = { epoch, cancelled: false }; this.active.set(id, pending);
    void (async () => {
      let result: { ok: boolean; value?: unknown; message?: string };
      try {
        if (record(value.query) && value.query.kind === 'script_control') {
          const query = value.query;
          if (!record(query.source) || !record(query.source.resource_owner) || query.source.resource_owner.kind !== 'managed_host'
            || !text(query.processId) || !text(query.runId) || !text(query.threadId) || typeof query.stop !== 'boolean' || !this.owner || !this.coordinator)
            throw new Error('Original managed script owner unavailable');
          const client = await this.owner(query.source.resource_owner as unknown as ManagedHostSourceOwner);
          result = { ok: true, value: await controlManagedScript(client, { coordinatorHostId: this.coordinator(),
            source: query.source as unknown as LaunchSource, processId: query.processId, runId: query.runId, threadId: query.threadId, stop: query.stop }) };
        } else if (record(value.query) && value.query.kind === 'schedule_receipt') {
          const query = value.query;
          if (!record(query.source) || !record(query.source.resource_owner) || query.source.resource_owner.kind !== 'managed_host'
            || !text(query.operationId) || !text(query.runId) || !text(query.threadId) || !['observe', 'release'].includes(String(query.phase)) || !this.owner || !this.coordinator)
            throw new Error('Original managed schedule receipt owner unavailable');
          const client = await this.owner(query.source.resource_owner as unknown as ManagedHostSourceOwner);
          result = { ok: true, value: await recallManagedScheduleReceipt(client, this.coordinator(), query as unknown as ManagedScheduleReceiptQuery) };
        } else if (record(value.query) && value.query.kind === 'package_cleanup') {
          const query = value.query;
          if (!record(query.source) || !record(query.source.resource_owner) || query.source.resource_owner.kind !== 'managed_host'
            || !text(query.operationId) || !text(query.runId) || !text(query.threadId) || !this.owner || !this.coordinator)
            throw new Error('Original managed package cleanup owner unavailable');
          const client = await this.owner(query.source.resource_owner as unknown as ManagedHostSourceOwner);
          result = { ok: true, value: await releaseManagedPackageSource(client, this.coordinator(), query as unknown as ManagedPackageCleanup) };
        } else if (record(value.query) && value.query.kind === 'process_access') {
          const binding = value.query.binding as SourceToolBinding;
          if (!binding?.remoteAuthority || binding.resourceOwner.kind !== 'managed_host' || !text(value.query.processId) || !this.owner || !this.coordinator)
            throw new Error('Original managed process binding unavailable');
          const client = await this.owner(binding.resourceOwner);
          result = { ok: true, value: await client.processAccess({ coordinatorHostId: this.coordinator(),
            authorityId: binding.remoteAuthority.authorityId, resourceEpoch: binding.remoteAuthority.resourceEpoch, processId: value.query.processId }) };
        } else if(record(value.query)&&value.query.kind==='file_observation_address') {
          const binding=value.query.binding as SourceToolBinding;
          if(!binding?.remoteAuthority||binding.resourceOwner.kind!=='managed_host'||!this.coordinator)throw new Error('Original file source binding unavailable');
          result={ok:true,value:{kind:'managed_host',coordinatorHostId:this.coordinator(),authorityId:binding.remoteAuthority.authorityId,resourceEpoch:binding.remoteAuthority.resourceEpoch}};
        } else if(record(value.query)&&['file_observation','file_observation_scope_close'].includes(String(value.query.kind))) {
          const query=value.query;
          if(!record(query.source)||!record(query.source.resource_owner)||query.source.resource_owner.kind!=='managed_host'||!this.owner||!this.coordinator)throw new Error('Original managed observation source missing');
          const client=await this.owner(query.source.resource_owner as unknown as ManagedHostSourceOwner);
          const controller=new AbortController();pending.cancel=async()=>controller.abort();if(pending.cancelled)controller.abort();
          if(query.kind==='file_observation_scope_close') {
            if(query.coordinatorHostId!==this.coordinator())throw new Error('Original observation coordinator changed');
            result={ok:true,value:await client.closeReadScope({coordinatorHostId:query.coordinatorHostId as string,scope:query.scope as Extract<import('./protocol.generated.js').SourceAuthorityScope,{kind:'source_read'}>,source:query.source as unknown as LaunchSource},controller.signal)};
          } else {
            const authority=query.authority as import('./protocol.generated.js').FileObservationAuthority;
            if(authority?.coordinatorHostId!==this.coordinator())throw new Error('Original observation coordinator changed');
            result={ok:true,value:await client.fileObservation({...authority,requestId:randomUUID(),action:query.action as import('./protocol.generated.js').SourceFileObservationAction},controller.signal)};
          }
        } else {
        if (record(value.query) && value.query.kind === 'integration_receipt') {
          const query=value.query;
          if (!record(query.source) || !record(query.source.resource_owner) || query.source.resource_owner.kind!=='managed_host' || !text(query.runId) || !text(query.threadId) || !text(query.operationId) || !this.owner || !this.coordinator) throw new Error('Invalid original Integration receipt address');
          const client=await this.owner(query.source.resource_owner as unknown as ManagedHostSourceOwner);
          const receipt=await client.integrationReceipt({coordinatorHostId:this.coordinator(),source:query.source as unknown as LaunchSource,runId:query.runId,threadId:query.threadId,operationId:query.operationId});
          if(this.active.get(id)===pending&&epoch===this.epoch()){this.active.delete(id);await this.send({v:1,kind:'source-resource-response',id,kernelEpoch:epoch,result:{ok:true,value:receipt}});}return;
        }
        const query = value.query as Query;
        if (!record(query) || !record(query.binding) || query.binding.resourceOwner?.kind !== 'managed_host' || !query.binding.remoteAuthority || !record(query.context) || !this.owner || !this.coordinator) throw new Error('Managed source authority is unavailable');
        const client = await this.owner(query.binding.resourceOwner), authority = query.binding.remoteAuthority;
        const address = { coordinatorHostId: this.coordinator(), authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch };
        let reply: unknown;
        if (query.kind === 'tool') {
          if (!query.call || query.context.run_id !== query.binding.runId) throw new Error('Managed invocation scope changed');
          const input: ManagedSourceToolRequest = { ...address, call: { runId: query.context.run_id, operationId: query.context.operation_id,
            origin: query.context.origin, callId: query.call.call_id, name: query.call.name, schemaVersion: query.call.schema_version, arguments: query.call.arguments }, ...(query.journal ? { journal: query.journal } : {}) };
          if (query.phase === 'authorize') reply = await client.authorize(input);
          else {
            pending.cancel = () => { if (query.call?.name === 'process_spawn') void this.observeProcess(client, { ...query, phase: 'cancel' }, epoch); return client.cancel({ ...address, operationId: input.call.operationId }); };
            if (pending.cancelled) {
              reply = { operationId: input.call.operationId, resourceEpoch: authority.resourceEpoch, executionOwner: authority.executionOwner, accepted: false, executorStopped: true, result: { completion: { kind: 'not_dispatched', reason: 'Managed request cancelled before dispatch' }, executor_stopped: true } };
            } else {
            try { reply = await client.execute(input); }
            catch {
              try { reply = await client.observe({ ...address, operationId: input.call.operationId }); }
              catch (error) { if (query.call.name === 'process_spawn') void this.observeProcess(client, query, epoch); throw error; }
            }
            }
            if (!record(reply) || reply.operationId !== input.call.operationId || reply.resourceEpoch !== authority.resourceEpoch || !isDeepStrictEqual(reply.executionOwner, authority.executionOwner)) throw new Error('Managed execution receipt identity changed');
            if (query.call.name === 'process_spawn' && !(record(reply) && reply.accepted === false && reply.executorStopped === true)) void this.observeProcess(client, query, epoch, reply as unknown as ManagedSourceReceipt);
          }
        } else if (query.kind === 'resource') {
          if (!query.action) throw new Error('Closed source action missing');
          const requestId = randomUUID(); pending.cancel = () => client.cancelService({ ...address, requestId });
          if (pending.cancelled) await pending.cancel();
          reply = await client.service({ ...address, requestId, operation: { kind: 'native_resource', context: query.context, action: query.action, authorizeOnly: query.authorizeOnly === true } });
        } else if (query.kind === 'control') {
          try { reply = await client[query.phase === 'release' ? 'releaseReceipt' : query.phase === 'cancel' ? 'cancel' : 'observe']({ ...address, operationId: query.context.operation_id }); }
          finally { if (query.watchProcess) void this.observeProcess(client, query, epoch, reply as ManagedSourceReceipt | undefined); }
        } else throw new Error('Unknown closed source request');
        result = { ok: true, value: reply };
        }
      } catch (error) { result = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
      if (this.active.get(id) !== pending) return;
      this.active.delete(id); if (this.epoch() !== epoch) return;
      await this.send({ v: 1, kind: 'source-resource-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.failed());
    return true;
  }
}
