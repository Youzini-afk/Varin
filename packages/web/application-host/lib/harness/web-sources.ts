/** Search observations share the original immutable material owner, not a search side store. */
import { formatWebSourceCitation, materialAttachmentRef, type ScholarlyPaper, type SearchResultItem, type WebSourceProvenance, type WebSourceReference } from '@varin/protocol';
import type { WebMaterialStore, ThreadMaterialAuthority } from './web-materials.js';

export async function captureSearchSource(materials: WebMaterialStore, hit: SearchResultItem, authority: ThreadMaterialAuthority,
  provenance: Omit<WebSourceProvenance, 'kind' | 'contentKind'>, signal?: AbortSignal): Promise<WebSourceReference> {
  signal?.throwIfAborted();
  const url = new URL(hit.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Search sources require an ordinary HTTP(S) URL');
  const metadata: WebSourceProvenance = { ...provenance, kind: 'search-result', contentKind: hit.contentKind ?? 'unknown',
    ...(hit.author ? { author: hit.author } : {}), ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
    ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}), ...(hit.summaryKind ? { summaryKind: hit.summaryKind } : {}), ...(hit.provenance ? { observations: hit.provenance } : {}) };
  const excerpts = hit.excerpts?.filter(text => text.trim());
  const observed = excerpts?.length ? excerpts : [hit.snippet];
  const body = [...observed, ...(hit.summary && !observed.includes(hit.summary) ? [`Summary (${hit.summaryKind ?? 'unknown origin'}):\n${hit.summary}`] : [])]
    .filter(Boolean).join('\n\n');
  const snapshot = await materials.put(authority.owningWorkspaceId, { sourceUrl: hit.url, finalUrl: hit.url, title: hit.title,
    ...(hit.provenance?.[0] ? { fetchedAt: hit.provenance[0].retrievedAt } : {}),
    contentType: 'text/plain', representation: 'search-observation-v1', provenance: metadata }, Buffer.from(body), authority,
  provenance.operationId ? { observationId: provenance.operationId } : {});
  signal?.throwIfAborted();
  return { snapshot, citation: formatWebSourceCitation({ snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash }),
    attachmentRef: materialAttachmentRef(snapshot.snapshotId) };
}

/** Preserve the actual metadata record, including missing full-text access, as
 * a source observation. Do not turn its abstract into a read of the linked PDF. */
export async function captureScholarlySource(materials: WebMaterialStore, paper: ScholarlyPaper,
  authority: ThreadMaterialAuthority, operationId: string, signal?: AbortSignal): Promise<WebSourceReference> {
  const url = paper.landingUrl ?? (paper.provider === 'openalex' ? paper.id : `https://www.semanticscholar.org/paper/${encodeURIComponent(paper.id)}`);
  const { source: _source, sourceError: _error, ...record } = paper;
  return captureSearchSource(materials, { title: paper.title, url, contentKind: 'paper-metadata',
    snippet: `Scholarly metadata observation (not downloaded full text)\n\n${JSON.stringify(record, null, 2)}`,
    ...(paper.authors.length ? { author: paper.authors.map(author => author.name).join(', ') } : {}) },
  authority, { providerId: paper.provider, operationId }, signal);
}
