import { VARIN_EVENTS_CAPABILITY, parseVarinEventBatch, type JsonValue, type VarinEventBatch,
  type VarinEventReceipt } from '@varin/extension-contract';
import type { VarinHostCapabilityClient } from './index.js';
export type { VarinDurableEventSource, VarinEventConnection, VarinEventReceiveRequest,
  VarinIncomingEvent, VarinEventFile, VarinEventBatch, VarinEventReceipt } from '@varin/extension-contract';
export { VARIN_EVENTS_CAPABILITY };
/** Use only the capabilities of the Host-invoked receive method. Never activation-time clients.
 * The plugin owns network cancellation and retries. Await submit before acknowledging remote push
 * or advancing its local cursor. A rejected/unknown result leaves the same batch eligible for retry. */
export function eventReceiver(client: VarinHostCapabilityClient) {
  return {
    assertActive: async (): Promise<void> => { await client.call(VARIN_EVENTS_CAPABILITY, 'assertReceiver', {}); },
    submit: (batch: VarinEventBatch): Promise<VarinEventReceipt> => client.call(VARIN_EVENTS_CAPABILITY,
      'submit', parseVarinEventBatch(batch) as unknown as JsonValue) as unknown as Promise<VarinEventReceipt>,
  };
}
