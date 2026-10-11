/** Live handles only. Original Operations, passive inputs and ContentStore own durable facts. */
import { randomUUID } from 'node:crypto';
import { McpAuthorityError, type McpAuthorityLease, type McpAuthorityService, type McpResourceObserver, type McpResourceChange } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostToolCall, ToolExecutionReceipt } from './tool-bridge.js';
import type { ExecutorOwner, McpEndpoint, McpResourceBinding, McpResourcePending, McpResourceListenerParams, McpResourceNotifyParams, KernelMethod, KernelMethodParams } from './protocol.generated.js';
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
  metadata: Promise<unknown>;
  facts: Map<McpResourceNotifyParams['kind'], McpResourceNotifyParams>;
  sending?: McpResourceNotifyParams;
  preAck: Map<McpResourceChange['kind'], McpResourceChange>;
  publishing?: Promise<boolean>;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryDelay: number;
}
export type McpResourceRuntime = ReturnType<typeof createMcpResourceRuntime>;
export function createMcpResourceRuntime(options: {
  kernel: KernelClient;
  runtime: Pick<AgentRuntimeClient, 'onReady' | 'onEvent'>;
  recover(op: McpResourcePending, signal: AbortSignal, onChange: (change: McpResourceChange) => void): Promise<McpResourceObserver>;
  onError?: (error: Error) => void;
}) {
  const entries = new Map<string, Entry>(), admitting = new Set<string>(), removers: Array<() => void> = [], flights = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  let started = false, disposed = false, work: Promise<void> | undefined, dirty = false;
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
  const state = (e: Entry, change: Omit<McpResourceListenerParams, 'binding' | 'expectedListenerId'>): Promise<void> => {
    const run = async () => {
      const op = await request<McpResourcePending, 'runtime.mcp.resource.listener'>('runtime.mcp.resource.listener', {
        binding: e.op.subscription.binding,
        expectedListenerId: e.op.subscription.listenerId,
        ...change
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
    if (disposed || !e.acceptance && (e.closed || !e.op.subscription.acceptanceRef)) {
      return Promise.resolve(false);
    }
    e.publishing = track((async () => {
      while ((e.acceptance || e.sending || e.facts.size) && !disposed) {
        if (!e.acceptance && e.closed) {
          break;
        }
        try {
          // A received ACK is an immutable original RPC fact even after observation closes.
          // Both ACKs and notifications use this one live local publication lane.
          if (e.acceptance) {
            await accept(e);
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
          const signal = e.acceptance ? lifetime.signal : e.controller.signal;
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
  const close = (e: Entry): Promise<void> => {
    if (!e.closed) {
      e.closed = true;
      // Abort only observation publication. A known ACK owns the Host lifetime.
      e.controller.abort();
      e.facts.clear();
      e.preAck.clear();
      delete e.sending;
      delete e.receiving;
    }
    const observer = e.observer;
    delete e.observer;
    // detach is synchronous up to returning its independent remote cleanup promise.
    const cleanup = observer?.detach(e.cleanupInteraction);
    const local = state(e, {
      listenerId: e.op.subscription.listenerId,
      availability: 'closed',
      localReleased: true,
      remoteCleanup: !observer && e.op.subscription.acceptanceRef && !e.op.subscription.localReleased ? 'unknown' : e.op.subscription.remoteCleanup,
      problem: e.op.subscription.problem
    });
    if (cleanup) {
      void track(cleanup.then(async (release) => {
        await local;
        await state(e, {
          listenerId: e.op.subscription.listenerId,
          availability: 'closed',
          localReleased: true,
          remoteCleanup: release.status,
          problem: e.op.subscription.problem
        });
      })).catch(report);
    }
    return local;
  };
  const recover = (e: Entry, recordGap = true): Promise<void> => {
    if (e.recovery) {
      return e.recovery;
    }
    if (e.closed || e.attempted || !e.op.subscription.acceptanceRef) {
      return Promise.resolve();
    }
    e.attempted = true;
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
        const receiver = randomUUID();
        e.receiving = receiver;
        e.attaching = true;
        const observer = await options.recover(e.op, e.controller.signal, change => {
          if (e.receiving === receiver) {
            changed(e, change);
          }
        });
        if (e.closed || disposed) {
          void observer.detach();
          return;
        }
        e.observer = observer;
        await state(e, {
          listenerId: observer.listenerId,
          availability: 'active',
          localReleased: false,
          remoteCleanup: 'not_requested',
          problem: null
        });
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
          void observer.detach();
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
        void observer.detach();
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
      void observer.detach();
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
          if (e.op.cancelRequested) {
            if (!e.closed || !e.op.subscription.localReleased) {
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
          if (e.acceptance) {
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
  return {
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      removers.push(options.runtime.onEvent(wake), options.runtime.onReady(() => {
        for (const e of entries.values()) {
          if (!e.observer) {
            e.attempted = false;
          }
          void flush(e);
        }
        wake();
      }));
      wake();
    },
    reconcile,
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
        e.observer = observer;
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
      const observer = e.observer;
      const cleanup = observer?.detach(e.cleanupInteraction);
      await close(e);
      const release = cleanup ? await cleanup : { status: e.op.subscription.remoteCleanup };
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
          void e.observer.detach();
        }
      }
      await Promise.allSettled([...(work ? [work] : []), ...flights]);
      entries.clear();
    }
  };
}
