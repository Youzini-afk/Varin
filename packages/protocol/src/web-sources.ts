import type { SearchContentKind, SearchResultItem } from './harness.js';
import type { WebSnapshotRef } from './harness-web.js';

/** An observed search response is not evidence that the original page was read. */
export interface WebSourceProvenance {
  kind: 'search-result';
  /** Original tool operation, never authority by itself. */
  operationId?: string;
  providerId: string;
  connectionId?: string;
  query?: string;
  objective?: string;
  contentKind: SearchContentKind;
  summaryKind?: SearchResultItem['summaryKind'];
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  observations?: SearchResultItem['provenance'];
}

export interface WebSourceCitation {
  snapshotId: string;
  /** Revision of the retained text, not a URL version or permission token. */
  contentHash?: string;
  startLine?: number;
  endLine?: number;
}
export interface WebSourceReference {
  snapshot: WebSnapshotRef;
  citation: string;
  /** Select this in typed message/dispatch attachments to deliver the source. */
  attachmentRef: string;
  /** Whether the original tool result acquired the typed handoff descriptor. */
  deliveryStatus?: 'ready' | 'unavailable';
}
const validId = (value: string) => Boolean(value) && !/[\s/?#\\]/u.test(value) && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const positive = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value > 0;

/** Stable identity only. Reading and forwarding still require the material owner. */
export function materialAttachmentRef(snapshotId: string): string {
  if (!validId(snapshotId)) throw new Error('Invalid material snapshot identity');
  return `attachment:material_${Array.from(new TextEncoder().encode(snapshotId), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function formatWebSourceCitation(citation: WebSourceCitation): string {
  if (!validId(citation.snapshotId)) throw new Error('Invalid material snapshot identity');
  const query = new URLSearchParams();
  if (citation.contentHash) query.set('contentHash', citation.contentHash);
  if (citation.startLine !== undefined) {
    if (!positive(citation.startLine) || citation.endLine !== undefined && (!positive(citation.endLine) || citation.endLine < citation.startLine)) throw new Error('Invalid material citation range');
    query.set('startLine', String(citation.startLine));
    if (citation.endLine !== undefined) query.set('endLine', String(citation.endLine));
  } else if (citation.endLine !== undefined) throw new Error('A citation end line requires its start line');
  return `varin-material://${encodeURIComponent(citation.snapshotId)}${query.size ? `?${query}` : ''}`;
}

export function parseWebSourceCitation(value: string): WebSourceCitation | null {
  if (!value.startsWith('varin-material://')) return null;
  const raw = value.slice('varin-material://'.length), delimiter = raw.indexOf('?');
  let snapshotId: string;
  try { snapshotId = decodeURIComponent(delimiter < 0 ? raw : raw.slice(0, delimiter)); } catch { return null; }
  if (!validId(snapshotId) || value.includes('#')) return null;
  const params = new URLSearchParams(delimiter < 0 ? '' : raw.slice(delimiter + 1));
  if (['page', 'format', 'x', 'y', 'width', 'height'].some(key => params.has(key))) return null;
  const keys = ['contentHash', 'startLine', 'endLine'];
  if ([...params.keys()].some(key => !keys.includes(key) || params.getAll(key).length !== 1)) return null;
  const startLine = params.has('startLine') ? Number(params.get('startLine')) : undefined;
  const endLine = params.has('endLine') ? Number(params.get('endLine')) : undefined;
  if (startLine !== undefined && !positive(startLine) || endLine !== undefined && (!positive(endLine) || startLine === undefined || endLine < startLine)) return null;
  const contentHash = params.get('contentHash');
  if (contentHash !== null && !/^sha256-[0-9a-f]{64}$/u.test(contentHash)) return null;
  return { snapshotId, ...(contentHash ? { contentHash } : {}), ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) };
}
