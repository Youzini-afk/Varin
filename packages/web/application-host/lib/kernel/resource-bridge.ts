import { waitWithSignal } from '../cancellation.js';
import type { AgentResourceRequest, ToolOrigin } from './protocol.generated.js';
import { resourceQueryFailure, type ResourceQuery, type ResourceOwner, type ResourceToolResult } from './resource-owner.js';

export interface PrivateResourceResponse { v: 1; kind: 'resource-response'; id: string; kernelEpoch: string; result: ResourceToolResult }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const validOrigin = (value: unknown): value is ToolOrigin => record(value) && (
  value.kind === 'model_step' && text(value.request_id) && keys(value, ['kind', 'request_id'])
  || value.kind === 'policy_action' && text(value.action_id) && text(value.node_id) && keys(value, ['kind', 'action_id', 'node_id']));
const validRequest = (value: unknown): value is AgentResourceRequest => record(value) && (
  value.kind === 'skill' && text(value.resourceId) && keys(value, ['kind', 'resourceId'])
  || value.kind === 'skill-resource' && text(value.resourceId) && typeof value.relativePath === 'string' && keys(value, ['kind', 'resourceId', 'relativePath'])
  || value.kind === 'instruction-scope' && typeof value.targetPath === 'string'
    && (value.targetType === undefined || value.targetType === 'file' || value.targetType === 'directory')
    && keys(value, ['kind', 'targetPath', 'targetType']));
const validQuery = (value: unknown): value is ResourceQuery => record(value) && text(value.runId) && validOrigin(value.origin)
  && text(value.callId) && text(value.resourceCheckpointId) && validRequest(value.request)
  && keys(value, ['runId', 'origin', 'callId', 'resourceCheckpointId', 'request']);

/** The private kernel channel owns call/epoch identity. A model never selects source or snapshot. */
export class ResourceBridge {
  private owner?: ResourceOwner;
  private readonly active = new Map<string, { epoch: string; controller: AbortController }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateResourceResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: ResourceOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Resource owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Resource channel closed', 'AbortError'));
    this.active.clear();
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['resource-request', 'resource-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'resource-cancel') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Resource query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(id)) return true;
    const controller = new AbortController();
    const entry = { epoch, controller };
    this.active.set(id, entry);
    const query = value.query; const owner = this.owner;
    void (async () => {
      let result: ResourceToolResult;
      try {
        result = !validQuery(query) ? resourceQueryFailure('invalid', 'Invalid resource query')
          : !owner ? resourceQueryFailure('unavailable', 'Resource owner is unavailable', query)
            : await waitWithSignal(owner(query, controller.signal), controller.signal);
      } catch {
        result = resourceQueryFailure(controller.signal.aborted ? 'cancelled' : 'unavailable',
          controller.signal.aborted ? 'Resource query was cancelled' : 'Resource owner could not read the bound view');
      }
      if (this.active.get(id) !== entry) return;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'resource-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
