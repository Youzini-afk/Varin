/** Live handles only. Original Operations, passive inputs and ContentStore own durable facts. */
import { randomUUID } from 'node:crypto';
import { McpAuthorityError } from '../mcp/errors.js';
import type { McpAuthorityLease, McpAuthorityService, McpResourceObserver, McpResourceChange, McpResourceRelease } from '../mcp/authority.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostToolCall, ToolExecutionReceipt } from './tool-bridge.js';
import type { ExecutorOwner, McpEndpoint, McpResourceBinding, McpResourcePending, McpResourceListenerParams, McpResourceNotifyParams, SourceMcpCreationOutcome, SourceMcpCreationError, KernelMethod, KernelMethodParams } from './protocol.generated.js';
interface Entry {
  op: McpResourcePending;
  cleanupInteraction?: { interaction: { operationId: string; executionOwner: ExecutorOwner }; signal: AbortSignal };
  observer?: McpResourceObserver;
  controller: AbortController;
  closed: boolean;
  attempted: boolean;
  attaching: boolean;
  receiving?: string;
  acceptance?: {
    listenerId: string;
    content: Record<string, unknown>;
  };
  acceptanceFlight?: Promise<void>;
  recovery?: Promise<void>;
  creationFlight?: Promise<void>;
  creationFailure?: SourceMcpCreationError;
  creationAttempted: boolean;
  creationInspected: boolean;
  creationRetry: boolean;
  sourceRevision: number;
  cleanupPending: boolean;
  cleanupFlight?: Promise<void>;
  release?: McpResourceRelease;
  metadata: Promise<unknown>;
  facts: Map<McpResourceNotifyParams['kind'], McpResourceNotifyParams>;
  sending?: McpResourceNotifyParams;
  preAck: Map<McpResourceChange['kind'], McpResourceChange>;
  publishing?: Promise<boolean>;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryDelay: number;
}
export type McpResourceRuntime = ReturnType<typeof createMcpResourceRuntime>;
export type McpResourceCreationRecovery = SourceMcpCreationOutcome | { kind: 'cleanup_pending' };
export interface McpResourceRuntimeOptions {
  kernel: KernelClient;
  runtime: Pick<AgentRuntimeClient, 'onReady' | 'onEvent'>;
  recover(op: McpResourcePending, signal: AbortSignal, onChange: (change: McpResourceChange) => void): Promise<McpResourceObserver>;
  recoverCreation?(op: McpResourcePending, signal: AbortSignal): Promise<McpResourceCreationRecovery | null>;
  cleanup?(op: McpResourcePending, signal: AbortSignal, interaction?: Parameters<McpResourceObserver['detach']>[0]): Promise<McpResourceRelease>;
  onError?: (error: Error) => void;
}
export function createMcpResourceRuntime(options: McpResourceRuntimeOptions) {
  const entries = new Map<string, Entry>(), admitting = new Set<string>(), removers: Array<() => void> = [], flights = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  let started = false, disposed = false, work: Promise<void> | undefined, dirty = false, sourceRevision = 0;
  const report = (e: unknown) => {
    if (!disposed) {
      options.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };
  const track = <T>(p: Promise<T>): Promise<T> => {
    flights.add(p);
    void p.finally(() => flights.delete(p)).catch(() => undefined);
    return p;
  };
  const request = <T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal) => options.kernel.agentRuntimeRequest<T, M>(method, params, signal);
  const entry = (op: McpResourcePending): Entry => ({
    op,
    controller: new AbortController(),
    closed: false,
    attempted: false,
    attaching: false,
    creationAttempted: false,
    creationInspected: false,
    creationRetry: false,
    sourceRevision,
    cleanupPending: false,
    retryDelay: 250,
    metadata: Promise.resolve(),
    facts: new Map(),
    preAck: new Map()
  });
  const adoptLatest = (e: Entry, op: McpResourcePending): void => {
    if (op.revision >= e.op.revision) {
      // Kernel responses can arrive out of order; acknowledged cleanup never regresses.
      // A confirmed local withdrawal is irreversible even before its newer snapshot arrives.
      e.op = { ...op, cancelRequested: e.op.cancelRequested || op.cancelRequested };
    }
  };
  const state = (e: Entry, change: Omit<McpResourceListenerParams, 'binding' | 'expectedListenerId'>, replaceListener = false): Promise<void> => {
    const run = async () => {
      const op = await request<McpResourcePending, 'runtime.mcp.resource.listener'>('runtime.mcp.resource.listener', {
        binding: e.op.subscription.binding,
        expectedListenerId: e.op.subscription.listenerId,
        ...change,
        // Closure can queue behind a new listener's in-flight publication. Echo the
        // current incarnation, not the stale listener captured before that ACK.
        listenerId: replaceListener ? change.listenerId : e.op.subscription.listenerId
      });
      adoptLatest(e, op);
    };
    const p = e.metadata.then(run, run);
    e.metadata = p.catch(() => undefined);
    return p;
  };
  const flush = (e: Entry): Promise<boolean> => {
    if (e.publishing) {
      return e.publishing;
    }
    if (disposed || !e.acceptance && !e.creationRetry && !e.cleanupPending && (e.closed || !e.op.subscription.acceptanceRef)) {
      return Promise.resolve(false);
    }
    e.publishing = track((async () => {
      while ((e.acceptance || e.creationRetry || e.cleanupPending || e.sending || e.facts.size) && !disposed) {
        if (!e.acceptance && !e.creationRetry && !e.cleanupPending && e.closed) {
          break;
        }
        try {
          // A received ACK is an immutable original RPC fact even after observation closes.
          // Both ACKs and notifications use this one live local publication lane.
          if (e.acceptance) {
            await accept(e);
          } else if (e.creationRetry) {
            await recoverCreation(e);
          } else if (e.cleanupPending) {
            await cleanupManaged(e);
          } else {
            if (!e.sending) {
              const [kind, next] = e.facts.entries().next().value!;
              e.facts.delete(kind);
              e.sending = next;
            }
            await request('runtime.mcp.resource.notify', e.sending, e.controller.signal);
            delete e.sending;
          }
        } catch (error) {
          const signal = e.acceptance || e.creationRetry || e.cleanupPending ? lifetime.signal : e.controller.signal;
          if (!signal.aborted && !disposed) {
            report(error);
            await new Promise<void>(resolve => {
              const finish = () => {
                if (e.retryTimer) {
                  clearTimeout(e.retryTimer);
                }
                delete e.retryTimer;
                signal.removeEventListener('abort', finish);
                resolve();
              };
              e.retryTimer = setTimeout(finish, e.retryDelay);
              e.retryTimer.unref?.();
              signal.addEventListener('abort', finish, { once: true });
              if (signal.aborted) {
                finish();
              }
              e.retryDelay = Math.min(e.retryDelay * 2, 30000);
            });
          }
        }
      }
      if (e.retryTimer) {
        clearTimeout(e.retryTimer);
      }
      delete e.retryTimer;
      e.retryDelay = 250;
      return !e.closed && !disposed;
    })()).finally(() => {
      delete e.publishing;
    });
    return e.publishing;
  };
  const fact = (e: Entry, kind: McpResourceNotifyParams['kind'], notification?: Record<string, unknown>) => {
    if (e.closed || disposed) {
      return;
    }
    const listenerId = e.observer?.listenerId ?? e.op.subscription.listenerId;
    if (!listenerId) {
      return;
    }
    // Only not-yet-accepted invalidations coalesce. Catalog-accepted facts remain immutable.
    e.facts.set(kind, {
      binding: e.op.subscription.binding,
      listenerId,
      factId: randomUUID(),
      kind,
      ...(notification ? { notification } : {})
    });
    void flush(e);
  };
  // A managed observer is only a projection of B's retained holder. Observation
  // loss and Host disposal must never turn a projection disconnect into unsubscribe.
  const disconnect = (observer: McpResourceObserver): void => {
    if (observer.disconnect) observer.disconnect();
    else void observer.detach().catch(report);
  };
  const cleanupManaged = (e: Entry): Promise<void> => {
    if (e.cleanupFlight) return e.cleanupFlight;
    if (disposed || !e.cleanupPending) return Promise.resolve();
    e.cleanupFlight = track((async () => {
      if (!e.op.subscription.mcpHolderReleased && !e.release) {
        if (!options.cleanup) throw new McpAuthorityError('mcp-resource-original-cleanup-unavailable');
        // The hook proves exact original holder release and drained local callbacks.
        // Remote unsubscribe remains its separate shared/acknowledged/unknown fact.
        e.release = await options.cleanup(e.op, lifetime.signal, e.cleanupInteraction);
      }
      if (disposed) return;
      await state(e, {
        listenerId: e.op.subscription.listenerId,
        availability: 'closed',
        localReleased: true,
        remoteCleanup: e.release?.status ?? e.op.subscription.remoteCleanup,
        problem: e.op.subscription.problem
      });
      if (!e.op.subscription.mcpHolderReleased) {
        const op = await request<McpResourcePending, 'runtime.mcp.resource.holder_released'>(
          'runtime.mcp.resource.holder_released', { binding: e.op.subscription.binding }, lifetime.signal);
        adoptLatest(e, op);
      }
      e.cleanupPending = false;
    })()).finally(() => { delete e.cleanupFlight; });
    return e.cleanupFlight;
  };
  const close = (e: Entry): Promise<void> => {
    if (!e.closed) {
      e.closed = true;
      // Abort only observation publication. Known ACK and cleanup own the Host lifetime.
      e.controller.abort();
      e.facts.clear();
      e.preAck.clear();
      delete e.sending;
      delete e.receiving;
    }
    const observer = e.observer;
    delete e.observer;
    if (!e.op.subscription.mcpHolderReleased || e.cleanupPending) {
      // The explicit original cleanup hook owns B release, even with no live projection.
      // Calling detach as well would duplicate the same remote cleanup operation.
      observer?.disconnect?.();
      // Explicit unsubscribe/source retirement can arrive before reconciliation.
      // Preserve a known or recoverable original ACK before release drops its body.
      if (e.acceptance) return accept(e);
      if (e.creationFailure) return recoverCreation(e);
      if (!e.op.subscription.acceptanceRef && !e.creationInspected) {
        if (!options.recoverCreation) return Promise.reject(new McpAuthorityError('mcp-resource-original-creation-recovery-unavailable'));
        const inspection = recoverCreation(e).then(() => close(e));
        void inspection.catch(() => { if (e.creationRetry && !disposed) void flush(e); });
        return inspection;
      }
      e.cleanupPending = true;
      const pending = cleanupManaged(e);
      void pending.catch(() => { if (!disposed) void flush(e); });
      return pending;
    }
    const cleanup = observer?.detach(e.cleanupInteraction);
    const local = state(e, {
      listenerId: e.op.subscription.listenerId,
      availability: 'closed',
      localReleased: true,
      remoteCleanup: !observer && e.op.subscription.acceptanceRef && !e.op.subscription.localReleased ? 'unknown' : e.op.subscription.remoteCleanup,
      problem: e.op.subscription.problem
    });
    if (cleanup) {
      e.cleanupFlight = track(cleanup.then(async (release) => {
        e.release = release;
        await local;
        await state(e, {
          listenerId: e.op.subscription.listenerId,
          availability: 'closed',
          localReleased: true,
          remoteCleanup: release.status,
          problem: e.op.subscription.problem
        });
      })).finally(() => { delete e.cleanupFlight; });
      void e.cleanupFlight.catch(report);
    }
    return local;
  };
  const recoverCreation = (e: Entry): Promise<void> => {
    if (e.creationFlight) return e.creationFlight;
    if (disposed || e.op.subscription.acceptanceRef || e.acceptance || !options.recoverCreation) {
      e.creationRetry = false;
      return Promise.resolve();
    }
    e.creationAttempted = true;
    const revision = e.sourceRevision;
    e.creationFlight = track((async () => {
      try {
        const outcome = e.creationFailure ? { kind: 'failed' as const, error: e.creationFailure }
          : await options.recoverCreation!(e.op, lifetime.signal);
        if (disposed) return;
        e.creationRetry = false;
        e.creationInspected = true;
        if (outcome?.kind === 'subscribed') {
          e.attempted = false;
          e.acceptance = { listenerId: outcome.listenerId, content: outcome.acknowledgement };
          await accept(e);
        } else if (outcome?.kind === 'cleanup_pending') {
          // Original target release plus Catalog stop evidence preserves a cleanup
          // duty after receipt GC; it supplies no new acceptance or effect fact.
          await close(e);
        } else if (outcome?.kind === 'failed' && (!outcome.error.dispatched || outcome.error.settlement !== 'unknown')) {
          // Preserve the original finite RPC proof before release drops its receipt.
          // A protocol response or expired original transport proves this finite
          // RPC stopped, while its remote effect remains Unknown.
          e.creationFailure = outcome.error;
          const op = await request<McpResourcePending, 'runtime.mcp.resource.creation_failed'>(
            'runtime.mcp.resource.creation_failed', { binding: e.op.subscription.binding, error: outcome.error }, lifetime.signal);
          adoptLatest(e, op);
          delete e.creationFailure;
          await close(e);
        }
      } catch (error) {
        e.creationRetry = !!e.creationFailure || !e.op.subscription.acceptanceRef && !e.acceptance
          && error instanceof McpAuthorityError && error.code === 'mcp_resource_creation_receipt_pending';
        throw error;
      }
    })()).finally(() => {
      delete e.creationFlight;
      if (e.sourceRevision !== revision) e.creationAttempted = false;
      wake();
    });
    return e.creationFlight;
  };
  const recover = (e: Entry, recordGap = true): Promise<void> => {
    if (e.recovery) {
      return e.recovery;
    }
    if (e.closed || e.attempted || !e.op.subscription.acceptanceRef) {
      return Promise.resolve();
    }
    e.attempted = true;
    const revision = e.sourceRevision;
    e.recovery = track((async () => {
      try {
        // Persist the gap using the old local incarnation before publishing a replacement.
        if (recordGap) {
          fact(e, 'gap');
        }
        if (!await flush(e) || e.closed) {
          return;
        }
        await state(e, {
          listenerId: e.op.subscription.listenerId,
          availability: 'gap',
          localReleased: true,
          remoteCleanup: e.op.subscription.remoteCleanup,
          problem: null
        });
        if (e.closed || disposed) return;
        const receiver = randomUUID();
        e.receiving = receiver;
        e.attaching = true;
        const observer = await options.recover(e.op, e.controller.signal, change => {
          if (e.receiving === receiver) {
            changed(e, change);
          }
        });
        if (e.closed || disposed) {
          disconnect(observer);
          return;
        }
        e.observer = observer;
        await state(e, {
          listenerId: observer.listenerId,
          availability: 'active',
          localReleased: false,
          remoteCleanup: 'not_requested',
          problem: null
        }, true);
        e.attaching = false;
        const pending = [...e.preAck.values()];
        e.preAck.clear();
        for (const change of pending) {
          changed(e, change);
        }
        await flush(e);
      } catch (error) {
        e.attaching = false;
        delete e.receiving;
        e.preAck.clear();
        const observer = e.observer;
        delete e.observer;
        if (observer) {
          disconnect(observer);
        }
        if (!e.closed && !disposed) {
          await state(e, {
            listenerId: e.op.subscription.listenerId,
            availability: 'unavailable',
            localReleased: true,
            remoteCleanup: e.op.subscription.remoteCleanup,
            problem: error instanceof McpAuthorityError ? error.code : 'mcp-resource-original-owner-unavailable'
          });
        }
      }
    })()).finally(() => {
      delete e.recovery;
      if (e.sourceRevision !== revision) { e.attempted = false; wake(); }
    });
    return e.recovery;
  };
  const changed = (e: Entry, change: McpResourceChange) => {
    if (e.closed || disposed) {
      return;
    }
    if (e.attaching || !e.op.subscription.acceptanceRef) {
      e.preAck.set(change.kind, change);
      return;
    }
    if (change.kind === 'updated' || change.kind === 'unresolved_association') {
      fact(e, change.kind, change.kind === 'updated' ? change.notification : undefined);
      return;
    }
    if (change.kind === 'gap') {
      fact(e, 'gap');
      const observer = e.observer;
      delete e.observer;
      delete e.receiving;
      if (observer) {
        disconnect(observer);
      }
      if (!e.recovery) {
        e.attempted = false;
        void recover(e, false).catch(report);
      }
      return;
    }
    const observer = e.observer;
    delete e.observer;
    delete e.receiving;
    if (observer) {
      disconnect(observer);
    }
    void state(e, {
      listenerId: e.op.subscription.listenerId,
      availability: 'unavailable',
      localReleased: true,
      remoteCleanup: 'unknown',
      problem: change.problem
    }).catch(report);
  };
  const accept = (e: Entry): Promise<void> => {
    if (e.acceptanceFlight) {
      return e.acceptanceFlight;
    }
    if (!e.acceptance) {
      return Promise.resolve();
    }
    const ack = e.acceptance;
    e.acceptanceFlight = track(request<McpResourcePending, 'runtime.mcp.resource.accept'>('runtime.mcp.resource.accept', {
      binding: e.op.subscription.binding,
      listenerId: ack.listenerId,
      content: ack.content
    }, lifetime.signal).then(async (op) => {
      adoptLatest(e, op);
      delete e.acceptance;
      e.creationRetry = false;
      e.creationInspected = true;
      if (e.closed || e.op.cancelRequested) {
        await close(e);
      } else {
        const pending = [...e.preAck.values()];
        e.preAck.clear();
        for (const change of pending) {
          changed(e, change);
        }
        void flush(e);
      }
    })).finally(() => {
      delete e.acceptanceFlight;
      wake();
    });
    return e.acceptanceFlight;
  };
  const reconcile = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    dirty = true;
    if (work) {
      return work;
    }
    work = (async () => {
      while (dirty && !disposed) {
        dirty = false;
        const pending = await request<McpResourcePending[], 'runtime.mcp.resource.pending'>('runtime.mcp.resource.pending', {});
        for (const op of pending) {
          let e = entries.get(op.operationId);
          if (!e) {
            e = entry(op);
            entries.set(op.operationId, e);
          } else {
            adoptLatest(e, op);
          }
          if (!admitting.has(op.operationId) && !e.op.subscription.mcpHolderReleased && !e.op.subscription.acceptanceRef
            && !e.acceptance && !e.cleanupPending && !e.creationAttempted && options.recoverCreation) {
            void recoverCreation(e).catch(error => {
              report(error);
              if (e!.creationRetry || e!.acceptance || e!.cleanupPending) void flush(e!);
            });
            continue;
          }
          if (e.creationFlight) continue;
          // Never release a receipt body after an uncertain original inspection.
          if (!e.op.subscription.mcpHolderReleased && !e.op.subscription.acceptanceRef && !e.acceptance
            && options.recoverCreation && !e.creationInspected) continue;
          if (e.op.cancelRequested) {
            if (e.cleanupPending) { void flush(e); continue; }
            if (!e.closed || !e.op.subscription.localReleased || !e.op.subscription.mcpHolderReleased) {
              void close(e).catch(report);
            }
            if (e.acceptance) {
              void flush(e);
            }
            continue;
          }
          if (admitting.has(op.operationId)) {
            continue;
          }
          if (e.acceptance || e.creationRetry || e.cleanupPending) {
            void flush(e);
          } else if (!e.observer && !e.attempted && e.op.subscription.acceptanceRef) {
            void recover(e).catch(report);
          }
        }
      }
    })().finally(() => {
      work = undefined;
      if (dirty && !disposed) {
        wake();
      }
    });
    return work;
  };
  const wake = () => {
    if (started && !disposed) {
      void reconcile().catch(report);
    }
  };
  const sourceReached = () => {
    if (disposed) return;
    sourceRevision++;
    for (const e of entries.values()) {
      e.sourceRevision = sourceRevision;
      e.creationAttempted = false;
      if (!e.observer) e.attempted = false;
      void flush(e);
    }
    wake();
  };
  return {
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      removers.push(options.runtime.onEvent(wake), options.runtime.onReady(sourceReached));
      wake();
    },
    reconcile,
    sourceReached,
    async subscribe(input: {
      call: HostToolCall;
      owner: ExecutorOwner;
      lease: McpAuthorityLease;
      service: McpAuthorityService;
      uri: string;
      signal: AbortSignal;
      checkObservation: () => Promise<void>;
      beforeDispatch?: () => void | Promise<void>;
    }): Promise<ToolExecutionReceipt> {
      const endpoint: McpEndpoint = input.lease.resourceEndpoint(input.service);
      const binding: McpResourceBinding = {
        operationId: input.call.operationId,
        executionOwner: input.owner,
        endpoint,
        schemaVersion: input.service.schemaVersion,
        uri: input.uri
      };
      admitting.add(binding.operationId);
      let e: Entry | undefined;
      let acknowledged = false;
      try {
        let op: McpResourcePending;
        try {
          op = await request<McpResourcePending, 'runtime.mcp.resource.begin'>('runtime.mcp.resource.begin', { binding });
        } catch (error) {
          // This is a local admission call only. The original MCP observer/RPC
          // has not been entered, including when that local response was lost.
          report(error);
          return {
            executor_stopped: true,
            completion: {
              kind: 'not_dispatched',
              reason: error instanceof Error ? error.message : 'MCP resource observation admission failed'
            }
          };
        }
        if (op.subscription.acceptanceRef) {
          throw new McpAuthorityError('mcp-resource-original-call-already-accepted');
        }
        if (op.cancelRequested) {
          throw new McpAuthorityError('mcp-resource-observer-withdrawn');
        }
        e = entry(op);
        entries.set(binding.operationId, e);
        const selected = e;
        const receiver = randomUUID();
        e.receiving = receiver;
        const observer = await input.lease.observeResource(input.service, input.uri, {
          signal: AbortSignal.any([input.signal, e.controller.signal]),
          interaction: {operationId: input.call.operationId, executionOwner: input.owner},
          ...(input.beforeDispatch ? { beforeDispatch: input.beforeDispatch } : {}),
          onChange: change => {
            void input.checkObservation().then(() => {
              if (selected.receiving === receiver) {
                changed(selected, change);
              }
            }, () => {
              if (selected.receiving === receiver) {
                changed(selected, { kind: "unavailable", problem: "mcp-resource-permission-revoked" });
              }
            });
          }
        });
        acknowledged = true;
        // A late managed subscribe reply may arrive after explicit cleanup or Host
        // disposal. Disconnect that projection without releasing its holder again.
        if (disposed || e.closed && observer.disconnect) disconnect(observer);
        else e.observer = observer;
        e.acceptance = { listenerId: observer.listenerId, content: observer.acknowledgement };
        await accept(e);
        return {
          executor_stopped: true,
          completion: {
            kind: 'result',
            outcome: 'succeeded',
            effect: 'confirmed',
            content: {
              data: {
                operationId: binding.operationId,
                server: endpoint.server,
                uri: input.uri,
                acknowledgement: observer.acknowledgement
              },
              parts: []
            }
          }
        };
      } catch (error) {
        if (acknowledged) {
          // The original finite RPC really ended. Local ACK publication uncertainty
          // cannot keep its dispatch occupancy or source-writer barrier open.
          report(error);
          return {
            executor_stopped: true,
            completion: {
              kind: 'result',
              outcome: 'indeterminate',
              effect: 'unknown',
              content: {
                data: {
                  operationId: binding.operationId,
                  error: 'mcp_effect_unknown',
                  reason: 'mcp_resource_ack_publication_uncertain'
                },
                parts: []
              }
            }
          };
        }
        if (e && !e.acceptance && !e.op.subscription.acceptanceRef) {
          e.attempted = true;
          await state(e, {
            listenerId: e.op.subscription.listenerId,
            availability: 'unavailable',
            localReleased: true,
            remoteCleanup: 'unknown',
            problem: error instanceof McpAuthorityError ? error.code : 'mcp-resource-subscribe-unavailable'
          });
        }
        throw error;
      } finally {
        admitting.delete(binding.operationId);
        if (e?.acceptance) {
          void flush(e);
        }
        wake();
      }
    },
    async unsubscribe(input: {
      call: HostToolCall;
      owner: ExecutorOwner;
      operationId: string;
      signal: AbortSignal;
    }): Promise<ToolExecutionReceipt> {
      const op = await request<McpResourcePending, 'runtime.mcp.resource.access'>('runtime.mcp.resource.access', {
        runId: input.call.runId,
        targetOperationId: input.operationId,
        control: true
      }, input.signal);
      let e = entries.get(input.operationId);
      if (!e) {
        e = entry(op);
        entries.set(input.operationId, e);
      }
      // Reserve only this actual user control caller before its cancellation event can
      // trigger the same cleanup. Autonomous cleanup never creates an interaction origin.
      e.cleanupInteraction = {interaction:{operationId:input.call.operationId,executionOwner:input.owner},signal:input.signal};
      await request('runtime.operation.cancel', { operationId: input.operationId }, input.signal);
      adoptLatest(e, op);
      e.op = { ...e.op, cancelRequested: true };
      await close(e);
      await e.cleanupFlight;
      const release = e.release ?? { status: e.op.subscription.remoteCleanup };
      const remoteCleanup = release.status;
      return {
        executor_stopped: true,
        completion: {
          kind: 'result',
          outcome: remoteCleanup === 'unknown' ? 'indeterminate' : 'succeeded',
          effect: remoteCleanup === 'unknown' ? 'unknown' : 'confirmed',
          content: {
            data: {
              operationId: input.operationId,
              localReleased: true,
              remoteCleanup,
              ...('acknowledgement' in release ? { acknowledgement: release.acknowledgement } : {}),
              ...('protocolError' in release ? { protocolError: release.protocolError } : {}),
              ...('interactionProblem' in release ? { interactionProblem: release.interactionProblem } : {})
            },
            parts: []
          }
        }
      };
    },
    async releaseSource(runId: string): Promise<void> {
      const ops = await request<McpResourcePending[], 'runtime.mcp.resource.release_source'>('runtime.mcp.resource.release_source', { runId });
      await Promise.all(ops.map(async (op) => {
        let e = entries.get(op.operationId);
        if (!e) {
          e = entry(op);
          entries.set(op.operationId, e);
        } else {
          adoptLatest(e, op);
        }
        await close(e);
      }));
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      lifetime.abort();
      for (const stop of removers.splice(0)) {
        stop();
      }
      for (const e of entries.values()) {
        e.closed = true;
        e.controller.abort();
        e.facts.clear();
        if (e.observer) {
          disconnect(e.observer);
        }
      }
      await Promise.allSettled([...(work ? [work] : []), ...flights]);
      entries.clear();
    }
  };
}
