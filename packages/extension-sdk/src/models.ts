import {
  VARIN_MODELS_SERVICE, VARIN_MODEL_AUTHENTICATION_CAPABILITY, parseVarinModelsDescription, parseVarinModelAuthenticationCall,
  parseVarinModelAuthenticationResult, parseVarinToolJson,
  type JsonValue, type VarinModelsDescription, type ModelProtocolCall, type ModelProtocolResult,
  type VarinModelAuthenticationCall, type VarinModelAuthenticationResult,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';
export interface VarinModelAuthenticationClient {
  /** One POST to an exact endpoint declared by this provider. No redirect or automatic retry. */
  request(url: string, body: Record<string, string>, encoding?: 'form' | 'json'): Promise<JsonValue>;
}
export interface VarinModelsImplementation {
  description: VarinModelsDescription;
  /** Pure encoding/decoding. No HTTP, credentials, alternate requests or retry loops here.
   * Parse state belongs to this original request; completion must wait for trailing usage. */
  protocol?(adapter: string, call: Readonly<ModelProtocolCall>, signal: AbortSignal): ModelProtocolResult | Promise<ModelProtocolResult>;
  /** Requires reviewed varin.models.authentication. Tokens remain in the original Host store.
   * begin/complete use the existing workbench interaction; refresh preserves account identity. */
  authenticate?(call: Readonly<VarinModelAuthenticationCall>, signal: AbortSignal, client: VarinModelAuthenticationClient): VarinModelAuthenticationResult | Promise<VarinModelAuthenticationResult>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function provideModels(context: VarinBrokeredHostContext, implementation: VarinModelsImplementation): void {
  const description = freeze(parseVarinModelsDescription(implementation.description));
  if (description.adapters.length && !implementation.protocol) throw new Error('Model adapters require a protocol implementation');
  if (description.authentication.length && !implementation.authenticate) throw new Error('Model authentication requires an implementation');
  context.services.provide(structuredClone(VARIN_MODELS_SERVICE), {
    describe: args => {
      if (args.length) throw new Error('Model contribution description takes no arguments');
      return structuredClone(description) as unknown as JsonValue;
    },
    protocol: async (args, call) => {
      if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) throw new Error('Invalid model protocol request');
      const envelope = args[0] as { adapter?: JsonValue; call?: JsonValue };
      if (Object.keys(envelope).some(key => key !== 'adapter' && key !== 'call') || typeof envelope.adapter !== 'string'
        || !description.adapters.some(adapter => adapter.id === envelope.adapter) || !implementation.protocol) throw new Error('Model protocol implementation is unavailable');
      const input = parseVarinToolJson(envelope.call) as unknown as ModelProtocolCall;
      if (!input || typeof input !== 'object' || !['serialize', 'parse'].includes(input.kind)) throw new Error('Invalid model protocol call');
      call.signal.throwIfAborted();
      // Do not race this callback with abort. Broker cancellation retains the original invocation
      // until the callback actually settles; Rust owns its operation and physical transport.
      const result = await implementation.protocol(envelope.adapter, freeze(input), call.signal);
      if (!result || (input.kind === 'serialize' ? result.kind !== 'body' : result.kind !== 'parsed')) throw new Error('Invalid model protocol result');
      return parseVarinToolJson(result);
    },
    authenticate: async (args, call) => {
      if (args.length !== 1 || !implementation.authenticate) throw new Error('Model authentication implementation is unavailable');
      const input = freeze(parseVarinModelAuthenticationCall(args[0]));
      if (!description.authentication.some(provider => provider.id === input.provider)) throw new Error('Unknown model authentication provider');
      call.signal.throwIfAborted();
      const result = parseVarinModelAuthenticationResult(await implementation.authenticate(input, call.signal, { request: (url, body, encoding = 'form') => call.capabilities.call(VARIN_MODEL_AUTHENTICATION_CAPABILITY, 'request', { provider: input.provider, url, body, encoding }) }));
      if (result.kind === 'token' && result.token.provider !== input.provider) throw new Error('Model authentication returned a different provider');
      return result as unknown as JsonValue;
    },
  });
}
