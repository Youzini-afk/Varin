import { OFFICE_FORMAT_MIME_TYPES, type DocumentReadRequest, type FetchResult, type OfficeFormat, type OfficeReadRequest, type OfficeReadResult, type WebSnapshotRef } from '@varin/protocol';
import type { DocumentIngestInput, DocumentReader, DocumentReaderContext } from '../harness/document-reading.js';
import type { DocumentMaterialSources } from '../harness/document-material.js';
import type { WebMaterialStore } from '../harness/web-materials.js';
import { OfficePackage } from './package.js';
import type { OfficeRenderer } from './renderer.js';

export const OFFICE_MIME = OFFICE_FORMAT_MIME_TYPES;
export const isOfficeFormat = (value: unknown): value is OfficeFormat => value === 'docx' || value === 'xlsx' || value === 'pptx';
const bodyText = (result: OfficeReadResult): string => (result.objects ?? []).map(object => object.kind === 'cell'
  ? `${object.address}\t${object.formula ? `=${object.formula.text}\tstored value: ${object.cachedValue ?? '(not stored)'}` : object.value ?? ''}`
  : object.kind === 'table' && object.rows ? object.rows.map(row => row.cells.map(cell => cell.text).join('\t')).join('\n') : object.text ?? '').filter(Boolean).join('\n');

export function createOfficeReader(options: { materials: Pick<WebMaterialStore, 'put' | 'read'>; pdf: DocumentReader; renderer: OfficeRenderer }) {
  const load = async (input: Pick<OfficeReadRequest, 'path' | 'snapshotId'>, context: DocumentReaderContext,
    sources: DocumentMaterialSources, captured?: DocumentIngestInput): Promise<{ package: OfficePackage; bytes: Buffer; snapshot: WebSnapshotRef }> => {
    context.signal?.throwIfAborted();
    let source = captured;
    if (input.snapshotId) {
      const snapshot = await options.materials.read(context.workspaceId, input.snapshotId, context.authority, { includeSource: true, ...(context.signal ? { signal: context.signal } : {}) });
      if (!snapshot?.source) throw new Error('The original Office snapshot is unavailable to this task');
      if (!isOfficeFormat(snapshot.ref.document?.kind)) throw new Error('This snapshot is not an Office file; use document_read for PDF material');
      return { package: new OfficePackage(snapshot.source.bytes), bytes: snapshot.source.bytes, snapshot: snapshot.ref };
    }
    if (!source) {
      if (!input.path || !sources.readPath) throw new Error('Choose exactly one Office file path or snapshotId from this task');
      source = await sources.readPath(input.path, context.signal);
    }
    const document = new OfficePackage(source.source);
    const body = document.sections().map(section => `${section.name}\t${section.id}`).join('\n');
    const snapshot = await options.materials.put(context.workspaceId, { sourceUrl: source.sourceUrl, finalUrl: source.finalUrl ?? source.sourceUrl,
      ...(source.title ? { title: source.title } : {}), contentType: OFFICE_MIME[document.format], representation: 'ooxml-index',
      document: { kind: document.format, parser: 'ooxml', ...(document.format === 'pptx' ? { pageCount: document.sections().length } : {}) } },
      Buffer.from(body), context.authority, { source: { bytes: source.source, contentType: OFFICE_MIME[document.format] } });
    context.signal?.throwIfAborted();
    return { package: document, bytes: source.source, snapshot };
  };
  const render = async (input: { path?: string; snapshotId?: string; page?: number; scale?: number }, context: DocumentReaderContext, sources: DocumentMaterialSources,
    captured?: DocumentIngestInput): Promise<FetchResult> => {
    const original = await load(input, context, sources, captured);
    const converted = await options.renderer.convert(original.bytes, original.package.format, 'pdf', context.signal);
    const result = await options.pdf.ingest({ source: converted.bytes, sourceUrl: `${original.snapshot.sourceUrl}#render=${original.package.revision}`,
      title: `${original.snapshot.title ?? original.package.format}.pdf`, contentType: 'application/pdf' }, context,
      { view: input.page === undefined ? 'overview' : 'page-image', ...(input.page === undefined ? {} : { page: input.page }), ...(input.scale === undefined ? {} : { scale: input.scale }) });
    return result.status === 'ok' ? { ...result, rendered: true, sourceSnapshot: original.snapshot,
      rendering: { engine: converted.engine.name, version: converted.engine.version } } : result;
  };
  return {
    load,
    render,
    async read(input: OfficeReadRequest, context: DocumentReaderContext, sources: DocumentMaterialSources, captured?: DocumentIngestInput): Promise<OfficeReadResult> {
      const original = await load(input, context, sources, captured);
      return { ...original.package.read(input), snapshotId: original.snapshot.snapshotId, ...(original.snapshot.title ? { title: original.snapshot.title } : {}) };
    },
    /** The ordinary document entry also recognizes Office material without changing PDF behavior. */
    async document(input: DocumentReadRequest, context: DocumentReaderContext, captured?: DocumentIngestInput): Promise<FetchResult | undefined> {
      if (input.snapshotId) {
        const metadata = await options.materials.read(context.workspaceId, input.snapshotId, context.authority,
          { byteRange: { offset: 0, length: 0 }, ...(context.signal ? { signal: context.signal } : {}) });
        if (!isOfficeFormat(metadata?.ref.document?.kind)) return undefined;
      } else if (!captured || captured.source[0] !== 0x50 || captured.source[1] !== 0x4b) return undefined;
      if (input.view === 'page-image') return render({ ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}), page: input.page ?? 1,
        ...(input.scale === undefined ? {} : { scale: input.scale }) }, context, {}, captured);
      const original = await load(input, context, {}, captured);
      const read = original.package.read({ view: input.find ? 'find' : input.view === 'overview' || !input.view ? 'overview' : 'content',
        ...(input.find ? { query: input.find } : {}), ...(input.position?.kind === 'section' ? { section: input.position.title } : {}), ...input.office });
      const content = read.objects ? bodyText(read) : read.sections.map(section => `${section.name}\t${section.id}`).join('\n');
      return { status: 'ok', url: original.snapshot.sourceUrl, finalUrl: original.snapshot.finalUrl, snapshot: original.snapshot, markdown: content,
        bytes: Buffer.byteLength(content), fromCache: !!input.snapshotId, rendered: false, contentType: OFFICE_MIME[original.package.format],
        office: read, ...(original.snapshot.title ? { title: original.snapshot.title } : {}) };
    },
  };
}
export type OfficeReader = ReturnType<typeof createOfficeReader>;
