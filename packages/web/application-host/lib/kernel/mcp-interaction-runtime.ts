/** Live responders for Catalog-owned MCP input records. No durable state or connection authority here. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { McpSamplingRejectedError } from '../mcp/errors.js';
import { publishMcpInteractionRequest, isDefiniteMcpPublicationFailure } from './mcp-interaction-publication.js';
import { decodeElicitationRequest, validateElicitationResponse, decodeUrlElicitationError } from '../mcp/interactions.js';
import type { McpInteractionRequest, McpInteractionReceiver, McpErrorInteractionItem, McpErrorInteractionReceiver } from '../mcp/authority.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { McpInteractionBinding, McpInteractionRecord, McpInteractionView, McpInteractionRespondParams, McpElicitationResponse, McpInteractionAvailability, McpInteractionDelivery } from './protocol.generated.js';
import type { McpInteractionPending, McpSamplingResult, McpSamplingRequestReviewParams, McpSamplingOutputReviewParams, ModelSessionConfiguration, Operation } from './protocol.generated.js';
import type { CredentialScope, ExistingHostCredentialOwner } from './credential-owner.js';
type ReviewedAnswer = McpElicitationResponse | McpSamplingResult;
export interface SamplingModelSelection { configuration: ModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }
const failure = (code: string): Error => Object.assign(new Error(code), {code});
interface Entry {
  id: string;
  input: McpInteractionRequest | McpErrorInteractionItem;
  record?: McpInteractionRecord;
  controller: AbortController;
  resolve(response: ReviewedAnswer): void;
  credential?: { operationId: string; scope: CredentialScope; release(): void };
  reject(error: Error): void;
  opened: Promise<McpInteractionRecord>;
  completion?: () => void;
  unobserve?: () => void;
  finished: boolean;
  answerReleased?: boolean;
  proposedResponse?: McpElicitationResponse;
  proposedSamplingChoice?: { review: 'request' | 'output'; action: 'accept' | 'decline' | 'cancel'; expectedRevision: number; generationOperationId: string | null };
  choiceLane: Promise<unknown>;
  closeFact?: McpInteractionAvailability;
  settlementFact?: McpInteractionDelivery;
  completionFact?: boolean;
  publishing?: Promise<void>;
}
export type McpInteractionRuntime = ReturnType<typeof createMcpInteractionRuntime>;
export function createMcpInteractionRuntime(options: { kernel: KernelClient; runtime: Pick<AgentRuntimeClient, 'onReady' | 'onEvent'>; onError?: (error: Error) => void }) {
  const entries = new Map<string, Entry>();
  const removers: (() => void)[] = [];
  const lifetime = new AbortController();
  let disposed = false, started = false, poll: Promise<void> | undefined, dirty = false;
  const report = (error: unknown) => { if (!disposed) options.onError?.(error instanceof Error ? error : new Error('MCP interaction reconciliation requires attention')); };
  const adopt = (entry: Entry, record: McpInteractionRecord) => { if (!entry.record || record.revision >= entry.record.revision) entry.record = record; };
  const short = <T>(method: 'runtime.mcp.interaction.close' | 'runtime.mcp.interaction.response.begin' | 'runtime.mcp.interaction.response.settle' | 'runtime.mcp.interaction.complete', entry: Entry, extra: Record<string, unknown> = {}) =>
    options.kernel.agentRuntimeRequest<T, typeof method>(method, { binding: entry.input.binding, interactionId: entry.id, ...extra } as never);
  const hasFacts = (entry: Entry) => !!(entry.closeFact || entry.settlementFact || entry.completionFact);
  const keepCompletion = (entry: Entry) => entry.record?.mode === 'url'
    && (entry.input.binding.source.kind === 'rpc_error' ? entry.record.choice === null || entry.record.choice === 'accept' : entry.record.choice === 'accept')
    && entry.record.delivery !== 'not_sent' && ['live', 'rpc_closed'].includes(entry.record.availability) && !entry.record.completionReported;
  const retire = (entry: Entry) => {
    if (!entry.finished || hasFacts(entry) || !entry.record || entry.credential) return;
    if (keepCompletion(entry) && entry.completion) return;
    entry.unobserve?.(); delete entry.unobserve;
    entry.completion?.(); delete entry.completion;
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
  };
  const pause = (ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref?.();
    lifetime.signal.addEventListener('abort', done, {once: true});
    if (lifetime.signal.aborted) done();
  });
  // Only observed local facts retry. This lane never calls the peer or resends user content.
  const flush = (entry: Entry): Promise<void> => {
    if (entry.publishing) return entry.publishing;
    entry.publishing = (async () => {
      let delay = 250;
      while (hasFacts(entry) && !disposed && entries.get(entry.id) === entry) {
        try {
          if (entry.closeFact) {
            const availability = entry.closeFact;
            adopt(entry, await short<McpInteractionRecord>('runtime.mcp.interaction.close', entry, {availability}));
            if (entry.closeFact === availability) delete entry.closeFact;
          } else if (entry.settlementFact) {
            const delivery = entry.settlementFact;
            adopt(entry, await short<McpInteractionRecord>('runtime.mcp.interaction.response.settle', entry, {delivery}));
            if (entry.settlementFact === delivery) delete entry.settlementFact;
          } else if (entry.completionFact) {
            adopt(entry, await short<McpInteractionRecord>('runtime.mcp.interaction.complete', entry));
            delete entry.completionFact;
          }
          delay = 250;
        } catch (error) {
          report(error); await pause(delay); delay = Math.min(delay * 2, 30000);
        }
      }
    })().finally(() => { delete entry.publishing; retire(entry); });
    return entry.publishing;
  };
  const close = (entry: Entry, availability: McpInteractionAvailability) => {
    entry.controller.abort(availability); entry.reject(failure('mcp_interaction_not_live'));
    if (!entry.closeFact || entry.closeFact === 'rpc_closed') entry.closeFact = availability;
    // The open may have committed even if its reply was lost. Closing this exact ID is safe.
    void entry.opened.catch(() => undefined).then(() => { if (!disposed && entries.get(entry.id) === entry) void flush(entry); });
    if (availability !== 'rpc_closed') { entry.completion?.(); delete entry.completion; }
  };
  const reconcile = async () => {
    if (disposed) return; dirty = true;
    if (poll) return poll;
    poll = (async () => {
      while (dirty && !disposed) {
        dirty = false;
        const records = await options.kernel.agentRuntimeRequest<McpInteractionPending[], 'runtime.mcp.interaction.pending'>('runtime.mcp.interaction.pending', {});
        const current = new Map(records.map(r => [r.id, r]));
        for (const entry of entries.values()) {
          if (!entry.record) continue;
          const record = current.get(entry.id);
          if (record) adopt(entry, record);
          if (record?.mode === 'sampling') {
            if (record.generation?.phase === 'terminal' && record.generation.operationId === entry.credential?.operationId) { entry.credential.release(); delete entry.credential; }
            if (record.sampling?.review === 'closed' && !entry.answerReleased && record.choice === null && record.generation?.phase === 'terminal') {
              entry.reject(failure(record.generation.problem ?? 'mcp_sampling_unavailable'));
            }
            retire(entry);
          }
          if (record && record.availability !== 'live') close(entry, record.availability);
          else if (!record && (entry.record.availability === 'live' || entry.completion || entry.credential)) {
            // A closed row is omitted from pending. Read only this known exact identity.
            void options.kernel.agentRuntimeRequest<McpInteractionPending, 'runtime.mcp.interaction.inspect'>('runtime.mcp.interaction.inspect', {operationId: entry.input.binding.operationId, interactionId: entry.id})
              .then(record => { adopt(entry, record); if(record.generation?.phase === 'terminal' && record.generation.operationId === entry.credential?.operationId){entry.credential.release();delete entry.credential;} if (record.availability !== 'live') close(entry, record.availability); retire(entry); }).catch(report);
          }
        }
      }
    })().finally(() => { poll = undefined; });
    return poll;
  };
  const wake = () => { void reconcile().catch(report); };
  const receive = async (input: McpInteractionRequest, sampling = false): Promise<ReviewedAnswer> => {
    if (disposed) throw failure('mcp_interaction_owner_unavailable');
    const decoded = sampling ? { request: input.request, presentation: { mode: 'sampling' as const, message: 'Review this server’s isolated model request' } } : decodeElicitationRequest(input.request);
    const id = `mcp-interaction:${createHash('sha256').update(JSON.stringify([input.binding.connectionId, input.binding.source])).digest('hex')}`;
    if (entries.has(id)) throw failure('mcp_interaction_conflict');
    const controller = new AbortController();
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const answer = new Promise<ReviewedAnswer>((yes, no) => { resolve = yes; reject = no; });
    void answer.catch(() => {});
    let openRejected = false;
    const opened = publishMcpInteractionRequest({ id, binding: input.binding,
      mode: decoded.presentation.mode, request: decoded.request, presentation: decoded.presentation,
    }, { kernel: options.kernel, disposed: () => disposed, waitRetry: pause, report }).catch(error => {
      openRejected = isDefiniteMcpPublicationFailure(error); throw error;
    });
    const entry: Entry = { id, input, controller, resolve, reject, opened, finished: false, choiceLane: Promise.resolve() };
    entries.set(id, entry);
    void opened.catch(() => {
      if (openRejected) { entry.unobserve?.(); entries.delete(id); }
    });
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const abort = () => {
      const reason = input.signal.reason;
      close(entry, reason === 'rpc_closed' ? 'rpc_closed' : reason === 'owner_unavailable' ? 'owner_unavailable' : 'cancelled');
    };
    input.signal.addEventListener('abort', abort, { once: true });
    entry.unobserve = () => input.signal.removeEventListener('abort', abort);
    input.beforeResponse(async () => {
      // Handler failures carry no reviewed user answer. Their generic SDK error is
      // independent of the durable user-response delivery facts.
      if (!entry.answerReleased) return;
      signal.throwIfAborted(); await input.assertLive();
      adopt(entry, await short<McpInteractionRecord>('runtime.mcp.interaction.response.begin', entry));
      signal.throwIfAborted(); await input.assertLive();
    });
    input.onResponseSettled((state: 'sent' | 'not_sent' | 'unknown') => {
      if (openRejected) { entry.unobserve?.(); entries.delete(id); return; }
      entry.finished = true; entry.settlementFact = entry.answerReleased ? state : 'not_sent';
      void opened.catch(() => undefined).then(() => { if (!disposed) void flush(entry); });
    });
    try {
      adopt(entry, await opened);
      if (entry.record!.choice !== null || entry.record!.availability !== 'live') throw failure('mcp_interaction_not_live');
      if (input.signal.aborted) abort();
      signal.throwIfAborted();
      entry.completion = input.onComplete(() => {
        entry.completionFact = true;
        entry.completion?.(); delete entry.completion;
        void flush(entry);
      }, () => close(entry, 'connection_lost'));
      return await answer;
    } catch (error) {
      if (error instanceof McpSamplingRejectedError) throw error;
      if (!openRejected) close(entry, input.signal.reason === 'rpc_closed' ? 'rpc_closed' : input.signal.aborted ? 'cancelled' : 'owner_unavailable');
      throw error;
    }
  };
  const errorReceiver: McpErrorInteractionReceiver = input => {
    if (disposed) return;
    const items = input.items.map(item => ({...item,
      id: `mcp-interaction:${createHash('sha256').update(JSON.stringify([item.binding.connectionId, item.binding.source])).digest('hex')}`,
    }));
    if (items.some(item => entries.has(item.id))) throw failure('mcp_interaction_conflict');
    // Register every completion listener synchronously before another wire message can arrive.
    // Staging the single shared body is independent of the finite RPC's receipt/rejection.
    let resolve!: (records: McpInteractionRecord[]) => void, reject!: (error: unknown) => void;
    const publication = new Promise<McpInteractionRecord[]>((yes, no) => {resolve=yes;reject=no;});
    const staged = items.map((item,index): Entry => {
      const entry: Entry = {id:item.id,input:item,controller:new AbortController(),resolve:()=>{},reject:()=>{},
        opened:publication.then(records => records[index]!),finished:true,choiceLane:Promise.resolve()};
      entries.set(entry.id,entry);
      entry.completion=item.onComplete(()=>{
        entry.completionFact=true;entry.completion?.();delete entry.completion;
        void entry.opened.then(()=>flush(entry)).catch(report);
      },()=>close(entry,'connection_lost'));
      return entry;
    });
    // Body work never runs on the synchronous SDK reader or holds its settlement promise.
    queueMicrotask(()=>{void (async()=>{
      let delay=250;
      while (!disposed) {
        try {
          const records=await options.kernel.agentRuntimeRequest<McpInteractionRecord[],'runtime.mcp.interaction.error.open'>(
            'runtime.mcp.interaction.error.open',{request:input.request,items:items.map(item=>({id:item.id,binding:item.binding,presentation:item.presentation}))});
          for(let index=0;index<staged.length;index++) {
            const entry=staged[index]!;adopt(entry,records[index]!);
            if(entry.record!.availability !== 'live') {
              entry.closeFact=entry.record!.availability;entry.completion?.();delete entry.completion;
            }
          }
          resolve(records);
          for(const entry of staged){if(hasFacts(entry))void flush(entry);else retire(entry);}
          return;
        } catch(error) {
          const code=error && typeof error==='object' && 'code' in error ? error.code : undefined;
          if(['operation-error','protocol-error','cancelled','unauthorized'].includes(String(code)))throw error;
          report(error);await pause(delay);delay=Math.min(delay*2,30000);
        }
      }
      throw failure('mcp_interaction_owner_unavailable');
    })().catch(error=>{
      reject(error);
      for(const entry of staged){entry.completion?.();entries.delete(entry.id);void entry.opened.catch(()=>{});}
      report(error);
    });});
  };
  const receiver: McpInteractionReceiver = input => receive(input) as Promise<McpElicitationResponse>;
  const samplingReceiver = (input: McpInteractionRequest) => receive(input, true) as Promise<McpSamplingResult>;
  const readSampling = (input: {operationId:string;interactionId:string}) => options.kernel.agentRuntimeRequest<McpInteractionView, 'runtime.mcp.interaction.read'>('runtime.mcp.interaction.read', {operationId:input.operationId,interactionId:input.interactionId});
  const reviewLane = <T>(entry: Entry, run: () => Promise<T>): Promise<T> => { const result=entry.choiceLane.then(run,run);entry.choiceLane=result.catch(()=>undefined);return result; };
  const liveSampling = async (input: {operationId:string;interactionId:string}, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const view=await readSampling(input);
    const entry=entries.get(input.interactionId);
    if(view.record.mode !== 'sampling' || !entry || entry.finished || entry.controller.signal.aborted || entry.input.signal.aborted) throw failure('mcp_interaction_not_live');
    await entry.input.assertLive();
    if(view.generation?.phase === 'terminal' && view.generation.operationId === entry.credential?.operationId){entry.credential.release();delete entry.credential;}
    return {view,entry};
  };
  const reviewSamplingChoice = async (input: McpSamplingOutputReviewParams, review: 'request' | 'output', signal?: AbortSignal): Promise<McpInteractionView> => {
    const run = async () => {
      signal?.throwIfAborted();
      let view = await readSampling(input);
      if (view.record.mode !== 'sampling') throw failure('mcp_sampling_review_required');
      const entry = entries.get(input.interactionId);
      const release = () => {
        const proposed = entry?.proposedSamplingChoice;
        if (!entry || entry.answerReleased || entry.finished || entry.controller.signal.aborted || entry.input.signal.aborted
          || !proposed || proposed.review !== review || proposed.action !== input.action || proposed.expectedRevision !== input.expectedRevision
          || proposed.generationOperationId !== (view.record.sampling?.generationOperationId ?? null)) return;
        if (input.action === 'accept' && !view.sampling?.output) throw failure('mcp_sampling_output_unavailable');
        adopt(entry, view.record); entry.answerReleased = true;
        if (input.action === 'accept') entry.resolve(view.sampling!.output!);
        else entry.reject(new McpSamplingRejectedError());
      };
      if (view.record.choice !== null) {
        if (view.record.choice !== input.action) throw failure('mcp_interaction_conflict');
        // A lost private acknowledgement can only release this exact receiver's first
        // durably reviewed answer. Reading historical choices never replays a wire reply.
        release(); return view;
      }
      const live = await liveSampling(input, signal);
      signal?.throwIfAborted();
      const proposal = {review, action: input.action, expectedRevision: input.expectedRevision, generationOperationId: live.view.record.sampling?.generationOperationId ?? null};
      live.entry.proposedSamplingChoice = proposal;
      const method = review === 'request' ? 'runtime.mcp.sampling.review_request' : 'runtime.mcp.sampling.review_output';
      try {
        const record = await options.kernel.agentRuntimeRequest<McpInteractionRecord, typeof method>(method, input as never);
        adopt(live.entry, record);
        view = {...live.view, record};
      } catch (error) {
        view = await readSampling(input);
        if (view.record.choice !== input.action || view.record.sampling?.review !== 'closed'
          || (view.record.sampling?.generationOperationId ?? null) !== proposal.generationOperationId) throw error;
      }
      release(); wake(); return readSampling(input);
    };
    const entry = entries.get(input.interactionId);
    return entry ? reviewLane(entry, run) : run();
  };
  return {
    receiver,
    samplingReceiver,
    async published(binding: McpInteractionBinding): Promise<void> {
      const id = `mcp-interaction:${createHash('sha256').update(JSON.stringify([binding.connectionId, binding.source])).digest('hex')}`;
      const entry = entries.get(id);
      if (entry && !isDeepStrictEqual(entry.input.binding, binding)) throw failure('mcp_interaction_conflict');
      // Source cleanup joins publication, never user review or model execution.
      // A retired in-memory receiver is sufficient only if its exact Catalog row exists.
      const record = entry ? await entry.opened : await options.kernel.agentRuntimeRequest<McpInteractionRecord,
        'runtime.mcp.interaction.inspect'>('runtime.mcp.interaction.inspect', { operationId: binding.operationId, interactionId: id });
      if (record.id !== id || !isDeepStrictEqual(record.binding, binding)) throw failure('mcp_interaction_conflict');
    },
    async reviewRequest(input: McpSamplingRequestReviewParams, model?: SamplingModelSelection, signal?: AbortSignal): Promise<McpInteractionView> {
      if(input.action !== 'generate') return reviewSamplingChoice(input as McpSamplingOutputReviewParams, 'request', signal);
      const previous=await readSampling(input);
      if(previous.record.mode === 'sampling' && previous.record.choice !== null){
        if(input.action === 'generate' || previous.record.choice!==input.action)throw failure('mcp_interaction_conflict');
        return previous;
      }
      const {entry}=await liveSampling(input,signal);
      return reviewLane(entry,async()=>{
        const {view}=await liveSampling(input,signal);
        if(input.action === 'generate') {
          if(!model || !input.editedRequest)throw failure('mcp_sampling_model_required');
          const bindingId=`${input.interactionId}:generation:${input.expectedRevision}`;
          if(entry.credential && entry.credential.operationId !== bindingId) throw failure('mcp_interaction_conflict');
          let scope;
          let registered = false;
          if(!entry.credential){
            scope=await options.kernel.registerCredentialOwner(view.record.runId,model.credentialOwner,signal,bindingId,{kind:'operation',operationId:bindingId,assertLive:entry.input.assertLive});
            registered = true;
            const epoch=options.kernel.kernelEpoch;
            entry.credential={operationId:bindingId,scope,release:()=>{if(options.kernel.kernelEpoch === epoch)options.kernel.unregisterCredentialOwner(view.record.runId,bindingId);}};
          } else {
            scope=entry.credential.scope;
            if(!isDeepStrictEqual(await model.credentialOwner.scope(),scope))throw failure('mcp_interaction_conflict');
          }
          try {
            const record=await options.kernel.agentRuntimeRequest<McpInteractionRecord,'runtime.mcp.sampling.generate'>('runtime.mcp.sampling.generate',{
              operationId:input.operationId,interactionId:input.interactionId,expectedRevision:input.expectedRevision,editedRequest:input.editedRequest,configuration:model.configuration,credentialScope:scope,
            });adopt(entry,record);
          } catch(error) {
            const releaseRegistration = () => { if(registered && entry.credential?.operationId === bindingId){entry.credential.release();delete entry.credential;} };
            const code=error && typeof error==='object' && 'code' in error ? error.code : undefined;
            // A definite native rejection is not an ambiguous acknowledgement. In particular,
            // a same revision with a different explicit model must remain a visible conflict.
            if(['operation-error','protocol-error','unauthorized','cancelled'].includes(String(code))){releaseRegistration();throw error;}
            const accepted=await readSampling(input);
            if(accepted.record.sampling?.generationOperationId !== bindingId){releaseRegistration();throw error;}
            // On transport uncertainty, prove the entire original admission through its existing
            // body-reading Operation API. This never retries generation or adds a second ledger.
            const operation=await options.kernel.agentRuntimeRequest<Operation,'runtime.operation.inspect'>('runtime.operation.inspect',{operationId:bindingId});
            const intent=operation.intent as {kind?:unknown;parent_operation_id?:unknown;interaction_id?:unknown;request?:unknown;configuration?:unknown;credential_scope?:unknown} | null;
            const configuration=(value:unknown)=>value && typeof value==='object' && !Array.isArray(value)
              ? Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null && v!==undefined)) : value;
            // Rust serializes absent top-level Option configuration fields as null; nested
            // provider options retain their exact structure and values for this comparison.
            if(operation.id!==bindingId || operation.run_id!==view.record.runId || intent?.kind!=='mcp_sampling_generation_v1'
              || intent.parent_operation_id!==input.operationId || intent.interaction_id!==input.interactionId
              || !isDeepStrictEqual(intent.request,input.editedRequest)
              || !isDeepStrictEqual(configuration(intent.configuration),configuration(model.configuration))
              || !isDeepStrictEqual(intent.credential_scope,scope)){
              releaseRegistration();throw failure('mcp_interaction_conflict');
            }
            adopt(entry,accepted.record);
          }
          wake();return readSampling(input);
        }
        throw failure('mcp_interaction_conflict');
      });
    },
    async reviewOutput(input:McpSamplingOutputReviewParams,signal?:AbortSignal):Promise<McpInteractionView>{
      return reviewSamplingChoice(input, 'output', signal);
    },
    errorReceiver,
    start() { if (started || disposed) return; started = true; removers.push(options.runtime.onReady(wake), options.runtime.onEvent(wake)); wake(); },
    async respond(input: McpInteractionRespondParams, signal?: AbortSignal): Promise<McpInteractionView> {
      const read = () => options.kernel.agentRuntimeRequest<McpInteractionView, 'runtime.mcp.interaction.read'>('runtime.mcp.interaction.read', { operationId: input.operationId, interactionId: input.interactionId });
      const run = async () => {
        signal?.throwIfAborted();
        const view = await read();
        if (view.record.mode === 'sampling') throw failure('mcp_sampling_review_required');
        const isError = view.record.binding.source.kind === 'rpc_error';
        const request = isError
          ? decodeUrlElicitationError(view.request).find(p => p.elicitationId === (view.record.binding.source as {elicitationId:string}).elicitationId)
          : view.request;
        const response = validateElicitationResponse(request, input.response);
        const entry = entries.get(input.interactionId);
        if (isError) {
          if (view.response !== null) {
            if (!isDeepStrictEqual(view.response,response))throw failure('mcp_interaction_conflict');
            return view;
          }
          signal?.throwIfAborted();
          // Local review of already received evidence requires no client, active Run or send.
          const record=await options.kernel.agentRuntimeRequest<McpInteractionRecord,'runtime.mcp.interaction.respond'>(
            'runtime.mcp.interaction.respond',{...input,response});
          if(entry){adopt(entry,record);retire(entry);}
          return read();
        }
        if (view.response !== null) {
          if (!isDeepStrictEqual(view.response, response)) throw failure('mcp_interaction_conflict');
          // A reply may have been lost after this receiver's choice committed, before it
          // could release its first response. Never apply this to a different receiver.
          if (entry && !entry.answerReleased && isDeepStrictEqual(entry.proposedResponse, response)
            && !entry.finished && !entry.controller.signal.aborted && !entry.input.signal.aborted) {
            adopt(entry, view.record); entry.answerReleased = true; entry.resolve(response);
          }
          return view;
        }
        if (!entry || entry.finished || entry.controller.signal.aborted || entry.input.signal.aborted) throw failure('mcp_interaction_not_live');
        await entry.input.assertLive(); signal?.throwIfAborted();
        // Once admitted, a disconnected UI only loses its wait. It does not retract the answer.
        let record: McpInteractionRecord;
        entry.proposedResponse = response;
        try { record = await options.kernel.agentRuntimeRequest<McpInteractionRecord, 'runtime.mcp.interaction.respond'>('runtime.mcp.interaction.respond', { ...input, response }); }
        catch (error) {
          const accepted = await read();
          if (!isDeepStrictEqual(accepted.response, response)) throw error;
          record = accepted.record;
        }
        adopt(entry, record); entry.answerReleased = true; entry.resolve(response);
        return read();
      };
      const entry = entries.get(input.interactionId);
      if (!entry) return run();
      const result = entry.choiceLane.then(run, run); entry.choiceLane = result.catch(() => undefined); return result;
    },
    async releaseSource(runId: string): Promise<void> {
      await options.kernel.agentRuntimeRequest('runtime.mcp.interaction.release_source', { runId }); await reconcile();
    },
    async dispose() {
      if (disposed) return;
      for (const remove of removers) remove();
      // Try once to close this process's receivers. Reopen recovery closes any uncertain rows.
      for (const entry of entries.values()) {
        close(entry, 'connection_lost');
        void short('runtime.mcp.interaction.close', entry, {availability:'connection_lost'}).catch(() => undefined);
      }
      disposed = true; lifetime.abort();
      for (const entry of entries.values()) { entry.credential?.release(); entry.unobserve?.(); entry.completion?.(); }
      entries.clear();
    },
  };
}
