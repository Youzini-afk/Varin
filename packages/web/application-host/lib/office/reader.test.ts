import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { WebSnapshotRef } from '@varin/protocol';
import type { WebMaterialStore, WebSnapshotDraft } from '../harness/web-materials.js';
import type { DocumentReader } from '../harness/document-reading.js';
import type { OfficeRenderer } from './renderer.js';
import { createOfficeFile } from './create.js';
import { createOfficeReader } from './reader.js';
import { readDocumentMaterial } from '../harness/document-material.js';

it('reads Office body by path and snapshot, continues exact object pages, and keeps explicit overview and view conflicts clear', async () => {
  const bytes = await createOfficeFile({ format: 'docx', blocks: [
    { kind: 'paragraph', text: 'First paragraph 中文' }, { kind: 'paragraph', text: 'Second paragraph' },
  ] }, async () => { throw new Error('No image requested'); });
  const saved = new Map<string, { ref: WebSnapshotRef; source: { bytes: Buffer }; body: Buffer }>();
  const materials = {
    put: async (_workspace: string, draft: WebSnapshotDraft, body: Buffer, _authority: unknown, options: { source: { bytes: Buffer } }) => {
      const { structure, document, ...fields } = draft;
      const ref: WebSnapshotRef = { ...fields, ...(structure ? { structure } : {}), ...(document ? { document } : {}), snapshotId: `snapshot-${saved.size}`, fetchedAt: 1,
        contentHash: createHash('sha256').update(body).digest('hex'), byteLength: body.length };
      saved.set(ref.snapshotId, { ref, body, source: options.source }); return ref;
    },
    read: async (_workspace: string, id: string) => saved.get(id) ?? null,
  } as unknown as WebMaterialStore;
  const pdf = { ingest: async () => { throw new Error('Office source must not become PDF automatically'); },
    read: async () => { throw new Error('Office snapshot must stay with its original reader'); } } as DocumentReader;
  const reader = createOfficeReader({ materials, pdf, renderer: {} as OfficeRenderer });
  const context = { workspaceId: 'ws', authority: { kind: 'thread' as const, owningWorkspaceId: 'ws', threadId: 'thread' } };
  const sources = { readPath: async () => ({ source: bytes, sourceUrl: 'file:///report.docx' }) };
  const read = (request: Parameters<typeof readDocumentMaterial>[1]) => readDocumentMaterial(pdf, request, context, sources, reader.document);
  const first = await read({ path: 'report.docx' });
  expect(first.status).toBe('ok'); if (first.status !== 'ok') throw new Error('Missing body');
  expect(first).toMatchObject({ view: 'text', textStatus: 'available', markdown: 'First paragraph 中文\nSecond paragraph' });
  const pinned = await read({ snapshotId: first.snapshot!.snapshotId });
  expect(pinned).toMatchObject({ status: 'ok', view: 'text', markdown: first.markdown });
  const overview = await read({ snapshotId: first.snapshot!.snapshotId, view: 'overview' });
  expect(overview).toMatchObject({ status: 'ok', view: 'overview', textStatus: 'not-requested', nextRead: { snapshotId: first.snapshot!.snapshotId, view: 'text' } });
  const page = await read({ snapshotId: first.snapshot!.snapshotId, office: { limit: 1 } });
  if (page.status !== 'ok' || !page.nextRead) throw new Error('Missing continuation');
  expect(page.markdown).toBe('First paragraph 中文');
  expect((await read(page.nextRead))).toMatchObject({ status: 'ok', markdown: 'Second paragraph' });
  expect(await read({ snapshotId: first.snapshot!.snapshotId, view: 'overview', office: { view: 'content' } })).toMatchObject({ status: 'failed', reason: expect.stringContaining('Conflicting') });
  expect(await read({ snapshotId: first.snapshot!.snapshotId, view: 'page-image', office: { objectId: 'selected-object' } })).toMatchObject({ status: 'failed', reason: expect.stringContaining('content selectors') });
});
