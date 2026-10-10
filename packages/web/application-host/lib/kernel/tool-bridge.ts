/** The single private Host tool rendezvous for retained MCP and ordinary service endpoints.
 * Calls remain owned by their original lease across Run release and kernel channel replacement.
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  HostToolCall,
  LaunchTool,
  ExecutorOwner,
} from './protocol.generated.js';
export type HostToolSchema = LaunchTool;
export interface HostToolBinding {
  reference: string;
  generation: number;
  resources: Record<string, string>;
  tools: HostToolSchema[];
}
export interface LiveHostToolBinding {
  ownerId: string;
  binding: HostToolBinding;
}
export type { HostToolCall } from './protocol.generated.js';
export type HostToolCompletion =
  | { kind: 'not_dispatched'; reason: string }
  | {
      kind: 'result';
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
      effect: 'none' | 'confirmed' | 'unknown';
      content: unknown;
    };
/** Trusted adapter evidence; never accepted from the extension's ToolCompletion JSON. */
export interface ToolExecutionReceipt {
  completion: HostToolCompletion;
  executor_stopped: boolean;
}
export interface HostToolLease {
  readonly binding: HostToolBinding;
  readonly implementationIdentity: string;
  /** Different services occupy independent selected slots in one composition owner. */
  readonly slot?: string;
  available(schema: HostToolSchema): boolean;
  authorize(call: HostToolCall, signal: AbortSignal): Promise<void>;
  revocationSignal(call: HostToolCall): AbortSignal;
  execute(
    call: HostToolCall,
    signal: AbortSignal,
    owner: ExecutorOwner,
  ): Promise<ToolExecutionReceipt>;
  release(): void;
}
interface Request {
  v: 1;
  kind: 'host-tool-request';
  id: string;
  kernelEpoch: string;
  phase: 'authorize' | 'execute';
  binding: {
    ownerId: string;
    reference: string;
    generation: number;
    holderId: string;
  };
  call: HostToolCall;
}
export interface PrivateToolResponse {
  v: 1;
  kind: 'host-tool-response';
  id: string;
  kernelEpoch: string;
  ok: boolean;
  completion?: HostToolCompletion;
  executor_stopped?: boolean;
  error?: { code: string };
}
interface PrivateToolReceipt {
  v: 1;
  kind: 'host-tool-receipt';
  id: string;
  kernelEpoch: string;
  executionOwner: ExecutorOwner;
  call: HostToolCall;
  receipt: ToolExecutionReceipt;
}
interface Revoked {
  v: 1;
  kind: 'host-tool-revoked';
  kernelEpoch: string;
  ownerId: string;
  operationId: string;
}
export type PrivateToolFrame =
  PrivateToolResponse | PrivateToolReceipt | Revoked;
