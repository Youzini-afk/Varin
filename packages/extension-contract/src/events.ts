/** Durable inbound events. UI notifications without this declaration remain ephemeral. */
import type { JsonObject, JsonValue } from './types.js';
import type { IncomingMedia, OutputBody } from './nested-tools.generated.js';
import { parseVarinToolJson } from './tools.js';
import { parseIncomingOutputPart } from './output.js';

export const VARIN_EVENTS_CAPABILITY = 'varin.events';
export interface VarinDurableEventSource {
  /** Stable within this extension, independent of its implementation service generation. */
  sourceId: string;
  displayName: string;
  connectionsMethod: string;
  receiveMethod: string;
  modes: Array<'push' | 'stream' | 'poll'>;
  recovery: 'history' | 'realtime';
  /** Required sources use the original Host credential account identity. */
  credentials: 'required' | 'none';
  filterSchema: JsonObject | boolean;
}
export interface VarinEventSourceHost {
  hostId: string;
  /** Saved transport connection on the receiving Host, not a plugin account connection. */
  connectionId: string;
  endpointIdentity: string;
}
export interface VarinEventSourceDescriptor {
  host?: VarinEventSourceHost;
  extensionId: string;
  sourceId: string;
  displayName: string;
  description?: string;
  filterSchema: JsonObject | boolean;
  modes: VarinDurableEventSource['modes'];
  recovery: VarinDurableEventSource['recovery'];
  credentials: VarinDurableEventSource['credentials'];
  available: boolean;
  code?: string;
  connections: Array<{ connectionId: string; accountId: string | null; displayName: string; available: boolean; code?: string }>;
}
export interface VarinEventConnection {
  connectionId: string;
  displayName: string;
  /** Nonsecret stable configuration identity for sources without Host credentials. */
  accountId?: string;
}
export interface VarinEventSourceIdentity {
  host?: VarinEventSourceHost;
  extensionId: string;
  sourceId: string;
  connectionId: string;
  accountId: string;
}
export interface VarinEventReceiveRequest {
  sourceId: string;
  connectionId: string;
  accountId: string;
  cursor: string | null;
}
/** Original arbitrary file bytes. References and target permissions are assigned by Catalog. */
export interface VarinEventFile {
  fileId: string;
  filename: string;
  mimeType: string;
  bytesBase64: string;
}
export interface VarinIncomingEvent {
  eventId: string;
  objectId?: string;
  senderId?: string;
  revision?: string;
  /** Actual UTC occurrence time of this event/revision, never sync or receipt time.
   * Backfill preserves it; adapters must disclose unknown provider timestamps instead of inventing now. */
  occurredAtMs: number;
  attributes: JsonObject;
  content: OutputBody<IncomingMedia>;
  files?: VarinEventFile[];
  echoOf?: { ownerHostId?: string; followupId: string; occurrenceId: string; operationId?: string };
  /** Opt-in complete state snapshot. Scope is source/account + object + sender + key.
   * sequence is the source's ordered safe integer (also on backfill), value names the
   * current state. Ordinary messages and independent facts must omit this field. */
  state?: { key: string; sequence: number; value: string };
}
export interface VarinEventCoverage { kind: 'complete' | 'from'; fromMs?: number }
export interface VarinEventBatch {
  expectedCursor: string | null;
  nextCursor: string | null;
  coverage?: VarinEventCoverage;
  events: VarinIncomingEvent[];
}
/** Resolves only after the original Catalog has committed the batch and its cursor. */
export interface VarinEventReceipt { cursor: string | null; accepted: number; duplicates: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0');
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key));
export function parseVarinDurableEventSource(value: unknown): VarinDurableEventSource {
  if (!object(value) || !fields(value, ['sourceId', 'displayName', 'connectionsMethod', 'receiveMethod', 'modes', 'recovery', 'credentials', 'filterSchema'])
    || !['sourceId', 'displayName', 'connectionsMethod', 'receiveMethod'].every(key => text(value[key]))
    || !Array.isArray(value.modes) || !value.modes.length || new Set(value.modes).size !== value.modes.length
    || !value.modes.every(mode => ['push', 'stream', 'poll'].includes(mode))
    || !['history', 'realtime'].includes(String(value.recovery)) || !['required', 'none'].includes(String(value.credentials))
    || typeof value.filterSchema !== 'boolean' && !object(value.filterSchema)) throw new Error('Invalid durable event source');
  return parseVarinToolJson(value) as unknown as VarinDurableEventSource;
}
export function parseVarinEventConnections(value: unknown): VarinEventConnection[] {
  if (!Array.isArray(value)) throw new Error('Invalid event connections');
  const ids = new Set<string>();
  for (const connection of value) {
    if (!object(connection) || !fields(connection, ['connectionId', 'displayName', 'accountId'])
      || !text(connection.connectionId) || !text(connection.displayName)
      || connection.accountId !== undefined && !text(connection.accountId) || ids.has(connection.connectionId)) throw new Error('Invalid event connection');
    ids.add(connection.connectionId);
  }
  return value as VarinEventConnection[];
}
export function parseVarinEventBatch(raw: unknown): VarinEventBatch {
  const value = parseVarinToolJson(raw);
  if (!object(value) || !fields(value, ['expectedCursor', 'nextCursor', 'events', 'coverage'])
    || value.expectedCursor !== null && typeof value.expectedCursor !== 'string'
    || value.nextCursor !== null && typeof value.nextCursor !== 'string' || !Array.isArray(value.events)) throw new Error('Invalid event batch');
  if (value.coverage !== undefined && (!object(value.coverage) || !fields(value.coverage, ['kind', 'fromMs'])
    || !['complete', 'from'].includes(String(value.coverage.kind))
    || value.coverage.kind === 'from' && (!Number.isSafeInteger(value.coverage.fromMs) || Number(value.coverage.fromMs) < 0)
    || value.coverage.kind === 'complete' && value.coverage.fromMs !== undefined)) throw new Error('Invalid event coverage');
  for (const event of value.events) {
    if (!object(event) || !fields(event, ['eventId', 'objectId', 'senderId', 'revision', 'occurredAtMs', 'attributes', 'content', 'files', 'echoOf', 'state'])
      || !text(event.eventId) || event.senderId !== undefined && !text(event.senderId) || event.objectId !== undefined && !text(event.objectId) || event.revision !== undefined && !text(event.revision)
      || !Number.isSafeInteger(event.occurredAtMs) || Number(event.occurredAtMs) < 0 || !object(event.attributes)
      || !object(event.content) || !fields(event.content, ['data', 'parts']) || !Object.hasOwn(event.content, 'data')
      || !Array.isArray(event.content.parts)) throw new Error('Invalid inbound event');
    if (event.content.parts.some(part => object(part) && part.kind === 'attachment')) throw new Error('Inbound events require inline content bytes, not unscoped attachment references');
    event.content.parts = event.content.parts.map(parseIncomingOutputPart) as unknown as JsonValue[];
    if (event.state !== undefined && (!object(event.state) || !fields(event.state, ['key', 'sequence', 'value'])
      || !text(event.state.key) || !text(event.state.value)
      || !Number.isSafeInteger(event.state.sequence) || Number(event.state.sequence) < 0)) throw new Error('Invalid event state snapshot');
    if (event.files !== undefined) {
      if (!Array.isArray(event.files)) throw new Error('Invalid event files');
      const ids = new Set<string>();
      for (const file of event.files) {
        if (!object(file) || !fields(file, ['fileId', 'filename', 'mimeType', 'bytesBase64']) || !text(file.fileId)
          || ids.has(file.fileId) || !text(file.filename) || ['.', '..'].includes(file.filename)
          || (/[\\/]/.test(file.filename) || [...file.filename].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) || typeof file.mimeType !== 'string'
          || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.mimeType)
          || typeof file.bytesBase64 !== 'string') throw new Error('Invalid event file');
        try { if (btoa(atob(file.bytesBase64)) !== file.bytesBase64) throw new Error(); }
        catch { throw new Error('Event file bytes must be canonical base64'); }
        ids.add(file.fileId);
      }
    }
    if (event.echoOf !== undefined && (!object(event.echoOf) || !fields(event.echoOf, ['ownerHostId', 'followupId', 'occurrenceId', 'operationId'])
      || event.echoOf.ownerHostId !== undefined && !text(event.echoOf.ownerHostId)
      || !text(event.echoOf.followupId) || !text(event.echoOf.occurrenceId)
      || event.echoOf.operationId !== undefined && !text(event.echoOf.operationId))) throw new Error('Invalid event echo reference');
  }
  return value as unknown as VarinEventBatch;
}
