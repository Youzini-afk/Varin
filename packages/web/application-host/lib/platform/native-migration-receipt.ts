import { FRONTEND_CREDENTIAL_KEYS } from '@varin/application-client/desktop';
const statuses = new Set(['imported', 'retained', 'failed']);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const slots = new Set(FRONTEND_CREDENTIAL_KEYS.flatMap(key => [key, `config-store.state.${key}`]));
/** The settings owner persists only application-credential outcomes. Browser
 * cookies, sessions and site storage are intentionally outside this handoff. */
export function nativeMigrationReceipt(input: unknown): Record<string, unknown> {
  const value = object(input);
  if (!value || value.schema !== 1 || value.protocol !== 1 || value.attemptComplete !== true
    || typeof value.sourceSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(value.sourceSha)
    || typeof value.sourceVersion !== 'string' || !value.sourceVersion
    || !Array.isArray(value.credentials) || value.sourceRetained !== true
    || value.browserStatus !== 'not-migrated' || value.browserRequiresLogin !== true
    || value.cookies !== undefined || value.origins !== undefined || value.browserStorage !== undefined)
    throw new Error('Native application migration receipt is invalid');
  const credentials = value.credentials.map(raw => {
    const item = object(raw);
    if (!item || typeof item.slot !== 'string' || !slots.has(item.slot) || !statuses.has(String(item.status))) throw new Error('Native credential receipt is invalid');
    return { slot: item.slot, status: item.status };
  });
  if (new Set(credentials.map(item => item.slot)).size !== credentials.length) throw new Error('Native credential receipt is duplicated');
  const companionFailures = Array.isArray(value.companionFailures) ? value.companionFailures.map(raw => {
    const item = object(raw);
    if (!item || typeof item.id !== 'string' || !['source-validation', 'destination-conflict', 'asset-integrity', 'publication-unavailable', 'source-cache-unavailable'].includes(String(item.reason))) throw new Error('Companion recovery receipt is invalid');
    return { id: item.id, reason: item.reason };
  }) : [];
  return { schema: 1, protocol: 1, sourceSha: value.sourceSha, sourceVersion: value.sourceVersion,
    attemptComplete: true, credentials, credentialsComplete: credentials.every(item => item.status === 'imported' || item.status === 'retained'),
    companionFailures, browserStatus: 'not-migrated', browserRequiresLogin: true, sourceRetained: true };
}
