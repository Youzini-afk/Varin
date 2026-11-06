import { VARIN_CREDENTIALS_CAPABILITY, type JsonValue, type VarinCredentialAdapter, type VarinCredentialValue,
  type VarinCredentialMetadata, type VarinCredentialAuthorizationState } from '@varin/extension-contract';
import type { VarinHostCapabilityClient } from './index.js';
/** Use the current Host service invocation's capabilities, not activation-time capabilities. */
export function credentials(client: VarinHostCapabilityClient, connectionId: string, expectedAccount?: string) {
  const call = <T>(method: string, fields: Record<string, JsonValue> = {}) =>
    client.call(VARIN_CREDENTIALS_CAPABILITY, method, { connectionId, ...(expectedAccount === undefined ? {} : { expectedAccount }), ...fields }) as Promise<T>;
  return {
    put: (key: string) => call<VarinCredentialMetadata>('put', { key }),
    inspect: () => call<VarinCredentialMetadata>('inspect'),
    resolve: (adapter?: VarinCredentialAdapter) => call<VarinCredentialValue>('resolve', adapter ? { adapter: adapter as unknown as JsonValue } : {}),
    remove: () => call<VarinCredentialMetadata>('remove'),
    start: (adapter: VarinCredentialAdapter) => call<VarinCredentialAuthorizationState>('start', { adapter: adapter as unknown as JsonValue }),
    read: (id: string) => call<VarinCredentialAuthorizationState>('read', { id }),
    reply: (id: string, redirect: string) => call<VarinCredentialAuthorizationState>('reply', { id, redirect }),
    cancel: (id: string) => call<VarinCredentialAuthorizationState>('cancel', { id }),
  };
}
