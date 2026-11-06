/** Host-only credentials. Never forward resolved values to a surface or model context. */
import type { JsonValue } from './types.js';
export const VARIN_CREDENTIALS_CAPABILITY = 'varin.credentials';
export interface VarinCredentialAdapter { serviceId: string; version: number; provider: string }
export type VarinCredentialValue = { kind: 'api-key'; key: string } | {
  kind: 'oauth'; provider: string; accessToken: string; refreshToken?: string; expiresAt?: number; accountId?: string;
};
export type VarinCredentialAuthenticationCall =
  | { kind: 'begin'; provider: string; connectionId: string }
  | { kind: 'complete'; provider: string; connectionId: string; state: JsonValue; redirect: string }
  | { kind: 'refresh'; provider: string; connectionId: string; token: Extract<VarinCredentialValue, { kind: 'oauth' }> };
export type VarinCredentialAuthenticationResult =
  | { kind: 'pending'; authorizationUrl: string; state: JsonValue; deviceCode?: string }
  | { kind: 'token'; token: Extract<VarinCredentialValue, { kind: 'oauth' }> };
export interface VarinCredentialMetadata { connected: boolean; account?: string; generation?: number; kind?: VarinCredentialValue['kind']; accountId?: string }
export interface VarinCredentialAuthorizationState { id: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'; authorizationUrl?: string; deviceCode?: string; message?: string }
export function parseVarinCredentialAuthenticationResult(raw: unknown): VarinCredentialAuthenticationResult {
  const value = raw as VarinCredentialAuthenticationResult;
  if (!value || typeof value !== 'object') throw new Error('Invalid credential authentication result');
  if (value.kind === 'pending') {
    const url = new URL(value.authorizationUrl);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password || value.state === undefined
      || value.deviceCode !== undefined && typeof value.deviceCode !== 'string') throw new Error('Invalid credential authorization URL');
  } else if (value.kind !== 'token' || !value.token || value.token.kind !== 'oauth' || typeof value.token.provider !== 'string'
    || !value.token.provider || typeof value.token.accessToken !== 'string' || !value.token.accessToken
    || value.token.refreshToken !== undefined && typeof value.token.refreshToken !== 'string'
    || value.token.accountId !== undefined && typeof value.token.accountId !== 'string'
    || value.token.expiresAt !== undefined && !Number.isFinite(value.token.expiresAt)) throw new Error('Invalid credential token');
  return value;
}