interface CallEntry {
  identity: string;
  call: HostToolCall;
  authorized: boolean;
  started: boolean;
  result?: Promise<ToolExecutionReceipt>;
  receipt?: ToolExecutionReceipt;
  receiptId: string;
  acknowledged: boolean;
  actualPending: boolean;
  stopWatch?: () => void;
}
interface OwnerEntry {
  lease: HostToolLease;
  binding: HostToolBinding;
  epoch: string;
  closing: boolean;
  selected: boolean;
  // The Host composition owns a candidate across kernel select/ready holder changes.
  retained: boolean;
  holders: Set<string>;
  active: Map<string, AbortController>;
  calls: Map<string, CallEntry>;
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((key) => keys.includes(key));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const generation = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
export const unknownToolReceipt = (): ToolExecutionReceipt => ({
  completion: {
    kind: 'result',
    outcome: 'indeterminate',
    effect: 'unknown',
    content: { error: 'host_tool_effect_unknown' },
  },
  executor_stopped: false,
});
export const undispatchedToolReceipt = (
  reason: string,
): ToolExecutionReceipt => ({
  completion: { kind: 'not_dispatched', reason },
  executor_stopped: true,
});
function callValid(v: unknown): v is HostToolCall {
  if (
    !record(v) ||
    !exact(v, [
      'runId',
      'origin',
      'operationId',
      'callId',
      'name',
      'schemaVersion',
      'arguments',
    ]) ||
    !['runId', 'operationId', 'callId', 'name', 'schemaVersion'].every((key) =>
      text(v[key]),
    ) ||
    !('arguments' in v) ||
    !record(v.origin)
  )
    return false;
  const origin = v.origin;
  return origin.kind === 'model_step'
    ? exact(origin, ['kind', 'request_id']) &&
        text(origin.request_id) &&
        v.operationId === `${origin.request_id}:tool:${v.callId}`
    : origin.kind === 'policy_action' &&
        exact(origin, ['kind', 'action_id', 'node_id']) &&
        text(origin.action_id) &&
        origin.node_id === v.callId &&
        v.operationId === `${origin.action_id}:node:${origin.node_id}`;
}
function waitForOwner<T>(
  work: Promise<T>,
  signal: AbortSignal,
  aborted: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}
export class ToolBridge {
  readonly #owners = new Map<string, Map<string, OwnerEntry>>();
  readonly #selected = new Map<string, Map<string, string>>();
  constructor(
    private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateToolFrame) => Promise<void>,
    private readonly transportFailed: () => void,
    private readonly released: (runId: string) => void = () => {},
  ) {}
  register(
    runId: string,
    lease: HostToolLease,
    selected = true,
  ): LiveHostToolBinding {
    const epoch = this.currentEpoch(),
      binding = structuredClone(lease.binding);
    if (
      !epoch ||
      !text(runId) ||
      !text(lease.implementationIdentity) ||
      !text(binding.reference) ||
      !generation(binding.generation) ||
      !record(binding.resources) ||
      Object.values(binding.resources).some((v) => !text(v)) ||
      !Array.isArray(binding.tools) ||
      binding.tools.some(
        (t) =>
          !text(t.name) ||
          !text(t.version) ||
          typeof t.description !== 'string',
      ) ||
      new Set(binding.tools.map((t) => t.name)).size !== binding.tools.length
    )
      throw new Error('host_tool_owner_registration_invalid');
    const entries = this.#owners.get(runId) ?? new Map<string, OwnerEntry>();
    const retained = [...entries].find(
      ([, e]) =>
        e.lease.implementationIdentity === lease.implementationIdentity &&
        !e.closing &&
        e.epoch === epoch &&
        isDeepStrictEqual(e.binding, binding),
    );
    const key = retained?.[0] ?? randomUUID();
    if (retained) {
      if (!selected) retained[1].retained = true;
      if (retained[1].lease !== lease) lease.release();
    } else {
      entries.set(key, {
        lease,
        binding,
        epoch,
        closing: false,
        selected: false,
        retained: !selected,
        holders: new Set(),
        active: new Map(),
        calls: new Map(),
      });
      this.#owners.set(runId, entries);
    }
    if (selected) this.#activate(runId, key);
    return { ownerId: key, binding: structuredClone(binding) };
  }
  #activate(runId: string, key: string): void {
    const entries = this.#owners.get(runId),
      entry = entries?.get(key);
    if (!entry || entry.closing || entry.epoch !== this.currentEpoch()) return;
    const slots = this.#selected.get(runId) ?? new Map<string, string>(),
      slot = entry.lease.slot ?? 'mcp';
    const previousKey = slots.get(slot);
    slots.set(slot, key);
    this.#selected.set(runId, slots);
    entry.selected = true;
    if (previousKey && previousKey !== key) {
      const previous = entries!.get(previousKey);
      if (previous) {
        previous.selected = false;
        this.#collect(runId, previousKey, previous);
      }
    }
  }
  #collect(runId: string, key: string, entry: OwnerEntry): void {
    if (
      entry.selected ||
      entry.retained ||
      entry.holders.size ||
      entry.active.size ||
      [...entry.calls.values()].some(
        (c) => c.started && (c.actualPending || !c.acknowledged),
      )
    )
      return;
    const entries = this.#owners.get(runId);
    if (entries?.get(key) !== entry) return;
    entries.delete(key);
    if (!entries.size) this.#owners.delete(runId);
    entry.closing = true;
    for (const call of entry.calls.values()) call.stopWatch?.();
    entry.lease.release();
  }
  discard(runId: string, binding: LiveHostToolBinding): void {
    const e = this.#owners.get(runId)?.get(binding.ownerId);
    if (e) {
      e.retained = false;
      this.#collect(runId, binding.ownerId, e);
    }
  }
  binding(runId: string): HostToolBinding | undefined {
    return this.liveBinding(runId)?.binding;
  }
  liveBinding(runId: string, slot = 'mcp'): LiveHostToolBinding | undefined {
    const key = this.#selected.get(runId)?.get(slot),
      owner = key ? this.#owners.get(runId)?.get(key) : undefined;
    return owner && !owner.closing && owner.epoch === this.currentEpoch()
      ? { ownerId: key!, binding: structuredClone(owner.binding) }
      : undefined;
  }
  availability(
    runId: string,
    name: string,
    version: string,
  ): boolean | undefined {
    for (const key of this.#selected.get(runId)?.values() ?? []) {
      const entry = this.#owners.get(runId)?.get(key);
      const schema = entry?.binding.tools.find(
        (tool) => tool.name === name && tool.version === version,
      );
      if (entry && schema)
        return (
          !entry.closing &&
          entry.epoch === this.currentEpoch() &&
          entry.lease.available(schema)
        );
    }
    return undefined;
  }
  implementationIdentity(runId: string): string | undefined {
    const key = this.#selected.get(runId)?.get('mcp');
    return key
      ? this.#owners.get(runId)?.get(key)?.lease.implementationIdentity
      : undefined;
  }
  /** Run termination withdraws admission. Original callbacks and unacknowledged facts retain leases. */
  unregister(runId: string): void {
    this.released(runId);
    this.#selected.delete(runId);
    for (const [key, entry] of this.#owners.get(runId) ?? []) {
      entry.closing = true;
      entry.selected = false;
      entry.retained = false;
      entry.holders.clear();
      for (const c of entry.active.values()) c.abort();
      this.#collect(runId, key, entry);
    }
  }
  /** Channel reset is not Host/broker death. No callback or receipt is deleted here. */
  reset(): void {
    for (const run of this.#owners.keys()) this.unregister(run);
  }
  close(): void {
    this.reset();
  }
  reconnect(): void {
    for (const [run, entries] of this.#owners)
      for (const [key, owner] of entries)
        for (const call of owner.calls.values())
          void this.#publishReceipt(run, key, owner, call);
  }
  consume(v: unknown): boolean {
    if (
      !record(v) ||
      ![
        'host-tool-request',
        'host-tool-cancel',
        'host-tool-owner-release',
        'host-tool-binding-retain',
        'host-tool-binding-release',
        'host-tool-binding-activate',
        'host-tool-binding-deactivate',
        'host-tool-receipt-ack',
      ].includes(String(v.kind))
    )
      return false;
    if (v.v !== 1 || v.kernelEpoch !== this.currentEpoch()) return true;
    if (v.kind === 'host-tool-receipt-ack') {
      if (
        !exact(v, ['v', 'kind', 'kernelEpoch', 'id', 'accepted']) ||
        !text(v.id) ||
        typeof v.accepted !== 'boolean'
      )
        return true;
      for (const [run, entries] of this.#owners)
        for (const [key, owner] of entries)
          for (const call of owner.calls.values())
            if (call.receiptId === v.id) {
              // Accepted or definitive identity rejection ends retransmission, never changes the fact.
              call.acknowledged = true;
              this.#collect(run, key, owner);
              return true;
            }
      return true;
    }
    if (v.kind === 'host-tool-owner-release') {
      if (text(v.runId) && exact(v, ['v', 'kind', 'kernelEpoch', 'runId']))
        this.unregister(v.runId);
      return true;
    }
    if (v.kind === 'host-tool-binding-deactivate') {
      if (
        !text(v.runId) ||
        !exact(v, ['v', 'kind', 'kernelEpoch', 'runId', 'slot'])
      )
        return true;
      const slots = this.#selected.get(v.runId),
        slot = typeof v.slot === 'string' ? v.slot : 'mcp',
        key = slots?.get(slot);
      slots?.delete(slot);
      const e = key ? this.#owners.get(v.runId)?.get(key) : undefined;
      if (e) {
        e.selected = false;
        this.#collect(v.runId, key!, e);
      }
      return true;
    }
    if (
      [
        'host-tool-binding-retain',
        'host-tool-binding-release',
        'host-tool-binding-activate',
      ].includes(String(v.kind))
    ) {
      if (
        !text(v.runId) ||
        !text(v.ownerId) ||
        !text(v.holderId) ||
        !exact(v, ['v', 'kind', 'kernelEpoch', 'runId', 'ownerId', 'holderId'])
      )
        return true;
      const e = this.#owners.get(v.runId)?.get(v.ownerId);
      if (!e || e.epoch !== v.kernelEpoch) return true;
      if (v.kind === 'host-tool-binding-release') {
        e.holders.delete(v.holderId);
        this.#collect(v.runId, v.ownerId, e);
      } else if (!e.closing) {
        if (v.kind === 'host-tool-binding-retain') e.holders.add(v.holderId);
        else if (e.holders.has(v.holderId)) this.#activate(v.runId, v.ownerId);
      }
      return true;
    }
    if (!text(v.id)) return true;
    if (v.kind === 'host-tool-cancel') {
      if (
        text(v.runId) &&
        exact(v, ['v', 'kind', 'id', 'kernelEpoch', 'runId'])
      )
        for (const e of this.#owners.get(v.runId)?.values() ?? [])
          e.active.get(v.id)?.abort();
      return true;
    }
    if (
      !exact(v, [
        'v',
        'kind',
        'id',
        'kernelEpoch',
        'phase',
        'binding',
        'call',
      ]) ||
      !['authorize', 'execute'].includes(String(v.phase)) ||
      !record(v.binding) ||
      !exact(v.binding, ['ownerId', 'reference', 'generation', 'holderId']) ||
      !text(v.binding.ownerId) ||
      !text(v.binding.reference) ||
      !generation(v.binding.generation) ||
      !text(v.binding.holderId) ||
      !callValid(v.call)
    )
      return true;
    const request = v as unknown as Request,
      key = request.binding.ownerId,
      owner = this.#owners.get(request.call.runId)?.get(key);
    if (
      !owner ||
      owner.closing ||
      owner.epoch !== request.kernelEpoch ||
      owner.binding.reference !== request.binding.reference ||
      owner.binding.generation !== request.binding.generation ||
      !owner.holders.has(request.binding.holderId)
    ) {
      void this.#reply(request, {
        ok: request.phase === 'execute',
        ...(request.phase === 'execute'
          ? undispatchedToolReceipt('host_tool_owner_unavailable')
          : { error: { code: 'host_tool_owner_unavailable' } }),
      });
      return true;
    }
    if (owner.active.has(request.id)) return true;
    const controller = new AbortController();
    owner.active.set(request.id, controller);
    void this.#invoke(request, owner, controller.signal).finally(() => {
      owner.active.delete(request.id);
      this.#collect(request.call.runId, key, owner);
    });
    return true;
  }
  async #reply(
    request: Request,
    response: Pick<
      PrivateToolResponse,
      'ok' | 'completion' | 'executor_stopped' | 'error'
    >,
  ): Promise<void> {
    if (request.kernelEpoch !== this.currentEpoch()) return;
    try {
      await this.send({
        v: 1,
        kind: 'host-tool-response',
        id: request.id,
        kernelEpoch: request.kernelEpoch,
        ...response,
      });
    } catch {
      if (request.kernelEpoch === this.currentEpoch()) this.transportFailed();
    }
  }
  async #publishReceipt(
    run: string,
    key: string,
    owner: OwnerEntry,
    call: CallEntry,
  ): Promise<void> {
    const epoch = this.currentEpoch();
    if (!epoch || !call.receipt || call.acknowledged) return;
    try {
      await this.send({
        v: 1,
        kind: 'host-tool-receipt',
        id: call.receiptId,
        kernelEpoch: epoch,
        executionOwner: {
          kind: 'external',
          identity: owner.binding.reference,
          epoch: key,
        },
        call: call.call,
        receipt: call.receipt,
      });
    } catch {
      if (epoch === this.currentEpoch()) this.transportFailed();
    }
    this.#collect(run, key, owner);
  }
  async #invoke(
    request: Request,
    owner: OwnerEntry,
    signal: AbortSignal,
  ): Promise<void> {
    const call = request.call,
      identity = JSON.stringify(call),
      previous = owner.calls.get(call.operationId);
    if (previous && previous.identity !== identity) {
      await this.#reply(request, {
        ok: false,
        error: { code: 'host_tool_call_identity_changed' },
      });
      return;
    }
    const entry = previous ?? {
      identity,
      call: structuredClone(call),
      authorized: false,
      started: false,
      receiptId: randomUUID(),
      acknowledged: false,
      actualPending: false,
    };
    owner.calls.set(call.operationId, entry);
    if (request.phase === 'authorize') {
      try {
        if (entry.started || signal.aborted || owner.closing)
          throw new Error('closed');
        const ok = await waitForOwner(
          owner.lease.authorize(structuredClone(call), signal).then(() => true),
          signal,
          () => false,
        );
        if (!ok || signal.aborted || owner.closing) throw new Error('closed');
        const revoked = owner.lease.revocationSignal(call);
        const notify = () => {
          const epoch = this.currentEpoch();
          if (epoch === request.kernelEpoch)
            void this.send({
              v: 1,
              kind: 'host-tool-revoked',
              kernelEpoch: epoch,
              ownerId: request.binding.ownerId,
              operationId: call.operationId,
            }).catch(() => this.transportFailed());
        };
        entry.stopWatch?.();
        revoked.addEventListener('abort', notify, { once: true });
        entry.stopWatch = () => revoked.removeEventListener('abort', notify);
        if (revoked.aborted) notify();
        entry.authorized = true;
        await this.#reply(request, { ok: true });
      } catch {
        await this.#reply(request, {
          ok: false,
          error: { code: 'host_tool_authorization_failed' },
        });
      }
      return;
    }
    if (!entry.authorized) {
      await this.#reply(request, {
        ok: true,
        ...undispatchedToolReceipt('host_tool_authorization_required'),
      });
      return;
    }
    if (!entry.result) {
      entry.started = true;
      entry.actualPending = true;
      // This Promise follows the actual retained callback. Only the kernel observer is raced.
      entry.result = Promise.resolve()
        .then(async () =>
          signal.aborted || owner.closing
            ? undispatchedToolReceipt('host_tool_cancelled_before_dispatch')
            : owner.lease.execute(structuredClone(call), signal, {
                kind: 'external',
                identity: owner.binding.reference,
                epoch: request.binding.ownerId,
              }),
        )
        .catch(unknownToolReceipt)
        .then((receipt) => {
          entry.actualPending = false;
          entry.receipt = receipt;
          void this.#publishReceipt(
            call.runId,
            request.binding.ownerId,
            owner,
            entry,
          );
          return receipt;
        });
    }
    const receipt = await waitForOwner(
      entry.result,
      signal,
      unknownToolReceipt,
    );
    await this.#reply(request, { ok: true, ...receipt });
  }
}
