import { defineHostExtension, provideModels, type VarinModelsImplementation } from '@varin/extension-sdk';
import type { ModelProtocolCall, ModelProtocolResult, ProviderEvent } from '@varin/extension-contract';
const family = 'example-text-sse';
/** Example protocol, deliberately distinct from an OpenAI wire shape. The target service implements
 * POST /respond with {engine, turns:[{source,text,continuation}], outputLimit} and SSE below. */
export const implementation: VarinModelsImplementation = {
  description: {
    channels: [{ id: 'example.text-service', name: 'Example text SSE service', protocol: family,
      authentication: ['none', 'credential', 'environment'], credentialHeader: { name: 'x-example-key', prefix: '' },
      operations: ['chat'], parametersSchema: { type: 'object', additionalProperties: false },
      adapter: { id: 'example.text-codec', version: '1', endpointPath: '/respond' },
      catalog: [{ id: 'text-engine', name: 'Example text engine', enabled: true, operations: ['chat'], input: ['text'] }] }],
    adapters: [{ id: 'example.text-codec', version: '1', protocolFamily: family, headers: { 'x-example-protocol': '1' } }],
    authentication: [],
  },
  protocol: (_adapter, call, signal) => { signal.throwIfAborted(); return protocol(call); },
};
export function protocol(call: Readonly<ModelProtocolCall>): ModelProtocolResult {
  if (call.kind === 'serialize') {
    if (call.request.binding.tools.length) throw new Error('The example text protocol does not support tool calling');
    const turns = call.request.history.map(item => {
      if (item.content.kind !== 'text') throw new Error('The example text protocol supports text history only');
      return { source: item.provenance, text: item.content.text, continuation: item.opaque?.value ?? null };
    });
    return { kind: 'body', body: { engine: call.configuration.model, turns, outputLimit: call.configuration.maxOutputTokens } };
  }
  if (call.frame === null) return { kind: 'parsed', events: [], state: call.state, finish: null };
  const frame: unknown = JSON.parse(call.frame);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid example protocol frame');
  const event = frame as Record<string, unknown>;
  const state = call.state === null ? '' : call.state;
  if (typeof state !== 'string') throw new Error('Invalid example protocol state');
  if (event.kind === 'delta' && typeof event.text === 'string') return { kind: 'parsed',
    events: [{ kind: 'text_delta', item_id: 'answer', text: event.text }], state: state + event.text, finish: null };
  if (event.kind !== 'complete' || typeof event.text !== 'string' || event.text !== state
    || typeof event.continuation !== 'string') throw new Error('Invalid example protocol completion');
  const count = (value: unknown): number | null => {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid example protocol usage');
    return Number(value);
  };
  const events: ProviderEvent[] = [{ kind: 'item_completed', item: { id: 'answer', content: { kind: 'text', text: event.text },
    opaque: { connection_identity: call.connection_identity, family, adapter_version: '1', value: { continuation: event.continuation } } } },
  { kind: 'usage', receipt: { measurement: event.inputTokens === undefined && event.outputTokens === undefined ? 'missing' : 'actual',
    input_tokens: count(event.inputTokens), output_tokens: count(event.outputTokens), cached_input_tokens: null,
    cache_write_tokens: null, reasoning_tokens: null, raw: event.usage ?? null, pricing_version: null } }];
  return { kind: 'parsed', events, state: null, finish: 'stop' };
}
export default defineHostExtension(context => provideModels(context, implementation));
