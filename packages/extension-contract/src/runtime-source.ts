import type { JsonObject } from './types.js';

/** An exact current catalog slot, not permission to execute or read arbitrary Host files. */
export interface VarinRuntimeSourceArtifact {
  extensionId: string;
  slot: 'selected' | 'candidate';
  artifactIntegrity: string;
}
export interface VarinRuntimeSourceRequest extends VarinRuntimeSourceArtifact {
  action: 'read';
  kind: 'source';
  path: string;
  /** Zero-based UTF-8 byte offset. Must be a code point boundary. */
  offset?: number;
  /** Page budget; completing its last code point may add at most three bytes. */
  maxBytes?: number;
}
export const VARIN_RUNTIME_SOURCE_FAILURES = {
  extension_missing: 'missing', candidate_missing: 'missing', source_missing: 'missing',
  catalog_stale: 'stale', artifact_changed: 'stale',
  artifact_unmaterialized: 'unavailable', artifact_unavailable: 'unavailable',
  offset_out_of_range: 'invalid_range', offset_not_utf8_boundary: 'invalid_range',
  source_not_utf8: 'invalid_encoding', artifact_corrupt: 'corrupt',
} as const;
export type VarinRuntimeSourceFailureCode = keyof typeof VARIN_RUNTIME_SOURCE_FAILURES;
export type VarinRuntimeSourceOutcome = {
  status: 'found'; fileIntegrity: string;
  page: { encoding: 'utf-8'; text: string; offset: number; byteLength: number; totalBytes: number; nextOffset: number | null };
} | { [Code in VarinRuntimeSourceFailureCode]: { status: typeof VARIN_RUNTIME_SOURCE_FAILURES[Code]; code: Code } }[VarinRuntimeSourceFailureCode];
export type VarinRuntimeSourceResult = VarinRuntimeSourceArtifact & {
  action: 'read'; kind: 'source'; origin: 'immutable_artifact'; permission: 'checked_on_invocation'; path: string;
} & VarinRuntimeSourceOutcome;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source query must be an object');
  return value as Record<string, unknown>;
}
const nonempty = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Source identifier must be nonempty');
  return value;
};
const PACKAGE_SOURCE_PATH = /^(?!\s*$)(?!\/)(?![a-zA-Z][a-zA-Z0-9+.-]*:)(?![\s\S]*[\\\0])(?![\s\S]*(?:^|\/)\.{1,2}(?:\/|$))(?![\s\S]*\/\/)(?![\s\S]*\/$)[\s\S]+$/;
const ARTIFACT_INTEGRITY = /^sha256-[a-f0-9]{64}$/;
export function parseVarinPackageSourcePath(value: unknown): string {
  const path = nonempty(value);
  if (!PACKAGE_SOURCE_PATH.test(path)) throw new Error('Contract source must be a package-relative path');
  return path;
}
function integrity(value: unknown): string {
  const parsed = nonempty(value);
  if (!ARTIFACT_INTEGRITY.test(parsed)) throw new Error('Source integrity must be a SHA-256 content address');
  return parsed;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Source byte position/budget must be an integer >= ${minimum}`);
  return Number(value);
}
const literal = <Value extends string>(expected: Value) => (value: unknown): Value => {
  if (value !== expected) throw new Error(`Source query requires ${expected}`);
  return expected;
};
interface Field { schema: JsonObject; parse: (value: unknown) => unknown; optional?: boolean }
/** One field declaration drives both the published tool schema and public/Host input decoder. */
const sourceFields = {
  action: { schema: { const: 'read' }, parse: literal('read') },
  kind: { schema: { const: 'source' }, parse: literal('source') },
  extensionId: { schema: { type: 'string', minLength: 1, pattern: '\\S' }, parse: nonempty },
  slot: { schema: { enum: ['selected', 'candidate'] }, parse: (value: unknown) => {
    if (value !== 'selected' && value !== 'candidate') throw new Error('Source slot must be selected or candidate');
    return value;
  } },
  artifactIntegrity: { schema: { type: 'string', pattern: ARTIFACT_INTEGRITY.source }, parse: integrity },
  path: { schema: { type: 'string', minLength: 1, pattern: PACKAGE_SOURCE_PATH.source }, parse: parseVarinPackageSourcePath },
  offset: { schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, parse: (value: unknown) => integer(value, 0), optional: true },
  maxBytes: { schema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, parse: (value: unknown) => integer(value, 1), optional: true },
} satisfies Record<keyof VarinRuntimeSourceRequest, Field>;
const declaredFields: Record<string, Field> = sourceFields;
export const VARIN_RUNTIME_SOURCE_REQUEST_SCHEMA: JsonObject = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(Object.entries(declaredFields).map(([key, field]) => [key, field.schema])),
  required: Object.entries(declaredFields).filter(([, field]) => !field.optional).map(([key]) => key),
};
export function parseVarinRuntimeSourceRequest(value: unknown): VarinRuntimeSourceRequest {
  const raw = record(value);
  if (Object.keys(raw).some(key => !Object.hasOwn(declaredFields, key))) throw new Error('Source query contains an unknown field');
  return Object.fromEntries(Object.entries(declaredFields).flatMap(([key, field]) =>
    field.optional && raw[key] === undefined ? [] : [[key, field.parse(raw[key])]])) as unknown as VarinRuntimeSourceRequest;
}
export function parseVarinRuntimeSourceArtifact(value: unknown): VarinRuntimeSourceArtifact {
  const raw = record(value);
  return { extensionId: sourceFields.extensionId.parse(raw.extensionId), slot: sourceFields.slot.parse(raw.slot),
    artifactIntegrity: integrity(raw.artifactIntegrity) };
}
export function parseVarinRuntimeSourceResult(value: unknown): VarinRuntimeSourceResult {
  const raw = record(value);
  const artifact = parseVarinRuntimeSourceArtifact(raw);
  literal('read')(raw.action); literal('source')(raw.kind); literal('immutable_artifact')(raw.origin);
  literal('checked_on_invocation')(raw.permission);
  const basis = { ...artifact, action: 'read' as const, kind: 'source' as const, origin: 'immutable_artifact' as const,
    permission: 'checked_on_invocation' as const, path: parseVarinPackageSourcePath(raw.path) };
  if (raw.status !== 'found') {
    if (typeof raw.code !== 'string' || !Object.hasOwn(VARIN_RUNTIME_SOURCE_FAILURES, raw.code)
      || VARIN_RUNTIME_SOURCE_FAILURES[raw.code as VarinRuntimeSourceFailureCode] !== raw.status) throw new Error('Invalid source failure');
    const code = raw.code as VarinRuntimeSourceFailureCode;
    return { ...basis, status: VARIN_RUNTIME_SOURCE_FAILURES[code], code } as VarinRuntimeSourceResult;
  }
  const page = record(raw.page);
  literal('utf-8')(page.encoding);
  const offset = integer(page.offset, 0), byteLength = integer(page.byteLength, 0), totalBytes = integer(page.totalBytes, 0);
  const nextOffset = page.nextOffset === null ? null : integer(page.nextOffset, 0);
  if (typeof page.text !== 'string' || new TextEncoder().encode(page.text).length !== byteLength
    || offset + byteLength > totalBytes || !Number.isSafeInteger(offset + byteLength)
    || (nextOffset === null ? offset + byteLength !== totalBytes : nextOffset !== offset + byteLength || byteLength === 0 || nextOffset >= totalBytes)) {
    throw new Error('Invalid source page');
  }
  return { ...basis, status: 'found', fileIntegrity: integrity(raw.fileIntegrity),
    page: { encoding: 'utf-8', text: page.text, offset, byteLength, totalBytes, nextOffset } };
}
