import { FRONTEND_CREDENTIAL_KEYS } from '@varin/application-client/desktop';
import { createLegacyMigrationReader, writeLegacyMigrationRecord, LEGACY_MIGRATION_PROTOCOL as protocol } from '@varin/web/server/lib/platform/legacy-migration-protocol.js';
export type LegacyCredential = { kind: 'credential'; slot: string; value: string } | { kind:'credential';slot:string;sourceStatus:'unavailable' }
export function legacyCredentials(entries: readonly (readonly [string, string])[]): LegacyCredential[] {
  const source = new Map(entries), result: LegacyCredential[] = [];
  for (const key of FRONTEND_CREDENTIAL_KEYS) {
    const value = source.get(key); if (value) result.push({ kind: 'credential', slot: key, value });
  }
  const serialized = source.get('config-store');
  if (serialized) {
    let state: Record<string, unknown> | undefined;
    try { state = JSON.parse(serialized)?.state; if(!state||typeof state!=='object'||Array.isArray(state)) throw new Error(); } catch { for(const key of FRONTEND_CREDENTIAL_KEYS) result.push({kind:'credential',slot:`config-store.state.${key}`,sourceStatus:'unavailable'}); return result; }
    if (state && typeof state === 'object') for (const key of FRONTEND_CREDENTIAL_KEYS) {
      const value = state[key];
      if (typeof value === 'string' && value) result.push({ kind: 'credential', slot: `config-store.state.${key}`, value });
      else if (value !== undefined && value !== null && value !== '') result.push({kind:'credential',slot:`config-store.state.${key}`,sourceStatus:'unavailable'});
    }
  }
  return result;
}
/** No data is sent before the private parent handshake; every write obeys pipe
 * backpressure. Failures never contain credential material. */
export async function openLegacyPrivateChannel(input: AsyncIterable<Uint8Array>, write: (bytes: Uint8Array) => Promise<void>) {
  const read = createLegacyMigrationReader(input), hello = await read();
  if (hello.protocol !== protocol || hello.version !== 1 || hello.kind !== 'begin' || typeof hello.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(hello.nonce)) throw new Error('Legacy migration parent handshake is invalid');
  const nonce = hello.nonce;
  return { nonce, lease: hello.lease, read, send: (value: Record<string, unknown>) => writeLegacyMigrationRecord(write, { ...value, protocol, version: 1, nonce }) };
}
export async function exportLegacyPrivateState(options: {
  channel: Awaited<ReturnType<typeof openLegacyPrivateChannel>>;
  sourceVersion: string; credentials: LegacyCredential[];
  uiReceipt: unknown;
}): Promise<void> {
  const {read,send,nonce}=options.channel;
  await send({ kind: 'ready', browserStatus: 'not-migrated', sourceVersion: options.sourceVersion,
    credentialCount: options.credentials.length, uiReceipt: options.uiReceipt });
  let sequence = 0;
  const item = async (value: Record<string, unknown>) => {
    await send({ ...value, sequence: ++sequence });
    const ack = await read();
    if (ack.protocol !== protocol || ack.version !== 1 || ack.nonce !== nonce || ack.kind !== 'ack' || ack.sequence !== sequence || !['imported', 'retained', 'failed'].includes(String(ack.status))) throw new Error('Legacy migration acknowledgement is invalid');
  };
  for (const credential of options.credentials) await item({ ...credential });
  await send({ kind: 'done', records: sequence });
  const complete = await read();
  if (complete.protocol !== protocol || complete.version !== 1 || complete.nonce !== nonce || complete.kind !== 'complete' || complete.records !== sequence) throw new Error('Legacy migration final acknowledgement is invalid');
}
