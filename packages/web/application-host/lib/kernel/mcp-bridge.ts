/** Private Host/kernel tool rendezvous. There is no renderer or generic method dispatch here.
 * The shared MCP authority owns connections, frozen schemas, credentials and permission decisions.
 */
export interface McpToolSchema { name: string; version: string; schema: Record<string, unknown> }
export interface McpBinding { reference: string; generation: number; resources: Record<string, string>; tools: McpToolSchema[] }
export interface McpCall {
  runId: string; requestId: string; operationId: string; callId: string;
  name: string; schemaVersion: string; arguments: Record<string, unknown>;
}
export type McpCompletion = { kind: 'not_dispatched'; reason: string } | {
  kind: 'result'; outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
  effect: 'none' | 'confirmed' | 'unknown'; content: unknown;
};
/** A retained generation from the sole shared MCP owner, never an independently opened client. */
export interface McpLease {
  readonly binding: McpBinding;
  authorize(call: McpCall, signal: AbortSignal): Promise<void>;
  execute(call: McpCall, signal: AbortSignal): Promise<McpCompletion>;
  release(): void;
}
interface Request {
  v: 1; kind: 'mcp-tool-request'; id: string; kernelEpoch: string;
  phase: 'authorize' | 'execute'; binding: { reference: string; generation: number }; call: McpCall;
}
export interface PrivateMcpResponse {
  v: 1; kind: 'mcp-tool-response'; id: string; kernelEpoch: string;
  ok: boolean; completion?: McpCompletion; error?: { code: string };
}
interface CallEntry { identity: string; authorized: boolean; started: boolean; result?: Promise<McpCompletion> }
interface OwnerEntry {
  lease: McpLease; binding: McpBinding; epoch: string; closing: boolean;
  active: Map<string, AbortController>; calls: Map<string, CallEntry>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const unknown = (): McpCompletion => ({ kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: { error: 'mcp_effect_unknown' } });
const notDispatched = (reason: string): McpCompletion => ({ kind: 'not_dispatched', reason });
function callValid(value: unknown): value is McpCall {
  return record(value) && exact(value, ['runId', 'requestId', 'operationId', 'callId', 'name', 'schemaVersion', 'arguments'])
    && ['runId', 'requestId', 'operationId', 'callId', 'name', 'schemaVersion'].every(key => text(value[key]))
    && record(value.arguments);
}
function waitForOwner<T>(work: Promise<T>, signal: AbortSignal, aborted: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
export class McpBridge {
  readonly #owners = new Map<string, OwnerEntry>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateMcpResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  register(runId: string, lease: McpLease): McpBinding {
    const epoch = this.currentEpoch();
    const binding = structuredClone(lease.binding);
    if (!epoch || !text(runId) || this.#owners.has(runId) || !text(binding.reference) || !generation(binding.generation)
      || !record(binding.resources) || Object.values(binding.resources).some(value => !text(value))
      || !Array.isArray(binding.tools) || binding.tools.some(tool => !text(tool.name)
        || !text(tool.version) || !record(tool.schema)) || new Set(binding.tools.map(tool => tool.name)).size !== binding.tools.length) {
      throw new Error('mcp_owner_registration_invalid');
    }
    this.#owners.set(runId, { lease, binding, epoch, closing: false, active: new Map(), calls: new Map() });
    return structuredClone(binding);
  }
  binding(runId: string): McpBinding | undefined {
    const owner = this.#owners.get(runId);
    return owner && !owner.closing && owner.epoch === this.currentEpoch() ? structuredClone(owner.binding) : undefined;
  }
  unregister(runId: string): void {
    const entry = this.#owners.get(runId);
    if (!entry) return;
    this.#owners.delete(runId);
    entry.closing = true;
    for (const controller of entry.active.values()) controller.abort();
    entry.lease.release();
  }
  close(): void { for (const runId of this.#owners.keys()) this.unregister(runId); }
  consume(value: unknown): boolean {
    if (!record(value) || !['mcp-tool-request', 'mcp-tool-cancel', 'mcp-owner-release'].includes(String(value.kind))) return false;
    // Consume malformed/private traffic rather than letting it reach public protocol consumers.
    if (value.kind === 'mcp-owner-release') {
      if (value.v === 1 && value.kernelEpoch === this.currentEpoch() && text(value.runId)
        && exact(value, ['v', 'kind', 'kernelEpoch', 'runId'])) this.unregister(value.runId);
      return true;
    }
    if (value.v !== 1 || !text(value.id) || value.kernelEpoch !== this.currentEpoch()) return true;
    if (value.kind === 'mcp-tool-cancel') {
      if (!exact(value, ['v', 'kind', 'id', 'kernelEpoch', 'runId']) || !text(value.runId)) return true;
      this.#owners.get(value.runId)?.active.get(value.id)?.abort();
      return true;
    }
    if (!exact(value, ['v', 'kind', 'id', 'kernelEpoch', 'phase', 'binding', 'call'])
      || !['authorize', 'execute'].includes(String(value.phase)) || !record(value.binding)
      || !exact(value.binding, ['reference', 'generation']) || !text(value.binding.reference)
      || !generation(value.binding.generation) || !callValid(value.call)) return true;
    const request = value as unknown as Request;
    const entry = this.#owners.get(request.call.runId);
    if (!entry || entry.closing || entry.epoch !== request.kernelEpoch
      || entry.binding.reference !== request.binding.reference || entry.binding.generation !== request.binding.generation) {
      void this.#reply(request, { ok: false, error: { code: 'mcp_owner_unavailable' } });
      return true;
    }
    if (entry.active.has(request.id)) return true;
    const controller = new AbortController();
    entry.active.set(request.id, controller);
    void this.#invoke(request, entry, controller.signal).finally(() => entry.active.delete(request.id));
    return true;
  }
  async #reply(request: Request, response: Pick<PrivateMcpResponse, 'ok' | 'completion' | 'error'>): Promise<void> {
    if (request.kernelEpoch !== this.currentEpoch()) return;
    try { await this.send({ v: 1, kind: 'mcp-tool-response', id: request.id, kernelEpoch: request.kernelEpoch, ...response }); }
    catch (error) {
      // The encoder rejects an oversized frame before writing any bytes. Preserve the actual
      // remote-effect receipt and fail just this output, rather than taking down unrelated Runs.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'kernel-frame-too-large'
        && response.completion?.kind === 'result') {
        const completion = response.completion;
        try {
          await this.send({ v: 1, kind: 'mcp-tool-response', id: request.id, kernelEpoch: request.kernelEpoch, ok: true,
            completion: { kind: 'result', outcome: completion.outcome === 'succeeded' ? 'failed' : completion.outcome,
              effect: completion.effect, content: { error: 'mcp_output_exceeds_transport_frame',
                remoteOutcome: completion.outcome, message: 'The remote call settled, but its output exceeds the private transport frame. Do not replay the remote effect to retrieve this output.' } } });
          return;
        } catch { /* A real transport failure still invalidates the private channel. */ }
      }
      if (request.kernelEpoch === this.currentEpoch()) this.transportFailed();
    }
  }
  async #invoke(request: Request, owner: OwnerEntry, signal: AbortSignal): Promise<void> {
    const call = request.call;
    const identity = JSON.stringify(call);
    const previous = owner.calls.get(call.operationId);
    if (previous && previous.identity !== identity) {
      await this.#reply(request, { ok: false, error: { code: 'mcp_call_identity_changed' } });
      return;
    }
    const entry = previous ?? { identity, authorized: false, started: false };
    owner.calls.set(call.operationId, entry);
    if (request.phase === 'authorize') {
      try {
        if (entry.started || signal.aborted || owner.closing) throw new Error('closed');
        const authorized = await waitForOwner(owner.lease.authorize(structuredClone(call), signal).then(() => true), signal, () => false);
        if (!authorized || signal.aborted || owner.closing) throw new Error('closed');
        entry.authorized = true;
        await this.#reply(request, { ok: true });
      } catch { await this.#reply(request, { ok: false, error: { code: 'mcp_authorization_failed' } }); }
      return;
    }
    if (!entry.authorized) {
      await this.#reply(request, { ok: true, completion: notDispatched('mcp_authorization_required') });
      return;
    }
    if (!entry.result) {
      entry.started = true;
      // Mark the identity before invoking the owner. Duplicate frames must never send two effects.
      entry.result = Promise.resolve().then(async () => {
        if (signal.aborted || owner.closing) return notDispatched('mcp_cancelled_before_dispatch');
        try {
          // Owner rechecks current authorization/revocation immediately before the actual MCP call.
          return await waitForOwner(owner.lease.execute(structuredClone(call), signal), signal, unknown);
        } catch { return unknown(); }
      });
    }
    await this.#reply(request, { ok: true, completion: await entry.result });
  }
}
